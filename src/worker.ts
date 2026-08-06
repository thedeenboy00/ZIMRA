// =============================================================================
// src/worker.ts — In-Process Sync Queue Worker
// =============================================================================
// Runs inside the same Node.js process as the Express API (free-tier friendly).
// Exported as startWorker() / stopWorker() so server.ts owns the lifecycle.
//
// Responsibilities:
//   • Poll PostgreSQL OfflineSyncQueue for PENDING / RETRYING entries
//   • Replay OPEN_DAY, SUBMIT_RECEIPT, CLOSE_DAY operations against ZIMRA
//   • Update Sale / FiscalDay / Device records on success
//   • Apply exponential backoff + jitter on failure; mark FAILED after maxAttempts
//   • Concurrency lock — at most WORKER_MAX_CONCURRENT operations in-flight
//   • Never throws — all errors are caught and logged; the API keeps running
// =============================================================================

import prisma from "./lib/db.js";
import { SyncOperationType, SyncQueueStatus } from "../generated/prisma/index.js";
import { FiscalDayService } from "./services/zimra/fiscalDay.js";
import { DeviceRegistrationService } from "./services/zimra/deviceRegistration.js";
import { createZimraClient, isZimraSuccess } from "./services/zimra/client.js";
import { decryptPrivateKey, deriveEncryptionKey } from "./services/zimra/crypto.js";
import type {
  ZimraOpenDayRequest,
  ZimraSubmitReceiptRequest,
  ZimraCloseDayRequest,
} from "./types/zimra.js";

// ---------------------------------------------------------------------------
// §1. CONFIGURATION
// ---------------------------------------------------------------------------

const POLL_INTERVAL_MS =
  parseInt(process.env.WORKER_POLL_INTERVAL_MS ?? "10000", 10);

const MAX_CONCURRENT =
  parseInt(process.env.WORKER_MAX_CONCURRENT ?? "3", 10);

const BACKOFF_BASE_MS = 5_000;
const BACKOFF_MAX_MS  = 5 * 60_000; // 5 minutes

// ---------------------------------------------------------------------------
// §2. WORKER STATE
// ---------------------------------------------------------------------------

/** Tracks in-flight operation IDs to prevent double-dispatch. */
const inFlight = new Set<string>();

/** Timer handle — kept so stopWorker() can cancel the next scheduled tick. */
let pollTimer: ReturnType<typeof setTimeout> | null = null;

/** Set to true by stopWorker() — prevents any new tick from starting. */
let stopping = false;

/**
 * How many ticks are currently executing their async body.
 * Prevents stop() from returning before the current tick drains.
 */
let activeTicks = 0;

// ---------------------------------------------------------------------------
// §3. PUBLIC API
// ---------------------------------------------------------------------------

/**
 * Start the in-process sync worker.
 * Safe to call multiple times — subsequent calls are no-ops.
 */
export function startWorker(): void {
  if (pollTimer !== null || stopping) return;

  console.log(
    `[Worker] Starting — poll every ${POLL_INTERVAL_MS}ms, ` +
    `max ${MAX_CONCURRENT} concurrent operations.`
  );

  // Kick off the first tick after a short warm-up delay so the API is
  // fully listening before we touch the database.
  scheduleTick(2_000);
}

/**
 * Signal the worker to stop after the current tick completes.
 * Returns a Promise that resolves once no tick is executing.
 * Called by the graceful-shutdown handler in server.ts.
 */
export async function stopWorker(): Promise<void> {
  stopping = true;

  if (pollTimer !== null) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }

  // Wait for any currently-executing tick to finish (max 35 s).
  const deadline = Date.now() + 35_000;
  while (activeTicks > 0 && Date.now() < deadline) {
    await sleep(200);
  }

  console.log("[Worker] Stopped.");
}

// ---------------------------------------------------------------------------
// §4. SCHEDULING
// ---------------------------------------------------------------------------

function scheduleTick(delayMs: number): void {
  if (stopping) return;
  pollTimer = setTimeout(() => {
    pollTimer = null;
    tick().catch((err) => {
      console.error("[Worker] Unhandled tick error:", err);
    });
  }, delayMs);
}

async function tick(): Promise<void> {
  if (stopping) return;
  activeTicks++;

  try {
    const processed = await processQueue();

    // Back off to a longer interval when the queue is empty
    const nextDelay = processed > 0 ? POLL_INTERVAL_MS : POLL_INTERVAL_MS * 3;
    scheduleTick(nextDelay);
  } catch (err) {
    console.error("[Worker] Queue processing error:", err);
    scheduleTick(POLL_INTERVAL_MS);
  } finally {
    activeTicks--;
  }
}

// ---------------------------------------------------------------------------
// §5. QUEUE PROCESSOR
// ---------------------------------------------------------------------------

/**
 * Fetch eligible queue entries and dispatch up to MAX_CONCURRENT of them.
 * Returns the number of entries dispatched in this tick.
 */
async function processQueue(): Promise<number> {
  const now = new Date();
  const available = MAX_CONCURRENT - inFlight.size;
  if (available <= 0) return 0;

  // Fetch entries that are due, in priority + createdAt order
  const entries = await prisma.offlineSyncQueue.findMany({
    where: {
      status: { in: [SyncQueueStatus.PENDING, SyncQueueStatus.RETRYING] },
      nextRetryAt: { lte: now },
      id: { notIn: Array.from(inFlight) },
    },
    orderBy: [
      { priority: "asc" },
      { nextRetryAt: "asc" },
    ],
    take: available,
  });

  if (entries.length === 0) return 0;

  // Dispatch concurrently — do NOT await; each entry manages its own lifecycle
  for (const entry of entries) {
    inFlight.add(entry.id);
    dispatch(entry).finally(() => inFlight.delete(entry.id));
  }

  return entries.length;
}

// ---------------------------------------------------------------------------
// §6. OPERATION DISPATCHER
// ---------------------------------------------------------------------------

/**
 * Marks the entry IN_FLIGHT, runs the appropriate ZIMRA handler,
 * then marks it SUCCEEDED or updates its backoff state for retry.
 */
async function dispatch(
  entry: Awaited<ReturnType<typeof prisma.offlineSyncQueue.findMany>>[number]
): Promise<void> {
  const now = new Date();

  // Mark in-flight immediately to prevent concurrent re-dispatch
  await prisma.offlineSyncQueue.update({
    where: { id: entry.id },
    data: {
      status: SyncQueueStatus.IN_FLIGHT,
      lastAttemptAt: now,
      attemptCount: { increment: 1 },
    },
  });

  try {
    await executeOperation(entry);

    // ── Success ────────────────────────────────────────────────────────────
    await prisma.offlineSyncQueue.update({
      where: { id: entry.id },
      data: {
        status: SyncQueueStatus.SUCCEEDED,
        succeededAt: new Date(),
      },
    });

    console.log(
      `[Worker] ✓ ${entry.operationType} succeeded — entity: ${entry.entityId}`
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const isPermanent = (err as WorkerError).isPermanent ?? false;
    const newAttemptCount = entry.attemptCount + 1;
    const maxReached = newAttemptCount >= entry.maxAttempts;

    const shouldFail = isPermanent || maxReached;
    const nextStatus = shouldFail
      ? SyncQueueStatus.FAILED
      : SyncQueueStatus.RETRYING;

    const nextRetryAt = shouldFail
      ? new Date()
      : new Date(Date.now() + computeBackoff(newAttemptCount));

    await prisma.offlineSyncQueue.update({
      where: { id: entry.id },
      data: {
        status: nextStatus,
        lastErrorCode: (err as WorkerError).code ?? "ERR_UNKNOWN",
        lastErrorMessage: message.slice(0, 1000),
        nextRetryAt,
      },
    });

    console.error(
      `[Worker] ✗ ${entry.operationType} ${shouldFail ? "FAILED permanently" : `will retry at ${nextRetryAt.toISOString()}`}` +
      ` — entity: ${entry.entityId} — ${message}`
    );
  }
}

// ---------------------------------------------------------------------------
// §7. OPERATION EXECUTORS
// ---------------------------------------------------------------------------

async function executeOperation(
  entry: Awaited<ReturnType<typeof prisma.offlineSyncQueue.findMany>>[number]
): Promise<void> {
  const payload = entry.requestPayload as Record<string, unknown>;

  switch (entry.operationType) {
    case SyncOperationType.OPEN_DAY:
      await executeOpenDay(entry.deviceId, entry.entityId, payload as unknown as ZimraOpenDayRequest, entry.idempotencyKey);
      break;

    case SyncOperationType.SUBMIT_RECEIPT:
      await executeSubmitReceipt(entry.deviceId, entry.entityId, payload as unknown as ZimraSubmitReceiptRequest, entry.idempotencyKey);
      break;

    case SyncOperationType.CLOSE_DAY:
      await executeCloseDay(entry.deviceId, entry.entityId, payload as unknown as ZimraCloseDayRequest, entry.idempotencyKey);
      break;

    default:
      throw new WorkerError(
        `Unknown operation type: ${entry.operationType}`,
        "ERR_UNKNOWN_OP",
        true // permanent — never retry
      );
  }
}

// ── 7.1 OpenDay ─────────────────────────────────────────────────────────────

async function executeOpenDay(
  deviceDbId: string,
  fiscalDayDbId: string,
  payload: ZimraOpenDayRequest,
  idempotencyKey: string
): Promise<void> {
  const client = await buildZimraClient(deviceDbId);
  const result = await client.openDay(
    payload.fiscalDayNo,
    new Date(payload.fiscalDayOpened),
    idempotencyKey
  );

  if (!isZimraSuccess(result)) {
    throw WorkerError.fromZimra(result.error.errorCode, result.error.errorMessage);
  }

  const response = result.data;

  await prisma.$transaction([
    prisma.fiscalDay.update({
      where: { id: fiscalDayDbId },
      data: {
        status: "OPEN",
        zimraOpenToken: response.fiscalDayOpenedToken,
        openResponsePayload: response as object,
      },
    }),
    prisma.device.update({
      where: { id: deviceDbId },
      data: { lastFiscalDayNo: response.fiscalDayNo },
    }),
  ]);
}

// ── 7.2 SubmitReceipt ────────────────────────────────────────────────────────

async function executeSubmitReceipt(
  deviceDbId: string,
  saleDbId: string,
  payload: ZimraSubmitReceiptRequest,
  idempotencyKey: string
): Promise<void> {
  const client = await buildZimraClient(deviceDbId);
  const result = await client.submitReceipt(payload, idempotencyKey);

  if (!isZimraSuccess(result)) {
    // ERR_010 = duplicate — ZIMRA already has it, treat as success
    if (result.error.errorCode === "ERR_010") {
      await prisma.sale.update({
        where: { id: saleDbId },
        data: {
          status: "FISCALLY_ACCEPTED",
          zimraResponseCode: "ERR_010_DUPLICATE",
          zimraSubmittedAt: new Date(),
        },
      });
      return;
    }
    throw WorkerError.fromZimra(result.error.errorCode, result.error.errorMessage);
  }

  const response = result.data;

  await prisma.$transaction([
    prisma.sale.update({
      where: { id: saleDbId },
      data: {
        status: "FISCALLY_ACCEPTED",
        receiptGlobalNo: response.receiptGlobalNo,
        zimraQrCode: response.receiptQRUrl,
        zimraVerifyUrl: `https://www.zimra.co.zw/verify?code=${response.receiptVerificationCode}`,
        zimraSubmittedAt: new Date(),
        zimraResponseCode: response.receiptResponseCode,
        submitResponsePayload: response as object,
        offlineSyncedAt: new Date(),
      },
    }),
    prisma.device.update({
      where: { id: deviceDbId },
      data: { lastReceiptGlobalNo: response.receiptGlobalNo },
    }),
  ]);
}

// ── 7.3 CloseDay ─────────────────────────────────────────────────────────────

async function executeCloseDay(
  deviceDbId: string,
  fiscalDayDbId: string,
  payload: ZimraCloseDayRequest,
  idempotencyKey: string
): Promise<void> {
  const client = await buildZimraClient(deviceDbId);
  const result = await client.closeDay(payload, idempotencyKey);

  if (!isZimraSuccess(result)) {
    throw WorkerError.fromZimra(result.error.errorCode, result.error.errorMessage);
  }

  const response = result.data;

  await prisma.fiscalDay.update({
    where: { id: fiscalDayDbId },
    data: {
      status: "CLOSED",
      closedAt: new Date(),
      zimraCloseToken: response.fiscalDayClosedToken,
      closeResponsePayload: response as object,
    },
  });
}

// ---------------------------------------------------------------------------
// §8. ZIMRA CLIENT FACTORY (loads device credentials from DB)
// ---------------------------------------------------------------------------

async function buildZimraClient(deviceDbId: string) {
  const device = await prisma.device.findUniqueOrThrow({
    where: { id: deviceDbId },
    select: {
      deviceId: true,
      privateKeyPem: true,
      certificatePem: true,
      certificateThumb: true,
    },
  });

  if (!device.privateKeyPem || !device.certificatePem || !device.certificateThumb) {
    throw new WorkerError(
      `Device ${deviceDbId} is missing cryptographic material.`,
      "ERR_DEVICE_NOT_READY",
      true
    );
  }

  // Decrypt private key from AES-256-GCM storage
  const encryptionKey = await deriveEncryptionKey(
    process.env.DEVICE_KEY_SECRET!,
    process.env.DEVICE_KEY_SALT!
  );
  const encryptedKey = JSON.parse(device.privateKeyPem);
  const privateKeyPem = decryptPrivateKey(encryptedKey, encryptionKey);

  return createZimraClient({
    baseUrl: "",
    deviceId: device.deviceId,
    privateKeyPem,
    certificatePem: device.certificatePem,
    certificateThumbprint: device.certificateThumb,
  });
}

// ---------------------------------------------------------------------------
// §9. HELPERS
// ---------------------------------------------------------------------------

/** Exponential backoff with ±20% jitter. Returns milliseconds. */
function computeBackoff(attemptCount: number): number {
  const base = BACKOFF_BASE_MS * Math.pow(2, attemptCount - 1);
  const capped = Math.min(base, BACKOFF_MAX_MS);
  const jitter = capped * 0.2 * (Math.random() * 2 - 1);
  return Math.round(capped + jitter);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// §10. WORKER ERROR CLASS
// ---------------------------------------------------------------------------

class WorkerError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly isPermanent = false
  ) {
    super(message);
    this.name = "WorkerError";
  }

  /**
   * Map ZIMRA error codes to permanent vs retryable failures.
   * ERR_001 / ERR_006 / ERR_009 should not be retried — they indicate
   * fundamental problems (bad key, suspended device) that won't self-heal.
   */
  static fromZimra(code: string, message: string): WorkerError {
    const permanent = new Set([
      "ERR_001", // Invalid activation key
      "ERR_006", // Invalid receipt signature
      "ERR_009", // Device suspended
    ]);
    return new WorkerError(
      `ZIMRA [${code}]: ${message}`,
      code,
      permanent.has(code)
    );
  }
}