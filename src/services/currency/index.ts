// =============================================================================
// Currency Services — Public barrel
// src/services/currency/index.ts
// =============================================================================

export {
  CurrencyRateService,
  ZimraTaxRateCache,
  usdToZig,
  zigToUsd,
  toDualCurrency,
  decomposeVat,
  applyVat,
  priceLineItem,
  buildReceiptTotals,
  normalisePayments,
  buildDailyCurrencySummary,
  MissingRateError,
  InvalidExchangeRateError,
  InvalidVatRateError,
  PaymentValidationError,
  InsufficientPaymentError,
  type DualCurrencyAmount,
  type PaymentLine,
  type NormalisedPayments,
  type PricedLineItem,
  type ReceiptTotals,
  type VatCategoryBreakdown,
  type LineItemInput,
} from "./currencyEngine.js";