# Event Tracker (Next.js) — runtime image.
#
# Multi-stage build → a lean STANDALONE Next.js server (no full node_modules in the final image). The
# Mongo connection + all secrets are RUNTIME env (getDb is lazy, so `next build` needs no database).
#
# IMPORTANT — NEXT_PUBLIC_* is inlined at BUILD time. The demo build must pass --build-arg EIT_DEMO_MODE=1
# so next.config derives NEXT_PUBLIC_DEMO_MODE=1 (client banner + disabled controls). BUILD_ID stamps
# the version-watcher; pass the git SHA for a meaningful value.
#
#   docker build -t event-tracker-next:demo --build-arg EIT_DEMO_MODE=1 --build-arg BUILD_ID=$(git rev-parse --short HEAD) .

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Build-time only: NEXT_PUBLIC_DEMO_MODE + BUILD_ID get inlined here (see next.config.mjs).
ARG EIT_DEMO_MODE=""
ARG BUILD_ID=""
ENV EIT_DEMO_MODE=$EIT_DEMO_MODE BUILD_ID=$BUILD_ID NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3100 HOSTNAME=0.0.0.0
RUN addgroup -g 1001 -S nodejs && adduser -S nextjs -u 1001
# Standalone server + its traced node_modules, plus the static assets + public dir.
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
USER nextjs
EXPOSE 3100
# The standalone server reads PORT/HOSTNAME from the env. Runtime env (MONGO_URI, ET_SESSION_SECRET,
# EIT_DEMO_MODE, EIT_DEMO_USER, EIT_ADMIN_EMAILS, GOOGLE_*…) is supplied by compose / the VM.
CMD ["node", "server.js"]
