// =============================================================================
// Root Layout
// src/app/layout.tsx
// =============================================================================

import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import { SyncManagerProvider } from "../services/sync/useSyncManager";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

export const metadata: Metadata = {
  title: "ZIMRA POS Platform",
  description: "ZIMRA FDMS-compliant point-of-sale system for Zimbabwean businesses",
  robots: { index: false, follow: false }, // Internal tool — no indexing
  manifest: "/manifest.json",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1, // Prevent accidental zoom on POS touchscreens
  themeColor: "#0F1117",
};

// Sync manager config — in production, pull from server session
const SYNC_CONFIG = {
  apiBaseUrl: process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001",
  tenantId: "RUNTIME_TENANT_ID",   // Injected at runtime from auth session
  deviceDbId: "RUNTIME_DEVICE_ID", // Injected at runtime from device registration
  deviceId: "RUNTIME_ZIMRA_SERIAL",
  activeIntervalMs: 5_000,
  idleIntervalMs: 30_000,
  connectivityProbeUrl: "/api/health",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={inter.variable}>
      <head>
        {/* JetBrains Mono for all monetary values */}
        <link
          rel="preconnect"
          href="https://fonts.googleapis.com"
        />
        <link
          rel="preconnect"
          href="https://fonts.gstatic.com"
          crossOrigin="anonymous"
        />
        <link
          href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700;900&family=Inter:wght@400;500;600;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>
        <SyncManagerProvider config={SYNC_CONFIG}>
          {children}
        </SyncManagerProvider>
        <style>{globalStyles}</style>
      </body>
    </html>
  );
}

// ---------------------------------------------------------------------------
// Global CSS — design tokens applied at :root, resets, and utility classes
// ---------------------------------------------------------------------------

const globalStyles = `
  *, *::before, *::after {
    box-sizing: border-box;
    margin: 0;
    padding: 0;
  }

  :root {
    /* Design tokens — shared across all components */
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

    --font-mono: 'JetBrains Mono', 'Fira Code', 'Courier New', monospace;
    --font-body: 'Inter', var(--font-inter, system-ui), sans-serif;

    --radius-sm: 4px;
    --radius-md: 8px;
    --radius-lg: 12px;

    color-scheme: dark;
  }

  html, body {
    height: 100%;
    background: var(--pos-bg);
    color: var(--pos-text);
    font-family: var(--font-body);
    font-size: 14px;
    line-height: 1.5;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
    /* Prevent pull-to-refresh on touch POS devices */
    overscroll-behavior: none;
  }

  /* Number inputs — hide spinners in POS context */
  input[type="number"]::-webkit-inner-spin-button,
  input[type="number"]::-webkit-outer-spin-button {
    -webkit-appearance: none;
    margin: 0;
  }
  input[type="number"] { -moz-appearance: textfield; }

  /* Focus ring — visible for accessibility, styled to brand */
  :focus-visible {
    outline: 2px solid var(--pos-green-light);
    outline-offset: 2px;
  }

  /* Custom scrollbar — dark theme */
  ::-webkit-scrollbar { width: 6px; height: 6px; }
  ::-webkit-scrollbar-track { background: var(--pos-bg); }
  ::-webkit-scrollbar-thumb { background: var(--pos-border); border-radius: 3px; }
  ::-webkit-scrollbar-thumb:hover { background: var(--pos-muted); }

  /* Global print reset */
  @media print {
    :root { color-scheme: light; }
    body { background: white; color: black; }
    .no-print { display: none !important; }
  }

  /* Utility: screen-reader only */
  .sr-only {
    position: absolute; width: 1px; height: 1px;
    padding: 0; margin: -1px; overflow: hidden;
    clip: rect(0,0,0,0); white-space: nowrap; border: 0;
  }
`;