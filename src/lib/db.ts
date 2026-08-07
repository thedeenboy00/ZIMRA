// =============================================================================
// src/lib/db.ts — PrismaClient singleton (Prisma v7 with pg driver adapter)
// =============================================================================
// Prisma v7 requires an explicit driver adapter — datasourceUrl alone is no
// longer accepted. We use @prisma/adapter-pg with the `pg` package.
//
// DATABASE_URL = Transaction Pooler URL (port 6543, ?pgbouncer=true)
//               All runtime queries go through Supabase's connection pooler.
// =============================================================================

import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../generated/prisma/index.js";

// Prevent multiple PrismaClient instances during hot reload (Next.js / tsx watch)
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

function createPrismaClient(): PrismaClient {
  const connectionString = process.env.DATABASE_URL;

  if (!connectionString) {
    throw new Error(
      "DATABASE_URL environment variable is not set. " +
      "Add it to your .env file or Render environment variables."
    );
  }

  // pg Pool — Supabase transaction pooler handles connection limits
  const pool = new Pool({
    connectionString,
    // Supabase transaction pooler works best with max 1 connection per Pool
    // instance when using ?pgbouncer=true — the pooler manages the real pool
    max: 1,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });

  const adapter = new PrismaPg(pool);

  return new PrismaClient({
    adapter,
    log:
      process.env.NODE_ENV === "development"
        ? ["query", "error", "warn"]
        : ["error"],
  });
}

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

export default prisma;