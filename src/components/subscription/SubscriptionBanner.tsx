"use client";

// =============================================================================
// Subscription Banner
// src/components/subscription/SubscriptionBanner.tsx
// =============================================================================

import { useState, useEffect } from "react";
import type { SubscriptionState } from "../../services/subscription.js";

export function SubscriptionBanner() {
  const [state, setState] = useState<SubscriptionState | null>(null);

  useEffect(() => {
    fetch("/api/subscription/status")
      .then((r) => r.json())
      .then((data) => setState(data as SubscriptionState))
      .catch(() => {});
  }, []);

  if (!state || state.code === "OK") return null;

  const isLocked = state.code === "LOCKED";
  const isWarning = state.code === "WARNING";

  return (
    <div
      className={`sub-banner sub-banner--${isLocked ? "locked" : "warning"}`}
      role={isLocked ? "alert" : "status"}
      aria-live={isLocked ? "assertive" : "polite"}
    >
      <span className="sub-banner__icon" aria-hidden="true">
        {isLocked ? "🔒" : "⚠️"}
      </span>

      <div className="sub-banner__content">
        {isLocked ? (
          <>
            <strong>Subscription expired.</strong>{" "}
            POS sales are disabled.{" "}
            {(state as any).daysOverdue > 0 &&
              `${(state as any).daysOverdue} day${(state as any).daysOverdue !== 1 ? "s" : ""} overdue. `}
          </>
        ) : (
          <>
            <strong>Subscription expiring soon.</strong>{" "}
            {(state as any).daysRemainingLabel} remaining until your POS is locked.{" "}
          </>
        )}
        <a href="/subscription/renew" className="sub-banner__link">
          {isLocked ? "Renew now to restore access →" : "Renew subscription →"}
        </a>
      </div>

      <style>{bannerStyles}</style>
    </div>
  );
}

const bannerStyles = `
  .sub-banner {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 16px;
    font-size: 13px;
    border-bottom: 1px solid transparent;
    position: sticky;
    top: 0;
    z-index: 100;
  }
  .sub-banner--warning {
    background: color-mix(in srgb, var(--pos-amber) 14%, #0F1117);
    border-color: var(--pos-amber);
    color: var(--pos-amber-light);
  }
  .sub-banner--locked {
    background: color-mix(in srgb, var(--pos-red) 14%, #0F1117);
    border-color: var(--pos-red);
    color: var(--pos-red-light);
  }
  .sub-banner__icon { font-size: 16px; flex-shrink: 0; }
  .sub-banner__content { flex: 1; line-height: 1.5; }
  .sub-banner__link { color: currentColor; font-weight: 600; text-decoration: underline; text-underline-offset: 2px; }
  .sub-banner__link:hover { opacity: 0.8; }
`;