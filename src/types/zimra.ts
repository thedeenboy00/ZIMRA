// =============================================================================
// ZIMRA FDMS Virtual Device API — Full TypeScript Type Definitions
// REST API Base: https://fdmsapidev.zimra.co.zw/Device/v1
// Spec version: FDMS API v1 (2024)
// =============================================================================
// Endpoint map:
//   POST   /Device/v1/{deviceID}/RegisterDevice
//   POST   /Device/v1/{deviceID}/GetServerCertificate
//   POST   /Device/v1/{deviceID}/OpenDay
//   POST   /Device/v1/{deviceID}/SubmitReceipt
//   POST   /Device/v1/{deviceID}/CloseDay
//   GET    /Device/v1/{deviceID}/GetConfig
//   POST   /Device/v1/{deviceID}/Heartbeat
// =============================================================================

// ---------------------------------------------------------------------------
// §1. SHARED PRIMITIVES
// ---------------------------------------------------------------------------

/**
 * ISO 4217 currency codes relevant to Zimbabwe.
 * ZIMRA FDMS only accepts USD and ZIG as valid tender currencies.
 */
export type ZimraCurrencyCode = "USD" | "ZIG";

/**
 * ZIMRA tax category codes as defined in the FDMS specification.
 * Maps directly to TaxCategory enum in schema.prisma.
 */
export type ZimraTaxCategory = "A" | "B" | "C" | "D" | "E";

/**
 * Receipt type codes accepted by the FDMS SubmitReceipt endpoint.
 */
export type ZimraReceiptType =
  | "FiscalInvoice"
  | "CreditNote"
  | "DebitNote";

/**
 * Payment type codes recognised by ZIMRA FDMS.
 * Note: ZIMRA categorises by modality, not by specific provider (e.g., both
 * EcoCash and InnBucks map to "MobileWallet" for ZIMRA's purposes).
 */
export type ZimraPaymentType =
  | "Cash"
  | "MobileWallet"
  | "Swipe"        // POS card / RTGS bank swipe
  | "BankTransfer"
  | "Credit"       // Account / store credit
  | "Other";

/**
 * ZIMRA fiscal device operational status codes.
 */
export type ZimraDeviceStatus =
  | "Active"
  | "Disabled"
  | "NotRegistered"
  | "Deactivated";

/**
 * ZIMRA fiscal day status codes (state machine).
 */
export type ZimraFiscalDayStatus =
  | "FiscalDayOpened"
  | "FiscalDayCloseInitiated"
  | "FiscalDayClosed";

// ---------------------------------------------------------------------------
// §2. AUTHENTICATION & DEVICE REGISTRATION
// ---------------------------------------------------------------------------

/**
 * Request body for POST /Device/v1/{deviceID}/RegisterDevice.
 * The device self-registers using an activation key from the ZIMRA operator portal.
 * A PKCS#10 CSR (PEM-encoded) must be provided so ZIMRA can issue an x.509 cert.
 */
export interface ZimraRegisterDeviceRequest {
  /** The activation key provided by the ZIMRA operator web portal. */
  activationKey: string;
  /**
   * PEM-encoded PKCS#10 certificate signing request generated locally
   * using RSA-2048. Subject CN must equal the deviceID.
   */
  certificateRequest: string;
}

/**
 * Successful response from RegisterDevice.
 * The certificateThumbprint and certificate are required for all subsequent
 * API calls via the Authorization header.
 */
export interface ZimraRegisterDeviceResponse {
  /** PEM-encoded x.509 certificate issued by ZIMRA CA. */
  certificate: string;
  /**
   * Hex-encoded SHA-256 thumbprint of the issued certificate.
   * Must be sent as a query param (?thumbprint=…) on authenticated endpoints.
   */
  certificateThumbprint: string;
  /**
   * UTC ISO-8601 timestamp indicating when the certificate expires.
   * Typically 1 year. Devices must re-register before expiry.
   */
  certificateValidTill: string; // ISO 8601 UTC
}

/**
 * Request body for POST /Device/v1/{deviceID}/GetServerCertificate.
 * Retrieves ZIMRA's own TLS certificate for mutual TLS pinning.
 */
export interface ZimraGetServerCertificateRequest {
  certificateThumbprint: string;
}

export interface ZimraGetServerCertificateResponse {
  /** ZIMRA CA root certificate in PEM format. */
  certificate: string;
}

// ---------------------------------------------------------------------------
// §3. DEVICE CONFIGURATION
// ---------------------------------------------------------------------------

/**
 * Tax rate definition returned in GetConfig response.
 * Each entry maps a tax category code to a human-readable name and rate.
 */
export interface ZimraTaxRate {
  /** Single-letter ZIMRA tax category: A | B | C | D | E */
  taxCategory: ZimraTaxCategory;
  /** Human-readable label (e.g., "Standard Rate", "Zero Rated"). */
  taxCategoryName: string;
  /**
   * VAT rate as a percentage (not a decimal).
   * e.g., 15 means 15%, not 0.15.
   */
  taxRate: number;
}

/**
 * Response from GET /Device/v1/{deviceID}/GetConfig.
 * Contains current tax rates, device status, and server configuration.
 */
export interface ZimraGetConfigResponse {
  deviceStatus: ZimraDeviceStatus;
  /** Current FDMS tax rate schedule — may change via gazette updates. */
  taxRates: ZimraTaxRate[];
  /**
   * Current fiscal day status as known by ZIMRA server.
   * Use to reconcile local state after an offline period.
   */
  fiscalDayStatus: ZimraFiscalDayStatus | null;
  /** The highest receipt counter ZIMRA has recorded for this device. */
  lastReceiptGlobalNo: number;
  /** The current fiscal day number on the ZIMRA server. */
  fiscalDayNo: number | null;
  /** UTC timestamp of last successful communication with this device. */
  lastHeartbeatAt: string | null; // ISO 8601
}

// ---------------------------------------------------------------------------
// §4. HEARTBEAT
// ---------------------------------------------------------------------------

/**
 * Request body for POST /Device/v1/{deviceID}/Heartbeat.
 * Must be sent at least every 2 hours during an open fiscal day.
 */
export interface ZimraHeartbeatRequest {
  fiscalDayNo: number;
  fiscalDayStatus: ZimraFiscalDayStatus;
}

export interface ZimraHeartbeatResponse {
  heartbeatResponseCode: string; // "00" = success
}

// ---------------------------------------------------------------------------
// §5. OPEN FISCAL DAY
// ---------------------------------------------------------------------------

/**
 * Request body for POST /Device/v1/{deviceID}/OpenDay.
 * Must be the first call each business day before any receipts can be submitted.
 */
export interface ZimraOpenDayRequest {
  /**
   * Monotonically increasing fiscal day number.
   * Must be lastFiscalDayNo + 1 from the previous day.
   */
  fiscalDayNo: number;
  /**
   * UTC ISO-8601 date-time when the cashier opened the fiscal day.
   * ZIMRA validates this is within the expected business date.
   */
  fiscalDayOpened: string; // ISO 8601 UTC
}

/**
 * Successful response from OpenDay.
 */
export interface ZimraOpenDayResponse {
  fiscalDayNo: number;
  fiscalDayStatus: "FiscalDayOpened";
  /** ZIMRA server-side acknowledgement token — store for audit trail. */
  fiscalDayOpenedToken: string;
  /** ZIMRA server UTC timestamp when the day was officially opened. */
  fiscalDayOpenedAt: string; // ISO 8601
}

// ---------------------------------------------------------------------------
// §6. SUBMIT RECEIPT
// ---------------------------------------------------------------------------

/**
 * Per-line tax breakdown required by ZIMRA for each SaleItem.
 * Multiple entries per line are allowed (e.g., VAT + levy on same item).
 */
export interface ZimraReceiptLineTax {
  taxCategory: ZimraTaxCategory;
  /** Tax amount for this line in the billing currency. */
  taxAmount: number;
  /** Sales amount before tax (exclusive of VAT). */
  salesAmountWithTax: number; // ZIMRA calls this "salesAmountWithTax" — it means incl. tax
}

/**
 * Single line item as submitted to ZIMRA.
 * Mirrors the fiscal receipt line — all amounts in billing currency.
 */
export interface ZimraReceiptLine {
  /** Line sequence number (1-based). */
  receiptLineNo: number;
  /** Short product description (max 100 chars). */
  receiptLineName: string;
  /** Quantity sold (up to 4 decimal places). */
  receiptLineQuantity: number;
  /** Price per unit before tax (up to 4 decimal places). */
  receiptLinePrice: number;
  /** Total line value inclusive of tax, net of discount. */
  receiptLineTotal: number;
  /** Applicable tax breakdowns for this line. */
  taxRateCode: ZimraTaxCategory;
  /** Pre-calculated tax amount for this specific line. */
  receiptLineTaxPercent: number; // e.g., 15 for 15% VAT
  /** HS Tariff code as registered in the ZIMRA product catalogue. */
  hsCode?: string; // Optional but strongly recommended
}

/**
 * Payment tender entry for the receipt submission.
 * Split payments require one entry per tender type used.
 */
export interface ZimraReceiptPayment {
  moneyTypeCode: ZimraPaymentType;
  /** Amount paid via this tender, in the billing currency. */
  paymentAmount: number;
}

/**
 * Tax summary aggregated across all lines — required at receipt level.
 */
export interface ZimraReceiptTax {
  taxCategory: ZimraTaxCategory;
  /** Total sales amount for this tax category (inclusive of tax). */
  salesAmountWithTax: number;
  /** Total VAT amount collected for this category. */
  taxAmount: number;
}

/**
 * The full receipt submission payload for POST /Device/v1/{deviceID}/SubmitReceipt.
 * This is the central ZIMRA API object — every fiscal sale must produce one.
 */
export interface ZimraSubmitReceiptRequest {
  // ── Receipt identity ─────────────────────────────────────────────────────

  /**
   * Device-local receipt counter. Must be monotonically increasing per device.
   * Resets to 1 at the start of each fiscal day.
   */
  receiptCounter: number;

  /**
   * ZIMRA global receipt number from the last accepted receipt.
   * ZIMRA uses this to detect and reject gaps in the submission sequence.
   * Pass 0 if this is the first receipt of the day.
   */
  receiptGlobalNo: number;

  receiptType: ZimraReceiptType;

  // ── Timestamps ────────────────────────────────────────────────────────────

  /** UTC ISO-8601 date-time the sale was completed on the POS. */
  receiptDate: string; // ISO 8601 UTC

  /** Fiscal day number this receipt belongs to. */
  fiscalDayNo: number;

  // ── Currency ──────────────────────────────────────────────────────────────

  /** Primary billing currency for this receipt. */
  receiptCurrency: ZimraCurrencyCode;

  /**
   * Official RBZ exchange rate used for ZiG/USD conversion on this receipt.
   * Required when receiptCurrency is ZIG.
   * ZIMRA validates against their own published daily RBZ rate.
   */
  receiptExchangeRate?: number; // ZiG per 1 USD

  // ── Amounts ───────────────────────────────────────────────────────────────

  /** Total discount applied across the entire receipt. */
  receiptDiscountTotals?: ZimraReceiptLineTax[];

  /** Total value of all lines before tax (excl. VAT). */
  invoiceAmount: number;

  /** Grand total including VAT. */
  receiptTotal: number;

  /** Taxes aggregated by category at the receipt level. */
  receiptTaxes: ZimraReceiptTax[];

  // ── Credit note reference ─────────────────────────────────────────────────

  /**
   * Required only when receiptType is "CreditNote" or "DebitNote".
   * Must reference the receiptCounter of the original fiscal invoice.
   */
  referenceReceiptNo?: number;

  /**
   * Date of the original receipt being reversed.
   * Required alongside referenceReceiptNo.
   */
  referenceReceiptDate?: string; // ISO 8601 UTC

  // ── Customer (B2B) ────────────────────────────────────────────────────────

  /** Buyer's company name — required for B2B fiscal invoices over threshold. */
  buyerName?: string;
  /** Buyer's ZIMRA TIN — required when buyerName is provided. */
  buyerTIN?: string;
  /** Buyer's VAT registration number. */
  buyerVATNumber?: string;

  // ── Line items ────────────────────────────────────────────────────────────

  receiptLines: ZimraReceiptLine[];

  // ── Payments ─────────────────────────────────────────────────────────────

  receiptPayments: ZimraReceiptPayment[];

  // ── Cryptographic signature ───────────────────────────────────────────────

  /**
   * RSA-2048 SHA-256 digital signature of the canonical receipt hash.
   * Signed with the device private key. Base64-encoded.
   * ZIMRA validates this against the device's registered certificate.
   */
  receiptDeviceSignature: ZimraDeviceSignature;
}

/**
 * The signature block attached to every submitted receipt.
 */
export interface ZimraDeviceSignature {
  /** SHA-256 hash of the canonical receipt string, hex-encoded. */
  hash: string;
  /**
   * RSA-2048 PKCS#1v15 signature of `hash`, using the device private key.
   * Base64-encoded.
   */
  signature: string;
}

/**
 * Successful response from SubmitReceipt.
 * The fiscalSignature and qrCode must be printed on the customer receipt.
 */
export interface ZimraSubmitReceiptResponse {
  /** ZIMRA-assigned global receipt number. Must be stored and used in next submission. */
  receiptGlobalNo: number;
  /** UTC ISO-8601 timestamp when ZIMRA processed this receipt. */
  receiptDate: string;
  /**
   * ZIMRA's cryptographic fiscal signature for this receipt.
   * Base64-encoded RSA signature from ZIMRA's CA key.
   * Must be printed on the receipt and used to generate the verification QR code.
   */
  receiptQRUrl: string;
  /**
   * Short code used to build the ZIMRA verification URL:
   * https://www.zimra.co.zw/verify?code={receiptVerificationCode}
   */
  receiptVerificationCode: string;
  /** ZIMRA confirmation that the receipt was accepted. "00" = accepted. */
  receiptResponseCode: string;
}

// ---------------------------------------------------------------------------
// §7. CLOSE FISCAL DAY
// ---------------------------------------------------------------------------

/**
 * Per-payment-method totals for the Z-Report submitted at day close.
 */
export interface ZimraDayPaymentSummary {
  moneyTypeCode: ZimraPaymentType;
  paymentAmount: number;
}

/**
 * Per-tax-category totals for the Z-Report.
 */
export interface ZimraDayTaxSummary {
  taxCategory: ZimraTaxCategory;
  totalSalesWithTax: number;
  totalTaxAmount: number;
}

/**
 * Request body for POST /Device/v1/{deviceID}/CloseDay.
 * Contains the complete Z-Report aggregated from all receipts submitted during the day.
 * ZIMRA cross-validates these totals against individually submitted receipts.
 */
export interface ZimraCloseDayRequest {
  fiscalDayNo: number;
  /** UTC ISO-8601 date-time the cashier initiated the day-close procedure. */
  fiscalDayClosed: string; // ISO 8601 UTC
  /** Total number of receipts submitted during this fiscal day. */
  receiptCount: number;
  /** Grand total sales inclusive of VAT for the fiscal day, in reporting currency. */
  fiscalDaySalesTotal: number;
  /** Total VAT collected across all tax categories. */
  fiscalDayTaxTotal: number;
  /** Z-Report tax breakdown by category. */
  taxSummaries: ZimraDayTaxSummary[];
  /** Z-Report payment breakdown by tender type. */
  paymentSummaries: ZimraDayPaymentSummary[];
  /** Total of all discounts applied during the day. */
  fiscalDayDiscountTotal: number;
  /** Total of all credit notes (refunds) issued during the day. */
  fiscalDayRefundTotal: number;
  /**
   * Hash of the last accepted receipt's fiscalSignature.
   * Chains fiscal day closure to the last known-good receipt.
   * SHA-256 hex-encoded.
   */
  lastReceiptHash: string;
}

/**
 * Successful response from CloseDay.
 */
export interface ZimraCloseDayResponse {
  fiscalDayNo: number;
  fiscalDayStatus: "FiscalDayClosed";
  /** ZIMRA ack token for the close event — store for audit trail. */
  fiscalDayClosedToken: string;
  /** UTC ISO-8601 timestamp when ZIMRA officially closed the fiscal day. */
  fiscalDayClosedAt: string; // ISO 8601
}

// ---------------------------------------------------------------------------
// §8. ERROR RESPONSES
// ---------------------------------------------------------------------------

/**
 * Standard ZIMRA FDMS error response body.
 * HTTP status codes: 400 Bad Request | 401 Unauthorized | 409 Conflict | 500 Server Error
 */
export interface ZimraErrorResponse {
  /**
   * ZIMRA internal error code.
   * Common codes:
   *  "ERR_001" — Invalid activation key
   *  "ERR_002" — Certificate not found / expired
   *  "ERR_003" — Fiscal day already open
   *  "ERR_004" — Fiscal day not open (submitting without OpenDay)
   *  "ERR_005" — Receipt counter gap detected
   *  "ERR_006" — Invalid receipt signature
   *  "ERR_007" — Invalid exchange rate
   *  "ERR_008" — Day totals mismatch
   *  "ERR_009" — Device suspended
   *  "ERR_010" — Duplicate receipt submission (idempotency)
   */
  errorCode: string;
  /** Human-readable description of the error. */
  errorMessage: string;
  /** Optional field-level validation errors. */
  validationErrors?: ZimraValidationError[];
}

export interface ZimraValidationError {
  /** The JSON path of the field that failed validation (e.g., "receiptLines[0].hsCode"). */
  field: string;
  message: string;
}

// ---------------------------------------------------------------------------
// §9. VERIFICATION QR CODE PAYLOAD
// ---------------------------------------------------------------------------

/**
 * Decoded payload of the ZIMRA verification QR code printed on receipts.
 * The QR code encodes a URL:
 *   https://www.zimra.co.zw/verify?code={verificationCode}&device={deviceId}
 *
 * This interface represents the human-readable decoded data for our own
 * internal use and for receipt rendering.
 */
export interface ZimraQrCodePayload {
  /** ZIMRA verification URL (the actual string encoded in the QR). */
  verificationUrl: string;
  /** Short alphanumeric receipt verification code. */
  verificationCode: string;
  /** The ZIMRA device serial that issued this receipt. */
  deviceId: string;
  /** ZIMRA global receipt number. */
  receiptGlobalNo: number;
  /** UTC date of the receipt. */
  receiptDate: string;
  /** Grand total in the billing currency. */
  receiptTotal: number;
  /** Billing currency. */
  currency: ZimraCurrencyCode;
}

// ---------------------------------------------------------------------------
// §10. CANONICAL RECEIPT HASH INPUT
// ---------------------------------------------------------------------------

/**
 * The canonical string structure used to compute the SHA-256 receipt hash
 * before RSA signing. All fields must be concatenated in this exact order
 * with the delimiter "|" as specified in the ZIMRA FDMS developer guide.
 *
 * Final canonical string format:
 *   {deviceID}|{fiscalDayNo}|{receiptCounter}|{receiptDate}|{receiptTotal}|
 *   {receiptCurrency}|{lastReceiptGlobalNo}
 *
 * This type documents the inputs — the actual serialisation is done in
 * src/services/zimra/crypto.ts (Phase 2).
 */
export interface ZimraReceiptHashInput {
  deviceId: string;
  fiscalDayNo: number;
  receiptCounter: number;
  /** ISO 8601 UTC string — must match the value submitted in SubmitReceiptRequest. */
  receiptDate: string;
  receiptTotal: number;
  receiptCurrency: ZimraCurrencyCode;
  /** lastReceiptGlobalNo from the previous receipt (0 if first receipt). */
  previousReceiptGlobalNo: number;
}

// ---------------------------------------------------------------------------
// §11. INTERNAL SERVICE / ADAPTER TYPES
// ---------------------------------------------------------------------------

/**
 * Typed HTTP client configuration for the ZIMRA FDMS REST client.
 * (Used in Phase 2: src/services/zimra/client.ts)
 */
export interface ZimraClientConfig {
  /** ZIMRA FDMS base URL. Switch between dev/prod via environment. */
  baseUrl: string;
  /** ZIMRA device serial identifier. */
  deviceId: string;
  /** PEM-encoded device private key for signing. */
  privateKeyPem: string;
  /** PEM-encoded device x.509 certificate for mutual TLS. */
  certificatePem: string;
  /** Hex SHA-256 thumbprint of the device certificate. */
  certificateThumbprint: string;
  /** Timeout in milliseconds for FDMS API calls (default: 30 000). */
  timeoutMs?: number;
}

/**
 * Discriminated union result type used by all ZIMRA service methods.
 * Avoids exception-based error handling for expected FDMS API failures.
 */
export type ZimraResult<T> =
  | { success: true; data: T }
  | { success: false; error: ZimraErrorResponse; httpStatus: number };

/**
 * Offline-queued ZIMRA operation — mirrors OfflineSyncQueue in Prisma but
 * typed for the service layer. The payload is the fully-constructed
 * ZIMRA API request, ready to submit upon reconnection.
 */
export interface ZimraQueuedOperation {
  id: string;                        // OfflineSyncQueue PK (uuid)
  operationType: "OPEN_DAY" | "SUBMIT_RECEIPT" | "CLOSE_DAY";
  deviceId: string;
  idempotencyKey: string;
  payload:
    | ZimraOpenDayRequest
    | ZimraSubmitReceiptRequest
    | ZimraCloseDayRequest;
  attemptCount: number;
  nextRetryAt: Date | null;
}

/**
 * Z-Report summary object — constructed locally and submitted via CloseDay.
 * Also used for the end-of-day printout.
 */
export interface ZimraZReport {
  deviceId: string;
  fiscalDayNo: number;
  fiscalDayDate: string; // ISO 8601 date (YYYY-MM-DD)
  openedAt: string;      // ISO 8601 UTC
  closedAt: string;      // ISO 8601 UTC

  totalReceipts: number;
  totalSalesUsd: number;
  totalSalesZig: number;
  totalVatUsd: number;
  totalVatZig: number;
  totalDiscountsUsd: number;
  totalRefundsUsd: number;

  taxBreakdown: Array<{
    taxCategory: ZimraTaxCategory;
    salesWithTaxUsd: number;
    taxAmountUsd: number;
    salesWithTaxZig: number;
    taxAmountZig: number;
  }>;

  paymentBreakdown: Array<{
    method: ZimraPaymentType;
    totalUsd: number;
    totalZig: number;
  }>;

  lastReceiptGlobalNo: number;
  lastReceiptHash: string; // SHA-256 hex of last receipt's fiscalSignature
}