// =============================================================================
// Sync Services — Public barrel
// src/services/sync/index.ts
// =============================================================================

// ── Offline Database (Dexie / IndexedDB) ─────────────────────────────────────
export {
  ZimraPosOfflineDb,
  getOfflineDb,
  deleteOfflineDb,
  parseSaleItems,
  serialiseSaleItems,
  parsePayments,
  serialisePayments,
  parseSyncPayload,
  type LocalSale,
  type LocalSaleItem,
  type LocalProduct,
  type LocalFiscalDay,
  type LocalSyncQueueEntry,
  type LocalCurrencyRate,
  type LocalDevice,
  type LocalSignedReceipt,
} from "./offlineDb.js";

// ── Offline Sync Manager ───────────────────────────────────────────────────────
export {
  OfflineSyncManager,
  computeNextRetry,
  SyncDispatchError,
  type SyncManagerConfig,
  type SyncEventType,
  type SyncEvent,
  type SyncEventListener,
} from "./offlineSyncManager.js";

// ── React Hooks (client-side only) ───────────────────────────────────────────
export {
  SyncManagerProvider,
  useSyncManager,
  useSyncStatus,
  useConnectivity,
  useFailedSyncEntries,
  useLocalRate,
  useProductSearch,
  type SyncStatus,
} from "./useSyncManager.js";