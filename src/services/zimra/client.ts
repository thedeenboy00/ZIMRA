// =============================================================================
// ZIMRA FDMS REST API Client
// src/services/zimra/client.ts
// =============================================================================
// Covers all FDMS virtual device endpoints:
//   POST   RegisterDevice
//   POST   GetServerCertificate
//   GET    GetConfig
//   POST   Heartbeat
//   POST   OpenDay
//   POST   SubmitReceipt
//   POST   CloseDay
//
// Auth model:
//   - Pre-registration: activationKey in request body only
//   - Post-registration: Bearer token = base64(deviceId:certificateThumbprint)
//     sent in `Authorization` header on every authenticated call.
//   - The certificateThumbprint is also required as a query param: ?thumbprint=…
//
// Error handling:
//   All public methods return `ZimraResult<T>` — a discriminated union.
//   No exceptions are thrown for expected API failures (4xx/5xx from ZIMRA).
//   Network-level errors (timeout, DNS failure) ARE thrown as they indicate
//   infrastructure issues that the caller's retry/offline logic must handle.
// =============================================================================

import type {
  ZimraClientConfig,
  ZimraResult,
  ZimraRegisterDeviceRequest,
  ZimraRegisterDeviceResponse,
  ZimraGetServerCertificateRequest,
  ZimraGetServerCertificateResponse,
  ZimraGetConfigResponse,
  ZimraHeartbeatRequest,
  ZimraHeartbeatResponse,
  ZimraOpenDayRequest,
  ZimraOpenDayResponse,
  ZimraSubmitReceiptRequest,
  ZimraSubmitReceiptResponse,
  ZimraCloseDayRequest,
  ZimraCloseDayResponse,
  ZimraErrorResponse,
} from "../../types/zimra.js";

// ---------------------------------------------------------------------------
// §1. CONSTANTS & DEFAULTS
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_REQUEST_RETRIES = 3;
const RETRY_DELAY_BASE_MS = 1_000;

// ZIMRA FDMS environment URLs
export const ZIMRA_ENDPOINTS = {
  /** ZIMRA FDMS development/sandbox environment. */
  DEV: "https://fdmsapidev.zimra.co.zw/Device/v1",
  /** ZIMRA FDMS production environment. */
  PROD: "https://fdmsapi.zimra.co.zw/Device/v1",
} as const;

// HTTP status codes ZIMRA uses for specific error conditions
const ZIMRA_HTTP_STATUSES = {
  OK: 200,
  BAD_REQUEST: 400,      // Malformed request / validation failure
  UNAUTHORIZED: 401,     // Invalid cert/token
  CONFLICT: 409,         // State conflict (e.g., day already open)
  UNPROCESSABLE: 422,    // Business rule violation
  SERVER_ERROR: 500,
} as const;

// ZIMRA error codes that should NOT be retried (permanent failures)
const NON_RETRYABLE_ERROR_CODES = new Set([
  "ERR_001", // Invalid activation key
  "ERR_006", // Invalid receipt signature
  "ERR_009", // Device suspended
  "ERR_010", // Duplicate receipt (already accepted)
]);

// ---------------------------------------------------------------------------
// §2. ZIMRA FDMS CLIENT CLASS
// ---------------------------------------------------------------------------

export class ZimraFdmsClient {
  private readonly config: Required<ZimraClientConfig>;

  constructor(config: ZimraClientConfig) {
    this.config = {
      ...config,
      timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    };
  }

  // ── §2.1 Bearer token construction ────────────────────────────────────────

  /**
   * Constructs the ZIMRA Bearer token.
   * Format (per FDMS API spec §3.2):
   *   base64("{deviceId}:{certificateThumbprint}")
   */
  private buildBearerToken(): string {
    const raw = `${this.config.deviceId}:${this.config.certificateThumbprint}`;
    return Buffer.from(raw, "utf8").toString("base64");
  }

  /**
   * Builds the standard authenticated request headers for all post-registration calls.
   */
  private buildAuthHeaders(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${this.buildBearerToken()}`,
    };
  }

  /**
   * Builds the device-specific endpoint URL.
   * Format: {baseUrl}/{deviceId}/{endpoint}?thumbprint={thumbprint}
   */
  private buildUrl(endpoint: string, includeThumbprint = true): string {
    const base = `${this.config.baseUrl}/${encodeURIComponent(this.config.deviceId)}/${endpoint}`;
    if (includeThumbprint) {
      const params = new URLSearchParams({
        thumbprint: this.config.certificateThumbprint,
      });
      return `${base}?${params.toString()}`;
    }
    return base;
  }

  // ── §2.2 Core HTTP request handler ────────────────────────────────────────

  /**
   * Core HTTP request method wrapping the native fetch API.
   * Handles timeouts, JSON parsing, and maps ZIMRA error responses to
   * typed `ZimraResult<T>` discriminated union results.
   *
   * Network-level failures (DNS, timeout, TLS) throw — the caller's
   * offline sync layer is responsible for catching and queuing these.
   */
  private async request<TResponse>(
    method: "GET" | "POST",
    url: string,
    headers: Record<string, string>,
    body?: unknown
  ): Promise<ZimraResult<TResponse>> {
    const controller = new AbortController();
    const timeoutHandle = setTimeout(
      () => controller.abort(),
      this.config.timeoutMs
    );

    try {
      const response = await fetch(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      clearTimeout(timeoutHandle);

      // Parse response body (always JSON from ZIMRA)
      let responseBody: unknown;
      const contentType = response.headers.get("content-type") ?? "";
      if (contentType.includes("application/json")) {
        responseBody = await response.json();
      } else {
        // Unexpected content type — treat as error
        const text = await response.text();
        responseBody = {
          errorCode: "ERR_UNEXPECTED_CONTENT",
          errorMessage: `ZIMRA returned non-JSON response (${response.status}): ${text.slice(0, 200)}`,
        };
      }

      if (response.ok) {
        return { success: true, data: responseBody as TResponse };
      }

      // ZIMRA API error response
      return {
        success: false,
        error: responseBody as ZimraErrorResponse,
        httpStatus: response.status,
      };
    } catch (error) {
      clearTimeout(timeoutHandle);

      if ((error as Error).name === "AbortError") {
        throw new ZimraTimeoutError(
          `ZIMRA FDMS request timed out after ${this.config.timeoutMs}ms: ${method} ${url}`
        );
      }

      // Re-throw network errors (connection refused, DNS failure, etc.)
      throw new ZimraNetworkError(
        `ZIMRA FDMS network error for ${method} ${url}: ${(error as Error).message}`,
        error as Error
      );
    }
  }

  // ── §2.3 POST helper with automatic idempotency header ────────────────────

  private async post<TResponse>(
    endpoint: string,
    body: unknown,
    options: { includeThumbprint?: boolean; idempotencyKey?: string } = {}
  ): Promise<ZimraResult<TResponse>> {
    const { includeThumbprint = true, idempotencyKey } = options;
    const url = this.buildUrl(endpoint, includeThumbprint);
    const headers = this.buildAuthHeaders();

    if (idempotencyKey) {
      headers["X-Idempotency-Key"] = idempotencyKey;
    }

    return this.request<TResponse>("POST", url, headers, body);
  }

  private async get<TResponse>(
    endpoint: string
  ): Promise<ZimraResult<TResponse>> {
    const url = this.buildUrl(endpoint);
    const headers = this.buildAuthHeaders();
    return this.request<TResponse>("GET", url, headers);
  }

  // ---------------------------------------------------------------------------
  // §3. DEVICE REGISTRATION (unauthenticated — uses activationKey)
  // ---------------------------------------------------------------------------

  /**
   * Registers a new virtual fiscal device with ZIMRA.
   *
   * POST /Device/v1/{deviceID}/RegisterDevice
   *
   * This endpoint does NOT require Bearer auth — only the activationKey
   * from the ZIMRA operator portal and the PKCS#10 CSR.
   *
   * On success:
   *   1. Store `certificate` (PEM) in Device.certificatePem
   *   2. Compute and store `certificateThumbprint` in Device.certificateThumb
   *   3. Parse `certificateValidTill` and store in Device.certExpiresAt
   *   4. Update Device.status to ACTIVE
   *
   * @param activationKey     - Key from ZIMRA operator portal.
   * @param csrPem            - PKCS#10 CSR generated by `generateCsr()`.
   */
  async registerDevice(
    activationKey: string,
    csrPem: string
  ): Promise<ZimraResult<ZimraRegisterDeviceResponse>> {
    // RegisterDevice uses a minimal URL — no thumbprint param, no Bearer auth
    const url = `${this.config.baseUrl}/${encodeURIComponent(this.config.deviceId)}/RegisterDevice`;
    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    const body: ZimraRegisterDeviceRequest = {
      activationKey,
      certificateRequest: csrPem,
    };

    return this.request<ZimraRegisterDeviceResponse>(
      "POST",
      url,
      headers,
      body
    );
  }

  // ---------------------------------------------------------------------------
  // §4. SERVER CERTIFICATE
  // ---------------------------------------------------------------------------

  /**
   * Retrieves ZIMRA's own CA certificate for TLS pinning.
   *
   * POST /Device/v1/{deviceID}/GetServerCertificate
   *
   * Store the returned certificate and use it as a trusted root when making
   * subsequent FDMS API calls (mutual TLS verification).
   */
  async getServerCertificate(): Promise<
    ZimraResult<ZimraGetServerCertificateResponse>
  > {
    const body: ZimraGetServerCertificateRequest = {
      certificateThumbprint: this.config.certificateThumbprint,
    };
    return this.post<ZimraGetServerCertificateResponse>(
      "GetServerCertificate",
      body
    );
  }

  // ---------------------------------------------------------------------------
  // §5. DEVICE CONFIGURATION
  // ---------------------------------------------------------------------------

  /**
   * Retrieves current device configuration from ZIMRA.
   *
   * GET /Device/v1/{deviceID}/GetConfig
   *
   * Call this:
   *   - On application startup to get current tax rates
   *   - After an offline period to reconcile fiscal day state
   *   - Before opening a fiscal day to verify device is Active
   *
   * The returned `taxRates` array is the authoritative source of truth for
   * VAT rates — do NOT hardcode rates in the application.
   */
  async getConfig(): Promise<ZimraResult<ZimraGetConfigResponse>> {
    return this.get<ZimraGetConfigResponse>("GetConfig");
  }

  // ---------------------------------------------------------------------------
  // §6. HEARTBEAT
  // ---------------------------------------------------------------------------

  /**
   * Sends a keepalive heartbeat to ZIMRA.
   *
   * POST /Device/v1/{deviceID}/Heartbeat
   *
   * ZIMRA requires heartbeats at least every 2 hours during an open fiscal day.
   * Schedule this with a background job (e.g., every 90 minutes for safety margin).
   *
   * A failed heartbeat is NOT a blocking error — the day can continue offline.
   * Log the failure and ensure the offline sync queue picks it up.
   *
   * @param fiscalDayNo     - Current open fiscal day number.
   * @param fiscalDayStatus - Must be "FiscalDayOpened" during normal operation.
   */
  async sendHeartbeat(
    fiscalDayNo: number,
    fiscalDayStatus: "FiscalDayOpened"
  ): Promise<ZimraResult<ZimraHeartbeatResponse>> {
    const body: ZimraHeartbeatRequest = { fiscalDayNo, fiscalDayStatus };
    return this.post<ZimraHeartbeatResponse>("Heartbeat", body);
  }

  // ---------------------------------------------------------------------------
  // §7. OPEN FISCAL DAY
  // ---------------------------------------------------------------------------

  /**
   * Opens a new fiscal day on the ZIMRA FDMS.
   *
   * POST /Device/v1/{deviceID}/OpenDay
   *
   * Preconditions (validate BEFORE calling):
   *   - Device.status === ACTIVE
   *   - No currently open FiscalDay for this device
   *   - `fiscalDayNo` = Device.lastFiscalDayNo + 1
   *   - A CurrencyRate exists for today (ZiG/USD)
   *
   * On success:
   *   1. Create FiscalDay record with status OPEN
   *   2. Update Device.lastFiscalDayNo
   *   3. Store `fiscalDayOpenedToken` in FiscalDay.zimraOpenToken
   *
   * @param fiscalDayNo  - Next sequential day number (lastFiscalDayNo + 1).
   * @param openedAt     - UTC ISO-8601 timestamp of day open event.
   * @param idempotencyKey - Unique key for offline dedup (UUID).
   */
  async openDay(
    fiscalDayNo: number,
    openedAt: Date,
    idempotencyKey: string
  ): Promise<ZimraResult<ZimraOpenDayResponse>> {
    const body: ZimraOpenDayRequest = {
      fiscalDayNo,
      fiscalDayOpened: openedAt.toISOString(),
    };
    return this.post<ZimraOpenDayResponse>("OpenDay", body, {
      idempotencyKey,
    });
  }

  // ---------------------------------------------------------------------------
  // §8. SUBMIT RECEIPT
  // ---------------------------------------------------------------------------

  /**
   * Submits a fiscal receipt to ZIMRA for signing and recording.
   *
   * POST /Device/v1/{deviceID}/SubmitReceipt
   *
   * Preconditions (validate BEFORE calling):
   *   - FiscalDay is in OPEN status
   *   - `receiptCounter` = last accepted receiptCounter + 1 (per device)
   *   - `receiptGlobalNo` = last accepted receiptGlobalNo (from previous response)
   *   - `receiptDeviceSignature` has been computed via `buildReceiptSignature()`
   *
   * On success:
   *   1. Update Sale with:
   *      - receiptGlobalNo (from response)
   *      - zimraQrCode (receiptQRUrl from response)
   *      - zimraVerifyUrl
   *      - status = FISCALLY_ACCEPTED
   *      - zimraSubmittedAt = now()
   *   2. Update Device.lastReceiptGlobalNo
   *
   * ZIMRA uses `receiptGlobalNo` to detect sequence gaps. If the last accepted
   * receipt's globalNo differs from what you send, ZIMRA will return ERR_005.
   *
   * @param receipt        - Fully constructed `ZimraSubmitReceiptRequest`.
   * @param idempotencyKey - Unique key (UUID) to prevent duplicate submissions.
   */
  async submitReceipt(
    receipt: ZimraSubmitReceiptRequest,
    idempotencyKey: string
  ): Promise<ZimraResult<ZimraSubmitReceiptResponse>> {
    return this.post<ZimraSubmitReceiptResponse>("SubmitReceipt", receipt, {
      idempotencyKey,
    });
  }

  // ---------------------------------------------------------------------------
  // §9. CLOSE FISCAL DAY
  // ---------------------------------------------------------------------------

  /**
   * Closes the current fiscal day and submits the Z-Report to ZIMRA.
   *
   * POST /Device/v1/{deviceID}/CloseDay
   *
   * This is a two-phase process:
   *   Phase 1 — Set FiscalDay.status = CLOSE_INITIATED, set closeInitiatedAt.
   *   Phase 2 — Call this method. On success, set status = CLOSED.
   *
   * ZIMRA cross-validates the Z-Report totals against all individually
   * submitted receipts. If totals don't match, ZIMRA returns ERR_008.
   *
   * After a successful close:
   *   1. Update FiscalDay.status = CLOSED
   *   2. Store FiscalDay.zimraCloseToken
   *   3. Update FiscalDay.closedAt
   *   4. No more receipts can be submitted until next OpenDay
   *
   * @param closeRequest   - Fully constructed `ZimraCloseDayRequest` (Z-Report).
   * @param idempotencyKey - Unique key (UUID) for dedup.
   */
  async closeDay(
    closeRequest: ZimraCloseDayRequest,
    idempotencyKey: string
  ): Promise<ZimraResult<ZimraCloseDayResponse>> {
    return this.post<ZimraCloseDayResponse>("CloseDay", closeRequest, {
      idempotencyKey,
    });
  }
}

// ---------------------------------------------------------------------------
// §10. FACTORY FUNCTION
// ---------------------------------------------------------------------------

/**
 * Creates a configured `ZimraFdmsClient` instance from environment variables
 * and decrypted device credentials.
 *
 * @param config - Device-specific ZIMRA credentials from the database.
 */
export function createZimraClient(config: ZimraClientConfig): ZimraFdmsClient {
  const baseUrl =
    process.env.ZIMRA_ENVIRONMENT === "production"
      ? ZIMRA_ENDPOINTS.PROD
      : ZIMRA_ENDPOINTS.DEV;

  return new ZimraFdmsClient({
    ...config,
    baseUrl: config.baseUrl || baseUrl,
    timeoutMs: config.timeoutMs ?? Number(process.env.ZIMRA_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS),
  });
}

// ---------------------------------------------------------------------------
// §11. RETRY UTILITY
// ---------------------------------------------------------------------------

/**
 * Retries a ZIMRA API call with exponential backoff.
 *
 * Only retries on network errors or retryable ZIMRA error codes.
 * Permanent ZIMRA errors (ERR_001, ERR_006, ERR_009, ERR_010) are
 * returned immediately without retry.
 *
 * @param fn          - Async function that performs a single ZIMRA API call.
 * @param maxRetries  - Maximum number of attempts (default: 3).
 * @param baseDelayMs - Initial delay in milliseconds (doubles each retry).
 */
export async function withZimraRetry<T>(
  fn: () => Promise<ZimraResult<T>>,
  maxRetries = MAX_REQUEST_RETRIES,
  baseDelayMs = RETRY_DELAY_BASE_MS
): Promise<ZimraResult<T>> {
  let lastResult: ZimraResult<T> | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await fn();

      // Permanent API error — do not retry
      if (
        !result.success &&
        NON_RETRYABLE_ERROR_CODES.has(result.error.errorCode)
      ) {
        return result;
      }

      // Success or retryable error
      if (result.success) return result;

      // 4xx client errors (except 409 Conflict which can be transient)
      if (
        result.httpStatus >= 400 &&
        result.httpStatus < 500 &&
        result.httpStatus !== 409
      ) {
        return result;
      }

      lastResult = result;
    } catch (error) {
      // Network/timeout errors — retry if attempts remain
      if (attempt === maxRetries) throw error;

      const delay = baseDelayMs * Math.pow(2, attempt);
      const jitter = Math.random() * delay * 0.2; // ±20% jitter
      await sleep(delay + jitter);
      continue;
    }

    if (attempt < maxRetries) {
      const delay = baseDelayMs * Math.pow(2, attempt);
      const jitter = Math.random() * delay * 0.2;
      await sleep(delay + jitter);
    }
  }

  return lastResult!;
}

// ---------------------------------------------------------------------------
// §12. RESULT HELPERS
// ---------------------------------------------------------------------------

/**
 * Type guard that narrows a `ZimraResult<T>` to its success branch.
 */
export function isZimraSuccess<T>(
  result: ZimraResult<T>
): result is { success: true; data: T } {
  return result.success === true;
}

/**
 * Unwraps a `ZimraResult<T>` or throws a descriptive `ZimraApiError`.
 * Use in contexts where a ZIMRA failure should propagate as an exception
 * (e.g., device registration during initial setup where there's no fallback).
 */
export function unwrapZimraResult<T>(result: ZimraResult<T>): T {
  if (result.success) return result.data;
  throw new ZimraApiError(
    result.error.errorCode,
    result.error.errorMessage,
    result.httpStatus,
    result.error.validationErrors
  );
}

// ---------------------------------------------------------------------------
// §13. CUSTOM ERROR CLASSES
// ---------------------------------------------------------------------------

export class ZimraApiError extends Error {
  constructor(
    public readonly errorCode: string,
    public readonly errorMessage: string,
    public readonly httpStatus: number,
    public readonly validationErrors?: Array<{ field: string; message: string }>
  ) {
    super(`ZIMRA API Error [${errorCode}] HTTP ${httpStatus}: ${errorMessage}`);
    this.name = "ZimraApiError";
  }

  /** True if this error represents a duplicate submission (safe to ignore). */
  get isDuplicate(): boolean {
    return this.errorCode === "ERR_010";
  }

  /** True if the device has been suspended by ZIMRA. */
  get isDeviceSuspended(): boolean {
    return this.errorCode === "ERR_009";
  }

  /** True if the fiscal day state is inconsistent with the ZIMRA server. */
  get isFiscalDayConflict(): boolean {
    return this.errorCode === "ERR_003" || this.errorCode === "ERR_004";
  }
}

export class ZimraNetworkError extends Error {
  constructor(
    message: string,
    public readonly cause: Error
  ) {
    super(message);
    this.name = "ZimraNetworkError";
  }
}

export class ZimraTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZimraTimeoutError";
  }
}

// ---------------------------------------------------------------------------
// §14. PRIVATE UTILITIES
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}