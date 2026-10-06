# syntax=docker/dockerfile:1.7
#
# One production image for every role: ROLE=web (default) | worker | migrate. See docs/runbook.md.
#
# Optional build-time CA (only for hosts behind a TLS-intercepting proxy; never part of the final image):
#   docker build --secret id=npm_ca,src=$HOME/ca-bundle.pem -t techplanner .

ARG NODE_IMAGE=node:22-bookworm-slim

# ---- deps: full dependency tree from the lockfile ----
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=secret,id=npm_ca,required=false \
    if [ -f /run/secrets/npm_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/npm_ca; fi; \
    npm ci --no-audit --no-fund

# ---- build: Next.js standalone server + bundled worker and migration runner ----
FROM deps AS build
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
# `next build` imports route modules, and src/server/db/pool.ts reads config at import time. These obviously fake
# values exist only for this RUN step; they are not ENV, so they never reach any image layer's configuration.
RUN ATLASSIAN_CLIENT_ID=build ATLASSIAN_CLIENT_SECRET=build ATLASSIAN_CLOUD_ID=build \
    OAUTH_REDIRECT_URI=http://localhost:3000/api/auth/callback \
    TOKEN_ENCRYPTION_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA= \
    DATABASE_URL=postgres://build:build@localhost:5432/build APP_BASE_URL=http://localhost:3000 \
    COPILOT_GITHUB_TOKEN=build FACILITATOR_MODEL=build EVALUATOR_MODEL=build \
    CONFLUENCE_SPACE_KEY=build CONFLUENCE_PARENT_PAGE_ID=build \
    npm run build
# Same code paths as `npm run worker` / `npm run migrate`, compiled so the image needs neither tsx nor sources.
RUN npx esbuild worker=src/worker/index.ts migrate=scripts/migrate.ts --bundle --platform=node --target=node22 --format=esm \
    --packages=external --outdir=dist --out-extension:.js=.mjs --log-level=warning

# ---- prod-deps: runtime dependencies only (no second network fetch) ----
FROM deps AS prod-deps
RUN npm prune --omit=dev --no-audit --no-fund

# ---- copilot: GitHub Copilot CLI at the version pinned in docs/adr/0015-copilot-sdk-api.md ----
FROM ${NODE_IMAGE} AS copilot
ARG COPILOT_CLI_VERSION=1.0.90
RUN --mount=type=secret,id=npm_ca,required=false \
    if [ -f /run/secrets/npm_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/npm_ca; fi; \
    npm install -g --prefix /opt/copilot --no-audit --no-fund "@github/copilot@${COPILOT_CLI_VERSION}"

# ---- runtime ----
FROM ${NODE_IMAGE} AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000 \
    ROLE=web \
    COPILOT_CLI_PATH=/opt/copilot/bin/copilot

COPY --from=copilot /opt/copilot /opt/copilot
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
# Full runtime dependencies (the worker needs more than Next's traced subset).
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY db/migrations ./db/migrations
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
# Strip CRLF in case the file was checked out on Windows with autocrlf.
RUN sed -i 's/\r$//' /usr/local/bin/entrypoint.sh && chmod 755 /usr/local/bin/entrypoint.sh

# Built-in non-root user from the node image (uid 1000). The app needs no writable paths besides os.tmpdir().
USER node

EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
    CMD [ "$ROLE" != "web" ] || node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
