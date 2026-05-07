FROM mcr.microsoft.com/playwright:v1.59.1-noble

# Install pnpm (match version used in lockfile)
RUN npm install -g pnpm@10

WORKDIR /app

# Copy workspace manifests for dependency install layer caching
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./

# Copy all package.json files so pnpm can resolve the workspace graph
COPY lib/api-spec/package.json ./lib/api-spec/
COPY lib/api-zod/package.json ./lib/api-zod/
COPY lib/api-client-react/package.json ./lib/api-client-react/
COPY lib/db/package.json ./lib/db/
COPY scripts/package.json ./scripts/
COPY artifacts/api-server/package.json ./artifacts/api-server/
COPY artifacts/fb-bot-dashboard/package.json ./artifacts/fb-bot-dashboard/

# Install all workspace dependencies
RUN pnpm install --no-frozen-lockfile

# Copy full source (node_modules excluded via .dockerignore)
COPY . .

# Build the React dashboard
# BASE_PATH=/ → assets served from root (no sub-path prefix needed on Railway)
# PORT and BASE_PATH must be set to satisfy vite.config.ts validation
RUN BASE_PATH=/ PORT=3000 NODE_ENV=production \
    pnpm --filter @workspace/fb-bot-dashboard run build

# Build the API server (esbuild bundles everything including lib/* TypeScript)
RUN pnpm --filter @workspace/api-server run build

# Persistent state directory — mount a Railway volume at /data for session survival
RUN mkdir -p /data

# ── Runtime environment ──────────────────────────────────────────────────────
ENV NODE_ENV=production
ENV PORT=8080
# Serve built dashboard static files from Express
ENV DASHBOARD_DIST=/app/artifacts/fb-bot-dashboard/dist/public
# Browser state file location (mount Railway volume at /data to persist across deploys)
ENV STATE_DIR=/data

EXPOSE 8080

CMD ["node", "--enable-source-maps", "/app/artifacts/api-server/dist/index.mjs"]
