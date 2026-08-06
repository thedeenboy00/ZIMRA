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

import { PrismaClient } from "../../generated/prisma/index.js";

// Prevent multiple PrismaClient instances in development (Next.js hot reload)
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };
const nodeEnv = (globalThis as any).process?.env?.NODE_ENV;

export const prisma =
  globalForPrisma.prisma ??
  (() => {
    const prismaOptions: any = {
      log:
        nodeEnv === "development"
          ? ["query", "error", "warn"]
          : ["error"],
    };
    return new PrismaClient(prismaOptions);
  })();

if (nodeEnv !== "production") {
  globalForPrisma.prisma = prisma;
}

export default prisma;