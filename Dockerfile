# DorkOS — Multi-stage Dockerfile
#
# One file, four build targets. The default (bare `docker build .`) is the
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
RUN npm install -g /tmp/dorkos-*.tgz && \
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

# ── runtime (published product image) ──────────────────────────────────────
# Last stage, so a bare `docker build .` produces it. Built FROM base — no
# toolchain in the final image; the compiled global npm tree is copied from the
# install stage.
FROM base AS runtime

LABEL org.opencontainers.image.source="https://github.com/dork-labs/dorkos"
LABEL org.opencontainers.image.description="DorkOS — the coordination layer for autonomous AI agents"
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

# Bind to all interfaces so Docker port forwarding works. The container owns the
# network boundary, so opt out of the non-loopback bind guard (accounts-and-auth
# task 1.3) that would otherwise refuse to start without a login.
ENV DORKOS_HOST=0.0.0.0
ENV DORKOS_ALLOW_INSECURE_BIND=true

EXPOSE 4242

# Reads DORKOS_PORT at check time (defaults to 4242, matching the server's own
# default). No baked-in CMD --port: a CLI flag would beat the env var inside
# the app, silently defeating -e DORKOS_PORT and desyncing this check.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.DORKOS_PORT||4242)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["tini", "--", "dorkos"]
