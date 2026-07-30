# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS build
WORKDIR /app

# argon2 is a native module and needs a toolchain to build.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY packages/rules/package.json      packages/rules/
COPY packages/contracts/package.json  packages/contracts/
COPY Backend/package.json             Backend/
COPY Frontend/package.json            Frontend/
RUN npm ci --workspaces --include-workspace-root

COPY tsconfig.base.json ./
COPY packages/ packages/
COPY Backend/  Backend/
RUN npm run build -w @pct/rules \
 && npm run build -w @pct/contracts \
 && npm run build -w @pct/backend

# ── runtime ──
FROM node:22-bookworm-slim AS runtime
RUN groupadd -g 1001 pct && useradd -u 1001 -g 1001 -m pct
WORKDIR /app

ENV NODE_ENV=production
ENV NODE_OPTIONS=--max-old-space-size=2048

COPY --from=build --chown=1001:1001 /app/node_modules            ./node_modules
# Node resolves module type from the nearest package.json. The workspace root has
# no "type" field, so without this every dist/*.js is reparsed as ESM at a cost.
RUN echo '{"name":"pct-runtime","private":true,"type":"module"}' > /app/package.json \
 && chown 1001:1001 /app/package.json
COPY --from=build --chown=1001:1001 /app/packages/rules/dist     ./packages/rules/dist
COPY --from=build --chown=1001:1001 /app/packages/rules/package.json ./packages/rules/package.json
COPY --from=build --chown=1001:1001 /app/packages/contracts/dist ./packages/contracts/dist
COPY --from=build --chown=1001:1001 /app/packages/contracts/package.json ./packages/contracts/package.json
COPY --from=build --chown=1001:1001 /app/Backend/dist            ./dist
COPY --from=build --chown=1001:1001 /app/Backend/package.json    ./Backend/package.json
# Migrations are .sql files, not compiled output, so they are copied separately.
COPY --from=build --chown=1001:1001 /app/Backend/src/db/migrations ./dist/db/migrations

USER 1001
EXPOSE 3000
CMD ["node", "dist/main.js"]
