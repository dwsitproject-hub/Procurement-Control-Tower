# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
# SheetJS ships fixed releases only from its own CDN (npm's xlsx stopped at the
# vulnerable 0.18.5), so the tarball is vendored: builds need no new egress.
COPY vendor/ vendor/
COPY packages/rules/package.json      packages/rules/
COPY packages/contracts/package.json  packages/contracts/
COPY Backend/package.json             Backend/
COPY Frontend/package.json            Frontend/
RUN npm ci --workspaces --include-workspace-root --ignore-scripts

COPY tsconfig.base.json ./
COPY packages/ packages/
COPY Frontend/ Frontend/

# Downstream Hub SDK (11 Nov 2026), per environment and all optional: without
# HUB_SDK_URL and HUB_SDK_KEY the bundle carries no SDK and the CSP is
# unchanged. The key is the Hub's PUBLISHABLE key (it is in the page source by
# design), so a build arg is the right place for it. GIT_SHA is the release
# the SDK reports, so Sentinel reads the code users actually ran.
ARG HUB_SDK_URL=""
ARG HUB_SDK_KEY=""
ARG GIT_SHA=""
ENV VITE_HUB_SDK_URL=$HUB_SDK_URL \
    VITE_HUB_SDK_KEY=$HUB_SDK_KEY \
    VITE_GIT_SHA=$GIT_SHA
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
# The Hub's origin joins script-src (the SDK script) and connect-src (what it
# sends), and nothing else - the CSP stays as strict as before for every other
# origin. Only when this image carries the SDK.
ARG HUB_SDK_URL=""
RUN if [ -n "$HUB_SDK_URL" ]; then \
      HUB_ORIGIN=$(echo "$HUB_SDK_URL" | sed -E 's#^(https?://[^/]+).*#\1#') && \
      sed -i -e "s#script-src 'self'#script-src 'self' $HUB_ORIGIN#" \
             -e "s#connect-src 'self'#connect-src 'self' $HUB_ORIGIN#" \
             /etc/nginx/conf.d/security-headers.conf && \
      grep -q "script-src 'self' $HUB_ORIGIN" /etc/nginx/conf.d/security-headers.conf; \
    fi
COPY --from=build /app/Frontend/dist /usr/share/nginx/html
EXPOSE 80
