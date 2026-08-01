"use client";

// =============================================================================
// Payment Panel — Split-Tender Input
// src/components/pos/PaymentPanel.tsx
// =============================================================================
// Supports: Cash USD, EcoCash USD, Cash ZiG, EcoCash ZiG, InnBucks ZiG,
//           Swipe USD, ZIPIT USD — any combination as split tenders.
// Live change calculation updates as cashier enters amounts.
// =============================================================================

import { useState, useCallback, useMemo } from "react";
import {
  normalisePayments,
  usdToZig,
  zigToUsd,
} from "../../services/currency/currencyEngine.js";
import type { PaymentLine } from "../../services/currency/currencyEngine.js";

// ---------------------------------------------------------------------------
// §1. TENDER METHOD DEFINITIONS
// ---------------------------------------------------------------------------

interface TenderMethod {
  id: string;
  label: string;
  currency: "USD" | "ZIG";
  icon: string;
  color: string;
}

const TENDER_METHODS: TenderMethod[] = [
  { id: "CASH_USD",      label: "Cash (USD)",    currency: "USD", icon: "💵", color: "#2D5FA6" },
  { id: "SWIPE_USD",     label: "Swipe (USD)",   currency: "USD", icon: "💳", color: "#4A7EC0" },
  { id: "ECOCASH_USD",   label: "EcoCash $",     currency: "USD", icon: "📱", color: "#1A6B3C" },
  { id: "RTGS_USD",      label: "ZIPIT (USD)",   currency: "USD", icon: "🏦", color: "#374DA0" },
  { id: "CASH_ZIG",      label: "Cash (ZiG)",    currency: "ZIG", icon: "💴", color: "#8B4513" },
  { id: "ECOCASH_ZIG",   label: "EcoCash ZiG",   currency: "ZIG", icon: "📲", color: "#6B8C3A" },
  { id: "INNBUCKS_ZIG",  label: "InnBucks",      currency: "ZIG", icon: "🔷", color: "#1A5F7A" },
];

// ---------------------------------------------------------------------------
// §2. ACTIVE TENDER LINE STATE
// ---------------------------------------------------------------------------

interface ActiveTenderLine {
  methodId: string;
  rawInput: string;  // What the cashier typed
  amount: number;    // Parsed USD or ZiG amount
}

// ---------------------------------------------------------------------------
// §3. COMPONENT
// ---------------------------------------------------------------------------

interface PaymentPanelProps {
  grandTotalUsd: number;
  grandTotalZig: number;
  zigPerUsd: number;
  isProcessing: boolean;
  error: string | null;
  onSubmit: (tenders: PaymentLine[]) => Promise<void>;
  onBack: () => void;
}

export function PaymentPanel({
  grandTotalUsd,
  grandTotalZig,
  zigPerUsd,
  isProcessing,
  error,
  onSubmit,
  onBack,
}: PaymentPanelProps) {
  const [tenderLines, setTenderLines] = useState<ActiveTenderLine[]>([
    { methodId: "CASH_USD", rawInput: "", amount: 0 },
  ]);
  const [validationError, setValidationError] = useState<string | null>(null);

  // ---------------------------------------------------------------------------
  // §4. LIVE CALCULATIONS
  // ---------------------------------------------------------------------------

  const { totalTenderedUsd, totalTenderedZig, changeDueUsd, changeDueZig, remainingUsd } =
    useMemo(() => {
      let totalUsd = 0;
      let totalZig = 0;

      for (const line of tenderLines) {
        const method = TENDER_METHODS.find((m) => m.id === line.methodId);
        if (!method || line.amount <= 0) continue;
        if (method.currency === "USD") {
          totalUsd += line.amount;
          totalZig += zigPerUsd > 0 ? usdToZig(line.amount, zigPerUsd) : 0;
        } else {
          totalZig += line.amount;
          totalUsd += zigPerUsd > 0 ? zigToUsd(line.amount, zigPerUsd) : 0;
        }
      }

      const overUsd = totalUsd - grandTotalUsd;
      const changeDueUsd = Math.max(0, parseFloat(overUsd.toFixed(2)));
      const changeDueZig =
        changeDueUsd === 0 && totalZig > grandTotalZig
          ? parseFloat((totalZig - grandTotalZig).toFixed(2))
          : 0;
      const remainingUsd = Math.max(0, grandTotalUsd - totalUsd);

      return {
        totalTenderedUsd: parseFloat(totalUsd.toFixed(2)),
        totalTenderedZig: parseFloat(totalZig.toFixed(2)),
        changeDueUsd,
        changeDueZig,
        remainingUsd: parseFloat(remainingUsd.toFixed(2)),
      };
    }, [tenderLines, grandTotalUsd, grandTotalZig, zigPerUsd]);

  const isSufficient = remainingUsd <= 0.005;

  // ---------------------------------------------------------------------------
  // §5. TENDER LINE MANAGEMENT
  // ---------------------------------------------------------------------------

  const updateLine = useCallback(
    (idx: number, rawInput: string) => {
      const method = TENDER_METHODS.find(
        (m) => m.id === tenderLines[idx].methodId
      );
      const parsed = parseFloat(rawInput) || 0;
      setTenderLines((prev) =>
        prev.map((line, i) =>
          i === idx ? { ...line, rawInput, amount: parsed } : line
        )
      );
      setValidationError(null);
    },
    [tenderLines]
  );

  const changeMethod = useCallback(
    (idx: number, methodId: string) => {
      setTenderLines((prev) =>
        prev.map((line, i) =>
          i === idx ? { ...line, methodId, rawInput: "", amount: 0 } : line
        )
      );
    },
    []
  );

  const addLine = useCallback(() => {
    // Default to first method not already in use
    const usedIds = tenderLines.map((l) => l.methodId);
    const nextMethod =
      TENDER_METHODS.find((m) => !usedIds.includes(m.id)) ?? TENDER_METHODS[0];
    setTenderLines((prev) => [
      ...prev,
      { methodId: nextMethod.id, rawInput: "", amount: 0 },
    ]);
  }, [tenderLines]);

  const removeLine = useCallback((idx: number) => {
    setTenderLines((prev) => prev.filter((_, i) => i !== idx));
  }, []);

  // Quick-fill: set the exact remaining amount on a line
  const quickFill = useCallback(
    (idx: number) => {
      const method = TENDER_METHODS.find(
        (m) => m.id === tenderLines[idx].methodId
      );
      if (!method) return;
      const fillAmount =
        method.currency === "USD"
          ? remainingUsd.toFixed(2)
          : (zigPerUsd > 0 ? usdToZig(remainingUsd, zigPerUsd).toFixed(2) : "0");
      updateLine(idx, fillAmount);
    },
    [tenderLines, remainingUsd, zigPerUsd, updateLine]
  );

  // ---------------------------------------------------------------------------
  // §6. SUBMIT
  // ---------------------------------------------------------------------------

  const handleSubmit = useCallback(async () => {
    setValidationError(null);
    const activeTenders: PaymentLine[] = tenderLines
      .filter((l) => l.amount > 0)
      .map((l) => {
        const method = TENDER_METHODS.find((m) => m.id === l.methodId)!;
        return {
          method: l.methodId,
          amountUsd: method.currency === "USD" ? l.amount : 0,
          amountZig: method.currency === "ZIG" ? l.amount : 0,
        };
      });

    if (activeTenders.length === 0) {
      setValidationError("Enter at least one payment amount.");
      return;
    }

    try {
      normalisePayments(activeTenders, grandTotalUsd, zigPerUsd);
    } catch (err) {
      setValidationError(err instanceof Error ? err.message : "Invalid payment.");
      return;
    }

    await onSubmit(activeTenders);
  }, [tenderLines, grandTotalUsd, zigPerUsd, onSubmit]);

  // ---------------------------------------------------------------------------
  // §7. RENDER
  // ---------------------------------------------------------------------------

  return (
    <div className="payment-panel">
      {/* Header */}
      <div className="payment-panel__header">
        <button className="payment-panel__back" onClick={onBack} aria-label="Back to cart">
          ← Back
        </button>
        <span className="payment-panel__title">Payment</span>
      </div>

      {/* Total due reminder */}
      <div className="payment-panel__due">
        <div className="payment-panel__due-row">
          <span className="payment-panel__due-label">Total Due</span>
          <span className="payment-panel__due-usd">${grandTotalUsd.toFixed(2)}</span>
        </div>
        {zigPerUsd > 0 && (
          <div className="payment-panel__due-row payment-panel__due-row--zig">
            <span className="payment-panel__due-label">ZiG equiv.</span>
            <span className="payment-panel__due-zig">{grandTotalZig.toFixed(2)} ZiG</span>
          </div>
        )}
      </div>

      {/* Tender lines */}
      <div className="payment-panel__tenders">
        <label className="payment-panel__section-label">Tender</label>

        {tenderLines.map((line, idx) => {
          const method = TENDER_METHODS.find((m) => m.id === line.methodId)!;
          const usedIds = tenderLines
            .map((l, i) => (i !== idx ? l.methodId : null))
            .filter(Boolean) as string[];

          return (
            <div key={idx} className="tender-line">
              {/* Method selector */}
              <select
                className="tender-line__method"
                value={line.methodId}
                onChange={(e) => changeMethod(idx, e.target.value)}
                aria-label="Payment method"
                style={{ borderColor: method.color }}
              >
                {TENDER_METHODS.map((m) => (
                  <option key={m.id} value={m.id} disabled={usedIds.includes(m.id)}>
                    {m.icon} {m.label}
                  </option>
                ))}
              </select>

              {/* Amount input */}
              <div className="tender-line__input-wrap">
                <span
                  className="tender-line__currency"
                  style={{ color: method.color }}
                >
                  {method.currency === "USD" ? "$" : "Z"}
                </span>
                <input
                  type="number"
                  className="tender-line__input"
                  value={line.rawInput}
                  onChange={(e) => updateLine(idx, e.target.value)}
                  placeholder="0.00"
                  min={0}
                  step={0.01}
                  aria-label={`Amount for ${method.label}`}
                  style={{ borderColor: line.amount > 0 ? method.color : undefined }}
                />
                {/* Quick-fill button */}
                {remainingUsd > 0 && (
                  <button
                    className="tender-line__fill"
                    onClick={() => quickFill(idx)}
                    title={`Fill exact ${method.currency === "USD" ? `$${remainingUsd.toFixed(2)}` : `${usdToZig(remainingUsd, zigPerUsd).toFixed(2)} ZiG`} remaining`}
                    aria-label="Fill exact remaining amount"
                  >
                    Exact
                  </button>
                )}
              </div>

              {/* Remove line (only if > 1 line) */}
              {tenderLines.length > 1 && (
                <button
                  className="tender-line__remove"
                  onClick={() => removeLine(idx)}
                  aria-label="Remove tender line"
                >
                  ×
                </button>
              )}
            </div>
          );
        })}

        {/* Add split tender */}
        {tenderLines.length < TENDER_METHODS.length && (
          <button className="payment-panel__add-split" onClick={addLine}>
            + Split payment
          </button>
        )}
      </div>

      {/* Live totals */}
      <div className="payment-panel__summary">
        <div className="payment-summary__row">
          <span>Tendered</span>
          <span className="payment-summary__value">${totalTenderedUsd.toFixed(2)}</span>
        </div>
        <div className="payment-summary__row">
          <span>Total Due</span>
          <span className="payment-summary__value">${grandTotalUsd.toFixed(2)}</span>
        </div>

        {remainingUsd > 0.005 && (
          <div className="payment-summary__row payment-summary__row--remaining">
            <span>Still Needed</span>
            <span className="payment-summary__value payment-summary__value--remaining">
              ${remainingUsd.toFixed(2)}
            </span>
          </div>
        )}

        {(changeDueUsd > 0 || changeDueZig > 0) && (
          <div className="payment-summary__row payment-summary__row--change">
            <span>Change Due</span>
            <span className="payment-summary__value payment-summary__value--change">
              {changeDueUsd > 0
                ? `$${changeDueUsd.toFixed(2)}`
                : `${changeDueZig.toFixed(2)} ZiG`}
            </span>
          </div>
        )}
      </div>

      {/* Errors */}
      {(validationError || error) && (
        <div className="payment-panel__error" role="alert">
          {validationError || error}
        </div>
      )}

      {/* Submit */}
      <button
        className="payment-panel__submit"
        onClick={handleSubmit}
        disabled={!isSufficient || isProcessing}
        aria-busy={isProcessing}
      >
        {isProcessing
          ? "Processing…"
          : `Confirm $${grandTotalUsd.toFixed(2)} Payment`}
      </button>

      <style>{styles}</style>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = `
  .payment-panel {
    display: flex;
    flex-direction: column;
    height: 100%;
    gap: 0;
  }

  .payment-panel__header {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 16px;
    border-bottom: 1px solid var(--pos-border);
    background: var(--pos-bg);
  }
  .payment-panel__back {
    background: none; border: none; color: var(--pos-muted);
    font-size: 13px; cursor: pointer; padding: 4px 8px;
    border-radius: var(--radius-sm); transition: color 0.1s, background 0.1s;
  }
  .payment-panel__back:hover { color: var(--pos-text); background: var(--pos-border); }
  .payment-panel__title { font-weight: 600; font-size: 15px; }

  .payment-panel__due {
    padding: 16px;
    background: color-mix(in srgb, var(--pos-usd) 8%, var(--pos-surface));
    border-bottom: 1px solid var(--pos-border);
  }
  .payment-panel__due-row {
    display: flex; justify-content: space-between; align-items: baseline; gap: 8px;
  }
  .payment-panel__due-row--zig { margin-top: 4px; opacity: 0.8; }
  .payment-panel__due-label { font-size: 12px; color: var(--pos-muted); text-transform: uppercase; letter-spacing: 0.06em; }
  .payment-panel__due-usd { font-family: var(--font-mono); font-size: 28px; font-weight: 800; color: var(--pos-usd-light); }
  .payment-panel__due-zig { font-family: var(--font-mono); font-size: 14px; color: var(--pos-zig-light); }

  .payment-panel__tenders { padding: 16px; display: flex; flex-direction: column; gap: 10px; flex: 1; }
  .payment-panel__section-label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--pos-muted); }

  .tender-line { display: flex; align-items: center; gap: 8px; }
  .tender-line__method {
    flex: 1; background: var(--pos-bg); border: 1px solid var(--pos-border);
    border-radius: var(--radius-sm); color: var(--pos-text); font-size: 13px;
    padding: 8px 10px; cursor: pointer; outline: none; transition: border-color 0.15s;
    min-width: 0;
  }
  .tender-line__method:focus { border-color: var(--pos-green-light); }

  .tender-line__input-wrap {
    display: flex; align-items: center; gap: 4px;
    background: var(--pos-bg); border: 1px solid var(--pos-border);
    border-radius: var(--radius-sm); padding: 0 8px; width: 140px; flex-shrink: 0;
    transition: border-color 0.15s;
  }
  .tender-line__input-wrap:focus-within { border-color: var(--pos-green-light); }
  .tender-line__currency { font-family: var(--font-mono); font-size: 14px; font-weight: 700; flex-shrink: 0; }
  .tender-line__input {
    flex: 1; background: none; border: none; outline: none; color: var(--pos-text);
    font-family: var(--font-mono); font-size: 16px; font-weight: 600;
    padding: 8px 0; text-align: right; width: 0; min-width: 0;
  }
  .tender-line__input::placeholder { color: var(--pos-muted); opacity: 0.5; }
  .tender-line__fill {
    background: none; border: none; color: var(--pos-muted); font-size: 10px;
    cursor: pointer; padding: 2px 4px; flex-shrink: 0; transition: color 0.1s;
    text-transform: uppercase; letter-spacing: 0.05em;
  }
  .tender-line__fill:hover { color: var(--pos-green-light); }
  .tender-line__remove {
    background: none; border: none; color: var(--pos-muted); font-size: 18px;
    cursor: pointer; padding: 0 4px; flex-shrink: 0; transition: color 0.1s;
  }
  .tender-line__remove:hover { color: var(--pos-red-light); }

  .payment-panel__add-split {
    background: none; border: 1px dashed var(--pos-border); border-radius: var(--radius-sm);
    color: var(--pos-muted); font-size: 12px; padding: 8px; cursor: pointer;
    transition: color 0.1s, border-color 0.1s; text-align: center;
  }
  .payment-panel__add-split:hover { color: var(--pos-usd-light); border-color: var(--pos-usd); }

  /* Summary */
  .payment-panel__summary {
    padding: 12px 16px; border-top: 1px solid var(--pos-border);
    display: flex; flex-direction: column; gap: 6px;
    background: var(--pos-bg);
  }
  .payment-summary__row { display: flex; justify-content: space-between; font-size: 13px; color: var(--pos-muted); }
  .payment-summary__value { font-family: var(--font-mono); font-weight: 600; }
  .payment-summary__row--remaining .payment-summary__value--remaining { color: var(--pos-amber-light); }
  .payment-summary__row--change .payment-summary__value--change { color: var(--pos-green-light); font-size: 16px; font-weight: 800; }

  /* Error */
  .payment-panel__error {
    margin: 0 16px; padding: 10px 12px;
    background: color-mix(in srgb, var(--pos-red) 15%, transparent);
    border: 1px solid var(--pos-red);
    border-radius: var(--radius-sm);
    color: var(--pos-red-light); font-size: 13px;
  }

  /* Submit */
  .payment-panel__submit {
    margin: 12px 16px 16px; padding: 16px;
    background: var(--pos-green); color: #fff;
    border: none; border-radius: var(--radius-md);
    font-family: var(--font-body); font-size: 16px; font-weight: 700;
    cursor: pointer; transition: background 0.15s, transform 0.1s;
    letter-spacing: 0.01em;
  }
  .payment-panel__submit:hover:not(:disabled) { background: #1f8049; }
  .payment-panel__submit:active:not(:disabled) { transform: scale(0.99); }
  .payment-panel__submit:disabled { background: var(--pos-border); color: var(--pos-muted); cursor: not-allowed; }
`;