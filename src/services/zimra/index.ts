// =============================================================================
// ZIMRA Services — Public API barrel
// src/services/zimra/index.ts
// =============================================================================
// Import from this barrel rather than individual files to keep import paths
// stable and to allow internal refactoring without touching consumers.
//
// Usage:
//   import { ZimraFdmsClient, FiscalDayService, buildReceiptSignature } from
//     '../services/zimra/index.js';
// =============================================================================

// ── Cryptography ─────────────────────────────────────────────────────────────
export {
  generateDeviceKeyPair,
  generateCsr,
  parseCertificate,
  assertCertificateValid,
  hashReceipt,
  buildCanonicalReceiptString,
  signReceipt,
  buildReceiptSignature,
  verifyReceiptSignature,
  verifyZimraFiscalSignature,
  encryptPrivateKey,
  decryptPrivateKey,
  deriveEncryptionKey,
  type GeneratedKeyPair,
  type GeneratedCsr,
  type ParsedCertificate,
  type EncryptedPrivateKey,
} from "./crypto.js";

// ── REST Client ───────────────────────────────────────────────────────────────
export {
  ZimraFdmsClient,
  createZimraClient,
  withZimraRetry,
  isZimraSuccess,
  unwrapZimraResult,
  ZimraApiError,
  ZimraNetworkError,
  ZimraTimeoutError,
  ZIMRA_ENDPOINTS,
} from "./client.js";

// ── Device Registration ───────────────────────────────────────────────────────
export {
  DeviceRegistrationService,
  DeviceAlreadyRegisteredError,
  DeviceRegistrationFailedError,
  DeviceNotReadyError,
  type DeviceRegistrationInput,
  type DeviceRegistrationResult,
  type DeviceCredentials,
} from "./deviceRegistration.js";

// ── Fiscal Day & Receipt Submission ───────────────────────────────────────────
export {
  FiscalDayService,
  FiscalDayAlreadyOpenError,
  FiscalDayNotOpenError,
  MissingCurrencyRateError,
  PendingSalesError,
  DeviceNotActiveError,
  type OpenDayInput,
  type OpenDayResult,
  type SubmitReceiptInput,
  type SubmitReceiptResult,
  type CloseDayInput,
  type CloseDayResult,
} from "./fiscalDay.js";