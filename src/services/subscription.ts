// =============================================================================
// Subscription Core Engine
// src/services/subscription.ts
// =============================================================================
// Responsibilities:
//   1. evaluateState()              — Determine OK / WARNING / LOCKED from expiry date
//   2. generateOfflineLicenseKey()  — HMAC-SHA256 signed key for offline payment proof
//   3. verifyOfflineLicenseKey()    — Cryptographic verification + replay-attack guard
//   4. SubscriptionService class    — Full DB-backed lifecycle: activate, extend, lock check
//   5. applyOfflineLicenseKey()     — Consume a license key and extend the subscription
//   6. Middleware helper             — Express/Fastify guard for locked tenants
// =============================================================================
// Dependencies: Node.js built-in `crypto` only. Zero third-party libs.
// =============================================================================

import {
  createHmac,
  createHash,
  timingSafeEqual,
  randomBytes,
} from "crypto";

import { PrismaClient, SubscriptionStatus } from "../../generated/prisma/index.js";

// ---------------------------------------------------------------------------
// §1. CONSTANTS
// ---------------------------------------------------------------------------

/** Subscription fee in USD — all payments must match this amount. */
export const MONTHLY_FEE_USD = 40.00;

/** Days before expiry at which status transitions from OK → WARNING. */
export const WARNING_DAYS = 10;

/** How long (in hours) an offline license key remains valid once issued.
 *  After this window the key can no longer be applied, even if unused.
 *  Prevents indefinite offline deferral — set to 72 hours (3 days). */
export const LICENSE_KEY_TTL_HOURS = 72;

/** HMAC algorithm — SHA-256 produces a 64-char hex digest. */
const HMAC_ALGORITHM = "sha256";

/** Delimiter between the HMAC signature and the timestamp payload. */
const KEY_DELIMITER = "-";

/** Key format: `ZMPOS-{HMAC_HEX}-{BASE64URL_PAYLOAD}` */
const KEY_PREFIX = "ZMPOS";

// ---------------------------------------------------------------------------
// §2. PURE STATE TYPES
// ---------------------------------------------------------------------------

export type SubscriptionStateCode = "OK" | "WARNING" | "LOCKED";

export interface SubscriptionStateOk {
  code: "OK";
  daysRemaining: number;
  expiresAt: Date;
}

export interface SubscriptionStateWarning {
  code: "WARNING";
  daysRemaining: number;
  expiresAt: Date;
  /** Friendly display string: e.g. "3 days" */
  daysRemainingLabel: string;
}

export interface SubscriptionStateLocked {
  code: "LOCKED";
  daysOverdue: number;
  expiresAt: Date;
  /** True if the expiry was very recent (<=24h) — use for softer messaging. */
  justExpired: boolean;
}

export type SubscriptionState =
  | SubscriptionStateOk
  | SubscriptionStateWarning
  | SubscriptionStateLocked;

// ---------------------------------------------------------------------------
// §3. STATE EVALUATION (pure function — no DB required)
// ---------------------------------------------------------------------------

/**
 * Evaluates the subscription state purely from the expiry date.
 *
 * State machine:
 *   daysRemaining > WARNING_DAYS  →  OK
 *   0 < daysRemaining <= WARNING_DAYS  →  WARNING
 *   daysRemaining <= 0  →  LOCKED
 *
 * Uses wall-clock days (floored), not exact milliseconds, so a subscription
 * that expires at 23:59 tonight is still "1 day remaining" all day today.
 *
 * @param subscriptionExpiresAt - The tenant's current expiry timestamp.
 * @param now                   - Optional reference time (defaults to Date.now()).
 *                                Inject in tests for deterministic behaviour.
 */
export function evaluateState(
  subscriptionExpiresAt: Date,
  now: Date = new Date()
): SubscriptionState {
  const msRemaining = subscriptionExpiresAt.getTime() - now.getTime();
  const daysRemaining = Math.floor(msRemaining / (1000 * 60 * 60 * 24));

  if (daysRemaining > WARNING_DAYS) {
    return {
      code: "OK",
      daysRemaining,
      expiresAt: subscriptionExpiresAt,
    };
  }

  if (daysRemaining > 0) {
    return {
      code: "WARNING",
      daysRemaining,
      expiresAt: subscriptionExpiresAt,
      daysRemainingLabel:
        daysRemaining === 1 ? "1 day" : `${daysRemaining} days`,
    };
  }

  // Expired
  const daysOverdue = Math.abs(daysRemaining);
  const justExpired = daysOverdue === 0; // Expired today

  return {
    code: "LOCKED",
    daysOverdue,
    expiresAt: subscriptionExpiresAt,
    justExpired,
  };
}

/**
 * Maps a `SubscriptionState` code to the Prisma `SubscriptionStatus` enum.
 * Used when persisting the evaluated state to the database.
 */
export function stateToDbStatus(
  state: SubscriptionState
): SubscriptionStatus {
  switch (state.code) {
    case "OK":
      return SubscriptionStatus.ACTIVE;
    case "WARNING":
      return SubscriptionStatus.WARNING;
    case "LOCKED":
      return SubscriptionStatus.EXPIRED;
  }
}

// ---------------------------------------------------------------------------
// §4. OFFLINE LICENSE KEY — GENERATION
// ---------------------------------------------------------------------------

/**
 * Payload embedded in every offline license key.
 */
interface LicenseKeyPayload {
  /** Tenant UUID — binds the key to a specific business. */
  tenantId: string;
  /** Number of months this key extends the subscription. */
  months: number;
  /** Unix seconds timestamp of key generation. */
  issuedAt: number;
  /** Unix seconds timestamp after which this key is invalid (issuedAt + TTL). */
  expiresAt: number;
  /** Random nonce (hex) — prevents two keys with identical payloads from
   *  producing the same HMAC if the same second is used. */
  nonce: string;
}

/**
 * Generates an offline license key that a super-admin can hand to a merchant
 * when internet is unavailable for payment processing.
 *
 * The key is a self-contained, cryptographically signed token that:
 *   - Binds to a specific `tenantId` (cannot be transferred)
 *   - Encodes the number of months purchased
 *   - Has a 72-hour validity window (prevents indefinite hoarding)
 *   - Cannot be forged without the `secretKey` (stored in Tenant.licenseSecretKey)
 *   - Includes a random nonce to prevent identical keys on rapid re-generation
 *
 * Key format:
 *   `ZMPOS-{HMAC_HEX_64}-{BASE64URL_PAYLOAD_JSON}`
 *
 * @param tenantId  - UUID of the tenant this key is issued for.
 * @param secretKey - Tenant's `licenseSecretKey` from the database (min 32 chars).
 * @param months    - Number of months to extend (1–12).
 * @param now       - Injectable reference time for testability.
 * @returns Full license key string (safe to print on paper / send via SMS).
 */
export function generateOfflineLicenseKey(
  tenantId: string,
  secretKey: string,
  months: number,
  now: Date = new Date()
): string {
  validateSecretKey(secretKey);

  if (months < 1 || months > 12 || !Number.isInteger(months)) {
    throw new LicenseKeyError(
      `months must be an integer between 1 and 12. Received: ${months}`
    );
  }

  const issuedAt = Math.floor(now.getTime() / 1000);
  const expiresAt = issuedAt + LICENSE_KEY_TTL_HOURS * 3600;
  const nonce = randomBytes(8).toString("hex");

  const payload: LicenseKeyPayload = {
    tenantId,
    months,
    issuedAt,
    expiresAt,
    nonce,
  };

  const payloadJson = JSON.stringify(payload);
  const payloadB64 = Buffer.from(payloadJson, "utf8").toString("base64url");

  // HMAC over: "{tenantId}:{payloadB64}"
  // Including tenantId in the signed message prevents cross-tenant key reuse
  // even if an attacker swaps the tenantId inside the payload
  const hmacInput = `${tenantId}${KEY_DELIMITER}${payloadB64}`;
  const signature = createHmac(HMAC_ALGORITHM, secretKey)
    .update(hmacInput, "utf8")
    .digest("hex");

  return `${KEY_PREFIX}${KEY_DELIMITER}${signature}${KEY_DELIMITER}${payloadB64}`;
}

// ---------------------------------------------------------------------------
// §5. OFFLINE LICENSE KEY — VERIFICATION
// ---------------------------------------------------------------------------

/**
 * Result of a successful license key verification.
 */
export interface LicenseKeyVerificationResult {
  /** True if the key is cryptographically valid and not expired. */
  isValid: true;
  tenantId: string;
  months: number;
  /** The new `subscriptionExpiresAt` if this key is applied to `currentExpiry`. */
  newExpiryDate: Date;
  issuedAt: Date;
  keyExpiresAt: Date;
}

export interface LicenseKeyVerificationFailure {
  isValid: false;
  reason:
    | "INVALID_FORMAT"
    | "SIGNATURE_MISMATCH"
    | "KEY_EXPIRED"
    | "TENANT_MISMATCH"
    | "INVALID_PAYLOAD";
  detail: string;
}

export type LicenseKeyVerificationOutcome =
  | LicenseKeyVerificationResult
  | LicenseKeyVerificationFailure;

/**
 * Cryptographically verifies an offline license key and computes the new
 * subscription expiry date if the key is applied.
 *
 * Verification steps:
 *   1. Parse and validate key format (3 segments separated by `-`)
 *   2. Decode the base64url payload — reject if malformed JSON
 *   3. Recompute HMAC and compare using `timingSafeEqual` (prevents timing attacks)
 *   4. Check the key's own TTL expiry (issuedAt + 72h)
 *   5. Verify tenantId in payload matches the `tenantId` argument
 *
 * Does NOT check the replay-attack log (OfflineLicenseKey table) — that is
 * the responsibility of `SubscriptionService.applyOfflineLicenseKey()`.
 *
 * @param tenantId       - UUID of the tenant attempting to apply the key.
 * @param secretKey      - Tenant's `licenseSecretKey` from the database.
 * @param providedKey    - The full key string entered by the merchant.
 * @param currentExpiry  - The tenant's current `subscriptionExpiresAt`.
 * @param now            - Injectable reference time for testability.
 */
export function verifyOfflineLicenseKey(
  tenantId: string,
  secretKey: string,
  providedKey: string,
  currentExpiry: Date,
  now: Date = new Date()
): LicenseKeyVerificationOutcome {
  validateSecretKey(secretKey);

  // ── Step 1: Parse key format ───────────────────────────────────────────
  // Format: ZMPOS-{signature_hex_64}-{payload_base64url}
  const parts = providedKey.trim().split(KEY_DELIMITER);

  // Minimum 3 parts: PREFIX, SIGNATURE, and PAYLOAD
  // Note: base64url may not contain "-" so this is safe
  if (parts.length < 3 || parts[0] !== KEY_PREFIX) {
    return {
      isValid: false,
      reason: "INVALID_FORMAT",
      detail:
        `Key must start with "${KEY_PREFIX}-" and contain a signature and payload segment.`,
    };
  }

  const [, signature, ...payloadParts] = parts;
  // Rejoin in case base64url had padding we stripped
  const payloadB64 = payloadParts.join(KEY_DELIMITER);

  if (!signature || !payloadB64) {
    return {
      isValid: false,
      reason: "INVALID_FORMAT",
      detail: "Key is missing the signature or payload segment.",
    };
  }

  // ── Step 2: Decode and parse payload ──────────────────────────────────
  let payload: LicenseKeyPayload;
  try {
    const payloadJson = Buffer.from(payloadB64, "base64url").toString("utf8");
    payload = JSON.parse(payloadJson) as LicenseKeyPayload;

    // Validate all required fields exist and are the right types
    if (
      typeof payload.tenantId !== "string" ||
      typeof payload.months !== "number" ||
      typeof payload.issuedAt !== "number" ||
      typeof payload.expiresAt !== "number" ||
      typeof payload.nonce !== "string"
    ) {
      throw new Error("Missing required payload fields.");
    }
  } catch {
    return {
      isValid: false,
      reason: "INVALID_PAYLOAD",
      detail: "Could not decode the key payload. The key may be corrupted.",
    };
  }

  // ── Step 3: HMAC verification (timing-safe) ────────────────────────────
  const hmacInput = `${tenantId}${KEY_DELIMITER}${payloadB64}`;
  const expectedSignature = createHmac(HMAC_ALGORITHM, secretKey)
    .update(hmacInput, "utf8")
    .digest("hex");

  // timingSafeEqual requires same-length Buffers
  const sigBuf = Buffer.from(signature, "hex");
  const expectedBuf = Buffer.from(expectedSignature, "hex");

  const signaturesMatch =
    sigBuf.length === expectedBuf.length &&
    timingSafeEqual(sigBuf, expectedBuf);

  if (!signaturesMatch) {
    return {
      isValid: false,
      reason: "SIGNATURE_MISMATCH",
      detail:
        "The key signature is invalid. The key may have been tampered with, " +
        "or was generated for a different system.",
    };
  }

  // ── Step 4: Check key TTL expiry ──────────────────────────────────────
  const keyExpiresAt = new Date(payload.expiresAt * 1000);
  if (now > keyExpiresAt) {
    const hoursOverdue = Math.ceil(
      (now.getTime() - keyExpiresAt.getTime()) / 3_600_000
    );
    return {
      isValid: false,
      reason: "KEY_EXPIRED",
      detail:
        `This license key expired ${hoursOverdue} hour(s) ago. ` +
        `Keys are valid for ${LICENSE_KEY_TTL_HOURS} hours after generation. ` +
        `Please obtain a new key from your service provider.`,
    };
  }

  // ── Step 5: Tenant binding check ──────────────────────────────────────
  if (payload.tenantId !== tenantId) {
    return {
      isValid: false,
      reason: "TENANT_MISMATCH",
      detail:
        `This license key was issued for a different business account. ` +
        `Keys cannot be transferred between accounts.`,
    };
  }

  // ── Compute new expiry ─────────────────────────────────────────────────
  // Base from the later of: current expiry OR now (prevents losing paid time)
  const baseDate = currentExpiry > now ? currentExpiry : now;
  const newExpiryDate = addMonths(baseDate, payload.months);

  return {
    isValid: true,
    tenantId: payload.tenantId,
    months: payload.months,
    newExpiryDate,
    issuedAt: new Date(payload.issuedAt * 1000),
    keyExpiresAt,
  };
}

// ---------------------------------------------------------------------------
// §6. SUBSCRIPTION SERVICE CLASS (DB-backed)
// ---------------------------------------------------------------------------

export class SubscriptionService {
  private readonly prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  // ── §6.1 Get current state ────────────────────────────────────────────────

  /**
   * Loads the tenant's subscription state from the database and evaluates it.
   * Also syncs the DB `subscriptionStatus` column if the evaluated state
   * differs from the stored value (e.g., after midnight when a WARNING
   * transitions to LOCKED without a webhook firing).
   *
   * @param tenantId - Tenant UUID.
   */
  async getState(tenantId: string): Promise<SubscriptionState> {
    const tenant = await this.prisma.tenant.findUniqueOrThrow({
      where: { id: tenantId },
      select: {
        subscriptionExpiresAt: true,
        subscriptionStatus: true,
        trialEndsAt: true,
      } as any,
    });

    // Handle trial period (no subscriptionExpiresAt set yet)
    const expiresAt =
      (tenant as any).subscriptionExpiresAt ??
      (tenant as any).trialEndsAt;

    if (!expiresAt) {
      // No expiry set — treat as expired to force subscription setup
      return {
        code: "LOCKED",
        daysOverdue: 0,
        expiresAt: new Date(0),
        justExpired: false,
      };
    }

    const state = evaluateState(expiresAt as Date);
    const dbStatus = stateToDbStatus(state);

    // Sync status column if drift detected (e.g., midnight transition)
    if ((tenant as any).subscriptionStatus !== dbStatus) {
      await this.prisma.tenant.update({
        where: { id: tenantId },
        data: { subscriptionStatus: dbStatus } as any,
      });
    }

    return state;
  }

  // ── §6.2 Activate subscription (first payment) ───────────────────────────

  /**
   * Activates a tenant's subscription for the first time, or reactivates
   * after expiry. Sets `subscriptionExpiresAt` to `months` months from now.
   *
   * Called from the payment webhook handler after confirming payment.
   *
   * @param tenantId        - Tenant UUID.
   * @param transactionId   - UUID of the confirmed `PaymentTransaction`.
   * @param months          - Number of months purchased (default: 1).
   */
  async activate(
    tenantId: string,
    transactionId: string,
    months = 1
  ): Promise<{ newExpiresAt: Date; status: SubscriptionStatus }> {
    return this.prisma.$transaction(async (tx: any) => {
      const tenant = await tx.tenant.findUniqueOrThrow({
        where: { id: tenantId },
        select: {
          subscriptionExpiresAt: true,
        } as any,
      });

      const currentExpiry = (tenant as any).subscriptionExpiresAt as Date | null;
      const now = new Date();
      const baseDate = currentExpiry && currentExpiry > now ? currentExpiry : now;
      const newExpiresAt = addMonths(baseDate, months);

      await tx.tenant.update({
        where: { id: tenantId },
        data: {
          subscriptionStatus: SubscriptionStatus.ACTIVE,
          subscriptionExpiresAt: newExpiresAt,
          lastPaymentAt: now,
        } as any,
      });

      await (tx as any).paymentTransaction.update({
        where: { id: transactionId },
        data: {
          status: "PAID",
          paidAt: now,
          expiryExtendedTo: newExpiresAt,
        },
      });

      return { newExpiresAt, status: SubscriptionStatus.ACTIVE };
    });
  }

  // ── §6.3 Apply offline license key ───────────────────────────────────────

  /**
   * Verifies and applies an offline license key, extending the subscription.
   *
   * Guards against replay attacks by:
   *   1. Hashing the key and checking against `OfflineLicenseKey.keyHash`
   *   2. Rejecting if `isConsumed = true`
   *   3. Atomically marking as consumed on successful application
   *
   * @param tenantId    - Tenant UUID.
   * @param providedKey - Full key string from the merchant.
   * @param appliedByUserId - UUID of the user applying the key.
   */
  async applyOfflineLicenseKey(
    tenantId: string,
    providedKey: string,
    appliedByUserId: string
  ): Promise<{
    applied: boolean;
    newExpiresAt?: Date;
    reason?: string;
  }> {
    // Load tenant secret key
    const tenant = await this.prisma.tenant.findUniqueOrThrow({
      where: { id: tenantId },
      select: {
        licenseSecretKey: true,
        subscriptionExpiresAt: true,
      } as any,
    });

    const secretKey = (tenant as any).licenseSecretKey as string;
    const currentExpiry =
      ((tenant as any).subscriptionExpiresAt as Date | null) ?? new Date(0);

    // Verify cryptographic signature and TTL
    const outcome = verifyOfflineLicenseKey(
      tenantId,
      secretKey,
      providedKey,
      currentExpiry
    );

    if (!outcome.isValid) {
      return { applied: false, reason: outcome.detail };
    }

    // Replay-attack guard — check if key has already been consumed
    const keyHash = createHash("sha256")
      .update(providedKey.trim(), "utf8")
      .digest("hex");

    return this.prisma.$transaction(async (tx: any) => {
      const existingKey = await (tx as any).offlineLicenseKey.findUnique({
        where: { keyHash },
        select: { isConsumed: true, consumedAt: true },
      });

      if (existingKey?.isConsumed) {
        return {
          applied: false,
          reason:
            `This license key has already been used on ` +
            `${(existingKey.consumedAt as Date).toDateString()}. ` +
            `Each key can only be applied once.`,
        };
      }

      const now = new Date();

      // Record the key consumption (upsert in case it wasn't pre-registered)
      await (tx as any).offlineLicenseKey.upsert({
        where: { keyHash },
        update: {
          isConsumed: true,
          consumedAt: now,
          consumedByUserId: appliedByUserId,
        },
        create: {
          tenantId,
          keyHash,
          monthsPurchased: outcome.months,
          issuedForDate: outcome.issuedAt,
          expiresAt: outcome.keyExpiresAt,
          isConsumed: true,
          consumedAt: now,
          consumedByUserId: appliedByUserId,
        },
      });

      // Extend subscription
      await tx.tenant.update({
        where: { id: tenantId },
        data: {
          subscriptionStatus: SubscriptionStatus.ACTIVE,
          subscriptionExpiresAt: outcome.newExpiryDate,
          lastPaymentAt: now,
        } as any,
      });

      return { applied: true, newExpiresAt: outcome.newExpiryDate };
    });
  }

  // ── §6.4 Bulk status refresh (cron job) ─────────────────────────────────

  /**
   * Scans all tenants and updates their `subscriptionStatus` based on current
   * expiry dates. Run via a daily cron job at midnight UTC.
   *
   * Returns counts of tenants transitioned into each state.
   */
  async refreshAllStatuses(): Promise<{
    nowActive: number;
    nowWarning: number;
    nowExpired: number;
    unchanged: number;
  }> {
    const tenants = await this.prisma.tenant.findMany({
      where: { isActive: true },
      select: {
        id: true,
        subscriptionExpiresAt: true,
        subscriptionStatus: true,
      } as any,
    });

    const now = new Date();
    let nowActive = 0;
    let nowWarning = 0;
    let nowExpired = 0;
    let unchanged = 0;

    const updates: Array<Promise<unknown>> = [];

    for (const t of tenants as any[]) {
      if (!t.subscriptionExpiresAt) continue;

      const state = evaluateState(t.subscriptionExpiresAt as Date, now);
      const newStatus = stateToDbStatus(state);

      if (newStatus === t.subscriptionStatus) {
        unchanged++;
        continue;
      }

      updates.push(
        this.prisma.tenant.update({
          where: { id: t.id },
          data: { subscriptionStatus: newStatus } as any,
        })
      );

      if (newStatus === SubscriptionStatus.ACTIVE) nowActive++;
      else if (newStatus === SubscriptionStatus.WARNING) nowWarning++;
      else if (newStatus === SubscriptionStatus.EXPIRED) nowExpired++;
    }

    await Promise.all(updates);
    return { nowActive, nowWarning, nowExpired, unchanged };
  }

  // ── §6.5 Generate offline key and log it ─────────────────────────────────

  /**
   * Generates an offline license key and records it in `OfflineLicenseKey`
   * so it can later be checked for replay. Call this from the super-admin panel.
   *
   * @param tenantId        - Tenant to generate the key for.
   * @param months          - Months to encode in the key.
   * @param issuedByUserId  - Super-admin UUID for audit.
   * @param notes           - Optional note (e.g., "Phone payment via M-Pesa").
   */
  async generateAndLogKey(
    tenantId: string,
    months: number,
    issuedByUserId: string,
    notes?: string
  ): Promise<{ key: string; expiresAt: Date }> {
    const tenant = await this.prisma.tenant.findUniqueOrThrow({
      where: { id: tenantId },
      select: { licenseSecretKey: true } as any,
    });

    const secretKey = (tenant as any).licenseSecretKey as string;
    const now = new Date();
    const key = generateOfflineLicenseKey(tenantId, secretKey, months, now);

    const keyHash = createHash("sha256")
      .update(key.trim(), "utf8")
      .digest("hex");

    const keyExpiresAt = new Date(
      now.getTime() + LICENSE_KEY_TTL_HOURS * 3_600_000
    );

    await (this.prisma as any).offlineLicenseKey.create({
      data: {
        tenantId,
        keyHash,
        monthsPurchased: months,
        issuedForDate: now,
        expiresAt: keyExpiresAt,
        isConsumed: false,
        issuedByUserId,
        notes: notes ?? null,
      },
    });

    return { key, expiresAt: keyExpiresAt };
  }

  // ── §6.6 Generate a fresh licenseSecretKey for a new tenant ─────────────

  /**
   * Generates a cryptographically random 64-character hex secret for a new
   * tenant's `licenseSecretKey`. Call during tenant onboarding.
   */
  static generateTenantSecretKey(): string {
    return randomBytes(32).toString("hex"); // 64 hex chars
  }
}

// ---------------------------------------------------------------------------
// §7. SUBSCRIPTION GUARD MIDDLEWARE (Express / Fastify compatible)
// ---------------------------------------------------------------------------

/**
 * Express-compatible middleware that blocks POS sales routes when
 * the tenant's subscription is LOCKED (expired).
 *
 * Usage (Express):
 *   app.use('/api/sales', subscriptionGuard(prisma), salesRouter);
 *
 * Usage (Fastify):
 *   fastify.addHook('preHandler', subscriptionGuard(prisma));
 *
 * The tenant ID is read from `req.user.tenantId` — ensure your auth
 * middleware populates this before the subscription guard runs.
 */
export function createSubscriptionGuard(prisma: PrismaClient) {
  const service = new SubscriptionService(prisma);

  return async function subscriptionGuard(
    req: any,
    res: any,
    next: () => void
  ): Promise<void> {
    const tenantId = req.user?.tenantId;

    if (!tenantId) {
      res.status(401).json({ error: "Unauthenticated request." });
      return;
    }

    try {
      const state = await service.getState(tenantId);

      if (state.code === "LOCKED") {
        res.status(402).json({
          error: "SUBSCRIPTION_EXPIRED",
          message:
            `Your subscription expired ${(state as SubscriptionStateLocked).daysOverdue} day(s) ago. ` +
            `POS sales are disabled. Please renew your subscription to continue.`,
          daysOverdue: (state as SubscriptionStateLocked).daysOverdue,
          expiresAt: state.expiresAt.toISOString(),
        });
        return;
      }

      // Attach state to request for downstream use (e.g., showing warning banner)
      (req as any).subscriptionState = state;
      next();
    } catch (error) {
      // DB failure — fail open to avoid bricking operational POS terminals
      console.error("[SubscriptionGuard] Failed to evaluate state:", error);
      next();
    }
  };
}

// ---------------------------------------------------------------------------
// §8. PRIVATE UTILITIES
// ---------------------------------------------------------------------------

/**
 * Adds `months` calendar months to a date, preserving day-of-month.
 * Handles month-end edge cases: Jan 31 + 1 month = Feb 28/29.
 */
function addMonths(date: Date, months: number): Date {
  const result = new Date(date);
  const day = result.getDate();
  result.setMonth(result.getMonth() + months);

  // If setMonth skipped to the next month (e.g., Jan 31 → Mar 2),
  // roll back to the last day of the intended month.
  if (result.getDate() !== day) {
    result.setDate(0); // 0 = last day of previous month
  }

  return result;
}

/**
 * Validates the tenant secret key meets minimum entropy requirements.
 */
function validateSecretKey(secretKey: string): void {
  if (!secretKey || secretKey.length < 32) {
    throw new LicenseKeyError(
      `Tenant secret key must be at least 32 characters. ` +
        `Generate one with SubscriptionService.generateTenantSecretKey().`
    );
  }
}

// ---------------------------------------------------------------------------
// §9. CUSTOM ERRORS
// ---------------------------------------------------------------------------

export class LicenseKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LicenseKeyError";
  }
}

export class SubscriptionLockedError extends Error {
  constructor(
    public readonly state: SubscriptionStateLocked
  ) {
    super(
      `Subscription expired ${state.daysOverdue} day(s) ago. POS is locked.`
    );
    this.name = "SubscriptionLockedError";
  }
}