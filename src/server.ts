// =============================================================================
// src/server.ts — Express API Entry Point
// =============================================================================
// Start order:
//   1. Load env vars
//   2. Build Express app
//   3. app.listen() → server is accepting HTTP traffic
//   4. startWorker() → in-process sync worker begins polling
//   5. SIGTERM / SIGINT → graceful shutdown (drain requests + stop worker)
// =============================================================================

import "dotenv/config";
import express, { type Request, type Response, type NextFunction } from "express";
import { createServer, type Server as HttpServer } from "http";

import prisma from "./lib/db.js";
import { startWorker, stopWorker } from "./worker.js";
import { captureRawBody, createWebhookHandler } from "./api/webhooks/paynow.js";
import { createPaymentHandler } from "./api/subscription/create-payment.js";
import { createSubscriptionGuard } from "./services/subscription.js";

// ---------------------------------------------------------------------------
// §1. ENVIRONMENT VALIDATION
// ---------------------------------------------------------------------------

const REQUIRED_ENV = [
  "DATABASE_URL",
  "DEVICE_KEY_SECRET",
  "DEVICE_KEY_SALT",
  "JWT_SECRET",
] as const;

for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`[Server] FATAL: Missing required environment variable: ${key}`);
    process.exit(1);
  }
}

const PORT = parseInt(process.env.PORT ?? "3001", 10);

// ---------------------------------------------------------------------------
// §2. EXPRESS APPLICATION
// ---------------------------------------------------------------------------

const app = express();

// ── Global middleware ────────────────────────────────────────────────────────

// Raw body capture MUST come before express.json() for webhook signature verification
app.use("/api/webhooks", captureRawBody);
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

// Basic security headers
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-XSS-Protection", "1; mode=block");
  next();
});

// CORS — allow Vercel frontend origin
const allowedOrigins = [
  process.env.APP_BASE_URL,
  "http://localhost:3000",
].filter(Boolean) as string[];

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization,X-Idempotency-Key");
    res.setHeader("Access-Control-Max-Age", "86400");
  }
  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
});

// ── Health check ─────────────────────────────────────────────────────────────
// Render polls this before marking a deploy successful.
// Also checked by the GitHub Actions deploy workflow.

app.get("/api/health", async (_req: Request, res: Response) => {
  try {
    // Lightweight DB ping — confirms Supabase connection is alive
    await prisma.$queryRaw`SELECT 1`;
    res.json({
      status: "ok",
      timestamp: new Date().toISOString(),
      environment: process.env.ZIMRA_ENVIRONMENT ?? "unknown",
      worker: "in-process",
    });
  } catch {
    res.status(503).json({ status: "degraded", reason: "database_unavailable" });
  }
});

// ── Webhook routes (no auth — verified by payload signature) ─────────────────

app.post("/api/webhooks/paynow", createWebhookHandler(prisma));

// ── Authenticated routes ──────────────────────────────────────────────────────
// All routes below require a valid JWT and an active subscription.

const subscriptionGuard = createSubscriptionGuard(prisma);

app.post(
  "/api/subscription/create-payment",
  subscriptionGuard,
  createPaymentHandler(prisma)
);

// ── 404 handler ───────────────────────────────────────────────────────────────

app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: "Not found." });
});

// ── Global error handler ─────────────────────────────────────────────────────

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error("[Server] Unhandled error:", err);
  res.status(500).json({
    error: "Internal server error.",
    message: process.env.NODE_ENV === "development" ? err.message : undefined,
  });
});

// ---------------------------------------------------------------------------
// §3. START SERVER + WORKER
// ---------------------------------------------------------------------------

const httpServer: HttpServer = createServer(app);

httpServer.listen(PORT, () => {
  console.log(`[Server] Listening on port ${PORT} (${process.env.NODE_ENV})`);
  console.log(`[Server] ZIMRA environment: ${process.env.ZIMRA_ENVIRONMENT}`);

  // Start the in-process sync worker AFTER the server is listening.
  // If the worker errors on startup it must not crash the API process.
  try {
    startWorker();
  } catch (err) {
    console.error("[Server] Worker failed to start:", err);
    // Non-fatal — the API continues serving; worker will not poll.
  }
});

// ---------------------------------------------------------------------------
// §4. GRACEFUL SHUTDOWN
// ---------------------------------------------------------------------------
// Render sends SIGTERM before stopping a container.
// We have `maxShutdownDelaySeconds: 30` in render.yaml —
// 30 seconds to finish in-flight ZIMRA requests before the process is killed.

let isShuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (isShuttingDown) return; // Ignore duplicate signals
  isShuttingDown = true;

  console.log(`[Server] ${signal} received — starting graceful shutdown...`);

  // Step 1: Stop accepting new HTTP connections
  // Existing keep-alive connections are allowed to complete.
  httpServer.close(() => {
    console.log("[Server] HTTP server closed — no new connections accepted.");
  });

  // Step 2: Stop the sync worker and wait for the current tick to drain.
  // stopWorker() returns a Promise that resolves once in-flight ZIMRA
  // API calls complete (up to 35 seconds).
  try {
    await stopWorker();
  } catch (err) {
    console.error("[Server] Error stopping worker:", err);
  }

  // Step 3: Disconnect Prisma — flushes any pending query pipeline.
  try {
    await prisma.$disconnect();
    console.log("[Server] Prisma disconnected.");
  } catch (err) {
    console.error("[Server] Error disconnecting Prisma:", err);
  }

  console.log("[Server] Graceful shutdown complete.");
  process.exit(0);
}

// Render (and Docker) send SIGTERM on deploy / scale-down
process.on("SIGTERM", () => shutdown("SIGTERM"));

// Local development Ctrl+C
process.on("SIGINT", () => shutdown("SIGINT"));

// Safety net — log unhandled promise rejections rather than crashing silently.
// The worker catches its own errors; this catches anything that slips through.
process.on("unhandledRejection", (reason) => {
  console.error("[Server] Unhandled promise rejection:", reason);
});

process.on("uncaughtException", (err) => {
  console.error("[Server] Uncaught exception:", err);
  // Uncaught exceptions leave the process in an unknown state — exit and
  // let Render restart the container.
  shutdown("uncaughtException").finally(() => process.exit(1));
});