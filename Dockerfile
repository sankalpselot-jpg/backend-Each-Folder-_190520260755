# ────────────────────────────────────────────────────────────
# Dockerfile — BoothMarket Backend
# Optimized for Google Cloud Run (auto-scales to 1M users)
# ────────────────────────────────────────────────────────────

# Stage 1: Install dependencies
FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
# Install only production dependencies
RUN npm install --omit=dev

# Stage 2: Final image (lean — no devDependencies, no npm cache)
FROM node:20-alpine AS runner
WORKDIR /app

# Security: run as non-root user
RUN addgroup --system --gid 1001 nodejs \
 && adduser  --system --uid 1001 nodeuser

COPY --from=deps /app/node_modules ./node_modules
COPY --chown=nodeuser:nodejs . .

USER nodeuser

# Cloud Run injects PORT env var — our server.js reads process.env.PORT
EXPOSE 8080
ENV PORT=8080
ENV NODE_ENV=production

# Health check used by Cloud Run to route traffic
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- http://localhost:8080/api/health || exit 1

CMD ["node", "src/server.js"]
