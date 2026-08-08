"use client";

// =============================================================================
// Product Search Component
// src/components/pos/ProductSearch.tsx
// =============================================================================

import { useState, useRef, useEffect, useCallback } from "react";
import { useProductSearch } from "../../services/sync/useSyncManager";
import type { LocalProduct } from "../../services/sync/offlineDb";

interface ProductSearchProps {
  onAddProduct: (product: LocalProduct) => void;
}

export function ProductSearch({ onAddProduct }: ProductSearchProps) {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const { results, isSearching } = useProductSearch(query, 24);

  // Auto-focus on mount — cashier can start scanning immediately
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      // Enter with exactly one result = add it (barcode scanner behaviour)
      if (e.key === "Enter" && results.length === 1) {
        onAddProduct(results[0]);
        setQuery("");
      }
    },
    [results, onAddProduct]
  );

  return (
    <div className="product-search">
      {/* Search bar */}
      <div className="product-search__bar">
        <span className="product-search__icon" aria-hidden="true">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.35-4.35" />
          </svg>
        </span>
        <input
          ref={inputRef}
          type="text"
          className="product-search__input"
          placeholder="Search product or scan barcode…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          autoComplete="off"
          spellCheck={false}
          aria-label="Search products or scan barcode"
        />
        {query && (
          <button
            className="product-search__clear"
            onClick={() => { setQuery(""); inputRef.current?.focus(); }}
            aria-label="Clear search"
          >
            ×
          </button>
        )}
      </div>

      {/* Results grid */}
      <div className="product-search__results" role="list">
        {isSearching && (
          <div className="product-search__state">
            <div className="product-search__spinner" aria-hidden="true" />
            <span>Searching…</span>
          </div>
        )}

        {!isSearching && query && results.length === 0 && (
          <div className="product-search__state product-search__state--empty">
            <span className="product-search__empty-icon" aria-hidden="true">☐</span>
            <span>No products match &ldquo;{query}&rdquo;</span>
            <span className="product-search__empty-hint">Check the SKU or barcode</span>
          </div>
        )}

        {!isSearching && results.map((product) => (
          <ProductCard
            key={product.id}
            product={product}
            onAdd={onAddProduct}
          />
        ))}

        {!isSearching && !query && results.length === 0 && (
          <div className="product-search__state product-search__state--idle">
            <span className="product-search__empty-icon" aria-hidden="true">⊞</span>
            <span>Type a name, SKU, or scan a barcode</span>
          </div>
        )}
      </div>

      <style>{styles}</style>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Product Card
// ---------------------------------------------------------------------------

interface ProductCardProps {
  product: LocalProduct;
  onAdd: (product: LocalProduct) => void;
}

function ProductCard({ product, onAdd }: ProductCardProps) {
  const isLowStock =
    product.trackInventory &&
    product.stockQuantity <= 5 &&
    product.stockQuantity > 0;
  const isOutOfStock =
    product.trackInventory && product.stockQuantity <= 0;

  return (
    <button
      className={`product-card ${isOutOfStock ? "product-card--out-of-stock" : ""}`}
      onClick={() => !isOutOfStock && onAdd(product)}
      disabled={isOutOfStock}
      role="listitem"
      aria-label={`Add ${product.name} — $${product.priceInclVatUsd.toFixed(2)}`}
    >
      {/* Tax badge */}
      <span
        className={`product-card__tax-badge product-card__tax-badge--${product.taxCategory.toLowerCase()}`}
        title={`Tax category ${product.taxCategory}`}
      >
        {product.taxCategory}
      </span>

      <span className="product-card__name">{product.name}</span>
      <span className="product-card__sku">{product.sku}</span>

      <span className="product-card__price">
        ${product.priceInclVatUsd.toFixed(2)}
      </span>

      {isLowStock && (
        <span className="product-card__stock-warn" aria-label="Low stock">
          {product.stockQuantity} left
        </span>
      )}
      {isOutOfStock && (
        <span className="product-card__out-of-stock">Out of stock</span>
      )}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = `
  .product-search {
    display: flex;
    flex-direction: column;
    height: 100%;
    background: var(--pos-surface);
  }

  /* Search bar */
  .product-search__bar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 12px 16px;
    background: var(--pos-bg);
    border-bottom: 1px solid var(--pos-border);
    position: sticky;
    top: 0;
    z-index: 2;
  }
  .product-search__icon { color: var(--pos-muted); flex-shrink: 0; }
  .product-search__input {
    flex: 1;
    background: none;
    border: none;
    outline: none;
    color: var(--pos-text);
    font-family: var(--font-body);
    font-size: 15px;
    caret-color: var(--pos-green-light);
  }
  .product-search__input::placeholder { color: var(--pos-muted); }
  .product-search__clear {
    background: none;
    border: none;
    color: var(--pos-muted);
    font-size: 20px;
    cursor: pointer;
    line-height: 1;
    padding: 0 4px;
  }
  .product-search__clear:hover { color: var(--pos-text); }

  /* Results grid */
  .product-search__results {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
    gap: 1px;
    background: var(--pos-border);
    flex: 1;
    align-content: start;
    overflow-y: auto;
  }

  /* State messages */
  .product-search__state {
    grid-column: 1 / -1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 48px 24px;
    color: var(--pos-muted);
    font-size: 14px;
    text-align: center;
  }
  .product-search__empty-icon { font-size: 32px; opacity: 0.4; }
  .product-search__empty-hint { font-size: 12px; opacity: 0.7; }
  .product-search__spinner {
    width: 24px;
    height: 24px;
    border: 2px solid var(--pos-border);
    border-top-color: var(--pos-green-light);
    border-radius: 50%;
    animation: spin 0.7s linear infinite;
  }

  /* Product cards */
  .product-card {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 4px;
    padding: 12px;
    background: var(--pos-surface);
    border: none;
    cursor: pointer;
    text-align: left;
    transition: background 0.1s;
    min-height: 90px;
  }
  .product-card:hover:not(:disabled) {
    background: color-mix(in srgb, var(--pos-green) 12%, var(--pos-surface));
  }
  .product-card:active:not(:disabled) {
    background: color-mix(in srgb, var(--pos-green) 20%, var(--pos-surface));
  }
  .product-card--out-of-stock {
    opacity: 0.45;
    cursor: not-allowed;
  }

  .product-card__tax-badge {
    position: absolute;
    top: 6px;
    right: 6px;
    font-family: var(--font-mono);
    font-size: 9px;
    font-weight: 700;
    padding: 1px 4px;
    border-radius: 3px;
    letter-spacing: 0.05em;
  }
  .product-card__tax-badge--a { background: #1A6B3C22; color: #22C55E; border: 1px solid #1A6B3C; }
  .product-card__tax-badge--b { background: #2D5FA622; color: #93C5FD; border: 1px solid #2D5FA6; }
  .product-card__tax-badge--c { background: #6B728022; color: #9CA3AF; border: 1px solid #6B7280; }
  .product-card__tax-badge--d { background: #C8922A22; color: #FCD34D; border: 1px solid #C8922A; }
  .product-card__tax-badge--e { background: #8B451322; color: #FCD9A0; border: 1px solid #8B4513; }

  .product-card__name {
    font-size: 13px;
    font-weight: 500;
    color: var(--pos-text);
    line-height: 1.3;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .product-card__sku {
    font-family: var(--font-mono);
    font-size: 10px;
    color: var(--pos-muted);
  }
  .product-card__price {
    font-family: var(--font-mono);
    font-size: 15px;
    font-weight: 700;
    color: var(--pos-usd-light);
    margin-top: auto;
  }
  .product-card__stock-warn {
    font-size: 10px;
    color: var(--pos-amber);
    font-weight: 600;
  }
  .product-card__out-of-stock {
    font-size: 10px;
    color: var(--pos-red-light);
  }
`;