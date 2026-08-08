// =============================================================================
// Offline-First Local Database — Dexie.js (IndexedDB)
// src/services/sync/offlineDb.ts
// =============================================================================
// This module defines the client-side (browser/Electron) IndexedDB schema
// using Dexie.js. It mirrors the PostgreSQL schema for the subset of entities
// that must be available offline:
//
//   LocalSale          → mirrors Sale + SaleItems (denormalised for speed)
//   LocalProduct       → mirrors Product (for POS product search offline)
//   LocalFiscalDay     → mirrors FiscalDay (current day's state)
//   LocalSyncQueue     → mirrors OfflineSyncQueue (pending ZIMRA operations)
//   LocalCurrencyRate  → mirrors CurrencyRate (today + last 7 days)
//   LocalDevice        → mirrors Device (device identity & counters)
//   LocalReceipt       → signed ZIMRA receipt payloads ready to print/submit
//
// Version history:
//   v1 — Initial schema (Phase 3)
// =============================================================================

import Dexie, { type Table } from "dexie";
import type {
  ZimraSubmitReceiptRequest,
  ZimraOpenDayRequest,
  ZimraCloseDayRequest,
  ZimraTaxCategory,
} from "../../types/zimra.js";

// ---------------------------------------------------------------------------
// §1. LOCAL ENTITY TYPES
// ---------------------------------------------------------------------------

/**
 * Denormalised sale record stored locally on the POS device.
 * Combines the Sale header and all SaleItems into a single document
 * to minimise IndexedDB reads during offline receipt generation.
 */
export interface LocalSale {
  /** Client-generated UUID — used as idempotency key on server sync. */
  id: string;
  /** Server-side DB UUID — set after first successful server sync. */
  serverSaleId?: string;
  tenantId: string;
  deviceId: string;               // ZIMRA device serial
  deviceDbId: string;             // Server-side Device UUID
  fiscalDayNo: number;
  fiscalDayDbId?: string;         // Set after OpenDay succeeds
  cashierId: string;
  cashierName: string;

  // Status lifecycle
  /** "DRAFT" | "COMPLETED" | "SYNC_PENDING" | "FISCALLY_ACCEPTED" | "FISCALLY_REJECTED" | "VOIDED" */
  status: string;
  receiptType: string;            // "FISCAL_INVOICE" | "FISCAL_CREDIT_NOTE" | ...
  referenceReceiptId?: string;    // For credit notes

  // Timestamps
  createdAt: number;              // Unix ms — Dexie indexes numbers, not Dates
  updatedAt: number;
  completedAt?: number;

  // Customer (optional)
  customerName?: string;
  customerVatNumber?: string;
  customerTinNumber?: string;
  customerAddress?: string;

  // Monetary totals
  subtotalUsd: number;
  discountUsd: number;
  vatTotalUsd: number;
  grandTotalUsd: number;
  grandTotalZig: number;
  exchangeRateUsed: number;       // ZiG per USD at time of sale

  // Payments — JSON stringified PaymentLine[] for IndexedDB storage
  paymentsJson: string;
  changeDueUsd: number;
  changeDueZig: number;

  // Line items — JSON stringified LocalSaleItem[]
  itemsJson: string;

  // ZIMRA fiscal data (populated after submission)
  receiptCounter?: number;
  receiptGlobalNo?: number;
  fiscalHash?: string;
  fiscalSignature?: string;
  zimraQrCode?: string;
  zimraVerifyUrl?: string;
  zimraSubmittedAt?: number;
  zimraResponseCode?: string;
  zimraErrorMessage?: string;

  // Sync
  needsServerSync: boolean;       // True if not yet persisted to PostgreSQL
  needsZimraSync: boolean;        // True if not yet submitted to ZIMRA
  receiptNumber?: string;

  notes?: string;
}

/**
 * Line item embedded inside `LocalSale.itemsJson`.
 */
export interface LocalSaleItem {
  id: string;
  productId?: string;
  sku: string;
  productName: string;
  hsCode?: string;
  taxCategory: ZimraTaxCategory;
  quantity: number;
  unit: string;
  unitPriceExclVatUsd: number;
  vatRate: number;
  vatAmountUsd: number;
  lineTotalUsd: number;
  taxableAmountUsd: number;
  discountUsd: number;
  discountPercent: number;
  lineOrder: number;
}

/**
 * Product record cached locally for offline POS search.
 */
export interface LocalProduct {
  id: string;                     // Server Product UUID
  tenantId: string;
  sku: string;
  barcode?: string;
  name: string;
  description?: string;
  productType: string;
  priceInclVatUsd: number;        // Shelf price inclusive of VAT
  priceExclVatUsd: number;
  vatRate: number;
  taxCategory: ZimraTaxCategory;
  hsCode?: string;
  unit: string;
  trackInventory: boolean;
  stockQuantity: number;
  isActive: boolean;
  syncedAt: number;               // Unix ms of last sync from server
}

/**
 * Local fiscal day state — single record per device per day.
 */
export interface LocalFiscalDay {
  id: string;                     // Client UUID
  serverFiscalDayId?: string;     // Server FiscalDay UUID (set after OpenDay sync)
  tenantId: string;
  deviceId: string;               // ZIMRA device serial
  deviceDbId: string;
  fiscalDayNo: number;
  fiscalDayDate: string;          // "YYYY-MM-DD"
  /** "OPEN" | "CLOSE_INITIATED" | "CLOSED" | "FORCE_CLOSED" */
  status: string;
  openedAt: number;               // Unix ms
  closedAt?: number;
  zimraOpenToken?: string;
  zimraCloseToken?: string;
  /** True if OpenDay has not yet been acknowledged by ZIMRA. */
  pendingOpen: boolean;
  /** True if CloseDay has not yet been acknowledged by ZIMRA. */
  pendingClose: boolean;
  exchangeRateZigPerUsd: number;  // Rate locked in at day open
}

/**
 * Offline sync queue entry — mirrors OfflineSyncQueue in PostgreSQL.
 * Operations are processed in priority + createdAt order.
 */
export interface LocalSyncQueueEntry {
  /** Client-generated UUID. */
  id: string;
  /** Mirrors server OfflineSyncQueue.idempotencyKey. */
  idempotencyKey: string;
  tenantId: string;
  deviceId: string;
  deviceDbId: string;
  /** "OPEN_DAY" | "SUBMIT_RECEIPT" | "CLOSE_DAY" | "SYNC_SALE" */
  operationType: string;
  /** "Sale" | "FiscalDay" */
  entityType: string;
  entityId: string;               // Local entity ID
  /** 1=urgent (OpenDay/CloseDay), 2=receipt, 3=server sync */
  priority: number;
  /** "PENDING" | "IN_FLIGHT" | "SUCCEEDED" | "FAILED" | "RETRYING" */
  status: string;

  // Serialised request payload (ready to POST to ZIMRA or server API)
  payloadJson: string;

  // Retry state
  attemptCount: number;
  maxAttempts: number;
  nextRetryAt: number;            // Unix ms
  lastAttemptAt?: number;
  lastErrorCode?: string;
  lastErrorMessage?: string;
  succeededAt?: number;

  createdAt: number;
  updatedAt: number;
}

/**
 * Local copy of today's (and recent) ZiG/USD exchange rates.
 */
export interface LocalCurrencyRate {
  /** "tenantId:YYYY-MM-DD:USD:ZIG" */
  id: string;
  tenantId: string;
  rateDate: string;               // "YYYY-MM-DD"
  fromCurrency: string;
  toCurrency: string;
  rate: number;                   // ZiG per 1 USD
  rateSource: string;
  syncedAt: number;
}

/**
 * Local device identity and fiscal counters.
 * Single record per POS terminal instance.
 */
export interface LocalDevice {
  id: string;                     // Server Device UUID
  deviceId: string;               // ZIMRA device serial
  tenantId: string;
  deviceName: string;
  status: string;
  lastReceiptCounter: number;
  lastReceiptGlobalNo: number;
  lastFiscalDayNo: number;
  certificateThumb?: string;
  certExpiresAt?: number;         // Unix ms
  branchName?: string;
  syncedAt: number;
}

/**
 * Fully constructed ZIMRA receipt payload — stored locally so that
 * signed receipts can be re-submitted without re-signing after failures.
 */
export interface LocalSignedReceipt {
  /** Matches LocalSale.id */
  saleId: string;
  idempotencyKey: string;
  payload: ZimraSubmitReceiptRequest;
  signedAt: number;               // Unix ms
  submittedAt?: number;
  /** "PENDING" | "SUBMITTED" | "ACCEPTED" | "REJECTED" */
  submissionStatus: string;
  zimraReceiptGlobalNo?: number;
  zimraQrUrl?: string;
  zimraVerificationCode?: string;
  lastError?: string;
}

// ---------------------------------------------------------------------------
// §2. DEXIE DATABASE CLASS
// ---------------------------------------------------------------------------

export class ZimraPosOfflineDb extends Dexie {
  sales!: Table<LocalSale, string>;
  products!: Table<LocalProduct, string>;
  fiscalDays!: Table<LocalFiscalDay, string>;
  syncQueue!: Table<LocalSyncQueueEntry, string>;
  currencyRates!: Table<LocalCurrencyRate, string>;
  devices!: Table<LocalDevice, string>;
  signedReceipts!: Table<LocalSignedReceipt, string>;

  constructor() {
    super("ZimraPosOfflineDb");

    this.version(1).stores({
      // ── Sales ─────────────────────────────────────────────────────────
      // Primary key: id
      // Compound indexes for common query patterns
      sales: [
        "id",
        "tenantId",
        "deviceId",
        "status",
        "fiscalDayNo",
        "createdAt",
        "needsServerSync",
        "needsZimraSync",
        "[tenantId+status]",
        "[deviceId+fiscalDayNo]",
        "[tenantId+createdAt]",
        "receiptNumber",
      ].join(", "),

      // ── Products ──────────────────────────────────────────────────────
      products: [
        "id",
        "tenantId",
        "sku",
        "barcode",
        "name",
        "isActive",
        "[tenantId+isActive]",
        "[tenantId+sku]",
      ].join(", "),

      // ── Fiscal Days ───────────────────────────────────────────────────
      fiscalDays: [
        "id",
        "deviceId",
        "tenantId",
        "status",
        "fiscalDayNo",
        "fiscalDayDate",
        "[deviceId+fiscalDayDate]",
        "[deviceId+status]",
      ].join(", "),

      // ── Sync Queue ────────────────────────────────────────────────────
      // Indexed by priority + nextRetryAt for the worker's poll query
      syncQueue: [
        "id",
        "idempotencyKey",
        "tenantId",
        "deviceId",
        "status",
        "operationType",
        "entityId",
        "priority",
        "nextRetryAt",
        "[status+priority+nextRetryAt]",
        "[deviceId+status]",
      ].join(", "),

      // ── Currency Rates ─────────────────────────────────────────────────
      currencyRates: [
        "id",
        "tenantId",
        "rateDate",
        "[tenantId+rateDate]",
      ].join(", "),

      // ── Devices ───────────────────────────────────────────────────────
      devices: ["id", "deviceId", "tenantId"].join(", "),

      // ── Signed Receipts ───────────────────────────────────────────────
      signedReceipts: [
        "saleId",
        "idempotencyKey",
        "submissionStatus",
      ].join(", "),
    });
  }
}

// ---------------------------------------------------------------------------
// §3. SINGLETON INSTANCE
// ---------------------------------------------------------------------------

let _db: ZimraPosOfflineDb | null = null;

/**
 * Returns the singleton Dexie database instance.
 * Safe to call multiple times — creates the instance on first call.
 *
 * For server-side code (Next.js API routes, Node.js), import the Prisma
 * client instead. Dexie/IndexedDB is browser-only.
 */
export function getOfflineDb(): ZimraPosOfflineDb {
  if (typeof window === "undefined") {
    throw new Error(
      "getOfflineDb() must only be called in browser/client contexts. " +
        "Use PrismaClient for server-side database access."
    );
  }
  if (!_db) {
    _db = new ZimraPosOfflineDb();
  }
  return _db;
}

/**
 * Deletes the entire IndexedDB database (for testing / device reset).
 * WARNING: This permanently destroys all locally stored data.
 */
export async function deleteOfflineDb(): Promise<void> {
  if (_db) {
    await _db.delete();
    _db = null;
  } else {
    await Dexie.delete("ZimraPosOfflineDb");
  }
}

// ---------------------------------------------------------------------------
// §4. HELPER — parse/serialise JSON fields
// ---------------------------------------------------------------------------

export function parseSaleItems(sale: LocalSale): LocalSaleItem[] {
  try {
    return JSON.parse(sale.itemsJson) as LocalSaleItem[];
  } catch {
    return [];
  }
}

export function serialiseSaleItems(items: LocalSaleItem[]): string {
  return JSON.stringify(items);
}

export function parsePayments(
  sale: LocalSale
): Array<{ method: string; amountUsd: number; amountZig: number }> {
  try {
    return JSON.parse(sale.paymentsJson);
  } catch {
    return [];
  }
}

export function serialisePayments(
  payments: Array<{ method: string; amountUsd: number; amountZig: number }>
): string {
  return JSON.stringify(payments);
}

export function parseSyncPayload(
  entry: LocalSyncQueueEntry
): ZimraSubmitReceiptRequest | ZimraOpenDayRequest | ZimraCloseDayRequest {
  return JSON.parse(entry.payloadJson);
}