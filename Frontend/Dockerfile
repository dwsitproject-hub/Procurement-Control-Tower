# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/rules/package.json      packages/rules/
COPY packages/contracts/package.json  packages/contracts/
COPY Backend/package.json             Backend/
COPY Frontend/package.json            Frontend/
RUN npm ci --workspaces --include-workspace-root --ignore-scripts

COPY tsconfig.base.json ./
COPY packages/ packages/
COPY Frontend/ Frontend/
RUN npm run build -w @pct/rules \
 && npm run build -w @pct/contracts \
 && npm run build -w @pct/frontend

# Fail the build if any external origin crept into the bundle. A CDN reference
# would break the strict CSP and reintroduce v1's offline contradiction.
RUN if grep -rEl 'https?://(cdn|unpkg|jsdelivr|fonts\.googleapis|fonts\.gstatic)' Frontend/dist/; then \
      echo "FATAL: external origin reference found in bundle" >&2; exit 1; \
    fi

# ── runtime ──
FROM nginx:1.27-alpine AS runtime
COPY deploy/nginx/local.conf /etc/nginx/conf.d/default.conf
COPY deploy/nginx/security-headers.conf /etc/nginx/conf.d/security-headers.conf
COPY --from=build /app/Frontend/dist /usr/share/nginx/html
EXPOSE 80
