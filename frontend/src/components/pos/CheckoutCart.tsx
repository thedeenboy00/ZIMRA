"use client";

// =============================================================================
// Checkout Cart Component
// src/components/pos/CheckoutCart.tsx
// =============================================================================

import { useState, useCallback } from "react";
import type { CartItem } from "../../app/pos/page";
import type { ReceiptTotals } from "../../services/currency/currencyEngine";

interface CheckoutCartProps {
  items: CartItem[];
  totals: ReceiptTotals | null;
  zigPerUsd: number;
  onIncrement: (cartItemId: string) => void;
  onDecrement: (cartItemId: string) => void;
  onRemove: (cartItemId: string) => void;
  onSetDiscount: (cartItemId: string, discountPercent: number) => void;
  onClearCart: () => void;
  onProceedToPayment: () => void;
  disabled: boolean;
}

export function CheckoutCart({
  items,
  totals,
  zigPerUsd,
  onIncrement,
  onDecrement,
  onRemove,
  onSetDiscount,
  onClearCart,
  onProceedToPayment,
  disabled,
}: CheckoutCartProps) {
  const [discountEditId, setDiscountEditId] = useState<string | null>(null);
  const [discountInput, setDiscountInput] = useState("");

  const handleDiscountSubmit = useCallback(
    (cartItemId: string) => {
      const value = parseFloat(discountInput);
      if (!isNaN(value) && value >= 0 && value <= 100) {
        onSetDiscount(cartItemId, value);
      }
      setDiscountEditId(null);
      setDiscountInput("");
    },
    [discountInput, onSetDiscount]
  );

  if (items.length === 0) {
    return (
      <div className="cart cart--empty">
        <div className="cart__empty-state">
          <span className="cart__empty-icon" aria-hidden="true">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" opacity="0.25">
              <path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/>
              <line x1="3" y1="6" x2="21" y2="6"/>
              <path d="M16 10a4 4 0 0 1-8 0"/>
            </svg>
          </span>
          <p className="cart__empty-label">Cart is empty</p>
          <p className="cart__empty-hint">Search for products or scan a barcode</p>
        </div>
        <style>{styles}</style>
      </div>
    );
  }

  const pricedLines = totals?.lines ?? [];

  return (
    <div className="cart">
      {/* Header */}
      <div className="cart__header">
        <span className="cart__header-title">
          {items.length} {items.length === 1 ? "item" : "items"}
        </span>
        <button
          className="cart__clear-btn"
          onClick={onClearCart}
          disabled={disabled}
          aria-label="Clear cart"
        >
          Clear
        </button>
      </div>

      {/* Line items */}
      <div className="cart__lines" role="list">
        {items.map((item, idx) => {
          const priced = pricedLines[idx];
          const isEditingDiscount = discountEditId === item.cartItemId;

          return (
            <div key={item.cartItemId} className="cart-line" role="listitem">
              {/* Product name + remove */}
              <div className="cart-line__top">
                <span className="cart-line__name">{item.productName}</span>
                <button
                  className="cart-line__remove"
                  onClick={() => onRemove(item.cartItemId)}
                  disabled={disabled}
                  aria-label={`Remove ${item.productName}`}
                >
                  ×
                </button>
              </div>

              {/* SKU + tax category */}
              <div className="cart-line__meta">
                <span className="cart-line__sku">{item.sku}</span>
                <span className="cart-line__tax">VAT {(item.vatRate * 100).toFixed(0)}%</span>
              </div>

              {/* Qty controls + line total */}
              <div className="cart-line__bottom">
                {/* Quantity stepper */}
                <div className="cart-line__qty">
                  <button
                    className="qty-btn"
                    onClick={() => onDecrement(item.cartItemId)}
                    disabled={disabled}
                    aria-label="Decrease quantity"
                  >−</button>
                  <span className="qty-value" aria-label={`Quantity ${item.quantity}`}>
                    {item.quantity}
                  </span>
                  <button
                    className="qty-btn"
                    onClick={() => onIncrement(item.cartItemId)}
                    disabled={disabled}
                    aria-label="Increase quantity"
                  >+</button>
                </div>

                {/* Unit price */}
                <span className="cart-line__unit-price">
                  ${item.unitPriceInclVatUsd.toFixed(2)} ea.
                </span>

                {/* Discount toggle */}
                {isEditingDiscount ? (
                  <div className="cart-line__discount-edit">
                    <input
                      type="number"
                      className="discount-input"
                      value={discountInput}
                      onChange={(e) => setDiscountInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") handleDiscountSubmit(item.cartItemId);
                        if (e.key === "Escape") setDiscountEditId(null);
                      }}
                      placeholder="0–100"
                      min={0}
                      max={100}
                      step={0.5}
                      autoFocus
                      aria-label="Discount percentage"
                    />
                    <span className="discount-pct-sign">%</span>
                    <button
                      className="discount-apply"
                      onClick={() => handleDiscountSubmit(item.cartItemId)}
                    >✓</button>
                  </div>
                ) : (
                  <button
                    className={`cart-line__discount-btn ${item.discountPercent > 0 ? "cart-line__discount-btn--active" : ""}`}
                    onClick={() => {
                      setDiscountEditId(item.cartItemId);
                      setDiscountInput(item.discountPercent > 0 ? String(item.discountPercent) : "");
                    }}
                    disabled={disabled}
                    aria-label={`${item.discountPercent > 0 ? `${item.discountPercent}% discount applied — click to edit` : "Apply discount"}`}
                  >
                    {item.discountPercent > 0 ? `-${item.discountPercent}%` : "Disc."}
                  </button>
                )}

                {/* Line total */}
                <span className="cart-line__total">
                  {priced ? `$${priced.lineTotalUsd.toFixed(2)}` : "—"}
                </span>
              </div>
            </div>
          );
        })}
      </div>

      {/* Totals panel */}
      {totals && (
        <div className="cart__totals">
          <div className="cart__totals-row">
            <span>Subtotal (excl. VAT)</span>
            <span className="cart__totals-value">${totals.subtotalExclVatUsd.toFixed(2)}</span>
          </div>

          {totals.totalDiscountUsd > 0 && (
            <div className="cart__totals-row cart__totals-row--discount">
              <span>Discount</span>
              <span className="cart__totals-value">−${totals.totalDiscountUsd.toFixed(2)}</span>
            </div>
          )}

          {/* VAT breakdown by category */}
          {totals.vatByCategory.map((vat) => (
            <div key={vat.taxCategory} className="cart__totals-row cart__totals-row--vat">
              <span>
                VAT {(vat.taxRate * 100).toFixed(0)}%
                <span className="cart__totals-cat"> (Cat. {vat.taxCategory})</span>
              </span>
              <span className="cart__totals-value">${vat.vatAmountUsd.toFixed(2)}</span>
            </div>
          ))}

          <div className="cart__totals-divider" />

          {/* Grand total USD */}
          <div className="cart__totals-row cart__totals-row--grand">
            <span>Total (USD)</span>
            <span className="cart__totals-grand-usd">${totals.grandTotalUsd.toFixed(2)}</span>
          </div>

          {/* ZiG equivalent */}
          {zigPerUsd > 0 && (
            <div className="cart__totals-row cart__totals-row--zig">
              <span>
                ZiG equiv.
                <span className="cart__totals-rate"> @ {zigPerUsd.toFixed(4)}</span>
              </span>
              <span className="cart__totals-grand-zig">{totals.grandTotalZig.toFixed(2)} ZiG</span>
            </div>
          )}

          {/* Proceed button */}
          <button
            className="cart__pay-btn"
            onClick={onProceedToPayment}
            disabled={disabled || items.length === 0}
          >
            Proceed to Payment →
          </button>
        </div>
      )}

      <style>{styles}</style>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = `
  .cart {
    display: flex;
    flex-direction: column;
    height: 100%;
    background: var(--pos-surface);
  }

  /* Empty state */
  .cart--empty { justify-content: center; align-items: center; }
  .cart__empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    color: var(--pos-muted);
    text-align: center;
    padding: 32px;
  }
  .cart__empty-icon { display: block; margin-bottom: 8px; }
  .cart__empty-label { font-size: 15px; font-weight: 500; margin: 0; }
  .cart__empty-hint { font-size: 13px; margin: 0; opacity: 0.7; }

  /* Header */
  .cart__header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 16px;
    border-bottom: 1px solid var(--pos-border);
    background: var(--pos-bg);
  }
  .cart__header-title { font-size: 12px; text-transform: uppercase; letter-spacing: 0.07em; color: var(--pos-muted); }
  .cart__clear-btn {
    background: none;
    border: 1px solid var(--pos-border);
    border-radius: var(--radius-sm);
    color: var(--pos-muted);
    font-size: 12px;
    padding: 3px 10px;
    cursor: pointer;
    transition: color 0.1s, border-color 0.1s;
  }
  .cart__clear-btn:hover:not(:disabled) { color: var(--pos-red-light); border-color: var(--pos-red); }

  /* Lines */
  .cart__lines {
    flex: 1;
    overflow-y: auto;
    padding: 8px 0;
  }

  .cart-line {
    padding: 10px 16px;
    border-bottom: 1px solid var(--pos-border);
    display: flex;
    flex-direction: column;
    gap: 5px;
    transition: background 0.1s;
  }
  .cart-line:hover { background: color-mix(in srgb, var(--pos-border) 30%, transparent); }

  .cart-line__top { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }
  .cart-line__name { font-size: 13px; font-weight: 500; color: var(--pos-text); line-height: 1.3; flex: 1; }
  .cart-line__remove {
    background: none; border: none; color: var(--pos-muted); font-size: 18px;
    cursor: pointer; line-height: 1; padding: 0; flex-shrink: 0;
    transition: color 0.1s;
  }
  .cart-line__remove:hover { color: var(--pos-red-light); }

  .cart-line__meta { display: flex; gap: 10px; align-items: center; }
  .cart-line__sku { font-family: var(--font-mono); font-size: 10px; color: var(--pos-muted); }
  .cart-line__tax { font-size: 10px; color: var(--pos-muted); opacity: 0.7; }

  .cart-line__bottom { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }

  /* Qty stepper */
  .cart-line__qty { display: flex; align-items: center; gap: 6px; }
  .qty-btn {
    width: 26px; height: 26px;
    background: var(--pos-bg); border: 1px solid var(--pos-border);
    border-radius: var(--radius-sm); color: var(--pos-text); font-size: 16px;
    cursor: pointer; display: flex; align-items: center; justify-content: center;
    line-height: 1; transition: border-color 0.1s;
  }
  .qty-btn:hover:not(:disabled) { border-color: var(--pos-green-light); color: var(--pos-green-light); }
  .qty-value { font-family: var(--font-mono); font-size: 14px; font-weight: 600; min-width: 24px; text-align: center; }

  .cart-line__unit-price { font-family: var(--font-mono); font-size: 11px; color: var(--pos-muted); }

  /* Discount */
  .cart-line__discount-btn {
    font-size: 11px; padding: 2px 8px;
    background: var(--pos-bg); border: 1px dashed var(--pos-border);
    border-radius: var(--radius-sm); color: var(--pos-muted); cursor: pointer;
    transition: color 0.1s, border-color 0.1s;
  }
  .cart-line__discount-btn:hover:not(:disabled) { color: var(--pos-amber-light); border-color: var(--pos-amber); }
  .cart-line__discount-btn--active { color: var(--pos-amber-light); border-color: var(--pos-amber); border-style: solid; }

  .cart-line__discount-edit { display: flex; align-items: center; gap: 4px; }
  .discount-input {
    width: 56px; background: var(--pos-bg); border: 1px solid var(--pos-amber);
    border-radius: var(--radius-sm); color: var(--pos-amber-light);
    font-family: var(--font-mono); font-size: 12px; padding: 2px 6px;
    outline: none; text-align: right;
  }
  .discount-pct-sign { font-size: 11px; color: var(--pos-amber); }
  .discount-apply {
    background: none; border: none; color: var(--pos-green-light); cursor: pointer; font-size: 14px; padding: 0 2px;
  }

  .cart-line__total {
    font-family: var(--font-mono); font-size: 14px; font-weight: 700;
    color: var(--pos-usd-light); margin-left: auto;
  }

  /* Totals */
  .cart__totals {
    border-top: 1px solid var(--pos-border);
    padding: 12px 16px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    background: var(--pos-bg);
  }
  .cart__totals-row {
    display: flex; justify-content: space-between; align-items: center;
    font-size: 13px; color: var(--pos-muted);
  }
  .cart__totals-row--discount .cart__totals-value { color: var(--pos-amber-light); }
  .cart__totals-row--vat { font-size: 12px; opacity: 0.85; }
  .cart__totals-cat { font-family: var(--font-mono); font-size: 10px; opacity: 0.7; }
  .cart__totals-row--grand { color: var(--pos-text); }
  .cart__totals-value { font-family: var(--font-mono); font-weight: 600; }
  .cart__totals-divider { border: none; border-top: 1px solid var(--pos-border); margin: 4px 0; }
  .cart__totals-grand-usd { font-family: var(--font-mono); font-size: 22px; font-weight: 800; color: var(--pos-usd-light); }
  .cart__totals-rate { font-family: var(--font-mono); font-size: 10px; opacity: 0.6; }
  .cart__totals-grand-zig { font-family: var(--font-mono); font-size: 15px; font-weight: 700; color: var(--pos-zig-light); }

  .cart__pay-btn {
    margin-top: 8px; width: 100%; padding: 14px;
    background: var(--pos-green); color: #fff; border: none;
    border-radius: var(--radius-md); font-family: var(--font-body);
    font-size: 15px; font-weight: 600; cursor: pointer;
    transition: background 0.15s, transform 0.1s;
    letter-spacing: 0.01em;
  }
  .cart__pay-btn:hover:not(:disabled) { background: #1f8049; }
  .cart__pay-btn:active:not(:disabled) { transform: scale(0.99); }
  .cart__pay-btn:disabled { background: var(--pos-border); color: var(--pos-muted); cursor: not-allowed; }
`;