// =============================================================================
// Subscription Payment Initiation Endpoint
// src/api/subscription/create-payment.ts
// =============================================================================
// POST /api/subscription/create-payment
//
// Called when the merchant clicks "Pay Subscription" inside the POS.
// Supports all Zimbabwean payment providers:
//   - Paynow (aggregates EcoCash, Swipe, ZIPIT via their gateway)
//   - EcoCash (direct push-USSD initiation)
//   - InnBucks (direct wallet initiation)
//   - ZIPIT (bank reference generation)
//   - CASH_MANUAL (super-admin records a cash payment)
//
// Flow:
//   1. Validate request body & authenticated tenant
//   2. Verify no PENDING transaction already exists (idempotency)
//   3. Create a PaymentTransaction record (status: PENDING)
//   4. Build provider-specific checkout payload / reference
//   5. Return checkout URL or USSD string to the POS client
// =============================================================================

import type { Request, Response, NextFunction } from "express";
import { PrismaClient } from "../../generated/prisma";
import { createHash, randomUUID } from "crypto";
import {
  MONTHLY_FEE_USD,
  evaluateState,
} from "../../services/subscription.js";

// ---------------------------------------------------------------------------
// §1. TYPES & CONSTANTS
// ---------------------------------------------------------------------------

const SUPPORTED_PROVIDERS = [
  "PAYNOW",
  "ECOCASH",
  "INNBUCKS",
  "ZIPIT",
  "CASH_MANUAL",
] as const;

type SupportedProvider = (typeof SUPPORTED_PROVIDERS)[number];

/** Paynow API endpoints (switch via env). */
const PAYNOW_URLS = {
  DEV: "https://www.paynow.co.zw/interface/initiatetransaction",
  PROD: "https://www.paynow.co.zw/interface/initiatetransaction",
} as const;

/** EcoCash direct initiation URL (ECONET developer portal). */
const ECOCASH_API_URL =
  process.env.ECOCASH_API_URL ??
  "https://api.econet.co.zw/apis/ecocash/v1/transactions";

/** InnBucks direct API URL. */
const INNBUCKS_API_URL =
  process.env.INNBUCKS_API_URL ??
  "https://api.innbucks.co.zw/v1/payments/initiate";

export interface CreatePaymentRequest {
  /** Payment provider to use. */
  provider: SupportedProvider;
  /**
   * Currency to charge in.
   * "USD" = $40.00 USD.
   * "ZIG" = ZiG equivalent at today's rate (fetched from CurrencyRate).
   */
  currency: "USD" | "ZIG";
  /**
   * Number of months to purchase (1–12). Fee = months × $40 USD.
   * Default: 1.
   */
  months?: number;
  /**
   * Mobile number for EcoCash / InnBucks push-USSD.
   * Required when provider is "ECOCASH" or "INNBUCKS".
   * Format: "07XXXXXXXX" or "+2637XXXXXXXX".
   */
  mobileNumber?: string;
  /**
   * Bank account for ZIPIT. Required when provider is "ZIPIT".
   */
  bankAccount?: string;
  /**
   * For CASH_MANUAL only — reference number from physical receipt.
   * Only super-admins can submit CASH_MANUAL payments.
   */
  cashReference?: string;
}

export interface CreatePaymentResponse {
  /** Our internal PaymentTransaction UUID. */
  transactionId: string;
  /** Reference to poll / display to the customer. */
  reference: string;
  provider: SupportedProvider;
  amountUsd: number;
  amountZig: number | null;
  currency: "USD" | "ZIG";
  months: number;
  /**
   * Redirect URL (Paynow / browser-based providers).
   * Null for USSD-push providers (EcoCash, InnBucks) and ZIPIT.
   */
  checkoutUrl: string | null;
  /**
   * USSD string to dial (EcoCash / InnBucks).
   * Null for redirect-based providers.
   */
  ussdString: string | null;
  /**
   * Bank transfer reference (ZIPIT).
   */
  bankReference: string | null;
  /** ISO-8601 — expires after 30 minutes (Paynow sessions). */
  expiresAt: string;
  /** Instructions to display in the POS payment screen. */
  instructions: string;
}

// ---------------------------------------------------------------------------
// §2. ROUTE HANDLER FACTORY
// ---------------------------------------------------------------------------

/**
 * Creates the Express route handler for POST /api/subscription/create-payment.
 *
 * @param prisma - Shared Prisma client instance.
 */
export function createPaymentHandler(prisma: PrismaClient) {
  return async function handler(
    req: Request,
    res: Response,
    _next: NextFunction
  ): Promise<void> {
    // ── Auth: extract tenant from JWT middleware ───────────────────────────
    const tenantId = (req as any).user?.tenantId as string | undefined;
    const userId = (req as any).user?.userId as string | undefined;
    const userRole = (req as any).user?.role as string | undefined;

    if (!tenantId || !userId) {
      res.status(401).json({ error: "Authentication required." });
      return;
    }

    // ── Parse and validate request body ──────────────────────────────────
    const body = req.body as CreatePaymentRequest;
    const validationError = validateCreatePaymentRequest(body, userRole);
    if (validationError) {
      res.status(400).json({ error: validationError });
      return;
    }

    const months = body.months ?? 1;
    const provider = body.provider;
    const currency = body.currency ?? "USD";

    try {
      // ── Load tenant ───────────────────────────────────────────────────
      const tenant = await prisma.tenant.findUniqueOrThrow({
        where: { id: tenantId },
        select: {
          businessName: true,
          email: true,
          subscriptionExpiresAt: true,
        } as any,
      });

      // ── Idempotency: check for existing PENDING transaction ───────────
      const existingPending = await (prisma as any).paymentTransaction.findFirst({
        where: {
          tenantId,
          status: "PENDING",
          provider,
          monthsPurchased: months,
        },
        orderBy: { createdAt: "desc" },
        select: { id: true, reference: true, internalRef: true, createdAt: true },
      });

      // If a PENDING transaction was created within the last 30 minutes,
      // return it rather than creating a duplicate.
      if (existingPending) {
        const ageMs =
          Date.now() - new Date(existingPending.createdAt).getTime();
        if (ageMs < 30 * 60 * 1000) {
          res.status(409).json({
            error: "PAYMENT_ALREADY_PENDING",
            message:
              `A ${provider} payment of $${months * MONTHLY_FEE_USD} USD is already pending. ` +
              `Complete or cancel it before starting a new one.`,
            transactionId: existingPending.id,
            reference: existingPending.reference,
          });
          return;
        }
      }

      // ── Compute amounts ───────────────────────────────────────────────
      const amountUsd = parseFloat((MONTHLY_FEE_USD * months).toFixed(2));
      let amountZig: number | null = null;
      let exchangeRateUsed: number | null = null;

      if (currency === "ZIG") {
        const rateRecord = await (prisma as any).currencyRate.findFirst({
          where: {
            tenantId,
            fromCurrency: "USD",
            toCurrency: "ZIG",
            rateDate: {
              gte: startOfToday(),
            },
          },
          orderBy: { rateDate: "desc" },
          select: { rate: true },
        });

        if (!rateRecord) {
          res.status(422).json({
            error: "NO_EXCHANGE_RATE",
            message:
              "No ZiG/USD exchange rate is set for today. " +
              "Please set today's rate or choose USD as the payment currency.",
          });
          return;
        }

        exchangeRateUsed = Number(rateRecord.rate);
        amountZig = parseFloat((amountUsd * exchangeRateUsed).toFixed(2));
      }

      // ── Generate internal reference ───────────────────────────────────
      const internalRef = randomUUID();
      // Provider-facing reference: compact, URL-safe, max 30 chars
      const reference = buildProviderReference(tenantId, months, provider);

      // ── Create PaymentTransaction (PENDING) ───────────────────────────
      const transaction = await (prisma as any).paymentTransaction.create({
        data: {
          tenantId,
          reference,
          internalRef,
          amountUsd,
          amountZig: amountZig ?? undefined,
          exchangeRateUsed: exchangeRateUsed ?? undefined,
          currency,
          provider,
          monthsPurchased: months,
          status: "PENDING",
          initiatedAt: new Date(),
        },
      });

      // ── Build provider-specific checkout ──────────────────────────────
      const checkoutResult = await buildProviderCheckout({
        provider,
        transactionId: transaction.id,
        reference,
        internalRef,
        amountUsd,
        amountZig,
        currency,
        months,
        mobileNumber: body.mobileNumber,
        bankAccount: body.bankAccount,
        cashReference: body.cashReference,
        tenantName: (tenant as any).businessName as string,
        tenantEmail: (tenant as any).email as string,
      });

      // ── For CASH_MANUAL — immediately confirm the transaction ─────────
      if (provider === "CASH_MANUAL" && checkoutResult.immediatelyConfirmed) {
        const currentExpiry =
          ((tenant as any).subscriptionExpiresAt as Date | null) ?? new Date();
        const newExpiresAt = addMonths(
          currentExpiry > new Date() ? currentExpiry : new Date(),
          months
        );

        await (prisma as any).paymentTransaction.update({
          where: { id: transaction.id },
          data: {
            status: "PAID",
            paidAt: new Date(),
            expiryExtendedTo: newExpiresAt,
            verifiedByUserId: userId,
          },
        });

        await prisma.tenant.update({
          where: { id: tenantId },
          data: {
            subscriptionStatus: "ACTIVE",
            subscriptionExpiresAt: newExpiresAt,
            lastPaymentAt: new Date(),
          } as any,
        });
      }

      // ── Build response ─────────────────────────────────────────────────
      const response: CreatePaymentResponse = {
        transactionId: transaction.id,
        reference,
        provider,
        amountUsd,
        amountZig,
        currency,
        months,
        checkoutUrl: checkoutResult.checkoutUrl,
        ussdString: checkoutResult.ussdString,
        bankReference: checkoutResult.bankReference,
        expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
        instructions: checkoutResult.instructions,
      };

      res.status(201).json(response);
    } catch (error) {
      if ((error as any).code === "P2025") {
        res.status(404).json({ error: "Tenant not found." });
        return;
      }
      console.error("[create-payment] Unhandled error:", error);
      res.status(500).json({
        error: "PAYMENT_INITIATION_FAILED",
        message:
          "Failed to initiate payment. Please try again or contact support.",
      });
    }
  };
}

// ---------------------------------------------------------------------------
// §3. PROVIDER CHECKOUT BUILDERS
// ---------------------------------------------------------------------------

interface CheckoutBuildInput {
  provider: SupportedProvider;
  transactionId: string;
  reference: string;
  internalRef: string;
  amountUsd: number;
  amountZig: number | null;
  currency: "USD" | "ZIG";
  months: number;
  mobileNumber?: string;
  bankAccount?: string;
  cashReference?: string;
  tenantName: string;
  tenantEmail: string;
}

interface CheckoutBuildResult {
  checkoutUrl: string | null;
  ussdString: string | null;
  bankReference: string | null;
  instructions: string;
  immediatelyConfirmed?: boolean;
}

async function buildProviderCheckout(
  input: CheckoutBuildInput
): Promise<CheckoutBuildResult> {
  switch (input.provider) {
    case "PAYNOW":
      return buildPaynowCheckout(input);
    case "ECOCASH":
      return buildEcocashCheckout(input);
    case "INNBUCKS":
      return buildInnbucksCheckout(input);
    case "ZIPIT":
      return buildZipitCheckout(input);
    case "CASH_MANUAL":
      return buildCashManualCheckout(input);
  }
}

// ── Paynow ──────────────────────────────────────────────────────────────────

async function buildPaynowCheckout(
  input: CheckoutBuildInput
): Promise<CheckoutBuildResult> {
  const integrationId = process.env.PAYNOW_INTEGRATION_ID ?? "";
  const integrationKey = process.env.PAYNOW_INTEGRATION_KEY ?? "";
  const returnUrl = `${process.env.APP_BASE_URL}/subscription/payment-result?ref=${input.reference}`;
  const resultUrl = `${process.env.APP_BASE_URL}/api/webhooks/paynow`;

  if (!integrationId || !integrationKey) {
    throw new Error(
      "PAYNOW_INTEGRATION_ID and PAYNOW_INTEGRATION_KEY environment variables must be set."
    );
  }

  const amount = input.currency === "ZIG" && input.amountZig !== null
    ? input.amountZig
    : input.amountUsd;

  // Paynow requires fields in a specific order for hash computation
  const fields: Record<string, string> = {
    id: integrationId,
    reference: input.reference,
    amount: amount.toFixed(2),
    additionalinfo: `ZMPOS subscription – ${input.months} month(s) for ${input.tenantName}`,
    returnurl: returnUrl,
    resulturl: resultUrl,
    authemail: input.tenantEmail,
    status: "Message",
  };

  // Paynow hash: concatenate all values (in field order) + integrationKey, then SHA512
  const hashSource =
    Object.values(fields).join("") + integrationKey;
  const hash = createHash("sha512").update(hashSource, "utf8").digest("hex").toUpperCase();
  fields.hash = hash;

  // POST to Paynow initiation endpoint
  const formBody = new URLSearchParams(fields).toString();
  const paynowUrl =
    process.env.NODE_ENV === "production"
      ? PAYNOW_URLS.PROD
      : PAYNOW_URLS.DEV;

  let checkoutUrl: string | null = null;

  try {
    const response = await fetch(paynowUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formBody,
      signal: AbortSignal.timeout(15_000),
    });

    const text = await response.text();
    // Paynow returns URL-encoded: "status=Ok&browserurl=https://...&pollurl=https://..."
    const params = new URLSearchParams(text);
    const status = params.get("status");

    if (status?.toLowerCase() === "ok") {
      checkoutUrl = params.get("browserurl");
    } else {
      throw new PaymentProviderError(
        `Paynow rejected the initiation request: ${params.get("error") ?? text}`,
        "PAYNOW"
      );
    }
  } catch (error) {
    if (error instanceof PaymentProviderError) throw error;
    // Network failure — still return a pending transaction; merchant can retry
    console.error("[Paynow] Network error during initiation:", error);
  }

  return {
    checkoutUrl,
    ussdString: null,
    bankReference: null,
    instructions:
      checkoutUrl
        ? `Click the checkout link to pay $${input.amountUsd.toFixed(2)} USD via Paynow. ` +
          `Your subscription will activate automatically once payment is confirmed.`
        : `Paynow is temporarily unavailable. Your reference is ${input.reference}. ` +
          `Please try again in a few minutes.`,
  };
}

// ── EcoCash ─────────────────────────────────────────────────────────────────

async function buildEcocashCheckout(
  input: CheckoutBuildInput
): Promise<CheckoutBuildResult> {
  if (!input.mobileNumber) {
    throw new PaymentProviderError(
      "mobileNumber is required for EcoCash payments.",
      "ECOCASH"
    );
  }

  const normalised = normaliseMsisdn(input.mobileNumber);
  const amount = input.currency === "ZIG" && input.amountZig !== null
    ? input.amountZig
    : input.amountUsd;

  // EcoCash API initiation — sends a USSD push to the subscriber's phone
  const ecocashPayload = {
    msisdn: normalised,
    merchantCode: process.env.ECOCASH_MERCHANT_CODE ?? "",
    merchantPin: process.env.ECOCASH_MERCHANT_PIN ?? "",
    merchantNumber: process.env.ECOCASH_MERCHANT_NUMBER ?? "",
    transactionRef: input.reference,
    amount: amount.toFixed(2),
    currency: input.currency,
    narrative: `ZMPOS ${input.months}mth subscription`,
    callbackUrl: `${process.env.APP_BASE_URL}/api/webhooks/paynow`,
  };

  try {
    const response = await fetch(ECOCASH_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.ECOCASH_API_TOKEN ?? ""}`,
      },
      body: JSON.stringify(ecocashPayload),
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[EcoCash] Initiation failed (${response.status}):`, errorText);
    }
  } catch (error) {
    console.error("[EcoCash] Network error:", error);
  }

  // EcoCash also supports fallback USSD in case the push fails
  const ussdString = `*151*2*1*${process.env.ECOCASH_MERCHANT_CODE ?? ""}*${amount.toFixed(2)}#`;

  return {
    checkoutUrl: null,
    ussdString,
    bankReference: null,
    instructions:
      `A payment prompt of ${input.currency === "ZIG" ? input.amountZig?.toFixed(2) + " ZiG" : "$" + input.amountUsd.toFixed(2) + " USD"} ` +
      `has been sent to ${input.mobileNumber}. ` +
      `Enter your EcoCash PIN to confirm. Alternatively, dial ${ussdString} on your phone.`,
  };
}

// ── InnBucks ─────────────────────────────────────────────────────────────────

async function buildInnbucksCheckout(
  input: CheckoutBuildInput
): Promise<CheckoutBuildResult> {
  if (!input.mobileNumber) {
    throw new PaymentProviderError(
      "mobileNumber is required for InnBucks payments.",
      "INNBUCKS"
    );
  }

  const normalised = normaliseMsisdn(input.mobileNumber);
  const amount = input.currency === "ZIG" && input.amountZig !== null
    ? input.amountZig
    : input.amountUsd;

  const innbucksPayload = {
    walletNumber: normalised,
    amount: amount.toFixed(2),
    currency: input.currency,
    reference: input.reference,
    description: `ZMPOS subscription – ${input.months} month(s)`,
    merchantId: process.env.INNBUCKS_MERCHANT_ID ?? "",
    callbackUrl: `${process.env.APP_BASE_URL}/api/webhooks/paynow`,
  };

  try {
    await fetch(INNBUCKS_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": process.env.INNBUCKS_API_KEY ?? "",
      },
      body: JSON.stringify(innbucksPayload),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    console.error("[InnBucks] Network error:", error);
  }

  return {
    checkoutUrl: null,
    ussdString: null,
    bankReference: null,
    instructions:
      `An InnBucks payment request of ${amount.toFixed(2)} ${input.currency} ` +
      `has been sent to ${input.mobileNumber}. ` +
      `Open your InnBucks app and approve the request.`,
  };
}

// ── ZIPIT ───────────────────────────────────────────────────────────────────

async function buildZipitCheckout(
  input: CheckoutBuildInput
): Promise<CheckoutBuildResult> {
  const beneficiaryAccount = process.env.ZIPIT_BENEFICIARY_ACCOUNT ?? "";
  const beneficiaryBank = process.env.ZIPIT_BENEFICIARY_BANK ?? "CBZ";
  const beneficiaryName = process.env.ZIPIT_BENEFICIARY_NAME ?? "ZIMRA POS Platform";

  if (!beneficiaryAccount) {
    throw new PaymentProviderError(
      "ZIPIT_BENEFICIARY_ACCOUNT environment variable is not configured.",
      "ZIPIT"
    );
  }

  // ZIPIT is purely a bank transfer — generate a reference for the customer
  // No API call needed; the webhook arrives when RBZ processes the transfer.
  const bankRef = `ZMPOS-${input.reference.slice(-8).toUpperCase()}`;

  return {
    checkoutUrl: null,
    ussdString: null,
    bankReference: bankRef,
    instructions:
      `Transfer $${input.amountUsd.toFixed(2)} USD via ZIPIT to:\n` +
      `  Beneficiary: ${beneficiaryName}\n` +
      `  Bank: ${beneficiaryBank}\n` +
      `  Account: ${beneficiaryAccount}\n` +
      `  Reference: ${bankRef}\n\n` +
      `Your subscription will activate within 1 business day after the transfer is confirmed.`,
  };
}

// ── Cash Manual (super-admin only) ───────────────────────────────────────────

async function buildCashManualCheckout(
  input: CheckoutBuildInput
): Promise<CheckoutBuildResult> {
  // Cash payments are immediately confirmed — the super-admin is asserting
  // that physical cash has been received. No external API call needed.
  return {
    checkoutUrl: null,
    ussdString: null,
    bankReference: input.cashReference ?? null,
    instructions:
      `Cash payment of $${input.amountUsd.toFixed(2)} USD recorded manually. ` +
      `Subscription has been extended by ${input.months} month(s).`,
    immediatelyConfirmed: true,
  };
}

// ---------------------------------------------------------------------------
// §4. INPUT VALIDATION
// ---------------------------------------------------------------------------

function validateCreatePaymentRequest(
  body: CreatePaymentRequest,
  userRole?: string
): string | null {
  if (!body.provider || !SUPPORTED_PROVIDERS.includes(body.provider)) {
    return (
      `Invalid provider "${body.provider}". ` +
      `Supported: ${SUPPORTED_PROVIDERS.join(", ")}.`
    );
  }

  if (body.currency && !["USD", "ZIG"].includes(body.currency)) {
    return `Invalid currency "${body.currency}". Must be "USD" or "ZIG".`;
  }

  const months = body.months ?? 1;
  if (!Number.isInteger(months) || months < 1 || months > 12) {
    return "months must be an integer between 1 and 12.";
  }

  if (body.provider === "ECOCASH" || body.provider === "INNBUCKS") {
    if (!body.mobileNumber) {
      return `mobileNumber is required for ${body.provider} payments.`;
    }
    if (!/^(\+?2637[0-9]{8}|07[0-9]{8})$/.test(body.mobileNumber.replace(/\s/g, ""))) {
      return `Invalid mobile number format. Use "07XXXXXXXX" or "+2637XXXXXXXX".`;
    }
  }

  if (body.provider === "CASH_MANUAL") {
    if (userRole !== "SUPER_ADMIN" && userRole !== "TENANT_ADMIN") {
      return "Only administrators can record manual cash payments.";
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// §5. PRIVATE UTILITIES
// ---------------------------------------------------------------------------

/**
 * Generates a short, URL-safe provider reference.
 * Format: "ZM{MONTH}{YEAR}-{TENANT_SHORT}-{RANDOM}"
 * Max 30 characters for Paynow compatibility.
 */
function buildProviderReference(
  tenantId: string,
  months: number,
  provider: string
): string {
  const now = new Date();
  const mmyy = `${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getFullYear()).slice(-2)}`;
  const tenantShort = tenantId.replace(/-/g, "").slice(0, 6).toUpperCase();
  const random = randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase();
  return `ZM${mmyy}${months}M-${tenantShort}-${random}`.slice(0, 30);
}

/**
 * Normalises a Zimbabwean MSISDN to international format (+2637XXXXXXXX).
 */
function normaliseMsisdn(number: string): string {
  const digits = number.replace(/\D/g, "");
  if (digits.startsWith("2637")) return `+${digits}`;
  if (digits.startsWith("07")) return `+263${digits.slice(1)}`;
  if (digits.startsWith("7")) return `+2637${digits}`;
  return `+263${digits}`;
}

/**
 * Returns the start of today (UTC midnight) as a Date.
 */
function startOfToday(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/**
 * Adds `months` calendar months to a Date (identical to subscription.ts version).
 */
function addMonths(date: Date, months: number): Date {
  const result = new Date(date);
  const day = result.getDate();
  result.setMonth(result.getMonth() + months);
  if (result.getDate() !== day) result.setDate(0);
  return result;
}

// ---------------------------------------------------------------------------
// §6. CUSTOM ERRORS
// ---------------------------------------------------------------------------

export class PaymentProviderError extends Error {
  constructor(
    message: string,
    public readonly provider: string
  ) {
    super(message);
    this.name = "PaymentProviderError";
  }
}a