// =============================================================================
// React Hooks — Offline Sync Manager
// src/services/sync/useSyncManager.ts
// =============================================================================
// Provides React-friendly hooks that wrap OfflineSyncManager for use in
// the Next.js POS UI (Phase 4). Three hooks:
//
//   useSyncManager()     — Access the singleton manager instance
//   useSyncStatus()      — Live queue depth, online state, last sync time
//   useConnectivity()    — Simple boolean online/offline indicator
// =============================================================================

"use client";

import {
  useState,
  useEffect,
  useRef,
  useCallback,
  createContext,
  useContext,
  type ReactNode,
} from "react";

import {
  OfflineSyncManager,
  type SyncEvent,
  type SyncManagerConfig,
} from "./offlineSyncManager.js";

// ---------------------------------------------------------------------------
// §1. SYNC STATUS STATE
// ---------------------------------------------------------------------------

export interface SyncStatus {
  isOnline: boolean;
  pendingCount: number;
  failedCount: number;
  inFlightCount: number;
  lastSyncAt: Date | null;
  lastError: string | null;
  oldestPendingAt: Date | null;
}

const DEFAULT_STATUS: SyncStatus = {
  isOnline: typeof navigator !== "undefined" ? navigator.onLine : true,
  pendingCount: 0,
  failedCount: 0,
  inFlightCount: 0,
  lastSyncAt: null,
  lastError: null,
  oldestPendingAt: null,
};

// ---------------------------------------------------------------------------
// §2. REACT CONTEXT
// ---------------------------------------------------------------------------

interface SyncManagerContextValue {
  manager: OfflineSyncManager | null;
  status: SyncStatus;
}

const SyncManagerContext = createContext<SyncManagerContextValue>({
  manager: null,
  status: DEFAULT_STATUS,
});

// ---------------------------------------------------------------------------
// §3. CONTEXT PROVIDER
// ---------------------------------------------------------------------------

interface SyncManagerProviderProps {
  config: SyncManagerConfig;
  children: ReactNode;
}

/**
 * Wraps the application (or POS layout) to provide the sync manager
 * singleton and live status to all child components.
 *
 * Place this in the Next.js root layout or POS shell component:
 *
 * ```tsx
 * <SyncManagerProvider config={syncConfig}>
 *   <PosLayout />
 * </SyncManagerProvider>
 * ```
 */
export function SyncManagerProvider({
  config,
  children,
}: SyncManagerProviderProps) {
  const managerRef = useRef<OfflineSyncManager | null>(null);
  const [status, setStatus] = useState<SyncStatus>(DEFAULT_STATUS);

  useEffect(() => {
    // Initialise manager singleton
    if (!managerRef.current) {
      managerRef.current = new OfflineSyncManager(config);
    }
    const manager = managerRef.current;

    // Subscribe to sync events and update React state
    const unsubscribe = manager.on((event: SyncEvent) => {
      setStatus((prev) => applyEventToStatus(prev, event));

      // Refresh full queue status on significant events
      if (
        event.type === "queue:succeeded" ||
        event.type === "queue:failed" ||
        event.type === "queue:empty"
      ) {
        manager.getQueueStatus().then((qs) => {
          setStatus((prev) => ({
            ...prev,
            pendingCount: qs.pendingCount,
            failedCount: qs.failedCount,
            inFlightCount: qs.inFlightCount,
            oldestPendingAt: qs.oldestPendingAt,
          }));
        });
      }
    });

    manager.start();

    // Initial state fetch
    manager.getQueueStatus().then((qs) => {
      setStatus((prev) => ({
        ...prev,
        isOnline: qs.isOnline,
        pendingCount: qs.pendingCount,
        failedCount: qs.failedCount,
        inFlightCount: qs.inFlightCount,
        oldestPendingAt: qs.oldestPendingAt,
      }));
    });

    return () => {
      unsubscribe();
      manager.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Run once on mount

  return (
    <SyncManagerContext.Provider value={{ manager: managerRef.current, status }}>
      {children}
    </SyncManagerContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// §4. useSyncManager — access to the manager instance
// ---------------------------------------------------------------------------

/**
 * Returns the `OfflineSyncManager` singleton.
 * Use for imperative calls: `manager.storeSignedReceipt(...)`.
 *
 * @throws Error if called outside of `<SyncManagerProvider>`.
 */
export function useSyncManager(): OfflineSyncManager {
  const { manager } = useContext(SyncManagerContext);
  if (!manager) {
    throw new Error(
      "useSyncManager() must be called inside a <SyncManagerProvider>."
    );
  }
  return manager;
}

// ---------------------------------------------------------------------------
// §5. useSyncStatus — live queue state
// ---------------------------------------------------------------------------

/**
 * Returns the live sync status, updated reactively on every sync event.
 *
 * ```tsx
 * const { isOnline, pendingCount, failedCount } = useSyncStatus();
 * ```
 */
export function useSyncStatus(): SyncStatus {
  return useContext(SyncManagerContext).status;
}

// ---------------------------------------------------------------------------
// §6. useConnectivity — simple boolean
// ---------------------------------------------------------------------------

/**
 * Returns `true` when the device is online and the backend is reachable.
 * Useful for disabling/enabling UI elements based on connectivity.
 *
 * ```tsx
 * const isOnline = useConnectivity();
 * return <Button disabled={!isOnline}>Sync Now</Button>
 * ```
 */
export function useConnectivity(): boolean {
  return useContext(SyncManagerContext).status.isOnline;
}

// ---------------------------------------------------------------------------
// §7. useFailedSyncEntries — failed queue items for admin screen
// ---------------------------------------------------------------------------

/**
 * Returns failed sync queue entries and a retry handler.
 *
 * ```tsx
 * const { entries, retry } = useFailedSyncEntries();
 * ```
 */
export function useFailedSyncEntries(): {
  entries: import("./offlineDb.js").LocalSyncQueueEntry[];
  retry: (id: string) => Promise<void>;
  isLoading: boolean;
} {
  const manager = useSyncManager();
  const [entries, setEntries] = useState<
    import("./offlineDb.js").LocalSyncQueueEntry[]
  >([]);
  const [isLoading, setIsLoading] = useState(true);

  const load = useCallback(async () => {
    setIsLoading(true);
    try {
      const failed = await manager.getFailedEntries();
      setEntries(failed);
    } finally {
      setIsLoading(false);
    }
  }, [manager]);

  useEffect(() => {
    load();
  }, [load]);

  const retry = useCallback(
    async (id: string) => {
      await manager.retryFailed(id);
      await load();
    },
    [manager, load]
  );

  return { entries, retry, isLoading };
}

// ---------------------------------------------------------------------------
// §8. useLocalRate — offline-first exchange rate
// ---------------------------------------------------------------------------

/**
 * Returns today's locally-cached ZiG/USD exchange rate.
 *
 * ```tsx
 * const { rate, isLoading, error } = useLocalRate();
 * ```
 */
export function useLocalRate(): {
  rate: number | null;
  isLoading: boolean;
  error: string | null;
} {
  const manager = useSyncManager();
  const [rate, setRate] = useState<number | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);

    manager
      .getLocalRateForToday()
      .then((r) => {
        if (!cancelled) {
          setRate(r);
          setError(null);
        }
      })
      .catch((err) => {
        if (!cancelled) setError((err as Error).message);
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [manager]);

  return { rate, isLoading, error };
}

// ---------------------------------------------------------------------------
// §9. useProductSearch — offline product search hook
// ---------------------------------------------------------------------------

/**
 * Debounced offline product search hook.
 * Returns products from IndexedDB matching the query string.
 *
 * ```tsx
 * const { results, isSearching } = useProductSearch(searchTerm);
 * ```
 */
export function useProductSearch(
  query: string,
  limit = 20
): {
  results: import("./offlineDb.js").LocalProduct[];
  isSearching: boolean;
} {
  const manager = useSyncManager();
  const [results, setResults] = useState<
    import("./offlineDb.js").LocalProduct[]
  >([]);
  const [isSearching, setIsSearching] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);

    if (!query.trim()) {
      setResults([]);
      setIsSearching(false);
      return;
    }

    setIsSearching(true);
    debounceRef.current = setTimeout(async () => {
      try {
        const found = await manager.searchProducts(query, limit);
        setResults(found);
      } catch {
        setResults([]);
      } finally {
        setIsSearching(false);
      }
    }, 200); // 200ms debounce

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, limit, manager]);

  return { results, isSearching };
}

// ---------------------------------------------------------------------------
// §10. PRIVATE HELPERS
// ---------------------------------------------------------------------------

/**
 * Pure function that applies a sync event to the current status state.
 * Keeps the reducer logic testable and separate from React.
 */
function applyEventToStatus(prev: SyncStatus, event: SyncEvent): SyncStatus {
  switch (event.type) {
    case "online":
      return { ...prev, isOnline: true, lastError: null };

    case "offline":
      return { ...prev, isOnline: false };

    case "queue:enqueued":
      return {
        ...prev,
        pendingCount: prev.pendingCount + 1,
      };

    case "queue:processing":
      return {
        ...prev,
        inFlightCount: prev.inFlightCount + 1,
      };

    case "queue:succeeded":
      return {
        ...prev,
        inFlightCount: Math.max(0, prev.inFlightCount - 1),
        pendingCount: Math.max(0, prev.pendingCount - 1),
        lastSyncAt: event.timestamp,
        lastError: null,
      };

    case "queue:failed":
      return {
        ...prev,
        inFlightCount: Math.max(0, prev.inFlightCount - 1),
        failedCount: prev.failedCount + 1,
        lastError: event.error ?? prev.lastError,
      };

    case "queue:empty":
      return {
        ...prev,
        pendingCount: 0,
        inFlightCount: 0,
      };

    case "error":
      return { ...prev, lastError: event.error ?? prev.lastError };

    default:
      return prev;
  }
}