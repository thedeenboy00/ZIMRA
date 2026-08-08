// =============================================================================
// Offline Sync Queue Manager
// src/services/sync/offlineSyncManager.ts
// =============================================================================
// Responsibilities:
//   1. Enqueue ZIMRA operations when offline or on failure
//   2. Background worker — polls queue and replays operations on reconnection
//   3. Exponential backoff with jitter per entry
//   4. Connectivity detection (Network API + active probe)
//   5. Priority ordering: OPEN_DAY(1) → SUBMIT_RECEIPT(2) → CLOSE_DAY(3)
//   6. Server-side PostgreSQL reconciliation after full resync
//   7. Event emitter for POS UI to react to sync state changes
//   8. Idempotency — duplicate submissions handled gracefully
// =============================================================================

import { randomUUID } from "crypto";

import {
  getOfflineDb,
  parseSyncPayload,
  type LocalSale,
  type LocalFiscalDay,
  type LocalSyncQueueEntry,
  type LocalSignedReceipt,
} from "./offlineDb";

import type {
  ZimraSubmitReceiptRequest,
  ZimraOpenDayRequest,
  ZimraCloseDayRequest,
  ZimraOpenDayResponse,
  ZimraSubmitReceiptResponse,
  ZimraCloseDayResponse,
} from "../../types/zimra";

// ---------------------------------------------------------------------------
// §1. CONFIGURATION
// ---------------------------------------------------------------------------

export interface SyncManagerConfig {
  /** Base URL of our own backend API (not ZIMRA directly — goes via server). */
  apiBaseUrl: string;
  /** Tenant ID for this POS session. */
  tenantId: string;
  /** Server-side Device UUID (not the ZIMRA serial). */
  deviceDbId: string;
  /** ZIMRA device serial. */
  deviceId: string;
  /**
   * How often the worker polls the queue (ms). Default: 5 000.
   * Increases to `idleIntervalMs` when the queue is empty.
   */
  activeIntervalMs?: number;
  /**
   * Poll interval when the queue is empty (ms). Default: 30 000.
   */
  idleIntervalMs?: number;
  /**
   * URL to actively probe for internet connectivity.
   * Must return HTTP 200. Default: backend /api/health.
   */
  connectivityProbeUrl?: string;
  /**
   * Max concurrent in-flight operations. Default: 1.
   * Keep at 1 to preserve ZIMRA sequence ordering.
   */
  maxConcurrent?: number;
}

const DEFAULT_CONFIG: Required<
  Omit<SyncManagerConfig, "apiBaseUrl" | "tenantId" | "deviceDbId" | "deviceId">
> = {
  activeIntervalMs: 5_000,
  idleIntervalMs: 30_000,
  connectivityProbeUrl: "/api/health",
  maxConcurrent: 1,
};

// ---------------------------------------------------------------------------
// §2. SYNC EVENT TYPES
// ---------------------------------------------------------------------------

export type SyncEventType =
  | "online"
  | "offline"
  | "queue:enqueued"
  | "queue:processing"
  | "queue:succeeded"
  | "queue:failed"
  | "queue:empty"
  | "sale:synced"
  | "fiscalDay:opened"
  | "fiscalDay:closed"
  | "error";

export interface SyncEvent {
  type: SyncEventType;
  timestamp: Date;
  entityId?: string;
  operationType?: string;
  error?: string;
  /** Count of remaining items in the queue. */
  queueDepth?: number;
}

export type SyncEventListener = (event: SyncEvent) => void;

// ---------------------------------------------------------------------------
// §3. OFFLINE SYNC MANAGER
// ---------------------------------------------------------------------------

export class OfflineSyncManager {
  private readonly config: Required<SyncManagerConfig>;
  private readonly listeners = new Set<SyncEventListener>();

  private isOnline = false;
  private isRunning = false;
  private workerTimer: ReturnType<typeof setTimeout> | null = null;
  private inFlightCount = 0;

  // Tracks which entry IDs are currently in-flight to prevent double-dispatch
  private readonly inFlightIds = new Set<string>();

  constructor(config: SyncManagerConfig) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ---------------------------------------------------------------------------
  // §4. LIFECYCLE — start / stop
  // ---------------------------------------------------------------------------

  /**
   * Starts the background sync worker.
   * Attaches to browser network events and begins polling the queue.
   * Safe to call multiple times — subsequent calls are no-ops.
   */
  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;

    // Browser Network API listeners
    if (typeof window !== "undefined") {
      window.addEventListener("online", this.handleOnline);
      window.addEventListener("offline", this.handleOffline);
      // Set initial online state based on browser's navigator.onLine
      this.isOnline = navigator.onLine;
    }

    this.scheduleNextPoll(0); // Start immediately
  }

  /**
   * Stops the background sync worker and removes event listeners.
   */
  stop(): void {
    if (!this.isRunning) return;
    this.isRunning = false;

    if (this.workerTimer) {
      clearTimeout(this.workerTimer);
      this.workerTimer = null;
    }

    if (typeof window !== "undefined") {
      window.removeEventListener("online", this.handleOnline);
      window.removeEventListener("offline", this.handleOffline);
    }
  }

  // ---------------------------------------------------------------------------
  // §5. EVENT EMITTER
  // ---------------------------------------------------------------------------

  on(listener: SyncEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(type: SyncEventType, extras: Partial<SyncEvent> = {}): void {
    const event: SyncEvent = { type, timestamp: new Date(), ...extras };
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Never let a listener crash the sync worker
      }
    }
  }

  // ---------------------------------------------------------------------------
  // §6. ENQUEUE OPERATIONS
  // ---------------------------------------------------------------------------

  /**
   * Enqueues an OpenDay operation for offline retry.
   *
   * @param payload        - The `ZimraOpenDayRequest` to replay on reconnection.
   * @param localDayId     - Local `LocalFiscalDay.id`.
   * @param idempotencyKey - UUID generated at the time of the original attempt.
   */
  async enqueueOpenDay(
    payload: ZimraOpenDayRequest,
    localDayId: string,
    idempotencyKey: string
  ): Promise<void> {
    await this.enqueue({
      operationType: "OPEN_DAY",
      entityType: "FiscalDay",
      entityId: localDayId,
      priority: 1,
      payload,
      idempotencyKey,
    });
  }

  /**
   * Enqueues a SubmitReceipt operation for offline retry.
   *
   * @param payload        - Fully signed `ZimraSubmitReceiptRequest`.
   * @param localSaleId    - Local `LocalSale.id`.
   * @param idempotencyKey - UUID generated when the receipt was first signed.
   */
  async enqueueSubmitReceipt(
    payload: ZimraSubmitReceiptRequest,
    localSaleId: string,
    idempotencyKey: string
  ): Promise<void> {
    await this.enqueue({
      operationType: "SUBMIT_RECEIPT",
      entityType: "Sale",
      entityId: localSaleId,
      priority: 2,
      payload,
      idempotencyKey,
    });
  }

  /**
   * Enqueues a CloseDay (Z-Report) operation for offline retry.
   *
   * @param payload        - Constructed `ZimraCloseDayRequest`.
   * @param localDayId     - Local `LocalFiscalDay.id`.
   * @param idempotencyKey - UUID generated at close-day initiation.
   */
  async enqueueCloseDay(
    payload: ZimraCloseDayRequest,
    localDayId: string,
    idempotencyKey: string
  ): Promise<void> {
    await this.enqueue({
      operationType: "CLOSE_DAY",
      entityType: "FiscalDay",
      entityId: localDayId,
      priority: 3,
      payload,
      idempotencyKey,
    });
  }

  /**
   * Enqueues a server-sync operation (persist LocalSale to PostgreSQL).
   * Lower priority than ZIMRA fiscal operations.
   *
   * @param localSaleId - Local `LocalSale.id`.
   */
  async enqueueSaleSync(localSaleId: string): Promise<void> {
    await this.enqueue({
      operationType: "SYNC_SALE",
      entityType: "Sale",
      entityId: localSaleId,
      priority: 5,
      payload: { localSaleId },
      idempotencyKey: `sale-sync-${localSaleId}`,
    });
  }

  // ---------------------------------------------------------------------------
  // §7. QUEUE STATUS
  // ---------------------------------------------------------------------------

  /**
   * Returns a snapshot of the current sync queue for display in the POS UI.
   */
  async getQueueStatus(): Promise<{
    pendingCount: number;
    failedCount: number;
    inFlightCount: number;
    isOnline: boolean;
    oldestPendingAt: Date | null;
  }> {
    const db = getOfflineDb();
    const now = Date.now();

    const [pendingCount, failedCount] = await Promise.all([
      db.syncQueue
        .where("status")
        .anyOf(["PENDING", "RETRYING"])
        .count(),
      db.syncQueue.where("status").equals("FAILED").count(),
    ]);

    const oldest = await db.syncQueue
      .where("[status+priority+nextRetryAt]")
      .below(["PENDING", 99, now + 1])
      .first();

    return {
      pendingCount,
      failedCount,
      inFlightCount: this.inFlightCount,
      isOnline: this.isOnline,
      oldestPendingAt: oldest ? new Date(oldest.createdAt) : null,
    };
  }

  /**
   * Returns all failed queue entries for the admin error screen.
   */
  async getFailedEntries(): Promise<LocalSyncQueueEntry[]> {
    const db = getOfflineDb();
    return db.syncQueue.where("status").equals("FAILED").toArray();
  }

  /**
   * Manually resets a failed entry back to PENDING for retry.
   */
  async retryFailed(entryId: string): Promise<void> {
    const db = getOfflineDb();
    await db.syncQueue.update(entryId, {
      status: "RETRYING",
      attemptCount: 0,
      nextRetryAt: Date.now(),
      lastErrorCode: undefined,
      lastErrorMessage: undefined,
      updatedAt: Date.now(),
    });
    this.scheduleNextPoll(0);
  }

  // ---------------------------------------------------------------------------
  // §8. CONNECTIVITY DETECTION
  // ---------------------------------------------------------------------------

  /**
   * Actively probes for internet connectivity by hitting our backend API.
   * The browser's `navigator.onLine` is unreliable on captive portals
   * and some mobile networks — always prefer an active probe.
   */
  async checkConnectivity(): Promise<boolean> {
    try {
      const response = await fetch(this.config.connectivityProbeUrl, {
        method: "GET",
        cache: "no-store",
        signal: AbortSignal.timeout(5_000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // §9. WORKER LOOP
  // ---------------------------------------------------------------------------

  private scheduleNextPoll(delayMs: number): void {
    if (!this.isRunning) return;
    if (this.workerTimer) clearTimeout(this.workerTimer);
    this.workerTimer = setTimeout(() => this.runWorkerCycle(), delayMs);
  }

  private async runWorkerCycle(): Promise<void> {
    if (!this.isRunning) return;

    try {
      // ── Connectivity check ─────────────────────────────────────────────
      const online = await this.checkConnectivity();
      if (online !== this.isOnline) {
        this.isOnline = online;
        this.emit(online ? "online" : "offline");
      }

      if (!online) {
        this.scheduleNextPoll(this.config.idleIntervalMs);
        return;
      }

      // ── Process pending entries ────────────────────────────────────────
      const processed = await this.processPendingEntries();

      // ── Schedule next poll ─────────────────────────────────────────────
      const queueDepth = await this.getPendingCount();
      if (queueDepth > 0 || processed > 0) {
        this.scheduleNextPoll(this.config.activeIntervalMs);
      } else {
        this.emit("queue:empty", { queueDepth: 0 });
        this.scheduleNextPoll(this.config.idleIntervalMs);
      }
    } catch (error) {
      this.emit("error", {
        error: (error as Error).message,
      });
      this.scheduleNextPoll(this.config.activeIntervalMs);
    }
  }

  /**
   * Fetches eligible queue entries and dispatches them up to `maxConcurrent`.
   * Returns the number of entries processed in this cycle.
   */
  private async processPendingEntries(): Promise<number> {
    const db = getOfflineDb();
    const now = Date.now();

    // Fetch entries that are due, ordered by priority asc then nextRetryAt asc
    const eligible = await db.syncQueue
      .where("status")
      .anyOf(["PENDING", "RETRYING"])
      .and((entry: any) => entry.nextRetryAt <= now)
      .sortBy("priority");

    // Further sort within same priority by nextRetryAt
    eligible.sort((a: any, b: any) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      return a.nextRetryAt - b.nextRetryAt;
    });

    const toProcess = eligible
      .filter((e: any) => !this.inFlightIds.has(e.id))
      .slice(0, this.config.maxConcurrent - this.inFlightCount);

    if (toProcess.length === 0) return 0;

    // Dispatch (do NOT await — fire concurrently up to maxConcurrent)
    for (const entry of toProcess) {
      this.dispatchEntry(entry).catch((err) => {
        this.emit("error", { error: (err as Error).message, entityId: entry.entityId });
      });
    }

    return toProcess.length;
  }

  /**
   * Dispatches a single queue entry to the appropriate handler.
   * Updates IndexedDB state before and after the API call.
   */
  private async dispatchEntry(entry: LocalSyncQueueEntry): Promise<void> {
    const db = getOfflineDb();

    // Mark in-flight
    this.inFlightIds.add(entry.id);
    this.inFlightCount++;
    await db.syncQueue.update(entry.id, {
      status: "IN_FLIGHT",
      lastAttemptAt: Date.now(),
      attemptCount: entry.attemptCount + 1,
      updatedAt: Date.now(),
    });

    this.emit("queue:processing", {
      entityId: entry.entityId,
      operationType: entry.operationType,
    });

    try {
      await this.executeEntry(entry);

      // ── Success ───────────────────────────────────────────────────────
      await db.syncQueue.update(entry.id, {
        status: "SUCCEEDED",
        succeededAt: Date.now(),
        updatedAt: Date.now(),
      });

      this.emit("queue:succeeded", {
        entityId: entry.entityId,
        operationType: entry.operationType,
        queueDepth: await this.getPendingCount(),
      });
    } catch (error) {
      const err = error as SyncDispatchError;
      const attemptCount = entry.attemptCount + 1;
      const isPermanent = err.isPermanent || attemptCount >= entry.maxAttempts;

      const nextRetryAt = isPermanent
        ? Date.now()
        : computeNextRetry(attemptCount);

      await db.syncQueue.update(entry.id, {
        status: isPermanent ? "FAILED" : "RETRYING",
        nextRetryAt,
        lastErrorCode: err.code,
        lastErrorMessage: err.message,
        updatedAt: Date.now(),
      });

      this.emit("queue:failed", {
        entityId: entry.entityId,
        operationType: entry.operationType,
        error: err.message,
        queueDepth: await this.getPendingCount(),
      });
    } finally {
      this.inFlightIds.delete(entry.id);
      this.inFlightCount--;
    }
  }

  // ---------------------------------------------------------------------------
  // §10. OPERATION EXECUTORS
  // ---------------------------------------------------------------------------

  /**
   * Routes a queue entry to the correct API handler.
   * All handlers call our backend API (which proxies to ZIMRA server-side).
   * This avoids storing the device private key in the browser.
   */
  private async executeEntry(entry: LocalSyncQueueEntry): Promise<void> {
    switch (entry.operationType) {
      case "OPEN_DAY":
        await this.executeOpenDay(entry);
        break;
      case "SUBMIT_RECEIPT":
        await this.executeSubmitReceipt(entry);
        break;
      case "CLOSE_DAY":
        await this.executeCloseDay(entry);
        break;
      case "SYNC_SALE":
        await this.executeSyncSale(entry);
        break;
      default:
        throw new SyncDispatchError(
          `Unknown operation type: ${entry.operationType}`,
          "ERR_UNKNOWN_OP",
          true // Permanent — do not retry
        );
    }
  }

  private async executeOpenDay(entry: LocalSyncQueueEntry): Promise<void> {
    const payload = parseSyncPayload(entry) as ZimraOpenDayRequest;

    const response = await this.apiPost<ZimraOpenDayResponse>(
      `/api/devices/${this.config.deviceDbId}/open-day`,
      { ...payload, idempotencyKey: entry.idempotencyKey }
    );

    // Update local fiscal day record
    const db = getOfflineDb();
    const fiscalDay = await db.fiscalDays
      .where("id")
      .equals(entry.entityId)
      .first();

    if (fiscalDay) {
      await db.fiscalDays.update(fiscalDay.id, {
        serverFiscalDayId: response.fiscalDayNo.toString(),
        zimraOpenToken: response.fiscalDayOpenedToken,
        pendingOpen: false,
        status: "OPEN",
      });
    }

    // Update local device counter
    await db.devices.where("deviceId").equals(this.config.deviceId).modify({
      lastFiscalDayNo: response.fiscalDayNo,
    });

    this.emit("fiscalDay:opened", { entityId: entry.entityId });
  }

  private async executeSubmitReceipt(entry: LocalSyncQueueEntry): Promise<void> {
    const payload = parseSyncPayload(entry) as ZimraSubmitReceiptRequest;

    const response = await this.apiPost<ZimraSubmitReceiptResponse>(
      `/api/devices/${this.config.deviceDbId}/submit-receipt`,
      { ...payload, idempotencyKey: entry.idempotencyKey }
    );

    const db = getOfflineDb();

    // Update LocalSale with ZIMRA acceptance
    await db.sales.update(entry.entityId, {
      status: "FISCALLY_ACCEPTED",
      receiptGlobalNo: response.receiptGlobalNo,
      zimraQrCode: response.receiptQRUrl,
      zimraVerifyUrl: `https://www.zimra.co.zw/verify?code=${response.receiptVerificationCode}&device=${this.config.deviceId}`,
      zimraSubmittedAt: Date.now(),
      zimraResponseCode: response.receiptResponseCode,
      needsZimraSync: false,
      updatedAt: Date.now(),
    } as Partial<LocalSale>);

    // Update signed receipt record
    await db.signedReceipts
      .where("saleId")
      .equals(entry.entityId)
      .modify({
        submissionStatus: "ACCEPTED",
        submittedAt: Date.now(),
        zimraReceiptGlobalNo: response.receiptGlobalNo,
        zimraQrUrl: response.receiptQRUrl,
        zimraVerificationCode: response.receiptVerificationCode,
      } as Partial<LocalSignedReceipt>);

    // Update device counters
    await db.devices.where("deviceId").equals(this.config.deviceId).modify({
      lastReceiptGlobalNo: response.receiptGlobalNo,
    });

    this.emit("sale:synced", { entityId: entry.entityId });
  }

  private async executeCloseDay(entry: LocalSyncQueueEntry): Promise<void> {
    const payload = parseSyncPayload(entry) as ZimraCloseDayRequest;

    const response = await this.apiPost<ZimraCloseDayResponse>(
      `/api/devices/${this.config.deviceDbId}/close-day`,
      { ...payload, idempotencyKey: entry.idempotencyKey }
    );

    const db = getOfflineDb();
    await db.fiscalDays.update(entry.entityId, {
      status: "CLOSED",
      closedAt: Date.now(),
      zimraCloseToken: response.fiscalDayClosedToken,
      pendingClose: false,
    });

    this.emit("fiscalDay:closed", { entityId: entry.entityId });
  }

  /**
   * Syncs a locally-completed sale to the PostgreSQL backend.
   * Called for sales created offline that were successfully submitted to ZIMRA
   * but haven't been persisted server-side yet.
   */
  private async executeSyncSale(entry: LocalSyncQueueEntry): Promise<void> {
    const db = getOfflineDb();
    const sale = await db.sales.get(entry.entityId);

    if (!sale) {
      throw new SyncDispatchError(
        `Local sale "${entry.entityId}" not found in IndexedDB.`,
        "ERR_ENTITY_NOT_FOUND",
        true
      );
    }

    await this.apiPost(`/api/sales/sync`, {
      sale,
      idempotencyKey: entry.idempotencyKey,
    });

    await db.sales.update(entry.entityId, {
      needsServerSync: false,
      updatedAt: Date.now(),
    } as Partial<LocalSale>);
  }

  // ---------------------------------------------------------------------------
  // §11. PRODUCT & RATE SYNC (Pull from server)
  // ---------------------------------------------------------------------------

  /**
   * Pulls the latest product catalogue from the server into IndexedDB.
   * Called on startup and after regaining connectivity.
   * Uses a cursor-based approach to handle large catalogues efficiently.
   *
   * @param since - Optional Unix ms timestamp — only fetch products updated after this time.
   */
  async syncProducts(since?: number): Promise<{ count: number }> {
    const url = new URL(`${this.config.apiBaseUrl}/api/products/for-device`);
    url.searchParams.set("tenantId", this.config.tenantId);
    if (since) url.searchParams.set("since", String(since));

    const response = await fetch(url.toString(), {
      headers: this.buildAuthHeaders(),
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      throw new Error(`Product sync failed: HTTP ${response.status}`);
    }

    const { products } = await response.json() as {
      products: Array<{
        id: string;
        sku: string;
        barcode?: string;
        name: string;
        description?: string;
        productType: string;
        priceUsd: number;
        vatRate: number;
        taxCategory: string;
        hsCode?: string;
        unit: string;
        trackInventory: boolean;
        stockQuantity: number;
        isActive: boolean;
        updatedAt: string;
      }>;
    };

    const db = getOfflineDb();
    const now = Date.now();

    // Bulk upsert using Dexie's bulkPut for performance
    await db.products.bulkPut(
      products.map((p) => {
        // Compute inclusive price from exclusive + VAT rate
        const inclVat = p.priceUsd * (1 + p.vatRate);
        return {
          id: p.id,
          tenantId: this.config.tenantId,
          sku: p.sku,
          barcode: p.barcode,
          name: p.name,
          description: p.description,
          productType: p.productType,
          priceInclVatUsd: Math.round(inclVat * 100) / 100,
          priceExclVatUsd: p.priceUsd,
          vatRate: p.vatRate,
          taxCategory: p.taxCategory as any,
          hsCode: p.hsCode,
          unit: p.unit,
          trackInventory: p.trackInventory,
          stockQuantity: p.stockQuantity,
          isActive: p.isActive,
          syncedAt: now,
        };
      })
    );

    return { count: products.length };
  }

  /**
   * Pulls today's (and recent) ZiG/USD exchange rates into IndexedDB.
   */
  async syncCurrencyRates(): Promise<void> {
    const response = await fetch(
      `${this.config.apiBaseUrl}/api/currency-rates?tenantId=${this.config.tenantId}&days=7`,
      {
        headers: this.buildAuthHeaders(),
        signal: AbortSignal.timeout(10_000),
      }
    );

    if (!response.ok) {
      throw new Error(`Currency rate sync failed: HTTP ${response.status}`);
    }

    const { rates } = await response.json() as {
      rates: Array<{ rateDate: string; rate: number; rateSource: string }>;
    };

    const db = getOfflineDb();
    const now = Date.now();

    await db.currencyRates.bulkPut(
      rates.map((r) => ({
        id: `${this.config.tenantId}:${r.rateDate}:USD:ZIG`,
        tenantId: this.config.tenantId,
        rateDate: r.rateDate,
        fromCurrency: "USD",
        toCurrency: "ZIG",
        rate: r.rate,
        rateSource: r.rateSource,
        syncedAt: now,
      }))
    );
  }

  /**
   * Pulls the current device record from the server into IndexedDB.
   * Called on startup to refresh fiscal counters after a server-side update.
   */
  async syncDeviceState(): Promise<void> {
    const response = await fetch(
      `${this.config.apiBaseUrl}/api/devices/${this.config.deviceDbId}`,
      {
        headers: this.buildAuthHeaders(),
        signal: AbortSignal.timeout(10_000),
      }
    );

    if (!response.ok) {
      throw new Error(`Device sync failed: HTTP ${response.status}`);
    }

    const device = await response.json() as {
      id: string;
      deviceId: string;
      deviceName: string;
      status: string;
      lastReceiptCounter: number;
      lastReceiptGlobalNo: number;
      lastFiscalDayNo: number;
      certificateThumb?: string;
      certExpiresAt?: string;
      branchName?: string;
    };

    const db = getOfflineDb();
    await db.devices.put({
      id: device.id,
      deviceId: device.deviceId,
      tenantId: this.config.tenantId,
      deviceName: device.deviceName,
      status: device.status,
      lastReceiptCounter: device.lastReceiptCounter,
      lastReceiptGlobalNo: device.lastReceiptGlobalNo,
      lastFiscalDayNo: device.lastFiscalDayNo,
      certificateThumb: device.certificateThumb,
      certExpiresAt: device.certExpiresAt
        ? new Date(device.certExpiresAt).getTime()
        : undefined,
      branchName: device.branchName,
      syncedAt: Date.now(),
    });
  }

  // ---------------------------------------------------------------------------
  // §12. SALE HELPERS (used by the POS checkout flow)
  // ---------------------------------------------------------------------------

  /**
   * Saves a completed sale to IndexedDB and enqueues it for ZIMRA submission
   * and server persistence.
   *
   * Called immediately after the cashier completes payment — the customer
   * receives the receipt regardless of connectivity.
   *
   * @param sale - Fully constructed `LocalSale` with all items and payments.
   */
  async persistSaleLocally(sale: LocalSale): Promise<void> {
    const db = getOfflineDb();
    await db.sales.put(sale);

    // Enqueue server sync (low priority — happens after ZIMRA submission)
    await this.enqueueSaleSync(sale.id);
  }

  /**
   * Stores a signed ZIMRA receipt payload for offline submission.
   * Called after the receipt is signed but before ZIMRA submission.
   *
   * @param saleId         - Local sale ID.
   * @param payload        - Fully signed `ZimraSubmitReceiptRequest`.
   * @param idempotencyKey - UUID for dedup.
   */
  async storeSignedReceipt(
    saleId: string,
    payload: ZimraSubmitReceiptRequest,
    idempotencyKey: string
  ): Promise<void> {
    const db = getOfflineDb();
    await db.signedReceipts.put({
      saleId,
      idempotencyKey,
      payload,
      signedAt: Date.now(),
      submissionStatus: "PENDING",
    });

    await this.enqueueSubmitReceipt(payload, saleId, idempotencyKey);
  }

  /**
   * Opens a fiscal day locally and enqueues the OpenDay operation for ZIMRA.
   *
   * @param day            - `LocalFiscalDay` constructed by the POS.
   * @param payload        - `ZimraOpenDayRequest` to submit.
   * @param idempotencyKey - UUID for dedup.
   */
  async openFiscalDayLocally(
    day: LocalFiscalDay,
    payload: ZimraOpenDayRequest,
    idempotencyKey: string
  ): Promise<void> {
    const db = getOfflineDb();
    await db.fiscalDays.put(day);
    await this.enqueueOpenDay(payload, day.id, idempotencyKey);
  }

  /**
   * Marks a fiscal day as close-initiated locally and enqueues the CloseDay.
   *
   * @param localDayId     - Local `LocalFiscalDay.id`.
   * @param payload        - Constructed `ZimraCloseDayRequest`.
   * @param idempotencyKey - UUID for dedup.
   */
  async closeFiscalDayLocally(
    localDayId: string,
    payload: ZimraCloseDayRequest,
    idempotencyKey: string
  ): Promise<void> {
    const db = getOfflineDb();
    await db.fiscalDays.update(localDayId, {
      status: "CLOSE_INITIATED",
      pendingClose: true,
      closedAt: Date.now(),
    });
    await this.enqueueCloseDay(payload, localDayId, idempotencyKey);
  }

  // ---------------------------------------------------------------------------
  // §13. LOCAL PRODUCT SEARCH
  // ---------------------------------------------------------------------------

  /**
   * Searches the local product catalogue — fully offline.
   * Supports search by name substring, SKU prefix, or exact barcode.
   *
   * @param query  - Search string (name, SKU, or barcode).
   * @param limit  - Maximum results to return (default: 20).
   */
  async searchProducts(
    query: string,
    limit = 20
  ): Promise<import("./offlineDb.js").LocalProduct[]> {
    const db = getOfflineDb();
    const trimmed = query.trim().toLowerCase();

    if (!trimmed) {
      return db.products
        .where("[tenantId+isActive]")
        .equals([this.config.tenantId, 1])
        .limit(limit)
        .toArray();
    }

    // Barcode exact match — highest priority
    const byBarcode = await db.products
      .where("barcode")
      .equalsIgnoreCase(trimmed)
      .and((p: any) => p.tenantId === this.config.tenantId && p.isActive)
      .limit(1)
      .toArray();

    if (byBarcode.length > 0) return byBarcode;

    // SKU prefix match
    const bySku = await db.products
      .where("sku")
      .startsWithIgnoreCase(trimmed)
      .and((p: any) => p.tenantId === this.config.tenantId && p.isActive)
      .limit(limit)
      .toArray();

    // Name substring match (Dexie doesn't support full-text — filter in JS)
    const byName = await db.products
      .where("[tenantId+isActive]")
      .equals([this.config.tenantId, 1])
      .filter((p: any) => p.name.toLowerCase().includes(trimmed))
      .limit(limit)
      .toArray();

    // Deduplicate by id
    const seen = new Set<string>();
    const combined: import("./offlineDb.js").LocalProduct[] = [];
    for (const p of [...bySku, ...byName]) {
      if (!seen.has(p.id)) {
        seen.add(p.id);
        combined.push(p);
      }
    }
    return combined.slice(0, limit);
  }

  // ---------------------------------------------------------------------------
  // §14. CURRENCY RATE READER (offline)
  // ---------------------------------------------------------------------------

  /**
   * Gets today's ZiG/USD rate from IndexedDB (no network required).
   *
   * @throws Error if no rate is available locally for today.
   */
  async getLocalRateForToday(): Promise<number> {
    const db = getOfflineDb();
    const today = new Date().toISOString().split("T")[0];
    const record = await db.currencyRates.get(
      `${this.config.tenantId}:${today}:USD:ZIG`
    );
    if (!record) {
      throw new Error(
        `No local ZiG/USD exchange rate for ${today}. ` +
          `Connect to the server to pull today's rate.`
      );
    }
    return record.rate;
  }

  // ---------------------------------------------------------------------------
  // §15. PRIVATE HELPERS
  // ---------------------------------------------------------------------------

  private async enqueue(params: {
    operationType: string;
    entityType: string;
    entityId: string;
    priority: number;
    payload: object;
    idempotencyKey: string;
  }): Promise<void> {
    const db = getOfflineDb();
    const now = Date.now();

    const existing = await db.syncQueue
      .where("idempotencyKey")
      .equals(params.idempotencyKey)
      .first();

    if (existing) {
      // Already queued — reset if previously failed
      if (existing.status === "FAILED" || existing.status === "SUCCEEDED") {
        await db.syncQueue.update(existing.id, {
          status: "PENDING",
          attemptCount: 0,
          nextRetryAt: now,
          updatedAt: now,
        });
      }
      return;
    }

    const entry: LocalSyncQueueEntry = {
      id: randomUUID(),
      idempotencyKey: params.idempotencyKey,
      tenantId: this.config.tenantId,
      deviceId: this.config.deviceId,
      deviceDbId: this.config.deviceDbId,
      operationType: params.operationType,
      entityType: params.entityType,
      entityId: params.entityId,
      priority: params.priority,
      status: "PENDING",
      payloadJson: JSON.stringify(params.payload),
      attemptCount: 0,
      maxAttempts: 10,
      nextRetryAt: now,
      createdAt: now,
      updatedAt: now,
    };

    await db.syncQueue.add(entry);

    this.emit("queue:enqueued", {
      entityId: params.entityId,
      operationType: params.operationType,
      queueDepth: await this.getPendingCount(),
    });

    // If online, trigger an immediate poll cycle
    if (this.isOnline) {
      this.scheduleNextPoll(500);
    }
  }

  private async apiPost<T>(path: string, body: object): Promise<T> {
    const url = `${this.config.apiBaseUrl}${path}`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...this.buildAuthHeaders(),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      const errorBody = await response.json().catch(() => ({})) as {
        errorCode?: string;
        errorMessage?: string;
        message?: string;
      };
      const code = errorBody.errorCode ?? `HTTP_${response.status}`;
      const msg =
        errorBody.errorMessage ??
        errorBody.message ??
        `HTTP ${response.status}`;

      // 4xx non-duplicate errors are permanent failures — don't retry
      const isPermanent =
        response.status >= 400 &&
        response.status < 500 &&
        response.status !== 409 &&
        code !== "ERR_010";

      throw new SyncDispatchError(msg, code, isPermanent);
    }

    return response.json() as Promise<T>;
  }

  private buildAuthHeaders(): Record<string, string> {
    // In a real app, retrieve the session token from secure storage
    const token =
      typeof window !== "undefined"
        ? window.sessionStorage.getItem("pos_auth_token") ?? ""
        : "";
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  private async getPendingCount(): Promise<number> {
    const db = getOfflineDb();
    return db.syncQueue
      .where("status")
      .anyOf(["PENDING", "RETRYING", "IN_FLIGHT"])
      .count();
  }

  private readonly handleOnline = async (): Promise<void> => {
    const verified = await this.checkConnectivity();
    if (verified && !this.isOnline) {
      this.isOnline = true;
      this.emit("online");
      this.scheduleNextPoll(500); // Start processing immediately
    }
  };

  private readonly handleOffline = (): void => {
    this.isOnline = false;
    this.emit("offline");
  };
}

// ---------------------------------------------------------------------------
// §16. EXPONENTIAL BACKOFF
// ---------------------------------------------------------------------------

const BACKOFF_BASE_MS = 5_000;
const BACKOFF_MAX_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Computes the next retry timestamp with exponential backoff + ±20% jitter.
 *
 * @param attemptCount - Number of attempts already made (1-based).
 * @returns Unix ms timestamp for next retry.
 */
export function computeNextRetry(attemptCount: number): number {
  const base = BACKOFF_BASE_MS * Math.pow(2, attemptCount - 1);
  const capped = Math.min(base, BACKOFF_MAX_MS);
  const jitter = capped * 0.2 * (Math.random() * 2 - 1); // ±20%
  return Date.now() + Math.round(capped + jitter);
}

// ---------------------------------------------------------------------------
// §17. CUSTOM ERRORS
// ---------------------------------------------------------------------------

export class SyncDispatchError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    /** If true, the entry is moved to FAILED without further retries. */
    public readonly isPermanent: boolean = false
  ) {
    super(message);
    this.name = "SyncDispatchError";
  }
}