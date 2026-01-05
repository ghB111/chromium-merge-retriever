# Chromium Agentic Search Service - Production Dockerfile

# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files (including web for workspace resolution)
COPY package.json package-lock.json* ./
COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/
COPY packages/shared/package.json ./packages/shared/
COPY packages/tools/package.json ./packages/tools/
COPY packages/agent/package.json ./packages/agent/

# Install dependencies
RUN npm ci

# Copy source files
COPY tsconfig.json ./
COPY apps/api/ ./apps/api/
COPY packages/shared/ ./packages/shared/
COPY packages/tools/ ./packages/tools/
COPY packages/agent/ ./packages/agent/

# Generate Prisma client
RUN npx prisma generate --schema=./apps/api/prisma/schema.prisma

# Build TypeScript packages (API only, not web)
RUN npm run build:shared && npm run build:tools && npm run build:agent && npm run build:api

# Production stage
FROM node:20-alpine AS production

WORKDIR /app

# Create non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

# Copy package files for production (including web for workspace resolution)
COPY package.json package-lock.json* ./
COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/
COPY packages/shared/package.json ./packages/shared/
COPY packages/tools/package.json ./packages/tools/
COPY packages/agent/package.json ./packages/agent/

# Install production dependencies only
RUN npm ci --omit=dev

# Copy built files
COPY --from=builder /app/apps/api/dist ./apps/api/dist
COPY --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder /app/packages/tools/dist ./packages/tools/dist
COPY --from=builder /app/packages/agent/dist ./packages/agent/dist

# Copy Prisma files
COPY apps/api/prisma ./apps/api/prisma
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma

# Set ownership
RUN chown -R nodejs:nodejs /app

USER nodejs

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1

CMD ["node", "apps/api/dist/index.js"]
