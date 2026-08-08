// =============================================================================
// Multi-Currency Engine
// src/services/currency/currencyEngine.ts
// =============================================================================
// Responsibilities:
//   1. USD ↔ ZiG conversion using the day's official RBZ rate
//   2. Split-payment ledger — validate, normalise, compute change
//   3. Daily exchange rate management (set, fetch, validate)
//   4. VAT-inclusive/exclusive price decomposition per ZIMRA tax categories
//   5. Receipt monetary totals builder (subtotal, VAT, grand total, change)
//   6. Daily Z-Report currency summary
//
// All monetary arithmetic uses integer-scaled arithmetic (× 1,000,000)
// to avoid IEEE-754 floating-point rounding errors before final output.
// Final amounts are always rounded to 2 decimal places for display/ZIMRA.
// =============================================================================

import { PrismaClient, type CurrencyRate } from "../../../generated/prisma/index";
import type { ZimraTaxCategory, ZimraCurrencyCode } from "../../types/zimra";

// ---------------------------------------------------------------------------
// §1. CONSTANTS
// ---------------------------------------------------------------------------

/** Scaling factor for integer arithmetic (6 decimal places of precision). */
const SCALE = 1_000_000;

/** Maximum ZiG/USD rate ZIMRA considers credible (safety guard). */
const MAX_ZIG_USD_RATE = 10_000;

/** Minimum ZiG/USD rate (1 ZiG per USD — extreme floor). */
const MIN_ZIG_USD_RATE = 0.000_001;

// ---------------------------------------------------------------------------
// §2. CORE VALUE TYPES
// ---------------------------------------------------------------------------

/**
 * A monetary amount expressed in both USD and ZiG simultaneously.
 * All values are rounded to 2 decimal places (standard monetary rounding).
 */
export interface DualCurrencyAmount {
  usd: number;
  zig: number;
  /** The ZiG/USD rate used to compute the ZiG equivalent. */
  rateUsed: number;
}

/**
 * A single payment tender line in a split-payment transaction.
 */
export interface PaymentLine {
  /** Internal PaymentMethod enum value (e.g., "CASH_USD", "ECOCASH_ZIG"). */
  method: string;
  /**
   * Amount tendered in USD. Pass 0 if this is a ZiG-only tender.
   * Exactly one of `amountUsd` or `amountZig` must be non-zero per line.
   */
  amountUsd: number;
  /**
   * Amount tendered in ZiG. Pass 0 if this is a USD-only tender.
   */
  amountZig: number;
}

/**
 * Fully validated and normalised payment collection for a single sale.
 */
export interface NormalisedPayments {
  lines: PaymentLine[];
  /** Total amount tendered, expressed in USD. */
  totalTenderedUsd: number;
  /** Total amount tendered, expressed in ZiG (converted at day rate). */
  totalTenderedZig: number;
  /** Grand total due in USD. */
  grandTotalUsd: number;
  /** Change due in USD (0 if exact payment). */
  changeDueUsd: number;
  /** Change due in ZiG (0 if exact payment or change given in USD). */
  changeDueZig: number;
  /** True if any ZiG tender was used on this sale. */
  hasZigPayment: boolean;
  /** True if any USD tender was used on this sale. */
  hasUsdPayment: boolean;
  /** ZiG/USD rate used for all conversions. */
  rateUsed: number;
}

/**
 * Per-line item pricing with full VAT decomposition.
 */
export interface PricedLineItem {
  /** Internal product ID. */
  productId: string;
  sku: string;
  productName: string;
  hsCode?: string;
  taxCategory: ZimraTaxCategory;
  quantity: number;
  unit: string;
  /** Pre-tax unit price in USD. */
  unitPriceExclVatUsd: number;
  /** VAT rate as a decimal (e.g., 0.15 for 15%). */
  vatRate: number;
  /** VAT amount for the full line quantity, in USD. */
  vatAmountUsd: number;
  /** Line total inclusive of VAT, net of discount, in USD. */
  lineTotalUsd: number;
  /** Pre-VAT taxable amount for this line, in USD. */
  taxableAmountUsd: number;
  /** Discount applied to this line in USD (0 if none). */
  discountUsd: number;
  /** Discount percentage applied (0 if none). */
  discountPercent: number;
}

/**
 * Complete receipt monetary summary — used by the POS checkout and ZIMRA
 * SubmitReceipt builder.
 */
export interface ReceiptTotals {
  lines: PricedLineItem[];
  subtotalExclVatUsd: number;      // Sum of taxableAmountUsd across all lines
  totalDiscountUsd: number;        // Sum of line discounts
  totalVatUsd: number;             // Sum of vatAmountUsd
  grandTotalUsd: number;           // subtotal + VAT - discounts
  grandTotalZig: number;           // grandTotalUsd × ZiG/USD rate
  rateUsed: number;
  /** VAT breakdown by category (for ZIMRA receiptTaxes array). */
  vatByCategory: VatCategoryBreakdown[];
}

export interface VatCategoryBreakdown {
  taxCategory: ZimraTaxCategory;
  taxRate: number;                 // e.g., 0.15
  taxableAmountUsd: number;        // Excl. VAT
  vatAmountUsd: number;
  totalWithVatUsd: number;         // Incl. VAT
}

/**
 * Input for computing a priced line item from raw POS inputs.
 */
export interface LineItemInput {
  productId: string;
  sku: string;
  productName: string;
  hsCode?: string;
  taxCategory: ZimraTaxCategory;
  quantity: number;
  unit: string;
  /**
   * Unit selling price inclusive of VAT (as entered/displayed on POS screen).
   * The engine will back-calculate the excl-VAT price and VAT amount.
   */
  unitPriceInclVatUsd: number;
  vatRate: number;                  // e.g., 0.15 for 15%
  /** Optional line-level discount percentage (0–100). */
  discountPercent?: number;
  /** Optional fixed discount amount in USD (takes precedence over discountPercent). */
  discountAmountUsd?: number;
}

// ---------------------------------------------------------------------------
// §3. CURRENCY RATE SERVICE
// ---------------------------------------------------------------------------

export class CurrencyRateService {
  private readonly prisma: PrismaClient;
  /** In-memory rate cache — keyed by "tenantId:YYYY-MM-DD". Avoids repeated DB hits. */
  private readonly rateCache = new Map<string, number>();

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  /**
   * Sets or updates today's ZiG/USD exchange rate for a tenant.
   *
   * This should be called by the manager/admin at the start of each business
   * day using the RBZ inter-bank rate published at www.rbz.co.zw.
   *
   * ZIMRA validates submitted receipts against the officially published RBZ
   * rate — rates that deviate significantly will cause ERR_007 rejections.
   *
   * @param tenantId       - Tenant UUID.
   * @param zigPerUsd      - ZiG units per 1 USD (e.g., 27.5 means 1 USD = 27.5 ZiG).
   * @param setByUserId    - UUID of the user setting the rate.
   * @param rbzReference   - Optional RBZ publication reference number.
   * @param rateSource     - "RBZ_INTERBANK" | "MANUAL" (default: "MANUAL").
   * @returns The saved `CurrencyRate` record.
   */
  async setTodaysRate(
    tenantId: string,
    zigPerUsd: number,
    setByUserId: string,
    rbzReference?: string,
    rateSource: "RBZ_INTERBANK" | "MANUAL" = "MANUAL"
  ): Promise<CurrencyRate> {
    validateRate(zigPerUsd);

    const today = todayUtc();
    const cacheKey = `${tenantId}:${toDateString(today)}`;

    const rate = await this.prisma.currencyRate.upsert({
      where: {
        tenantId_rateDate_fromCurrency_toCurrency: {
          tenantId,
          rateDate: today,
          fromCurrency: "USD",
          toCurrency: "ZIG",
        },
      },
      update: {
        rate: zigPerUsd,
        setByUserId,
        rateSource,
        rbzReference: rbzReference ?? null,
      },
      create: {
        tenantId,
        rateDate: today,
        fromCurrency: "USD",
        toCurrency: "ZIG",
        rate: zigPerUsd,
        setByUserId,
        rateSource,
        rbzReference: rbzReference ?? null,
      },
    });

    // Invalidate and refresh cache
    this.rateCache.set(cacheKey, zigPerUsd);

    return rate;
  }

  /**
   * Fetches today's ZiG/USD rate for a tenant.
   *
   * @throws `MissingRateError` if no rate has been set for today.
   */
  async getTodaysRate(tenantId: string): Promise<number> {
    const today = todayUtc();
    const cacheKey = `${tenantId}:${toDateString(today)}`;

    const cached = this.rateCache.get(cacheKey);
    if (cached !== undefined) return cached;

    const record = await this.prisma.currencyRate.findUnique({
      where: {
        tenantId_rateDate_fromCurrency_toCurrency: {
          tenantId,
          rateDate: today,
          fromCurrency: "USD",
          toCurrency: "ZIG",
        },
      },
      select: { rate: true },
    });

    if (!record) {
      throw new MissingRateError(
        `No ZiG/USD exchange rate has been set for ${toDateString(today)}. ` +
          `Please set today's RBZ rate before processing sales.`
      );
    }

    const rate = Number(record.rate);
    this.rateCache.set(cacheKey, rate);
    return rate;
  }

  /**
   * Fetches the rate for a specific past date.
   * Used when re-processing historical receipts or generating reports.
   *
   * @throws `MissingRateError` if no rate exists for the given date.
   */
  async getRateForDate(tenantId: string, date: Date): Promise<number> {
    const dateOnly = startOfDay(date);
    const cacheKey = `${tenantId}:${toDateString(dateOnly)}`;

    const cached = this.rateCache.get(cacheKey);
    if (cached !== undefined) return cached;

    const record = await this.prisma.currencyRate.findUnique({
      where: {
        tenantId_rateDate_fromCurrency_toCurrency: {
          tenantId,
          rateDate: dateOnly,
          fromCurrency: "USD",
          toCurrency: "ZIG",
        },
      },
      select: { rate: true },
    });

    if (!record) {
      throw new MissingRateError(
        `No ZiG/USD exchange rate found for ${toDateString(dateOnly)}.`
      );
    }

    const rate = Number(record.rate);
    this.rateCache.set(cacheKey, rate);
    return rate;
  }

  /**
   * Returns the last N daily rates for a tenant (for the rate history screen).
   */
  async getRateHistory(
    tenantId: string,
    days = 30
  ): Promise<Array<{ date: string; rate: number; source: string }>> {
    const since = new Date();
    since.setUTCDate(since.getUTCDate() - days);

    const records = await this.prisma.currencyRate.findMany({
      where: {
        tenantId,
        fromCurrency: "USD",
        toCurrency: "ZIG",
        rateDate: { gte: since },
      },
      orderBy: { rateDate: "desc" },
      select: { rateDate: true, rate: true, rateSource: true },
    });

    return records.map((r: { rateDate: Date; rate: unknown; rateSource: string }) => ({
      date: toDateString(r.rateDate),
      rate: Number(r.rate),
      source: r.rateSource,
    }));
  }

  /** Clears the in-memory rate cache (useful in tests). */
  clearCache(): void {
    this.rateCache.clear();
  }
}

// ---------------------------------------------------------------------------
// §4. CURRENCY CONVERSION FUNCTIONS
// ---------------------------------------------------------------------------

/**
 * Converts a USD amount to ZiG using the provided rate.
 *
 * Uses integer-scaled arithmetic internally to avoid float drift.
 *
 * @param amountUsd  - Amount in USD.
 * @param zigPerUsd  - Official ZiG/USD rate (e.g., 27.5).
 * @returns ZiG amount, rounded to 2 decimal places.
 */
export function usdToZig(amountUsd: number, zigPerUsd: number): number {
  const scaledUsd = Math.round(amountUsd * SCALE);
  const scaledRate = Math.round(zigPerUsd * SCALE);
  const scaledZig = (scaledUsd * scaledRate) / SCALE;
  return round2(scaledZig / SCALE);
}

/**
 * Converts a ZiG amount to USD using the provided rate.
 *
 * @param amountZig  - Amount in ZiG.
 * @param zigPerUsd  - Official ZiG/USD rate (e.g., 27.5).
 * @returns USD amount, rounded to 4 decimal places (to avoid sub-cent loss).
 */
export function zigToUsd(amountZig: number, zigPerUsd: number): number {
  if (zigPerUsd === 0) throw new Error("ZiG/USD rate cannot be zero.");
  const scaledZig = Math.round(amountZig * SCALE);
  const scaledRate = Math.round(zigPerUsd * SCALE);
  const scaledUsd = (scaledZig * SCALE) / scaledRate;
  return round4(scaledUsd / SCALE);
}

/**
 * Produces a `DualCurrencyAmount` for any USD value using today's rate.
 */
export function toDualCurrency(
  amountUsd: number,
  zigPerUsd: number
): DualCurrencyAmount {
  return {
    usd: round2(amountUsd),
    zig: usdToZig(amountUsd, zigPerUsd),
    rateUsed: zigPerUsd,
  };
}

// ---------------------------------------------------------------------------
// §5. VAT DECOMPOSITION
// ---------------------------------------------------------------------------

/**
 * Decomposes a VAT-inclusive price into its excl-VAT and VAT components.
 *
 * ZIMRA requires both the taxable (excl-VAT) amount and the VAT amount
 * on every receipt line. This function derives them from the inclusive price.
 *
 * Formula:
 *   exclVat = inclVat / (1 + vatRate)
 *   vatAmount = inclVat - exclVat
 *
 * @param inclVatAmount  - Price inclusive of VAT.
 * @param vatRate        - VAT rate as decimal (e.g., 0.15).
 * @returns `{ exclVat, vatAmount }` both in the same currency unit.
 */
export function decomposeVat(
  inclVatAmount: number,
  vatRate: number
): { exclVat: number; vatAmount: number } {
  if (vatRate < 0 || vatRate > 1) {
    throw new InvalidVatRateError(
      `VAT rate must be between 0 and 1. Received: ${vatRate}`
    );
  }

  const scaledIncl = Math.round(inclVatAmount * SCALE);
  const scaledExcl = Math.round(scaledIncl / (1 + vatRate));
  const scaledVat = scaledIncl - scaledExcl;

  return {
    exclVat: round4(scaledExcl / SCALE),
    vatAmount: round4(scaledVat / SCALE),
  };
}

/**
 * Applies VAT to an exclusive-of-VAT price.
 *
 * @param exclVatAmount  - Price excluding VAT.
 * @param vatRate        - VAT rate as decimal (e.g., 0.15).
 * @returns `{ inclVat, vatAmount }`.
 */
export function applyVat(
  exclVatAmount: number,
  vatRate: number
): { inclVat: number; vatAmount: number } {
  const scaledExcl = Math.round(exclVatAmount * SCALE);
  const scaledVat = Math.round(scaledExcl * vatRate);
  const scaledIncl = scaledExcl + scaledVat;

  return {
    inclVat: round4(scaledIncl / SCALE),
    vatAmount: round4(scaledVat / SCALE),
  };
}

// ---------------------------------------------------------------------------
// §6. LINE ITEM PRICER
// ---------------------------------------------------------------------------

/**
 * Computes the full monetary breakdown for a single receipt line item.
 *
 * Input prices are expected inclusive of VAT (standard retail display).
 * The engine back-calculates excl-VAT, VAT amount, and applies discounts.
 *
 * Discount application order (ZIMRA standard):
 *   1. Apply discount to unit price (incl. VAT)
 *   2. Decompose discounted price into excl-VAT + VAT
 *   3. Multiply by quantity
 *
 * @param input - `LineItemInput` from the POS.
 * @returns `PricedLineItem` with full monetary breakdown.
 */
export function priceLineItem(input: LineItemInput): PricedLineItem {
  const {
    quantity,
    unitPriceInclVatUsd,
    vatRate,
    discountPercent = 0,
    discountAmountUsd,
  } = input;

  if (quantity <= 0) {
    throw new Error(`Line item quantity must be positive. Got: ${quantity}`);
  }

  // ── Compute unit discount ──────────────────────────────────────────────
  let unitDiscountUsd: number;
  let effectiveDiscountPercent: number;

  if (discountAmountUsd !== undefined && discountAmountUsd > 0) {
    // Fixed discount — spread across all units
    unitDiscountUsd = round4(discountAmountUsd / quantity);
    effectiveDiscountPercent = round4(
      (unitDiscountUsd / unitPriceInclVatUsd) * 100
    );
  } else if (discountPercent > 0) {
    effectiveDiscountPercent = discountPercent;
    unitDiscountUsd = round4(
      (unitPriceInclVatUsd * discountPercent) / 100
    );
  } else {
    unitDiscountUsd = 0;
    effectiveDiscountPercent = 0;
  }

  // ── Discounted unit price ──────────────────────────────────────────────
  const discountedUnitPriceIncl = round4(
    unitPriceInclVatUsd - unitDiscountUsd
  );

  if (discountedUnitPriceIncl < 0) {
    throw new Error(
      `Discount of ${unitDiscountUsd} USD exceeds unit price of ` +
        `${unitPriceInclVatUsd} USD on product "${input.sku}".`
    );
  }

  // ── Decompose discounted price ─────────────────────────────────────────
  const { exclVat: unitPriceExclVat, vatAmount: unitVatAmount } =
    decomposeVat(discountedUnitPriceIncl, vatRate);

  // ── Scale to full quantity ─────────────────────────────────────────────
  const scaledQty = Math.round(quantity * SCALE);
  const lineTotalUsd = round2(
    (Math.round(discountedUnitPriceIncl * SCALE) * scaledQty) / SCALE / SCALE
  );
  const taxableAmountUsd = round2(
    (Math.round(unitPriceExclVat * SCALE) * scaledQty) / SCALE / SCALE
  );
  const vatAmountUsd = round2(
    (Math.round(unitVatAmount * SCALE) * scaledQty) / SCALE / SCALE
  );
  const totalDiscountUsd = round2(
    (Math.round(unitDiscountUsd * SCALE) * scaledQty) / SCALE / SCALE
  );

  return {
    productId: input.productId,
    sku: input.sku,
    productName: input.productName,
    hsCode: input.hsCode,
    taxCategory: input.taxCategory,
    quantity,
    unit: input.unit,
    unitPriceExclVatUsd: round4(unitPriceExclVat),
    vatRate,
    vatAmountUsd,
    lineTotalUsd,
    taxableAmountUsd,
    discountUsd: totalDiscountUsd,
    discountPercent: effectiveDiscountPercent,
  };
}

// ---------------------------------------------------------------------------
// §7. RECEIPT TOTALS BUILDER
// ---------------------------------------------------------------------------

/**
 * Builds the complete monetary summary for a receipt from its line items.
 *
 * @param lines      - Array of `LineItemInput` from the POS checkout.
 * @param zigPerUsd  - Today's official ZiG/USD rate.
 * @returns `ReceiptTotals` used for display, persistence, and ZIMRA submission.
 */
export function buildReceiptTotals(
  lines: LineItemInput[],
  zigPerUsd: number
): ReceiptTotals {
  validateRate(zigPerUsd);

  if (lines.length === 0) {
    throw new Error("Cannot build receipt totals for an empty sale.");
  }

  const pricedLines = lines.map(priceLineItem);

  let subtotalExclVatUsd = 0;
  let totalDiscountUsd = 0;
  let totalVatUsd = 0;

  const vatMap = new Map<
    ZimraTaxCategory,
    { rate: number; taxable: number; vat: number; total: number }
  >();

  for (const line of pricedLines) {
    subtotalExclVatUsd += line.taxableAmountUsd;
    totalDiscountUsd += line.discountUsd;
    totalVatUsd += line.vatAmountUsd;

    const existing = vatMap.get(line.taxCategory) ?? {
      rate: line.vatRate,
      taxable: 0,
      vat: 0,
      total: 0,
    };
    existing.taxable += line.taxableAmountUsd;
    existing.vat += line.vatAmountUsd;
    existing.total += line.lineTotalUsd;
    vatMap.set(line.taxCategory, existing);
  }

  const grandTotalUsd = round2(subtotalExclVatUsd + totalVatUsd);
  const grandTotalZig = usdToZig(grandTotalUsd, zigPerUsd);

  const vatByCategory: VatCategoryBreakdown[] = Array.from(
    vatMap.entries()
  ).map(([cat, vals]) => ({
    taxCategory: cat,
    taxRate: vals.rate,
    taxableAmountUsd: round2(vals.taxable),
    vatAmountUsd: round2(vals.vat),
    totalWithVatUsd: round2(vals.total),
  }));

  return {
    lines: pricedLines,
    subtotalExclVatUsd: round2(subtotalExclVatUsd),
    totalDiscountUsd: round2(totalDiscountUsd),
    totalVatUsd: round2(totalVatUsd),
    grandTotalUsd,
    grandTotalZig,
    rateUsed: zigPerUsd,
    vatByCategory,
  };
}

// ---------------------------------------------------------------------------
// §8. SPLIT-PAYMENT LEDGER
// ---------------------------------------------------------------------------

/**
 * Validates and normalises a split-payment tender collection for a sale.
 *
 * Rules enforced:
 *   - Total tendered (in USD equivalent) must be >= grandTotalUsd
 *   - Each payment line must specify either a USD or ZiG amount (not both)
 *   - ZiG amounts are converted to USD at the day rate for total computation
 *   - Change due is computed in the currency of the last/largest tender
 *   - No negative payment amounts allowed
 *
 * @param tenders       - Array of `PaymentLine` from the POS cashier input.
 * @param grandTotalUsd - Total due on the receipt in USD.
 * @param zigPerUsd     - Today's ZiG/USD rate for cross-currency conversion.
 * @returns `NormalisedPayments` with computed change and validation results.
 */
export function normalisePayments(
  tenders: PaymentLine[],
  grandTotalUsd: number,
  zigPerUsd: number
): NormalisedPayments {
  validateRate(zigPerUsd);

  if (tenders.length === 0) {
    throw new PaymentValidationError(
      "At least one payment tender is required."
    );
  }

  // ── Validate individual tender lines ──────────────────────────────────
  for (const tender of tenders) {
    if (tender.amountUsd < 0 || tender.amountZig < 0) {
      throw new PaymentValidationError(
        `Payment amounts cannot be negative. ` +
          `Method: ${tender.method}, USD: ${tender.amountUsd}, ZiG: ${tender.amountZig}`
      );
    }
    if (tender.amountUsd === 0 && tender.amountZig === 0) {
      throw new PaymentValidationError(
        `Payment line for method "${tender.method}" has zero amount in both currencies.`
      );
    }
  }

  // ── Aggregate totals in USD ───────────────────────────────────────────
  let totalTenderedUsd = 0;
  let totalTenderedZig = 0;
  let hasUsdPayment = false;
  let hasZigPayment = false;

  const normalisedLines: PaymentLine[] = tenders.map((tender) => {
    let usdEquiv: number;
    let zigEquiv: number;

    if (tender.amountUsd > 0) {
      // USD tender — compute ZiG equivalent for record-keeping
      usdEquiv = tender.amountUsd;
      zigEquiv = usdToZig(tender.amountUsd, zigPerUsd);
      hasUsdPayment = true;
    } else {
      // ZiG tender — convert to USD for total computation
      usdEquiv = zigToUsd(tender.amountZig, zigPerUsd);
      zigEquiv = tender.amountZig;
      hasZigPayment = true;
    }

    totalTenderedUsd = round4(totalTenderedUsd + usdEquiv);
    totalTenderedZig = round2(totalTenderedZig + zigEquiv);

    return {
      method: tender.method,
      amountUsd: round2(usdEquiv),
      amountZig: round2(zigEquiv),
    };
  });

  // ── Validate sufficient tender ────────────────────────────────────────
  // Use a 0.005 USD tolerance to absorb floating-point rounding in conversions
  const TOLERANCE_USD = 0.005;
  if (totalTenderedUsd < grandTotalUsd - TOLERANCE_USD) {
    throw new InsufficientPaymentError(
      `Insufficient payment: total tendered ${round2(totalTenderedUsd)} USD ` +
        `is less than the receipt total of ${grandTotalUsd} USD.`
    );
  }

  // ── Compute change ────────────────────────────────────────────────────
  const overpaymentUsd = round4(totalTenderedUsd - grandTotalUsd);
  let changeDueUsd = 0;
  let changeDueZig = 0;

  if (overpaymentUsd > 0) {
    if (hasUsdPayment) {
      // Prefer giving change in USD
      changeDueUsd = round2(overpaymentUsd);
    } else {
      // All ZiG payment — give change in ZiG
      changeDueZig = usdToZig(overpaymentUsd, zigPerUsd);
    }
  }

  return {
    lines: normalisedLines,
    totalTenderedUsd: round2(totalTenderedUsd),
    totalTenderedZig: round2(totalTenderedZig),
    grandTotalUsd,
    changeDueUsd,
    changeDueZig,
    hasZigPayment,
    hasUsdPayment,
    rateUsed: zigPerUsd,
  };
}

// ---------------------------------------------------------------------------
// §9. Z-REPORT CURRENCY SUMMARY
// ---------------------------------------------------------------------------

/**
 * Builds a dual-currency daily summary for the Z-Report printout.
 * Used on the end-of-day report screen and the thermal Z-Report printout.
 *
 * @param totalsUsd  - USD totals from `ZimraZReport`.
 * @param zigPerUsd  - The rate used for the fiscal day.
 */
export function buildDailyCurrencySummary(
  totalsUsd: {
    totalSalesUsd: number;
    totalVatUsd: number;
    totalDiscountsUsd: number;
    totalRefundsUsd: number;
  },
  zigPerUsd: number
): {
  usd: typeof totalsUsd;
  zig: {
    totalSalesZig: number;
    totalVatZig: number;
    totalDiscountsZig: number;
    totalRefundsZig: number;
  };
  rate: number;
} {
  return {
    usd: totalsUsd,
    zig: {
      totalSalesZig: usdToZig(totalsUsd.totalSalesUsd, zigPerUsd),
      totalVatZig: usdToZig(totalsUsd.totalVatUsd, zigPerUsd),
      totalDiscountsZig: usdToZig(totalsUsd.totalDiscountsUsd, zigPerUsd),
      totalRefundsZig: usdToZig(totalsUsd.totalRefundsUsd, zigPerUsd),
    },
    rate: zigPerUsd,
  };
}

// ---------------------------------------------------------------------------
// §10. ZIMRA TAX RATE CACHE
// ---------------------------------------------------------------------------

/**
 * In-memory cache for ZIMRA tax rates fetched from GetConfig.
 * Rates are seeded at app startup and refreshed daily.
 * Falls back to the hardcoded defaults if ZIMRA is unreachable.
 */
export class ZimraTaxRateCache {
  private rates: Map<ZimraTaxCategory, number> = new Map([
    ["A", 0.15], // Standard rate 15%
    ["B", 0.00], // Zero-rated
    ["C", 0.00], // Exempt
    ["D", 0.02], // Tourism levy (2% — verify with current gazette)
    ["E", 0.00], // Specific excise (rate varies by product)
  ]);

  private lastRefreshed: Date | null = null;

  /**
   * Updates the cache from ZIMRA GetConfig `taxRates` response.
   * Call this after a successful `getConfig()` API call.
   */
  updateFromZimra(
    taxRates: Array<{ taxCategory: ZimraTaxCategory; taxRate: number }>
  ): void {
    for (const { taxCategory, taxRate } of taxRates) {
      // ZIMRA returns rates as percentages (e.g., 15) — convert to decimal
      this.rates.set(taxCategory, taxRate / 100);
    }
    this.lastRefreshed = new Date();
  }

  /**
   * Returns the VAT rate for a given tax category as a decimal.
   * Falls back to 0 for unknown categories (treat as exempt).
   */
  getRate(category: ZimraTaxCategory): number {
    return this.rates.get(category) ?? 0;
  }

  /**
   * Returns all current tax rates (for display in admin UI).
   */
  getAllRates(): Array<{ category: ZimraTaxCategory; ratePercent: number }> {
    return Array.from(this.rates.entries()).map(([category, rate]) => ({
      category,
      ratePercent: rate * 100,
    }));
  }

  /**
   * True if the cache has been updated from ZIMRA within the last 24 hours.
   */
  get isFresh(): boolean {
    if (!this.lastRefreshed) return false;
    const ageMs = Date.now() - this.lastRefreshed.getTime();
    return ageMs < 24 * 60 * 60 * 1000;
  }
}

// ---------------------------------------------------------------------------
// §11. PRIVATE UTILITIES
// ---------------------------------------------------------------------------

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function validateRate(rate: number): void {
  if (!isFinite(rate) || rate < MIN_ZIG_USD_RATE || rate > MAX_ZIG_USD_RATE) {
    throw new InvalidExchangeRateError(
      `ZiG/USD rate ${rate} is outside the valid range ` +
        `[${MIN_ZIG_USD_RATE}, ${MAX_ZIG_USD_RATE}]. ` +
        `Verify the rate with the RBZ daily bulletin.`
    );
  }
}

function todayUtc(): Date {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  );
}

function startOfDay(date: Date): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
  );
}

function toDateString(date: Date): string {
  return date.toISOString().split("T")[0];
}

// ---------------------------------------------------------------------------
// §12. CUSTOM ERRORS
// ---------------------------------------------------------------------------

export class MissingRateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MissingRateError";
  }
}

export class InvalidExchangeRateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidExchangeRateError";
  }
}

export class InvalidVatRateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidVatRateError";
  }
}

export class PaymentValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaymentValidationError";
  }
}

export class InsufficientPaymentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InsufficientPaymentError";
  }
}