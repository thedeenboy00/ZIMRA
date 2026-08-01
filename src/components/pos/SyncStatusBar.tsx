"use client";

// =============================================================================
// SyncStatusBar Component
// src/components/pos/SyncStatusBar.tsx
// =============================================================================

interface SyncStatusBarProps {
  isOnline: boolean;
  pendingCount: number;
  failedCount: number;
  lastSyncAt: Date | null;
}

export function SyncStatusBar({
  isOnline,
  pendingCount,
  failedCount,
  lastSyncAt,
}: SyncStatusBarProps) {
  const hasIssues = !isOnline || pendingCount > 0 || failedCount > 0;

  // Hidden when everything is fine and we're online
  if (isOnline && pendingCount === 0 && failedCount === 0) return null;

  return (
    <div
      className={`sync-bar sync-bar--${!isOnline ? "offline" : failedCount > 0 ? "error" : "pending"}`}
      role="status"
      aria-live="polite"
    >
      {/* Connectivity indicator */}
      <span className="sync-bar__dot" aria-hidden="true" />

      {/* Status message */}
      <span className="sync-bar__message">
        {!isOnline && "Offline — receipts saving locally"}
        {isOnline && pendingCount > 0 && !failedCount &&
          `Syncing ${pendingCount} receipt${pendingCount !== 1 ? "s" : ""} to ZIMRA…`}
        {isOnline && failedCount > 0 &&
          `${failedCount} receipt${failedCount !== 1 ? "s" : ""} failed to sync`}
      </span>

      {/* Last sync time */}
      {lastSyncAt && isOnline && (
        <span className="sync-bar__time">
          Last synced {formatRelativeTime(lastSyncAt)}
        </span>
      )}

      {/* Failed count — link to admin */}
      {failedCount > 0 && (
        <a href="/admin/sync-errors" className="sync-bar__action">
          View errors →
        </a>
      )}

      <style>{syncBarStyles}</style>
    </div>
  );
}

function formatRelativeTime(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
}

const syncBarStyles = `
  .sync-bar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 16px;
    font-size: 12px;
    font-weight: 500;
    border-bottom: 1px solid transparent;
  }
  .sync-bar--offline {
    background: color-mix(in srgb, var(--pos-amber) 12%, transparent);
    border-color: color-mix(in srgb, var(--pos-amber) 35%, transparent);
    color: var(--pos-amber-light);
  }
  .sync-bar--pending {
    background: color-mix(in srgb, var(--pos-usd) 10%, transparent);
    border-color: color-mix(in srgb, var(--pos-usd) 30%, transparent);
    color: var(--pos-usd-light);
  }
  .sync-bar--error {
    background: color-mix(in srgb, var(--pos-red) 12%, transparent);
    border-color: color-mix(in srgb, var(--pos-red) 35%, transparent);
    color: var(--pos-red-light);
  }

  .sync-bar__dot {
    width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0;
    background: currentColor;
  }
  .sync-bar--pending .sync-bar__dot { animation: pulse 1.5s ease-in-out infinite; }
  @keyframes pulse {
    0%, 100% { opacity: 1; } 50% { opacity: 0.3; }
  }

  .sync-bar__message { flex: 1; }
  .sync-bar__time { opacity: 0.65; font-size: 11px; }
  .sync-bar__action {
    color: currentColor; text-decoration: underline; text-underline-offset: 2px;
    font-size: 11px; white-space: nowrap;
  }
`;