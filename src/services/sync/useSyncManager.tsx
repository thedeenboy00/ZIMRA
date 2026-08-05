// =============================================================================
// React Hooks — Offline Sync Manager
// src/services/sync/useSyncManager.ts
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
  isOnline: true, // Safe default for SSR hydration match
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

export function SyncManagerProvider({
  config,
  children,
}: SyncManagerProviderProps) {
  const managerRef = useRef<OfflineSyncManager | null>(null);
  const [status, setStatus] = useState<SyncStatus>(DEFAULT_STATUS);

  useEffect(() => {
    // Initialise manager singleton (client-side only)
    if (!managerRef.current) {
      managerRef.current = new OfflineSyncManager(config);
    }
    const manager = managerRef.current;

    // Correct client navigator state after mounting (prevents SSR mismatch)
    if (typeof window !== "undefined") {
      setStatus((prev) => ({ ...prev, isOnline: navigator.onLine }));
    }

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
  }, []); // Run once on client mount

  return (
    <SyncManagerContext.Provider value={{ manager: managerRef.current, status }}>
      {children}
    </SyncManagerContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// §4. HOOKS
// ---------------------------------------------------------------------------

export function useSyncManager(): OfflineSyncManager {
  const { manager } = useContext(SyncManagerContext);
  if (!manager) {
    throw new Error(
      "useSyncManager() must be called inside a <SyncManagerProvider>."
    );
  }
  return manager;
}

export function useSyncStatus(): SyncStatus {
  return useContext(SyncManagerContext).status;
}

export function useConnectivity(): boolean {
  return useContext(SyncManagerContext).status.isOnline;
}

export function useFailedSyncEntries(): {
  entries: import("./offlineDb.js").LocalSyncQueueEntry[];
  retry: (id: string) => Promise<void>;
  isLoading: boolean;
} {
  const manager = useSyncManager();
  const status = useSyncStatus(); // Listen to live queue state changes
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

  // Re-fetch failed entries when failedCount changes in status
  useEffect(() => {
    load();
  }, [load, status.failedCount]);

  const retry = useCallback(
    async (id: string) => {
      await manager.retryFailed(id);
      await load();
    },
    [manager, load]
  );

  return { entries, retry, isLoading };
}

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
    }, 200);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, limit, manager]);

  return { results, isSearching };
}

// ---------------------------------------------------------------------------
// §5. PRIVATE HELPERS
// ---------------------------------------------------------------------------

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