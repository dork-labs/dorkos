# DorkOS — Multi-stage Dockerfile
#
# One file, seven build targets (smoke, integration, hub, hub-smoke, space-build,
# space, runtime),
# selected among two install modes. The default (bare `docker build .`) is the
# published `runtime` image; the other targets are for CI and local testing.
#
# Install modes (build-arg INSTALL_MODE, default "tarball"):
#   tarball — install from a locally packed dorkos-*.tgz (must be in the build
#             context). Fails loudly if the tarball is missing.
#   npm     — install from the npm registry (build-arg DORKOS_VERSION, default
#             latest). Never reads the build context.
#
# Runtime image (product image, from tarball):
#   pnpm --filter=dorkos run build
#   cd packages/cli && pnpm pack --pack-destination ../../ && cd ../..
#   docker build -t dorkos .                      # --target runtime is the default
#   docker run --rm -p 4242:4242 -e ANTHROPIC_API_KEY=sk-... dorkos
#
# Runtime image (from published npm package):
#   docker build --target runtime \
#     --build-arg INSTALL_MODE=npm --build-arg DORKOS_VERSION=latest -t dorkos .
#
# Custom port (the env var steers both the server and the healthcheck):
#   docker run --rm -p 8080:8080 -e DORKOS_PORT=8080 dorkos
#
# CLI install smoke test:
#   docker build --target smoke -t dorkos-smoke . && docker run --rm dorkos-smoke
#
# Full integration test (add --build-arg INSTALL_MODE=npm for the published package):
#   docker build --target integration -t dorkos-integration . && \
#     docker run --rm dorkos-integration
#
# Hub image (a person's own DorkOS in the cloud, DOR-2935). DorkOS Cloud boots
# it with its instance key and its /v1 origin; see the `hub` stage:
#   docker build --target hub -t dorkos-hub .
#   docker run --rm -p 4242:4242 -e DORKOS_HUB_INSTANCE_KEY=... \
#     -e DORKOS_CLOUD_API_URL=https://... dorkos-hub
#
# Hub smoke test: boots the hub image against a stand-in for Cloud:
#   docker build --target hub-smoke -t dorkos-hub-smoke . && docker run --rm dorkos-hub-smoke

ARG NODE_VERSION=24
# Declared before the first FROM so the install-stage selection
# (FROM install-${INSTALL_MODE}) can see it — args used in FROM lines must be
# global. npm mode never even reads the build context.
ARG INSTALL_MODE=tarball
FROM node:${NODE_VERSION}-slim AS base

# ── builder ────────────────────────────────────────────────────────────────
# Toolchain for native addons. node-pty (a direct CLI dep) ships no Linux
# prebuilds and compiles via node-gyp, so python3 + build-essential are
# required. better-sqlite3 has official Linux prebuilds for Node 24 and vendors
# its own SQLite, so no libsqlite3-dev is needed.
FROM base AS builder
RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 build-essential && \
    rm -rf /var/lib/apt/lists/*

# ── install (two modes, selected by INSTALL_MODE) ──────────────────────────
# Splitting the modes into separate stages avoids the unconditional-tarball
# trap: npm mode never touches the build context, and tarball mode fails loudly
# when no tarball is present instead of silently riding a stale one.

# tarball mode: install from a locally packed dorkos-*.tgz.
FROM builder AS install-tarball
COPY dorkos-*.tgz /tmp/
# Fail loudly if more than one tarball matched the glob — silently installing
# an ambiguous set (e.g. a stale tarball left over from a previous pack)
# would ship an unpredictable version instead of erroring.
RUN [ "$(ls /tmp/dorkos-*.tgz | wc -l)" -eq 1 ] || { echo "ERROR: expected exactly one dorkos-*.tgz in build context, found:"; ls /tmp/dorkos-*.tgz; exit 1; } && \
    npm install -g /tmp/dorkos-*.tgz && \
    rm -f /tmp/dorkos-*.tgz && \
    npm cache clean --force

# npm mode: install the published package from the registry.
FROM builder AS install-npm
ARG DORKOS_VERSION=latest
RUN npm install -g "dorkos@${DORKOS_VERSION}" && \
    npm cache clean --force

# Select the install stage (INSTALL_MODE is declared at the top of the file).
FROM install-${INSTALL_MODE} AS install

# ── smoke ──────────────────────────────────────────────────────────────────
# CLI install smoke test. --post-install-check hard-exits without a claude
# binary, so ship a mock shim here (the runtime image never runs it).
FROM install AS smoke
RUN printf '#!/bin/sh\necho "claude mock 1.0.0"\n' > /usr/local/bin/claude && \
    chmod +x /usr/local/bin/claude
CMD set -e && \
    echo "=== which dorkos ===" && which dorkos && \
    echo "=== dorkos --version ===" && dorkos --version && \
    echo "=== dorkos --help ===" && dorkos --help && \
    echo "=== dorkos --post-install-check ===" && dorkos --post-install-check && \
    echo "=== dorkos init --yes ===" && dorkos init --yes && \
    echo "" && echo "All smoke tests passed."

# ── integration ────────────────────────────────────────────────────────────
# Full integration test: starts the server, validates API + client endpoints.
FROM install AS integration
# curl needed for health checks in the test script.
RUN apt-get update && \
    apt-get install -y --no-install-recommends curl && \
    rm -rf /var/lib/apt/lists/*
# Mock Claude CLI so the server boots cleanly without a real install.
RUN printf '#!/bin/sh\necho "claude mock 1.0.0"\n' > /usr/local/bin/claude && \
    chmod +x /usr/local/bin/claude
# Bind to all interfaces (localhost resolves to ::1 in containers). The
# container owns the network boundary, so opt out of the non-loopback bind
# guard (accounts-and-auth task 1.3) that would otherwise refuse to start.
ENV DORKOS_HOST=0.0.0.0
ENV DORKOS_ALLOW_INSECURE_BIND=true
COPY scripts/smoke-test.sh /usr/local/bin/smoke-test
RUN chmod +x /usr/local/bin/smoke-test
# Run init (creates ~/.dork/config.json) then the full integration tests.
CMD dorkos init --yes && smoke-test

# ── served (what the runtime and hub images share) ─────────────────────────
# Built FROM base — no toolchain in the final images; the compiled global npm
# tree is copied from the install stage. Each image adds its own bind settings.
FROM base AS served

LABEL org.opencontainers.image.source="https://github.com/dork-labs/dorkos"
LABEL org.opencontainers.image.licenses="MIT"

# tini reaps zombies and forwards signals for clean shutdown.
RUN apt-get update && \
    apt-get install -y --no-install-recommends tini && \
    rm -rf /var/lib/apt/lists/*

# Copy the global npm install from the toolchain stage. The tree already
# contains the compiled native addons. The bin symlink is recreated rather than
# copied: COPY dereferences symlinks, which would strand the entry script away
# from its package (breaking its imports).
COPY --from=install /usr/local/lib/node_modules/dorkos /usr/local/lib/node_modules/dorkos
RUN ln -s ../lib/node_modules/dorkos/dist/bin/cli.js /usr/local/bin/dorkos

# Pre-create the data directory owned by node: a fresh named volume mounted at
# ~/.dork copies this ownership; without it the mountpoint appears root-owned
# and the unprivileged server can't write (EACCES on first boot).
RUN mkdir -p /home/node/.dork && chown node:node /home/node/.dork

# Run as the built-in unprivileged node user. WORKDIR keeps cwd off `/`, which
# would otherwise trip a workspace boundary-fallback warning at boot.
USER node
WORKDIR /home/node

# Bind to all interfaces so Docker port forwarding works.
ENV DORKOS_HOST=0.0.0.0

EXPOSE 4242

# Reads DORKOS_PORT at check time (defaults to 4242, matching the server's own
# default). No baked-in CMD --port: a CLI flag would beat the env var inside
# the app, silently defeating -e DORKOS_PORT and desyncing this check.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.DORKOS_PORT||4242)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["tini", "--", "dorkos"]

# ── hub (a person's own DorkOS in the cloud) ───────────────────────────────
# Hub mode (DOR-2934): no agent runtimes, login always on, every request from
# another device. Cloud sets DORKOS_HUB_INSTANCE_KEY and DORKOS_CLOUD_API_URL
# at boot; the key is read from the environment every boot, never written to
# disk. Mount a volume at /home/node/.dork for the hub's data. Never set
# DORKOS_ALLOW_INSECURE_BIND here: a hub refuses to boot with it, and needs no
# escape hatch, because login is always on. The health check answers on any
# Host without the front-door proof, from the moment the hub listens.
#
# Cloud mounts a new volume at the data folder owned by root, so the image
# starts as root, and scripts/hub-entrypoint.sh gives the folder to node and
# drops to node before DorkOS starts. DorkOS itself never runs as root. Cloud
# stops a sleeping hub with SIGINT and a 5-second grace period; tini passes it
# on.
FROM served AS hub
LABEL org.opencontainers.image.description="DorkOS hub: a person's own DorkOS in the cloud"
ENV DORKOS_SERVER_ROLE=hub
# USER root below would otherwise point HOME at /root; DorkOS runs as node.
ENV HOME=/home/node
USER root
COPY --chmod=755 scripts/hub-entrypoint.sh /usr/local/bin/hub-entrypoint
ENTRYPOINT ["tini", "--", "hub-entrypoint", "dorkos"]

# ── hub-smoke ──────────────────────────────────────────────────────────────
# Boots the hub image against a stand-in for Cloud and checks what Cloud
# relies on: the health check, the refusals while pooled, taking an
# assignment, and the front-door checks (scripts/hub-smoke/run.mjs). It runs as
# root, as the hub image does, and starts the hub through the image's own
# entrypoint, so a root-owned data folder is part of what it checks (mount an
# empty root-owned folder at /home/node/.dork).
FROM hub AS hub-smoke
COPY scripts/hub-smoke/ /opt/hub-smoke/
# Boot the hub with this image's own bind address, data folder and entrypoint.
ENV DORKOS_HUB_SMOKE_ISOLATE=0
ENV DORKOS_HUB_SMOKE_BIN="hub-entrypoint dorkos"
HEALTHCHECK NONE
ENTRYPOINT ["tini", "--", "node", "/opt/hub-smoke/run.mjs"]

# ── space (the space server, published as ghcr.io/dork-labs/dorkos-community) ─
# Server-merge step 7f: the space server's image builds from this file, beside the
# DorkOS image. It never carries the machine store, runtime SDKs or a terminal: it
# installs only the space package's own dependencies (`pnpm deploy` of
# @dorkos/community), never the DorkOS server's. Its own base, not `base`, so the
# image is byte-for-byte what it was when it built from apps/community/Dockerfile:
#   docker build --target space -t dorkos-space .
FROM node:24-bookworm-slim AS space-build
RUN corepack enable
WORKDIR /work
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches patches
COPY apps/community/package.json apps/community/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/relay/package.json packages/relay/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/decisions/package.json packages/decisions/package.json
COPY packages/ui/package.json packages/ui/package.json
COPY packages/icons/package.json packages/icons/package.json
COPY packages/test-utils/package.json packages/test-utils/package.json
COPY packages/cloud-api/package.json packages/cloud-api/package.json
COPY packages/connector-providers/package.json packages/connector-providers/package.json
COPY packages/eslint-config/package.json packages/eslint-config/package.json
COPY packages/typescript-config/package.json packages/typescript-config/package.json
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY packages/shared packages/shared
COPY packages/decisions packages/decisions
COPY packages/ui packages/ui
COPY packages/icons packages/icons
COPY packages/cloud-api packages/cloud-api
COPY packages/connector-providers packages/connector-providers
COPY packages/typescript-config packages/typescript-config
COPY apps/community apps/community
# The space server's code lives in the DorkOS server package (server-merge step 7); its build
# (apps/community/tsconfig.build.json) still compiles it into apps/community/dist-server/. The
# link lets that code find the space server's own packages without installing the DorkOS
# server's, so nothing of the server's reaches this image.
COPY apps/server/src/services/spaces apps/server/src/services/spaces
RUN ln -s ../community/node_modules apps/server/node_modules
# Its web pages are in apps/client (step 7e), built by their own Vite config into
# apps/community/dist/; the same link gives them the space package's own packages.
COPY apps/client/vite.space.config.ts apps/client/vite.space.config.ts
COPY apps/client/src/space apps/client/src/space
RUN ln -s ../community/node_modules apps/client/node_modules
RUN pnpm --filter @dork-labs/cloud-api build && pnpm --filter @dork-labs/connector-providers build && pnpm --filter @dorkos/shared build && pnpm --filter @dorkos/decisions build && pnpm --filter @dork-labs/ui build && pnpm --filter @dorkos/community build
# This image copies only the community's slice of the workspace, so a root patch for a
# package it never installs (when-exit, which the server reaches through conf) is
# "unused" here, and pnpm deploy refuses unused patches by default. The v0.114.0 and
# v0.114.1 images failed to build on exactly that.
RUN pnpm --config.allow-unused-patches=true --filter @dorkos/community deploy --prod --legacy --ignore-scripts /runtime
# The space server never loads the SQLite driver drizzle-orm brings in as an optional
# peer: remove it, then refuse to build an image that installs the machine store, a
# runtime SDK, a terminal or the DorkOS server.
COPY scripts/space-image scripts/space-image
RUN node scripts/space-image/runtime-packages.mjs /runtime --prune
RUN cp -R apps/community/dist apps/community/dist-server apps/community/migrations /runtime/

FROM node:24-bookworm-slim AS space
WORKDIR /app
COPY --from=space-build /runtime /app
RUN mkdir -p /data/blobs && chown node:node /data/blobs
USER node
ENV COMMUNITY_PORT=6481 COMMUNITY_STORAGE_PATH=/data/blobs NODE_ENV=production
EXPOSE 6481
VOLUME /data/blobs
CMD ["node", "dist-server/main.js"]

# ── runtime (published product image) ──────────────────────────────────────
# Last stage, so a bare `docker build .` produces it. The container owns the
# network boundary, so it opts out of the non-loopback bind guard
# (accounts-and-auth task 1.3) that would otherwise refuse to start without a
# login.
FROM served AS runtime
LABEL org.opencontainers.image.description="DorkOS — the coordination layer for autonomous AI agents"
ENV DORKOS_ALLOW_INSECURE_BIND=true
