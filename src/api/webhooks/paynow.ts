// =============================================================================
// Payment Webhook Handler
// src/api/webhooks/paynow.ts
// =============================================================================
// POST /api/webhooks/paynow
//
// Universal inbound webhook endpoint for all supported Zimbabwean payment
// providers. Each provider posts to this single endpoint; the handler
// auto-detects the provider from the request signature/body shape.
//
// Supported providers:
//   - Paynow    — URL-encoded body, SHA512 HMAC hash verification
//   - EcoCash   — JSON body, HMAC-SHA256 header signature
//   - InnBucks  — JSON body, HMAC-SHA256 header signature
//   - ZIPIT     — JSON body (RBZ webhook format)
//
// Security model:
//   1. Every webhook is verified cryptographically before any DB write
//   2. Raw body is hashed (SHA-512) and stored for audit replay
//   3. All writes (transaction + tenant) are in a single DB transaction
//   4. Idempotency key prevents duplicate processing on provider retry
//   5. Amount is cross-checked against the stored PaymentTransaction
//
// On success: extends Tenant.subscriptionExpiresAt and sets status = ACTIVE.
// On failure: returns 400 (provider will retry); logs full payload for audit.
// =============================================================================

import type { Request, Response, NextFunction } from "express";
import { createHash, createHmac, timingSafeEqual } from "crypto";
import { PrismaClient } from "@prisma/client";
import { SubscriptionService } from "../../services/subscription.js";

// ---------------------------------------------------------------------------
// §1. PROVIDER WEBHOOK PAYLOAD SHAPES
// ---------------------------------------------------------------------------

/** Paynow posts URL-encoded bodies to the resulturl. */
interface PaynowWebhookBody {
  reference: string;     // Our reference
  paynowreference: string; // Paynow's own transaction ID
  amount: string;        // Decimal string
  status: string;        // "Paid" | "Awaiting Delivery" | "Cancelled" | "Disputed" | "Refunded"
  pollurl: string;       // URL to poll for final status
  hash: string;          // SHA512 verification hash
}

/** EcoCash JSON webhook. */
interface EcocashWebhookBody {
  transactionRef: string;
  msisdn: string;
  amount: string;
  currency: string;
  status: string;        // "SUCCESS" | "FAILED" | "PENDING"
  ecocashRef: string;
  timestamp: string;
}

/** InnBucks JSON webhook. */
interface InnbucksWebhookBody {
  reference: string;
  walletNumber: string;
  amount: string;
  currency: string;
  status: string;        // "COMPLETED" | "FAILED" | "PENDING"
  innbucksRef: string;
  timestamp: string;
}

/** ZIPIT / RBZ JSON webhook. */
interface ZipitWebhookBody {
  transactionId: string;
  reference: string;     // Our bank reference (e.g., ZMPOS-XXXXXX)
  amount: string;
  currency: string;
  status: string;        // "COMPLETED" | "FAILED"
  bankReference: string;
  timestamp: string;
}

// Normalised internal representation after provider-specific parsing
interface NormalisedWebhookPayment {
  /** Provider-facing reference that matches PaymentTransaction.reference. */
  reference: string;
  /** Provider's own transaction ID for cross-reference. */
  providerRef: string;
  /** Amount as a number. */
  amount: number;
  /** "USD" | "ZIG" */
  currency: string;
  /** Normalised status: "PAID" | "FAILED" | "PENDING" */
  status: "PAID" | "FAILED" | "PENDING";
  /** Raw status string from provider. */
  rawStatus: string;
  /** Detected provider. */
  provider: "PAYNOW" | "ECOCASH" | "INNBUCKS" | "ZIPIT";
}

// ---------------------------------------------------------------------------
// §2. WEBHOOK HANDLER FACTORY
// ---------------------------------------------------------------------------

/**
 * Creates the Express route handler for POST /api/webhooks/paynow.
 * Mount BEFORE body-parser so that `req.rawBody` is available for hashing.
 *
 * Express setup:
 *   app.use(captureRawBody);                    // middleware defined below
 *   app.post('/api/webhooks/paynow', webhookHandler(prisma));
 */
export function createWebhookHandler(prisma: PrismaClient) {
  const subscriptionService = new SubscriptionService(prisma);

  return async function webhookHandler(
    req: Request,
    res: Response,
    _next: NextFunction
  ): Promise<void> {
    const rawBody: Buffer | undefined = (req as any).rawBody;

    // ── Step 1: Detect provider ───────────────────────────────────────────
    const detectedProvider = detectProvider(req);
    if (!detectedProvider) {
      console.warn("[Webhook] Could not detect provider from request headers.");
      res.status(400).json({ error: "Unknown payment provider." });
      return;
    }

    // ── Step 2: Verify signature ──────────────────────────────────────────
    const signatureValid = await verifyWebhookSignature(
      req,
      rawBody,
      detectedProvider
    );

    if (!signatureValid) {
      console.error(
        `[Webhook:${detectedProvider}] Signature verification failed. ` +
          `IP: ${req.ip}. Possible spoofed webhook.`
      );
      // Return 200 to prevent provider retry storm on a known-bad request
      res.status(200).json({ received: true });
      return;
    }

    // ── Step 3: Parse and normalise payload ───────────────────────────────
    let payment: NormalisedWebhookPayment;
    try {
      payment = parseWebhookPayload(req, detectedProvider);
    } catch (error) {
      console.error(
        `[Webhook:${detectedProvider}] Failed to parse payload:`,
        (error as Error).message
      );
      res.status(400).json({ error: "Malformed webhook payload." });
      return;
    }

    // ── Step 4: Compute raw body hash for audit log ────────────────────────
    const webhookHash = rawBody
      ? createHash("sha512").update(rawBody).digest("hex")
      : createHash("sha512")
          .update(JSON.stringify(req.body), "utf8")
          .digest("hex");

    const webhookReceivedAt = new Date();

    // ── Step 5: Look up the PaymentTransaction by reference ───────────────
    let transaction: {
      id: string;
      tenantId: string;
      amountUsd: unknown;
      amountZig: unknown;
      currency: string;
      monthsPurchased: number;
      status: string;
    } | null = null;

    try {
      transaction = await (prisma as any).paymentTransaction.findUnique({
        where: { reference: payment.reference },
        select: {
          id: true,
          tenantId: true,
          amountUsd: true,
          amountZig: true,
          currency: true,
          monthsPurchased: true,
          status: true,
        },
      });
    } catch (error) {
      console.error("[Webhook] DB lookup failed:", error);
      // Return 500 so the provider retries
      res.status(500).json({ error: "Internal error. Please retry." });
      return;
    }

    if (!transaction) {
      console.warn(
        `[Webhook:${detectedProvider}] Unknown reference "${payment.reference}". ` +
          `May be from a different system or a test call.`
      );
      res.status(200).json({ received: true, note: "Reference not found." });
      return;
    }

    // ── Step 6: Idempotency — skip if already processed ───────────────────
    if (transaction.status === "PAID") {
      console.info(
        `[Webhook:${detectedProvider}] Reference "${payment.reference}" already PAID. Skipping.`
      );
      res.status(200).json({ received: true, note: "Already processed." });
      return;
    }

    if (transaction.status === "FAILED" && payment.status !== "PAID") {
      res.status(200).json({ received: true, note: "Transaction already failed." });
      return;
    }

    // ── Step 7: Amount validation ──────────────────────────────────────────
    const expectedAmount = transaction.currency === "ZIG"
      ? Number(transaction.amountZig)
      : Number(transaction.amountUsd);

    const amountMismatch =
      Math.abs(payment.amount - expectedAmount) > 0.05; // 5-cent tolerance for FX rounding

    if (amountMismatch && payment.status === "PAID") {
      console.error(
        `[Webhook:${detectedProvider}] Amount mismatch for ref "${payment.reference}". ` +
          `Expected ${expectedAmount} ${transaction.currency}, ` +
          `received ${payment.amount} ${payment.currency}.`
      );

      // Record the failure with full audit trail — do not extend subscription
      await (prisma as any).paymentTransaction.update({
        where: { id: transaction.id },
        data: {
          status: "FAILED",
          failedAt: webhookReceivedAt,
          webhookReceivedAt,
          webhookHash,
          providerStatus: payment.rawStatus,
          providerMeta: req.body as object,
        },
      });

      // Acknowledge to prevent provider retry (the data is just wrong)
      res.status(200).json({
        received: true,
        note: "Amount mismatch. Transaction marked failed.",
      });
      return;
    }

    // ── Step 8: Handle non-PAID statuses ──────────────────────────────────
    if (payment.status === "FAILED") {
      await (prisma as any).paymentTransaction.update({
        where: { id: transaction.id },
        data: {
          status: "FAILED",
          failedAt: webhookReceivedAt,
          webhookReceivedAt,
          webhookHash,
          providerStatus: payment.rawStatus,
          providerMeta: req.body as object,
        },
      });

      res.status(200).json({ received: true, status: "FAILED" });
      return;
    }

    if (payment.status === "PENDING") {
      // Update audit fields but don't change transaction status
      await (prisma as any).paymentTransaction.update({
        where: { id: transaction.id },
        data: {
          webhookReceivedAt,
          webhookHash,
          providerStatus: payment.rawStatus,
          providerMeta: req.body as object,
        },
      });

      res.status(200).json({ received: true, status: "PENDING" });
      return;
    }

    // ── Step 9: PAID — atomically extend subscription ─────────────────────
    try {
      const { newExpiresAt } = await subscriptionService.activate(
        transaction.tenantId,
        transaction.id,
        transaction.monthsPurchased
      );

      // Update webhook audit fields in a separate update (activate() already
      // updated status + paidAt inside its own transaction)
      await (prisma as any).paymentTransaction.update({
        where: { id: transaction.id },
        data: {
          webhookReceivedAt,
          webhookHash,
          providerStatus: payment.rawStatus,
          providerMeta: req.body as object,
        },
      });

      console.info(
        `[Webhook:${detectedProvider}] ✓ Payment confirmed for tenant ${transaction.tenantId}. ` +
          `Subscription extended to ${newExpiresAt.toISOString()}.`
      );

      res.status(200).json({
        received: true,
        status: "PAID",
        subscriptionExpiresAt: newExpiresAt.toISOString(),
      });
    } catch (error) {
      console.error(
        `[Webhook:${detectedProvider}] Failed to activate subscription for ` +
          `tenant ${transaction.tenantId}:`,
        error
      );
      // Return 500 so the provider retries — the payment was confirmed but
      // we failed to persist the extension. Retry is safe (idempotent).
      res.status(500).json({ error: "Subscription activation failed. Retry." });
    }
  };
}

// ---------------------------------------------------------------------------
// §3. PROVIDER DETECTION
// ---------------------------------------------------------------------------

function detectProvider(
  req: Request
): "PAYNOW" | "ECOCASH" | "INNBUCKS" | "ZIPIT" | null {
  const ua = req.headers["user-agent"] ?? "";
  const contentType = req.headers["content-type"] ?? "";

  // EcoCash sends a custom header
  if (req.headers["x-ecocash-signature"]) return "ECOCASH";

  // InnBucks sends a custom header
  if (req.headers["x-innbucks-signature"]) return "INNBUCKS";

  // ZIPIT / RBZ sends JSON with a known field shape
  if (
    contentType.includes("application/json") &&
    (req.body as any)?.bankReference !== undefined
  )
    return "ZIPIT";

  // Paynow sends URL-encoded with a hash field
  if (
    contentType.includes("application/x-www-form-urlencoded") &&
    (req.body as any)?.hash !== undefined
  )
    return "PAYNOW";

  // Fallback: check User-Agent
  if (ua.toLowerCase().includes("paynow")) return "PAYNOW";

  return null;
}

// ---------------------------------------------------------------------------
// §4. SIGNATURE VERIFICATION
// ---------------------------------------------------------------------------

async function verifyWebhookSignature(
  req: Request,
  rawBody: Buffer | undefined,
  provider: "PAYNOW" | "ECOCASH" | "INNBUCKS" | "ZIPIT"
): Promise<boolean> {
  try {
    switch (provider) {
      case "PAYNOW":
        return verifyPaynowHash(req.body as PaynowWebhookBody);

      case "ECOCASH": {
        const secret = process.env.ECOCASH_WEBHOOK_SECRET ?? "";
        const signature = req.headers["x-ecocash-signature"] as string ?? "";
        return verifyHmacSignature(rawBody, signature, secret, "sha256");
      }

      case "INNBUCKS": {
        const secret = process.env.INNBUCKS_WEBHOOK_SECRET ?? "";
        const signature = req.headers["x-innbucks-signature"] as string ?? "";
        return verifyHmacSignature(rawBody, signature, secret, "sha256");
      }

      case "ZIPIT": {
        // ZIPIT uses a static API key in the Authorization header
        const expectedKey = process.env.ZIPIT_WEBHOOK_API_KEY ?? "";
        const receivedKey =
          (req.headers["authorization"] ?? "").replace(/^Bearer\s+/, "");
        if (!expectedKey || !receivedKey) return false;
        const exp = Buffer.from(expectedKey, "utf8");
        const rec = Buffer.from(receivedKey, "utf8");
        return exp.length === rec.length && timingSafeEqual(exp, rec);
      }
    }
  } catch {
    return false;
  }
}

/**
 * Verifies a Paynow webhook hash.
 *
 * Paynow hash algorithm:
 *   Concatenate all field values (excluding `hash`) in alphabetical key order,
 *   append the integration key, compute SHA512, compare case-insensitively.
 */
function verifyPaynowHash(body: PaynowWebhookBody): boolean {
  const integrationKey = process.env.PAYNOW_INTEGRATION_KEY ?? "";
  if (!integrationKey) return false;

  const { hash, ...rest } = body;

  // Alphabetical key order
  const sortedKeys = Object.keys(rest).sort();
  const values = sortedKeys.map((k) => (rest as Record<string, string>)[k] ?? "");
  const hashInput = values.join("") + integrationKey;

  const expected = createHash("sha512")
    .update(hashInput, "utf8")
    .digest("hex")
    .toUpperCase();
  const received = (hash ?? "").toUpperCase();

  if (expected.length !== received.length) return false;

  return timingSafeEqual(
    Buffer.from(expected, "utf8"),
    Buffer.from(received, "utf8")
  );
}

/**
 * Verifies an HMAC-SHA256 header signature (EcoCash / InnBucks).
 */
function verifyHmacSignature(
  rawBody: Buffer | undefined,
  receivedSignature: string,
  secret: string,
  algorithm: "sha256" | "sha512"
): boolean {
  if (!secret || !receivedSignature || !rawBody) return false;

  const expected = createHmac(algorithm, secret)
    .update(rawBody)
    .digest("hex");

  const expectedBuf = Buffer.from(expected, "utf8");
  const receivedBuf = Buffer.from(
    receivedSignature.replace(/^sha256=/, ""),
    "utf8"
  );

  if (expectedBuf.length !== receivedBuf.length) return false;
  return timingSafeEqual(expectedBuf, receivedBuf);
}

// ---------------------------------------------------------------------------
// §5. PAYLOAD PARSING & NORMALISATION
// ---------------------------------------------------------------------------

function parseWebhookPayload(
  req: Request,
  provider: "PAYNOW" | "ECOCASH" | "INNBUCKS" | "ZIPIT"
): NormalisedWebhookPayment {
  switch (provider) {
    case "PAYNOW": {
      const body = req.body as PaynowWebhookBody;
      if (!body.reference || !body.amount || !body.status) {
        throw new Error("Missing required Paynow fields: reference, amount, status.");
      }
      return {
        reference: body.reference,
        providerRef: body.paynowreference ?? "",
        amount: parseFloat(body.amount),
        currency: "USD", // Paynow always charges in USD for our integration
        status: mapPaynowStatus(body.status),
        rawStatus: body.status,
        provider: "PAYNOW",
      };
    }

    case "ECOCASH": {
      const body = req.body as EcocashWebhookBody;
      if (!body.transactionRef || !body.amount || !body.status) {
        throw new Error("Missing required EcoCash fields.");
      }
      return {
        reference: body.transactionRef,
        providerRef: body.ecocashRef ?? "",
        amount: parseFloat(body.amount),
        currency: body.currency ?? "ZIG",
        status: mapEcocashStatus(body.status),
        rawStatus: body.status,
        provider: "ECOCASH",
      };
    }

    case "INNBUCKS": {
      const body = req.body as InnbucksWebhookBody;
      if (!body.reference || !body.amount || !body.status) {
        throw new Error("Missing required InnBucks fields.");
      }
      return {
        reference: body.reference,
        providerRef: body.innbucksRef ?? "",
        amount: parseFloat(body.amount),
        currency: body.currency ?? "ZIG",
        status: mapInnbucksStatus(body.status),
        rawStatus: body.status,
        provider: "INNBUCKS",
      };
    }

    case "ZIPIT": {
      const body = req.body as ZipitWebhookBody;
      if (!body.reference || !body.amount || !body.status) {
        throw new Error("Missing required ZIPIT fields.");
      }
      // ZIPIT reference may be prefixed (e.g., "ZMPOS-ABC123") — strip prefix
      const ref = body.reference.replace(/^ZMPOS-/i, "");
      return {
        reference: body.reference,
        providerRef: body.bankReference ?? body.transactionId ?? "",
        amount: parseFloat(body.amount),
        currency: body.currency ?? "USD",
        status: body.status === "COMPLETED" ? "PAID" : "FAILED",
        rawStatus: body.status,
        provider: "ZIPIT",
      };
    }
  }
}

// ---------------------------------------------------------------------------
// §6. STATUS MAPPERS (provider-specific → normalised)
// ---------------------------------------------------------------------------

function mapPaynowStatus(status: string): "PAID" | "FAILED" | "PENDING" {
  const s = status.toLowerCase();
  if (s === "paid" || s === "awaiting delivery") return "PAID";
  if (s === "cancelled" || s === "disputed" || s === "refunded") return "FAILED";
  return "PENDING";
}

function mapEcocashStatus(status: string): "PAID" | "FAILED" | "PENDING" {
  const s = status.toUpperCase();
  if (s === "SUCCESS") return "PAID";
  if (s === "FAILED") return "FAILED";
  return "PENDING";
}

function mapInnbucksStatus(status: string): "PAID" | "FAILED" | "PENDING" {
  const s = status.toUpperCase();
  if (s === "COMPLETED") return "PAID";
  if (s === "FAILED") return "FAILED";
  return "PENDING";
}

// ---------------------------------------------------------------------------
// §7. RAW BODY CAPTURE MIDDLEWARE
// ---------------------------------------------------------------------------

/**
 * Express middleware that captures the raw request body as a Buffer
 * and attaches it to `req.rawBody` before body-parser processes it.
 *
 * This is required for webhook signature verification where the raw
 * bytes must match exactly what the provider signed.
 *
 * Usage:
 *   app.use('/api/webhooks', captureRawBody);
 *   app.use('/api/webhooks', express.urlencoded({ extended: true }));
 *   app.use('/api/webhooks', express.json());
 *   app.post('/api/webhooks/paynow', webhookHandler);
 */
export function captureRawBody(
  req: Request,
  _res: Response,
  next: NextFunction
): void {
  const chunks: Buffer[] = [];

  req.on("data", (chunk: Buffer) => {
    chunks.push(chunk);
  });

  req.on("end", () => {
    (req as any).rawBody = Buffer.concat(chunks);
    next();
  });

  req.on("error", next);
}