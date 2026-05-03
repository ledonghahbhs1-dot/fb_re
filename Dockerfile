FROM mcr.microsoft.com/playwright:v1.59.1-noble

# Install pnpm
RUN npm install -g pnpm@9

WORKDIR /app

# Copy workspace manifests for layer caching
COPY package.json pnpm-workspace.yaml ./
# Copy lockfile if present (optional — falls back gracefully)
COPY pnpm-lock.yaml* ./

# Copy all package.json files for dependency resolution
COPY lib/api-spec/package.json ./lib/api-spec/
COPY lib/api-zod/package.json ./lib/api-zod/
COPY lib/api-client-react/package.json ./lib/api-client-react/
COPY lib/db/package.json ./lib/db/
COPY artifacts/api-server/package.json ./artifacts/api-server/
COPY artifacts/fb-bot-dashboard/package.json ./artifacts/fb-bot-dashboard/

# Install all workspace dependencies
RUN pnpm install --no-frozen-lockfile

# Copy full source
COPY . .

# Build the React dashboard (BASE_PATH=/ so assets are served from root)
RUN BASE_PATH=/ PORT=3000 NODE_ENV=production \
    pnpm --filter @workspace/fb-bot-dashboard run build

# Build the API server
RUN pnpm --filter @workspace/api-server run build

# Persistent state directory — mount a Railway volume at /data
RUN mkdir -p /data

# ── Runtime environment ──────────────────────────────────────────────────────
ENV NODE_ENV=production
ENV PORT=8080
# Path to built dashboard static files (served by Express)
ENV DASHBOARD_DIST=/app/artifacts/fb-bot-dashboard/dist/public
# Persistent browser-state.json location (mount Railway volume at /data)
ENV STATE_DIR=/data

EXPOSE 8080

CMD ["node", "--enable-source-maps", "/app/artifacts/api-server/dist/index.mjs"]
