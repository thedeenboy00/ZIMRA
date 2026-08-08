"use client";

// =============================================================================
// Thermal Receipt — ZIMRA-Compliant Printable Layout
// src/components/receipt/ThermalReceipt.tsx
// =============================================================================
// Renders a pixel-faithful thermal receipt:
//   - 80mm paper width (576px at 203dpi — standard ESC/POS)
//   - Monospace layout matching thermal printer character grid
//   - ZIMRA fiscal data block (signature, verification code, QR)
//   - Dual-currency totals (USD + ZiG)
//   - VAT breakdown by category
//   - Print-optimised @media print styles embedded
// =============================================================================

import { useRef, useCallback } from "react";
import { QRCodeCanvas } from "qrcode.react";
import type { LocalSale } from "../../services/sync/offlineDb";
import type { ReceiptTotals } from "../../services/currency/currencyEngine";
import type { NormalisedPayments } from "../../services/currency/currencyEngine";
import { parseSaleItems, parsePayments } from "../../services/sync/offlineDb";

// ---------------------------------------------------------------------------
// §1. PAYMENT METHOD DISPLAY LABELS
// ---------------------------------------------------------------------------

const PAYMENT_LABELS: Record<string, string> = {
  CASH_USD:     "Cash (USD)",
  SWIPE_USD:    "Swipe / Card",
  ECOCASH_USD:  "EcoCash (USD)",
  RTGS_USD:     "ZIPIT (USD)",
  CASH_ZIG:     "Cash (ZiG)",
  ECOCASH_ZIG:  "EcoCash (ZiG)",
  INNBUCKS_ZIG: "InnBucks",
};

// ---------------------------------------------------------------------------
// §2. TYPES
// ---------------------------------------------------------------------------

interface ThermalReceiptProps {
  sale: LocalSale;
  totals: ReceiptTotals;
  payments: NormalisedPayments;
  zigPerUsd: number;
  businessName: string;
  businessAddress: string;
  vatNumber: string;
  tinNumber: string;
  branchName?: string;
}

// ---------------------------------------------------------------------------
// §3. COMPONENT
// ---------------------------------------------------------------------------

export function ThermalReceipt({
  sale,
  totals,
  payments,
  zigPerUsd,
  businessName,
  businessAddress,
  vatNumber,
  tinNumber,
  branchName,
}: ThermalReceiptProps) {
  const items = parseSaleItems(sale);
  const paymentLines = parsePayments(sale);
  const receiptDate = new Date(sale.createdAt);

  const isFiscallyAccepted = sale.status === "FISCALLY_ACCEPTED";
  const isPending = sale.status === "SYNC_PENDING" || sale.needsZimraSync;

  return (
    <div className="receipt" role="document" aria-label="Fiscal receipt">

      {/* ── HEADER ─────────────────────────────────────────────────── */}
      <div className="receipt__header">
        <div className="receipt__business-name">{businessName}</div>
        {branchName && <div className="receipt__branch">{branchName}</div>}
        <div className="receipt__address">{businessAddress}</div>
        <div className="receipt__rule" aria-hidden="true" />
        <div className="receipt__meta-grid">
          <span>VAT Reg:</span><span>{vatNumber}</span>
          <span>TIN:</span><span>{tinNumber}</span>
        </div>
        <div className="receipt__rule" aria-hidden="true" />
      </div>

      {/* ── RECEIPT IDENTITY ────────────────────────────────────────── */}
      <div className="receipt__identity">
        <div className="receipt__type">FISCAL TAX INVOICE</div>
        <div className="receipt__meta-grid">
          {sale.receiptNumber && (
            <><span>Receipt #:</span><span className="receipt__mono">{sale.receiptNumber}</span></>
          )}
          {sale.receiptCounter && (
            <><span>Counter:</span><span className="receipt__mono">{sale.receiptCounter}</span></>
          )}
          <span>Date:</span><span className="receipt__mono">{formatDate(receiptDate)}</span>
          <span>Time:</span><span className="receipt__mono">{formatTime(receiptDate)}</span>
          {sale.cashierName && (
            <><span>Cashier:</span><span>{sale.cashierName}</span></>
          )}
        </div>
      </div>

      {/* ── CUSTOMER (B2B) ───────────────────────────────────────────── */}
      {sale.customerName && (
        <>
          <div className="receipt__rule" aria-hidden="true" />
          <div className="receipt__section-label">BILLED TO</div>
          <div className="receipt__meta-grid">
            <span>Name:</span><span>{sale.customerName}</span>
            {sale.customerVatNumber && (
              <><span>VAT:</span><span className="receipt__mono">{sale.customerVatNumber}</span></>
            )}
            {sale.customerTinNumber && (
              <><span>TIN:</span><span className="receipt__mono">{sale.customerTinNumber}</span></>
            )}
          </div>
        </>
      )}

      {/* ── LINE ITEMS ──────────────────────────────────────────────── */}
      <div className="receipt__rule" aria-hidden="true" />
      <div className="receipt__col-headers" aria-hidden="true">
        <span>ITEM</span>
        <span>QTY</span>
        <span>PRICE</span>
        <span>TOTAL</span>
      </div>
      <div className="receipt__rule receipt__rule--dotted" aria-hidden="true" />

      <div className="receipt__items" role="list">
        {totals.lines.map((line, idx) => (
          <div key={idx} className="receipt__item" role="listitem">
            {/* Product name row */}
            <div className="receipt__item-name">
              {line.productName}
              <span className="receipt__item-tax-badge">
                [{line.taxCategory}]
              </span>
            </div>

            {/* HS code if present */}
            {line.hsCode && (
              <div className="receipt__item-hs">HS: {line.hsCode}</div>
            )}

            {/* Qty × unit price → line total */}
            <div className="receipt__item-calc">
              <span className="receipt__mono">
                {line.quantity} × ${line.unitPriceExclVatUsd.toFixed(4)}
              </span>
              {line.discountPercent > 0 && (
                <span className="receipt__item-discount">
                  −{line.discountPercent}%
                </span>
              )}
              <span className="receipt__item-linetotal receipt__mono">
                ${line.lineTotalUsd.toFixed(2)}
              </span>
            </div>

            {/* VAT line */}
            <div className="receipt__item-vat">
              <span>VAT {(line.vatRate * 100).toFixed(0)}% on ${line.taxableAmountUsd.toFixed(2)}</span>
              <span className="receipt__mono">= ${line.vatAmountUsd.toFixed(2)}</span>
            </div>
          </div>
        ))}
      </div>

      {/* ── TOTALS ──────────────────────────────────────────────────── */}
      <div className="receipt__rule receipt__rule--dotted" aria-hidden="true" />

      <div className="receipt__totals" role="group" aria-label="Receipt totals">
        <div className="receipt__total-row">
          <span>Subtotal (excl. VAT)</span>
          <span className="receipt__mono">${totals.subtotalExclVatUsd.toFixed(2)}</span>
        </div>

        {totals.totalDiscountUsd > 0 && (
          <div className="receipt__total-row receipt__total-row--discount">
            <span>Total Discount</span>
            <span className="receipt__mono">−${totals.totalDiscountUsd.toFixed(2)}</span>
          </div>
        )}

        {/* VAT by category */}
        {totals.vatByCategory.map((vat) => (
          <div key={vat.taxCategory} className="receipt__total-row receipt__total-row--vat">
            <span>VAT ({(vat.taxRate * 100).toFixed(0)}%) Cat. {vat.taxCategory}</span>
            <span className="receipt__mono">${vat.vatAmountUsd.toFixed(2)}</span>
          </div>
        ))}

        <div className="receipt__rule" aria-hidden="true" />

        {/* Grand total USD */}
        <div className="receipt__total-row receipt__total-row--grand">
          <span>TOTAL (USD)</span>
          <span className="receipt__mono receipt__grand-usd">${totals.grandTotalUsd.toFixed(2)}</span>
        </div>

        {/* ZiG equivalent */}
        {zigPerUsd > 0 && (
          <div className="receipt__total-row receipt__total-row--zig">
            <span>TOTAL (ZiG) @ {zigPerUsd.toFixed(4)}</span>
            <span className="receipt__mono receipt__grand-zig">{totals.grandTotalZig.toFixed(2)}</span>
          </div>
        )}
      </div>

      {/* ── PAYMENTS ────────────────────────────────────────────────── */}
      <div className="receipt__rule" aria-hidden="true" />
      <div className="receipt__section-label">PAYMENT</div>

      <div className="receipt__payments" role="list">
        {paymentLines.map((pmt, idx) => (
          <div key={idx} className="receipt__payment-row" role="listitem">
            <span>{PAYMENT_LABELS[pmt.method] ?? pmt.method}</span>
            <span className="receipt__mono">
              {pmt.amountUsd > 0
                ? `$${pmt.amountUsd.toFixed(2)}`
                : `${pmt.amountZig.toFixed(2)} ZiG`}
            </span>
          </div>
        ))}

        {sale.changeDueUsd > 0 && (
          <div className="receipt__payment-row receipt__payment-row--change">
            <span>Change (USD)</span>
            <span className="receipt__mono">${sale.changeDueUsd.toFixed(2)}</span>
          </div>
        )}
        {sale.changeDueZig > 0 && (
          <div className="receipt__payment-row receipt__payment-row--change">
            <span>Change (ZiG)</span>
            <span className="receipt__mono">{sale.changeDueZig.toFixed(2)} ZiG</span>
          </div>
        )}
      </div>

      {/* ── ZIMRA FISCAL BLOCK ──────────────────────────────────────── */}
      <div className="receipt__rule receipt__rule--double" aria-hidden="true" />
      <div className="receipt__fiscal-block">
        <div className="receipt__fiscal-header">
          ZIMBABWE REVENUE AUTHORITY
        </div>
        <div className="receipt__fiscal-header receipt__fiscal-header--sub">
          FISCAL TAX RECEIPT
        </div>

        {isFiscallyAccepted ? (
          <>
            {/* QR code — the signature element */}
            {sale.zimraQrCode && (
              <div className="receipt__qr-wrap">
                <QRCodeCanvas
                  value={sale.zimraVerifyUrl ?? sale.zimraQrCode}
                  size={128}
                  bgColor="#F8F5EE"
                  fgColor="#1A1A1A"
                  level="M"
                  aria-label="ZIMRA receipt verification QR code"
                />
                <div className="receipt__qr-glow" aria-hidden="true" />
              </div>
            )}

            <div className="receipt__verify-url">
              Verify at: zimra.co.zw/verify
            </div>

            {sale.receiptGlobalNo && (
              <div className="receipt__fiscal-meta">
                <span>ZIMRA Global #:</span>
                <span className="receipt__mono">{sale.receiptGlobalNo}</span>
              </div>
            )}

            {sale.fiscalHash && (
              <div className="receipt__fiscal-meta receipt__fiscal-meta--hash">
                <span>Fiscal Hash:</span>
                <span className="receipt__mono receipt__hash">
                  {sale.fiscalHash.slice(0, 16)}…{sale.fiscalHash.slice(-8)}
                </span>
              </div>
            )}

            {sale.zimraSubmittedAt && (
              <div className="receipt__fiscal-meta">
                <span>Submitted:</span>
                <span className="receipt__mono">
                  {formatDateTime(new Date(sale.zimraSubmittedAt))}
                </span>
              </div>
            )}
          </>
        ) : isPending ? (
          <div className="receipt__fiscal-pending">
            <div className="receipt__fiscal-pending-icon" aria-hidden="true">⏳</div>
            <p className="receipt__fiscal-pending-title">PENDING ZIMRA SUBMISSION</p>
            <p className="receipt__fiscal-pending-body">
              This receipt is queued and will be submitted to ZIMRA automatically
              when internet connectivity is restored. The sale is fully recorded.
            </p>
            <p className="receipt__fiscal-pending-ref">
              Local Ref: <span className="receipt__mono">{sale.id.slice(0, 16)}</span>
            </p>
          </div>
        ) : (
          <div className="receipt__fiscal-pending receipt__fiscal-pending--error">
            <div className="receipt__fiscal-pending-icon">✗</div>
            <p className="receipt__fiscal-pending-title">ZIMRA SUBMISSION FAILED</p>
            <p className="receipt__fiscal-pending-body">
              {sale.zimraErrorMessage ?? "Contact your system administrator."}
            </p>
          </div>
        )}
      </div>

      {/* ── FOOTER ──────────────────────────────────────────────────── */}
      <div className="receipt__rule receipt__rule--double" aria-hidden="true" />
      <div className="receipt__footer">
        <p>Thank you for your business.</p>
        <p>Goods sold are not returnable unless defective.</p>
        <div className="receipt__rule receipt__rule--dotted" aria-hidden="true" />
        <p className="receipt__powered-by">Powered by ZIMRA POS Platform</p>
      </div>

      {/* ── TEAR EDGE ───────────────────────────────────────────────── */}
      <div className="receipt__tear" aria-hidden="true">
        {Array.from({ length: 36 }).map((_, i) => (
          <span key={i} className="receipt__tear-tooth" />
        ))}
      </div>

      <style>{receiptStyles}</style>
    </div>
  );
}

// ---------------------------------------------------------------------------
// §4. DATE FORMATTERS
// ---------------------------------------------------------------------------

function formatDate(date: Date): string {
  return date.toLocaleDateString("en-ZW", {
    day: "2-digit", month: "2-digit", year: "numeric",
  });
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString("en-ZW", {
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  });
}

function formatDateTime(date: Date): string {
  return `${formatDate(date)} ${formatTime(date)}`;
}

// ---------------------------------------------------------------------------
// §5. RECEIPT STYLES — thermal paper aesthetic
// ---------------------------------------------------------------------------

const receiptStyles = `
  .receipt {
    --paper: #F8F5EE;
    --ink:   #1A1A1A;
    --ink-muted: #4A4A4A;
    --green-fiscal: #1A6B3C;
    --receipt-width: 576px; /* 80mm at 203dpi */
    --font-receipt: 'JetBrains Mono', 'Courier New', Courier, monospace;

    width: var(--receipt-width);
    max-width: 100%;
    background: var(--paper);
    color: var(--ink);
    font-family: var(--font-receipt);
    font-size: 12px;
    line-height: 1.45;
    padding: 24px 20px 0;
    box-sizing: border-box;
    position: relative;

    /* Subtle paper texture */
    background-image:
      repeating-linear-gradient(
        0deg,
        transparent,
        transparent 23px,
        rgba(0,0,0,0.025) 24px
      );
  }

  /* ── Header ────────────────────────────────────────────────── */
  .receipt__header { text-align: center; margin-bottom: 8px; }
  .receipt__business-name {
    font-size: 16px; font-weight: 900; letter-spacing: 0.04em;
    text-transform: uppercase; line-height: 1.2; margin-bottom: 4px;
  }
  .receipt__branch { font-size: 11px; color: var(--ink-muted); }
  .receipt__address { font-size: 11px; color: var(--ink-muted); margin-bottom: 6px; }

  /* ── Rules ─────────────────────────────────────────────────── */
  .receipt__rule {
    border: none; border-top: 1px solid var(--ink);
    margin: 6px 0;
  }
  .receipt__rule--dotted { border-top-style: dashed; opacity: 0.5; }
  .receipt__rule--double {
    border-top: 3px double var(--ink);
    margin: 8px 0;
  }

  /* ── Meta grids ─────────────────────────────────────────────── */
  .receipt__meta-grid {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 1px 12px;
    font-size: 11px;
  }
  .receipt__meta-grid span:nth-child(odd) { color: var(--ink-muted); }
  .receipt__meta-grid span:nth-child(even) { font-weight: 600; }

  /* ── Receipt identity ───────────────────────────────────────── */
  .receipt__identity { margin: 8px 0; }
  .receipt__type {
    text-align: center; font-size: 13px; font-weight: 900;
    letter-spacing: 0.06em; margin-bottom: 6px;
  }
  .receipt__mono { font-family: var(--font-receipt); }

  /* ── Section label ──────────────────────────────────────────── */
  .receipt__section-label {
    font-size: 9px; text-transform: uppercase; letter-spacing: 0.12em;
    color: var(--ink-muted); margin-bottom: 4px;
  }

  /* ── Column headers ─────────────────────────────────────────── */
  .receipt__col-headers {
    display: grid;
    grid-template-columns: 1fr 40px 80px 70px;
    gap: 4px;
    font-size: 9px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--ink-muted);
  }
  .receipt__col-headers span:nth-child(n+2) { text-align: right; }

  /* ── Line items ─────────────────────────────────────────────── */
  .receipt__items { margin: 4px 0; }
  .receipt__item { margin-bottom: 8px; padding-bottom: 6px; }
  .receipt__item:last-child { margin-bottom: 0; }

  .receipt__item-name {
    font-size: 12px; font-weight: 600;
    display: flex; justify-content: space-between; align-items: baseline; gap: 4px;
  }
  .receipt__item-tax-badge {
    font-size: 9px; color: var(--green-fiscal); font-weight: 900; flex-shrink: 0;
  }
  .receipt__item-hs { font-size: 9px; color: var(--ink-muted); }
  .receipt__item-calc {
    display: flex; justify-content: space-between; align-items: baseline;
    gap: 4px; font-size: 11px; color: var(--ink-muted);
  }
  .receipt__item-discount { color: #B45309; font-weight: 600; }
  .receipt__item-linetotal { color: var(--ink); font-weight: 700; }
  .receipt__item-vat {
    display: flex; justify-content: space-between;
    font-size: 10px; color: var(--ink-muted); opacity: 0.75;
  }

  /* ── Totals ─────────────────────────────────────────────────── */
  .receipt__totals { margin: 4px 0; }
  .receipt__total-row {
    display: flex; justify-content: space-between; align-items: baseline;
    gap: 4px; font-size: 12px; padding: 1px 0;
  }
  .receipt__total-row--vat { font-size: 11px; color: var(--ink-muted); }
  .receipt__total-row--discount { color: #B45309; }
  .receipt__total-row--grand {
    font-size: 15px; font-weight: 900; padding: 3px 0;
  }
  .receipt__grand-usd { font-size: 18px; }
  .receipt__total-row--zig { color: #7C3A0A; font-size: 13px; font-weight: 700; }
  .receipt__grand-zig { font-size: 14px; }

  /* ── Payments ───────────────────────────────────────────────── */
  .receipt__payments { margin: 4px 0; }
  .receipt__payment-row {
    display: flex; justify-content: space-between;
    font-size: 12px; padding: 2px 0;
  }
  .receipt__payment-row--change { font-weight: 700; }

  /* ── ZIMRA fiscal block ─────────────────────────────────────── */
  .receipt__fiscal-block {
    text-align: center;
    padding: 12px 8px;
    border: 2px solid var(--green-fiscal);
    margin: 8px 0;
    border-radius: 2px;
  }
  .receipt__fiscal-header {
    font-size: 11px; font-weight: 900; letter-spacing: 0.08em;
    text-transform: uppercase; color: var(--green-fiscal);
  }
  .receipt__fiscal-header--sub {
    font-size: 9px; font-weight: 600; margin-bottom: 10px; opacity: 0.8;
  }

  /* QR code — the signature element */
  .receipt__qr-wrap {
    position: relative;
    display: inline-block;
    margin: 8px auto;
  }
  .receipt__qr-wrap canvas {
    border: 3px solid var(--green-fiscal);
    border-radius: 4px;
    display: block;
  }
  /* Fiscal green corner glow — the receipt's one visual flourish */
  .receipt__qr-glow {
    position: absolute;
    inset: -6px;
    border-radius: 8px;
    background: radial-gradient(
      ellipse at center,
      rgba(26, 107, 60, 0.12) 0%,
      transparent 70%
    );
    pointer-events: none;
  }

  .receipt__verify-url {
    font-size: 9px; color: var(--ink-muted); margin-bottom: 8px; letter-spacing: 0.04em;
  }
  .receipt__fiscal-meta {
    display: flex; justify-content: space-between;
    font-size: 10px; color: var(--ink-muted); padding: 1px 0;
  }
  .receipt__fiscal-meta--hash { font-size: 9px; }
  .receipt__hash { font-size: 9px; letter-spacing: 0.02em; }

  /* Pending / error states */
  .receipt__fiscal-pending {
    padding: 8px; text-align: center;
    border: 1px dashed var(--ink-muted);
    border-radius: 2px; margin-top: 8px;
  }
  .receipt__fiscal-pending--error { border-color: #DC2626; }
  .receipt__fiscal-pending-icon { font-size: 24px; margin-bottom: 4px; }
  .receipt__fiscal-pending-title {
    font-size: 11px; font-weight: 900; letter-spacing: 0.06em;
    margin-bottom: 4px;
  }
  .receipt__fiscal-pending-body { font-size: 10px; color: var(--ink-muted); line-height: 1.5; }
  .receipt__fiscal-pending-ref { font-size: 9px; color: var(--ink-muted); margin-top: 6px; }

  /* ── Footer ─────────────────────────────────────────────────── */
  .receipt__footer {
    text-align: center; font-size: 10px; color: var(--ink-muted);
    line-height: 1.8; padding: 4px 0 8px;
  }
  .receipt__footer p { margin: 0; }
  .receipt__powered-by {
    font-size: 9px; letter-spacing: 0.06em; text-transform: uppercase;
    opacity: 0.5; margin-top: 4px !important;
  }

  /* ── Tear edge (the signature element) ─────────────────────── */
  .receipt__tear {
    display: flex;
    margin: 0 -20px;
    overflow: hidden;
    height: 14px;
    align-items: flex-end;
  }
  .receipt__tear-tooth {
    flex: 1;
    height: 10px;
    background: white;
    clip-path: polygon(0% 100%, 50% 0%, 100% 100%);
  }
  .receipt__tear-tooth:nth-child(even) { background: #e8e4dc; }

  /* ── Print styles ───────────────────────────────────────────── */
  @media print {
    .receipt {
      width: 80mm;
      max-width: 80mm;
      padding: 8px 4px;
      font-size: 11px;
      box-shadow: none;
      background: white;
      background-image: none;
    }
    .receipt__qr-glow { display: none; }
    .receipt__tear { display: none; }

    /* Force black ink on all text */
    * { color: black !important; -webkit-print-color-adjust: exact; }

    /* Show fiscal border in print */
    .receipt__fiscal-block {
      border: 2px solid black !important;
    }
  }
`;