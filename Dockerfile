# Build the exact upstream release. Its normal build already includes the
# Control UI and external plugin runtimes such as WhatsApp.
ARG NODE_IMAGE=node:24.22.1-bookworm@sha256:6449e19d8184d84062525b6a7524def03146c2cb04a7f08b076680d0e8e4240a
ARG BUN_IMAGE=oven/bun:1.4.2@sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895
FROM ${BUN_IMAGE} AS bun
FROM ${NODE_IMAGE} AS openclaw-build

RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    git ca-certificates python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
RUN corepack enable

WORKDIR /openclaw
ARG OPENCLAW_GIT_REF=v2026.10.7
ARG OPENCLAW_GIT_SHA=157d8c2bc3ea2fa183afdc11088e69690bf8e64e
RUN git clone --depth 1 --branch "${OPENCLAW_GIT_REF}" https://github.com/openclaw/openclaw.git . \
  && test "$(git rev-parse HEAD)" = "${OPENCLAW_GIT_SHA}"

# The packageManager field selects the release's pnpm version and integrity.
# Keep the upstream manifests and lockfile intact.
RUN pnpm install --frozen-lockfile
ENV OPENCLAW_PREFER_PNPM=1
# Do not run ui:build again in a later layer. build already publishes the UI;
# a second atomic rename of that lower-layer directory fails with EXDEV.
RUN pnpm build

FROM ${NODE_IMAGE}
ENV NODE_ENV=production
RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    ca-certificates tini python3 python3-venv \
  && rm -rf /var/lib/apt/lists/*

COPY --from=openclaw-build /openclaw /openclaw
# Keep runtime pnpm aligned with the same release, without a separate version pin.
RUN corepack enable \
  && corepack prepare "$(node -p "require('/openclaw/package.json').packageManager")" --activate \
  && printf '%s\n' '#!/usr/bin/env bash' 'exec node /openclaw/openclaw.mjs "$@"' > /usr/local/bin/openclaw \
  && chmod +x /usr/local/bin/openclaw

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY scripts/smoke.js scripts/healthcheck.js ./scripts/

ENV OPENCLAW_ENTRY=/openclaw/openclaw.mjs \
    OPENCLAW_STATE_DIR=/data/.openclaw \
    OPENCLAW_WORKSPACE_DIR=/data/workspace \
    NPM_CONFIG_PREFIX=/data/npm \
    NPM_CONFIG_CACHE=/data/npm-cache \
    PNPM_HOME=/data/pnpm \
    PNPM_STORE_DIR=/data/pnpm-store
ENV PATH="/data/npm/bin:/data/pnpm:${PATH}"

# Railway injects PORT. Do not override it with a Docker default.
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=10s --start-period=90s --retries=3 \
  CMD ["node", "scripts/healthcheck.js"]
ENTRYPOINT ["tini", "-s", "--"]
CMD ["node", "src/server.js"]
