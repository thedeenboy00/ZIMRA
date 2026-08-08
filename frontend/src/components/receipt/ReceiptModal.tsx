"use client";

// =============================================================================
// Receipt Modal
// src/components/receipt/ReceiptModal.tsx
// =============================================================================
// Wraps ThermalReceipt in a full-screen overlay with:
//   - "Paper emerging from slot" entrance animation
//   - Print via window.print() with isolated print region
//   - WhatsApp / SMS share of verification URL
//   - "New Sale" button to clear and restart
// =============================================================================

import { useEffect, useRef, useState, useCallback } from "react";
import { ThermalReceipt } from "./ThermalReceipt.js";
import type { LocalSale } from "../../services/sync/offlineDb.js";
import type { ReceiptTotals, NormalisedPayments } from "../../services/currency/currencyEngine.js";

interface ReceiptModalProps {
  sale: LocalSale;
  totals: ReceiptTotals;
  payments: NormalisedPayments;
  zigPerUsd: number;
  onNewSale: () => void;
}

export function ReceiptModal({
  sale,
  totals,
  payments,
  zigPerUsd,
  onNewSale,
}: ReceiptModalProps) {
  const [entered, setEntered] = useState(false);
  const printAreaRef = useRef<HTMLDivElement>(null);

  // Trigger entrance animation on mount
  useEffect(() => {
    const t = setTimeout(() => setEntered(true), 60);
    return () => clearTimeout(t);
  }, []);

  // ---------------------------------------------------------------------------
  // Print handler — injects receipt into a hidden print region, triggers print,
  // then removes it. Keeps the rest of the POS UI out of the printed page.
  // ---------------------------------------------------------------------------
  const handlePrint = useCallback(() => {
    if (!printAreaRef.current) return;

    const printContent = printAreaRef.current.innerHTML;
    const printStyles = `
      <style>
        @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700;900&display=swap');
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { background: white; display: flex; justify-content: center; }
      </style>
    `;

    // Open a focused print window
    const printWindow = window.open("", "_blank", "width=400,height=800");
    if (!printWindow) {
      // Fallback: direct window.print()
      window.print();
      return;
    }

    printWindow.document.write(`
      <!DOCTYPE html>
      <html lang="en">
        <head>
          <meta charset="utf-8" />
          <title>Receipt ${sale.receiptNumber ?? sale.id.slice(0, 8)}</title>
          ${printStyles}
        </head>
        <body>${printContent}</body>
      </html>
    `);
    printWindow.document.close();
    printWindow.focus();

    // Small delay to allow fonts to render
    setTimeout(() => {
      printWindow.print();
      printWindow.close();
    }, 350);
  }, [sale]);

  // ---------------------------------------------------------------------------
  // Share via WhatsApp (verify URL)
  // ---------------------------------------------------------------------------
  const handleShare = useCallback(() => {
    const verifyUrl = sale.zimraVerifyUrl;
    if (!verifyUrl) return;

    const message = encodeURIComponent(
      `Your receipt from ${sale.createdAt ? new Date(sale.createdAt).toLocaleDateString("en-ZW") : "today"}.\n` +
        `Total: $${totals.grandTotalUsd.toFixed(2)} USD\n` +
        `Verify at ZIMRA: ${verifyUrl}`
    );
    window.open(`https://wa.me/?text=${message}`, "_blank", "noopener");
  }, [sale, totals]);

  // ---------------------------------------------------------------------------
  // Keyboard: Escape → new sale, P → print
  // ---------------------------------------------------------------------------
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onNewSale();
      if ((e.key === "p" || e.key === "P") && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        handlePrint();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onNewSale, handlePrint]);

  const isFiscal = sale.status === "FISCALLY_ACCEPTED";
  const isPending = sale.needsZimraSync || sale.status === "SYNC_PENDING";

  return (
    <div
      className="receipt-modal"
      role="dialog"
      aria-modal="true"
      aria-label="Sale complete — receipt"
    >
      {/* Dark backdrop */}
      <div
        className="receipt-modal__backdrop"
        onClick={onNewSale}
        aria-hidden="true"
      />

      {/* Paper slot machine */}
      <div className="receipt-modal__slot-frame" aria-hidden="true">
        <div className="receipt-modal__slot-label">ZIMRA POS</div>
        <div className="receipt-modal__slot-opening" />
      </div>

      {/* Receipt emerging from slot */}
      <div
        className={`receipt-modal__paper ${entered ? "receipt-modal__paper--entered" : ""}`}
      >
        {/* Scrollable receipt area */}
        <div className="receipt-modal__scroll">
          <div ref={printAreaRef}>
            <ThermalReceipt
              sale={sale}
              totals={totals}
              payments={payments}
              zigPerUsd={zigPerUsd}
              businessName="Acme Trading (Pvt) Ltd"
              businessAddress="123 Samora Machel Ave, Harare"
              vatNumber="V000123456"
              tinNumber="2000123456"
              branchName="Main Branch"
            />
          </div>
        </div>

        {/* Status pill */}
        <div className={`receipt-modal__status receipt-modal__status--${isFiscal ? "accepted" : isPending ? "pending" : "error"}`}>
          {isFiscal && (
            <>
              <span className="receipt-modal__status-dot" aria-hidden="true" />
              FISCALLY ACCEPTED — ZIMRA #{sale.receiptGlobalNo}
            </>
          )}
          {isPending && (
            <>
              <span className="receipt-modal__status-dot receipt-modal__status-dot--pulse" aria-hidden="true" />
              QUEUED — will sync to ZIMRA automatically
            </>
          )}
          {!isFiscal && !isPending && (
            <>
              <span className="receipt-modal__status-dot receipt-modal__status-dot--error" aria-hidden="true" />
              ZIMRA SYNC FAILED — check sync errors
            </>
          )}
        </div>

        {/* Action bar */}
        <div className="receipt-modal__actions">
          <button
            className="receipt-modal__btn receipt-modal__btn--print"
            onClick={handlePrint}
            aria-label="Print receipt (Ctrl+P)"
          >
            <PrintIcon />
            Print
          </button>

          {sale.zimraVerifyUrl && (
            <button
              className="receipt-modal__btn receipt-modal__btn--share"
              onClick={handleShare}
              aria-label="Share receipt via WhatsApp"
            >
              <ShareIcon />
              Share
            </button>
          )}

          <button
            className="receipt-modal__btn receipt-modal__btn--new"
            onClick={onNewSale}
            aria-label="Start new sale (Escape)"
          >
            <NewSaleIcon />
            New Sale
          </button>
        </div>

        {/* Keyboard hint */}
        <p className="receipt-modal__hint" aria-hidden="true">
          Press <kbd>Esc</kbd> for new sale &nbsp;·&nbsp; <kbd>Ctrl+P</kbd> to print
        </p>
      </div>

      <style>{modalStyles}</style>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Icon components (inline SVG — zero dependencies)
// ---------------------------------------------------------------------------

function PrintIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <polyline points="6 9 6 2 18 2 18 9" />
      <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
      <rect x="6" y="14" width="12" height="8" />
    </svg>
  );
}

function ShareIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <circle cx="18" cy="5" r="3" /><circle cx="6" cy="12" r="3" /><circle cx="18" cy="19" r="3" />
      <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
      <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
    </svg>
  );
}

function NewSaleIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const modalStyles = `
  .receipt-modal {
    position: fixed;
    inset: 0;
    z-index: 1000;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: flex-start;
    overflow: hidden;
  }

  /* Backdrop */
  .receipt-modal__backdrop {
    position: absolute;
    inset: 0;
    background: rgba(0, 0, 0, 0.82);
    backdrop-filter: blur(3px);
  }

  /* Slot machine frame (the printer top) */
  .receipt-modal__slot-frame {
    position: relative;
    z-index: 1;
    width: 340px;
    background: #1C1F2B;
    border: 1px solid #2D3348;
    border-bottom: none;
    border-radius: 10px 10px 0 0;
    padding: 12px 20px 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 10px;
    margin-top: 40px;
    box-shadow: 0 -4px 24px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.04);
  }
  .receipt-modal__slot-label {
    font-family: var(--font-mono);
    font-size: 9px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: #4A5068;
  }
  .receipt-modal__slot-opening {
    width: 280px;
    height: 6px;
    background: #0A0C12;
    border-radius: 3px;
    border: 1px solid #1A1D28;
    box-shadow: inset 0 2px 4px rgba(0,0,0,0.8);
  }

  /* Receipt paper — emerges from the slot */
  .receipt-modal__paper {
    position: relative;
    z-index: 1;
    width: 340px;
    max-height: calc(100vh - 160px);
    display: flex;
    flex-direction: column;
    background: #F8F5EE;
    box-shadow:
      0 8px 48px rgba(0,0,0,0.6),
      0 0 0 1px rgba(0,0,0,0.15),
      2px 0 8px rgba(0,0,0,0.08),
      -2px 0 8px rgba(0,0,0,0.08);

    /* Starting position — above the slot, hidden */
    transform: translateY(-40px);
    opacity: 0;
    transition:
      transform 0.55s cubic-bezier(0.22, 1, 0.36, 1),
      opacity 0.3s ease;
  }
  .receipt-modal__paper--entered {
    transform: translateY(0);
    opacity: 1;
  }

  /* Scrollable receipt content */
  .receipt-modal__scroll {
    overflow-y: auto;
    flex: 1;
    min-height: 0;
    /* Thin scrollbar on the receipt paper */
    scrollbar-width: thin;
    scrollbar-color: #D4C9B0 #F8F5EE;
  }
  .receipt-modal__scroll::-webkit-scrollbar { width: 4px; }
  .receipt-modal__scroll::-webkit-scrollbar-track { background: #F8F5EE; }
  .receipt-modal__scroll::-webkit-scrollbar-thumb { background: #D4C9B0; border-radius: 2px; }

  /* Status pill */
  .receipt-modal__status {
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 8px 14px;
    font-family: var(--font-mono);
    font-size: 9px;
    font-weight: 700;
    letter-spacing: 0.07em;
    text-transform: uppercase;
    border-top: 1px solid rgba(0,0,0,0.1);
  }
  .receipt-modal__status--accepted {
    background: rgba(26, 107, 60, 0.08);
    color: #1A6B3C;
  }
  .receipt-modal__status--pending {
    background: rgba(200, 146, 42, 0.08);
    color: #7C5A1A;
  }
  .receipt-modal__status--error {
    background: rgba(220, 38, 38, 0.08);
    color: #991B1B;
  }

  .receipt-modal__status-dot {
    width: 7px; height: 7px; border-radius: 50%; background: currentColor; flex-shrink: 0;
  }
  .receipt-modal__status-dot--pulse { animation: statusPulse 1.6s ease-in-out infinite; }
  .receipt-modal__status-dot--error { background: #DC2626; }
  @keyframes statusPulse {
    0%, 100% { opacity: 1; transform: scale(1); }
    50% { opacity: 0.4; transform: scale(0.85); }
  }

  /* Action bar */
  .receipt-modal__actions {
    display: flex;
    gap: 1px;
    border-top: 1px solid rgba(0,0,0,0.1);
    background: rgba(0,0,0,0.06);
  }
  .receipt-modal__btn {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 5px;
    padding: 12px 8px;
    background: none;
    border: none;
    cursor: pointer;
    font-family: var(--font-body);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.02em;
    transition: background 0.12s;
    color: #2A2A2A;
  }
  .receipt-modal__btn:hover { background: rgba(0,0,0,0.06); }
  .receipt-modal__btn:active { background: rgba(0,0,0,0.1); }
  .receipt-modal__btn--print { color: #1A4A8A; }
  .receipt-modal__btn--share { color: #1A6B3C; }
  .receipt-modal__btn--new {
    color: #fff;
    background: #1A6B3C;
    font-size: 12px;
    font-weight: 700;
  }
  .receipt-modal__btn--new:hover { background: #1f8049; }

  /* Keyboard hint */
  .receipt-modal__hint {
    text-align: center;
    font-size: 10px;
    color: rgba(0,0,0,0.3);
    padding: 5px 8px 8px;
    font-family: var(--font-mono);
    background: rgba(0,0,0,0.02);
  }
  kbd {
    display: inline-block;
    padding: 1px 5px;
    background: rgba(0,0,0,0.06);
    border: 1px solid rgba(0,0,0,0.15);
    border-radius: 3px;
    font-family: var(--font-mono);
    font-size: 10px;
    line-height: 1.4;
  }

  /* Responsive — narrow screens */
  @media (max-width: 400px) {
    .receipt-modal__slot-frame,
    .receipt-modal__paper { width: 100%; border-radius: 0; }
    .receipt-modal__slot-frame { margin-top: 0; }
  }

  /* Print: show only the receipt */
  @media print {
    .receipt-modal__backdrop,
    .receipt-modal__slot-frame,
    .receipt-modal__status,
    .receipt-modal__actions,
    .receipt-modal__hint { display: none !important; }
    .receipt-modal {
      position: static;
      display: block;
    }
    .receipt-modal__paper {
      width: 80mm;
      max-height: none;
      box-shadow: none;
      transform: none;
      opacity: 1;
    }
  }
`;