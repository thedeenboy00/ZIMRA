# =============================================================================
# Dockerfile — ZIMRA POS Backend API
# Multi-stage build: builder → runner
# Target platform: Render.com (Linux/amd64)
# Node.js 20 LTS (Active LTS until April 2026, Maintenance until 2026-04-30)
# =============================================================================

# ─── Stage 1: Builder ─────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

# Install build tools needed for native addons (e.g., bcrypt)
RUN apk add --no-cache python3 make g++

WORKDIR /app

# Copy package files first — layer-cache friendly
COPY package.json package-lock.json ./

# Install ALL dependencies (including devDependencies for build)
RUN npm ci

# Copy source
COPY tsconfig.json ./
COPY prisma ./prisma/
COPY src ./src/

# Generate Prisma client
RUN npx prisma generate

# Compile TypeScript → dist/
RUN npm run build

# Prune devDependencies after build
RUN npm ci --omit=dev && npm cache clean --force


# ─── Stage 2: Runner ──────────────────────────────────────────────────────────
FROM node:20-alpine AS runner

# Security: run as non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser  -u 1001 -S nodeapp -G nodejs

WORKDIR /app

# Copy only what's needed to run
COPY --from=builder --chown=nodeapp:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nodeapp:nodejs /app/dist         ./dist
COPY --from=builder --chown=nodeapp:nodejs /app/prisma       ./prisma
COPY --from=builder --chown=nodeapp:nodejs /app/package.json ./package.json

USER nodeapp

# Render injects PORT at runtime — default 3003 for local dev
ENV PORT=3003
ENV NODE_ENV=production

EXPOSE 3003

# Health check — Render polls this before marking deploy successful
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:${PORT}/api/health || exit 1

# Start the compiled API
CMD ["node", "dist/server.js"]