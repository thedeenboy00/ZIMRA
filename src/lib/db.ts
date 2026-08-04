// =============================================================================
// src/lib/db.ts — PrismaClient singleton (Prisma v7)
// =============================================================================
// In Prisma v7, the connection URL is passed to PrismaClient directly,
// not read from schema.prisma.
//
// DATABASE_URL = Transaction Pooler URL (port 6543, ?pgbouncer=true)
//               Used for all runtime queries — efficient connection pooling
//               for multiple simultaneous POS terminals.
// =============================================================================

import { PrismaClient } from "../../generated/prisma";

// Prevent multiple PrismaClient instances in development (Next.js hot reload)
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    datasourceUrl: process.env.DATABASE_URL,
    log:
      process.env.NODE_ENV === "development"
        ? ["query", "error", "warn"]
        : ["error"],
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

export default prisma;