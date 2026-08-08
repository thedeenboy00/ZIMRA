"use client";

// =============================================================================
// POS Checkout Page
// src/app/pos/page.tsx
// =============================================================================
// The primary cashier interface. Three-panel layout on desktop, stacked on
// tablet (the primary target device). Fully offline-capable via Dexie.js.
//
// Panel layout:
//   LEFT  — Product search + catalogue grid
//   CENTRE — Live cart with line items, discounts, dual-currency totals
//   RIGHT  — Payment tender panel (split USD + ZiG inputs) + receipt preview
// =============================================================================

import { useState, useCallback, useReducer, useRef, useEffect } from "react";
// Use browser-native crypto — available in all modern browsers and Next.js
const randomUUID = () => crypto.randomUUID();

import { CheckoutCart } from "../../components/pos/CheckoutCart";
import { ProductSearch } from "../../components/pos/ProductSearch";
import { PaymentPanel } from "../../components/pos/PaymentPanel";
import { ReceiptModal } from "../../components/receipt/ReceiptModal";
import { SubscriptionBanner } from "../../components/subscription/SubscriptionBanner";
import { SyncStatusBar } from "../../components/pos/SyncStatusBar";

import {
  useSyncManager,
  useSyncStatus,
  useLocalRate,
  useConnectivity,
} from "../../services/sync/useSyncManager";

import {
  buildReceiptTotals,
  normalisePayments,
  priceLineItem,
} from "../../services/currency/currencyEngine";

import {
  serialiseSaleItems,
  serialisePayments,
  type LocalProduct,
  type LocalSale,
  type LocalSaleItem,
} from "../../services/sync/offlineDb";

import type {
  LineItemInput,
  PaymentLine,
  ReceiptTotals,
  NormalisedPayments,
} from "../../services/currency/currencyEngine";

// ---------------------------------------------------------------------------
// §1. CART STATE TYPES & REDUCER
// ---------------------------------------------------------------------------

export interface CartItem extends LineItemInput {
  cartItemId: string; // Unique within this cart session
  productId: string;
  sku: string;
  productName: string;
  hsCode?: string;
}

type CartAction =
  | { type: "ADD_PRODUCT"; product: LocalProduct }
  | { type: "INCREMENT"; cartItemId: string }
  | { type: "DECREMENT"; cartItemId: string }
  | { type: "REMOVE"; cartItemId: string }
  | { type: "SET_DISCOUNT"; cartItemId: string; discountPercent: number }
  | { type: "CLEAR" };

function cartReducer(state: CartItem[], action: CartAction): CartItem[] {
  switch (action.type) {
    case "ADD_PRODUCT": {
      const p = action.product;
      // Increment quantity if product already in cart
      const existing = state.find((i) => i.productId === p.id);
      if (existing) {
        return state.map((i) =>
          i.productId === p.id
            ? { ...i, quantity: i.quantity + 1 }
            : i
        );
      }
      const newItem: CartItem = {
        cartItemId: randomUUID(),
        productId: p.id,
        sku: p.sku,
        productName: p.name,
        hsCode: p.hsCode,
        taxCategory: p.taxCategory,
        quantity: 1,
        unit: p.unit,
        unitPriceInclVatUsd: p.priceInclVatUsd,
        vatRate: p.vatRate,
        discountPercent: 0,
      };
      return [...state, newItem];
    }

    case "INCREMENT":
      return state.map((i) =>
        i.cartItemId === action.cartItemId
          ? { ...i, quantity: i.quantity + 1 }
          : i
      );

    case "DECREMENT":
      return state
        .map((i) =>
          i.cartItemId === action.cartItemId
            ? { ...i, quantity: Math.max(0, i.quantity - 1) }
            : i
        )
        .filter((i) => i.quantity > 0);

    case "REMOVE":
      return state.filter((i) => i.cartItemId !== action.cartItemId);

    case "SET_DISCOUNT":
      return state.map((i) =>
        i.cartItemId === action.cartItemId
          ? { ...i, discountPercent: action.discountPercent }
          : i
      );

    case "CLEAR":
      return [];

    default:
      return state;
  }
}

// ---------------------------------------------------------------------------
// §2. CHECKOUT FLOW STATE
// ---------------------------------------------------------------------------

type CheckoutStage =
  | "CART"       // Building the cart
  | "PAYMENT"    // Cashier entering tender
  | "PROCESSING" // Submitting to ZIMRA
  | "RECEIPT"    // Showing completed receipt

interface CompletedSale {
  sale: LocalSale;
  totals: ReceiptTotals;
  payments: NormalisedPayments;
}

// ---------------------------------------------------------------------------
// §3. PAGE COMPONENT
// ---------------------------------------------------------------------------

export default function PosCheckoutPage() {
  const syncManager = useSyncManager();
  const syncStatus = useSyncStatus();
  const isOnline = useConnectivity();
  const { rate: zigPerUsd, error: rateError } = useLocalRate();

  const [cart, dispatchCart] = useReducer(cartReducer, []);
  const [stage, setStage] = useState<CheckoutStage>("CART");
  const [completedSale, setCompletedSale] = useState<CompletedSale | null>(null);
  const [processingError, setProcessingError] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);

  // Compute live totals whenever cart or rate changes
  const totals: ReceiptTotals | null =
    cart.length > 0 && zigPerUsd
      ? buildReceiptTotals(cart, zigPerUsd)
      : null;

  // ---------------------------------------------------------------------------
  // §4. CART HANDLERS
  // ---------------------------------------------------------------------------

  const handleAddProduct = useCallback((product: LocalProduct) => {
    dispatchCart({ type: "ADD_PRODUCT", product });
  }, []);

  const handleIncrement = useCallback((cartItemId: string) => {
    dispatchCart({ type: "INCREMENT", cartItemId });
  }, []);

  const handleDecrement = useCallback((cartItemId: string) => {
    dispatchCart({ type: "DECREMENT", cartItemId });
  }, []);

  const handleRemove = useCallback((cartItemId: string) => {
    dispatchCart({ type: "REMOVE", cartItemId });
  }, []);

  const handleSetDiscount = useCallback(
    (cartItemId: string, discountPercent: number) => {
      dispatchCart({ type: "SET_DISCOUNT", cartItemId, discountPercent });
    },
    []
  );

  const handleClearCart = useCallback(() => {
    dispatchCart({ type: "CLEAR" });
    setStage("CART");
    setCompletedSale(null);
    setProcessingError(null);
  }, []);

  // ---------------------------------------------------------------------------
  // §5. PAYMENT SUBMISSION
  // ---------------------------------------------------------------------------

  const handlePaymentSubmit = useCallback(
    async (tenders: PaymentLine[]) => {
      if (!totals || !zigPerUsd) return;
      setIsProcessing(true);
      setProcessingError(null);
      setStage("PROCESSING");

      try {
        // Validate and normalise payments
        const payments = normalisePayments(
          tenders,
          totals.grandTotalUsd,
          zigPerUsd
        );

        // Build LocalSaleItems from priced lines
        const saleItems: LocalSaleItem[] = totals.lines.map((line, idx) => ({
          id: randomUUID(),
          productId: line.productId,
          sku: line.sku,
          productName: line.productName,
          hsCode: line.hsCode,
          taxCategory: line.taxCategory,
          quantity: line.quantity,
          unit: line.unit,
          unitPriceExclVatUsd: line.unitPriceExclVatUsd,
          vatRate: line.vatRate,
          vatAmountUsd: line.vatAmountUsd,
          lineTotalUsd: line.lineTotalUsd,
          taxableAmountUsd: line.taxableAmountUsd,
          discountUsd: line.discountUsd,
          discountPercent: line.discountPercent,
          lineOrder: idx,
        }));

        // Retrieve current device from IndexedDB
        const db = syncManager["config"]; // Access config for tenantId/deviceId
        const localDevice = await syncManager
          .syncDeviceState()
          .then(() =>
            syncManager["config"] // device info accessible from config
          )
          .catch(() => null);

        const now = Date.now();
        const saleId = randomUUID();

        // Build the LocalSale
        const sale: LocalSale = {
          id: saleId,
          tenantId: (syncManager as any).config.tenantId,
          deviceId: (syncManager as any).config.deviceId,
          deviceDbId: (syncManager as any).config.deviceDbId,
          fiscalDayNo: 0, // Set by device counter — will be reconciled on sync
          cashierId: "current-user", // Injected from auth context in real impl
          cashierName: "Cashier",   // Injected from auth context
          status: "COMPLETED",
          receiptType: "FISCAL_INVOICE",
          createdAt: now,
          updatedAt: now,
          completedAt: now,
          subtotalUsd: totals.subtotalExclVatUsd,
          discountUsd: totals.totalDiscountUsd,
          vatTotalUsd: totals.totalVatUsd,
          grandTotalUsd: totals.grandTotalUsd,
          grandTotalZig: totals.grandTotalZig,
          exchangeRateUsed: zigPerUsd,
          paymentsJson: serialisePayments(payments.lines),
          changeDueUsd: payments.changeDueUsd,
          changeDueZig: payments.changeDueZig,
          itemsJson: serialiseSaleItems(saleItems),
          needsServerSync: true,
          needsZimraSync: true,
          localIdempotencyKey: saleId,
        };

        // Persist locally and enqueue for ZIMRA sync
        await syncManager.persistSaleLocally(sale);

        setCompletedSale({ sale, totals, payments });
        setStage("RECEIPT");
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Payment processing failed.";
        setProcessingError(message);
        setStage("PAYMENT");
      } finally {
        setIsProcessing(false);
      }
    },
    [totals, zigPerUsd, syncManager]
  );

  // ---------------------------------------------------------------------------
  // §6. RENDER
  // ---------------------------------------------------------------------------

  return (
    <div className="pos-shell">
      {/* ── Subscription warning banner ─────────────────────────────── */}
      <SubscriptionBanner />

      {/* ── Sync & connectivity status bar ──────────────────────────── */}
      <SyncStatusBar
        isOnline={isOnline}
        pendingCount={syncStatus.pendingCount}
        failedCount={syncStatus.failedCount}
        lastSyncAt={syncStatus.lastSyncAt}
      />

      {/* ── Rate error notice ───────────────────────────────────────── */}
      {rateError && (
        <div className="rate-error-notice" role="alert">
          <span className="rate-error-icon">⚠</span>
          <span>
            No exchange rate for today. ZiG payments unavailable.{" "}
            <a href="/settings/rates" className="rate-error-link">
              Set rate
            </a>
          </span>
        </div>
      )}

      {/* ── Three-panel POS layout ───────────────────────────────────── */}
      <main className="pos-grid">
        {/* LEFT — Product catalogue */}
        <aside className="pos-panel pos-panel--products">
          <ProductSearch onAddProduct={handleAddProduct} />
        </aside>

        {/* CENTRE — Live cart */}
        <section className="pos-panel pos-panel--cart">
          <CheckoutCart
            items={cart}
            totals={totals}
            zigPerUsd={zigPerUsd ?? 0}
            onIncrement={handleIncrement}
            onDecrement={handleDecrement}
            onRemove={handleRemove}
            onSetDiscount={handleSetDiscount}
            onClearCart={handleClearCart}
            onProceedToPayment={() => setStage("PAYMENT")}
            disabled={stage !== "CART"}
          />
        </section>

        {/* RIGHT — Payment panel */}
        <section className="pos-panel pos-panel--payment">
          {stage === "CART" && totals && (
            <div className="payment-prompt">
              <p className="payment-prompt__label">Total Due</p>
              <p className="payment-prompt__amount">
                ${totals.grandTotalUsd.toFixed(2)}
              </p>
              {zigPerUsd && (
                <p className="payment-prompt__zig">
                  {totals.grandTotalZig.toFixed(2)} ZiG
                </p>
              )}
              <button
                className="btn btn--pay"
                onClick={() => setStage("PAYMENT")}
                disabled={cart.length === 0}
              >
                Charge Customer
              </button>
            </div>
          )}

          {(stage === "PAYMENT" || stage === "PROCESSING") && totals && (
            <PaymentPanel
              grandTotalUsd={totals.grandTotalUsd}
              grandTotalZig={totals.grandTotalZig}
              zigPerUsd={zigPerUsd ?? 0}
              isProcessing={isProcessing}
              error={processingError}
              onSubmit={handlePaymentSubmit}
              onBack={() => setStage("CART")}
            />
          )}

          {stage === "PROCESSING" && (
            <div className="processing-overlay" aria-live="polite">
              <div className="processing-spinner" aria-hidden="true" />
              <p>Submitting to ZIMRA&hellip;</p>
              {!isOnline && (
                <p className="processing-offline">
                  You&apos;re offline — receipt saved locally and will sync
                  automatically.
                </p>
              )}
            </div>
          )}
        </section>
      </main>

      {/* ── Completed receipt modal ──────────────────────────────────── */}
      {stage === "RECEIPT" && completedSale && (
        <ReceiptModal
          sale={completedSale.sale}
          totals={completedSale.totals}
          payments={completedSale.payments}
          zigPerUsd={zigPerUsd ?? 0}
          onNewSale={handleClearCart}
        />
      )}

      <style>{posPageStyles}</style>
    </div>
  );
}

// ---------------------------------------------------------------------------
// §7. PAGE-LEVEL STYLES
// ---------------------------------------------------------------------------

const posPageStyles = `
  /* Design tokens */
  :root {
    --pos-bg:          #0F1117;
    --pos-surface:     #181C27;
    --pos-border:      #262C3D;
    --pos-text:        #E8EAF0;
    --pos-muted:       #6B7280;
    --pos-green:       #1A6B3C;
    --pos-green-light: #22C55E;
    --pos-amber:       #C8922A;
    --pos-amber-light: #FCD34D;
    --pos-red:         #DC2626;
    --pos-red-light:   #FCA5A5;
    --pos-usd:         #2D5FA6;
    --pos-usd-light:   #93C5FD;
    --pos-zig:         #8B4513;
    --pos-zig-light:   #FCD9A0;
    --pos-receipt-bg:  #F8F5EE;
    --pos-receipt-ink: #1A1A1A;
    --font-mono:       'JetBrains Mono', 'Fira Code', 'Courier New', monospace;
    --font-body:       'Inter', system-ui, sans-serif;
    --radius-sm:       4px;
    --radius-md:       8px;
    --radius-lg:       12px;
  }

  /* Shell */
  .pos-shell {
    display: flex;
    flex-direction: column;
    min-height: 100vh;
    background: var(--pos-bg);
    color: var(--pos-text);
    font-family: var(--font-body);
    font-size: 14px;
    line-height: 1.5;
  }

  /* Three-panel grid */
  .pos-grid {
    display: grid;
    grid-template-columns: 340px 1fr 380px;
    grid-template-rows: 1fr;
    flex: 1;
    min-height: 0;
    gap: 1px;
    background: var(--pos-border);
  }

  @media (max-width: 1024px) {
    .pos-grid {
      grid-template-columns: 1fr;
      grid-template-rows: auto 1fr auto;
    }
  }

  /* Panels */
  .pos-panel {
    background: var(--pos-surface);
    overflow-y: auto;
    padding: 16px;
  }

  .pos-panel--products { padding: 0; }
  .pos-panel--cart { padding: 0; }
  .pos-panel--payment { display: flex; flex-direction: column; }

  /* Rate error */
  .rate-error-notice {
    display: flex;
    align-items: center;
    gap: 8px;
    background: color-mix(in srgb, var(--pos-amber) 15%, transparent);
    border-bottom: 1px solid var(--pos-amber);
    padding: 8px 16px;
    font-size: 13px;
    color: var(--pos-amber-light);
  }
  .rate-error-icon { font-size: 16px; }
  .rate-error-link {
    color: var(--pos-amber-light);
    text-decoration: underline;
    text-underline-offset: 2px;
  }

  /* Payment prompt (idle state, right panel) */
  .payment-prompt {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    flex: 1;
    gap: 8px;
    padding: 32px 16px;
    text-align: center;
  }
  .payment-prompt__label {
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--pos-muted);
    margin: 0;
  }
  .payment-prompt__amount {
    font-family: var(--font-mono);
    font-size: 48px;
    font-weight: 700;
    color: var(--pos-usd-light);
    margin: 0;
    line-height: 1;
  }
  .payment-prompt__zig {
    font-family: var(--font-mono);
    font-size: 18px;
    color: var(--pos-zig-light);
    margin: 0;
  }

  /* Charge button */
  .btn--pay {
    margin-top: 24px;
    width: 100%;
    max-width: 280px;
    padding: 16px 24px;
    background: var(--pos-green);
    color: #fff;
    border: none;
    border-radius: var(--radius-md);
    font-family: var(--font-body);
    font-size: 16px;
    font-weight: 600;
    letter-spacing: 0.02em;
    cursor: pointer;
    transition: background 0.15s, transform 0.1s;
  }
  .btn--pay:hover:not(:disabled) { background: #1f8049; }
  .btn--pay:active:not(:disabled) { transform: scale(0.98); }
  .btn--pay:disabled {
    background: var(--pos-border);
    color: var(--pos-muted);
    cursor: not-allowed;
  }

  /* Processing overlay */
  .processing-overlay {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    background: color-mix(in srgb, var(--pos-surface) 92%, transparent);
    gap: 16px;
    font-size: 15px;
    color: var(--pos-muted);
    backdrop-filter: blur(2px);
    z-index: 10;
  }
  .processing-spinner {
    width: 40px;
    height: 40px;
    border: 3px solid var(--pos-border);
    border-top-color: var(--pos-green-light);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  .processing-offline {
    font-size: 13px;
    color: var(--pos-amber);
    text-align: center;
    max-width: 260px;
  }
`;