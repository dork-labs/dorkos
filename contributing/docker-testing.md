# Docker-Based Testing Guide

## Overview

DorkOS validates the published CLI (`npm install -g dorkos`) inside clean Linux containers so a broken build never reaches a real user — one `Dockerfile`, three build targets, driven by `pnpm` scripts locally and by GitHub Actions on every push to main. This guide covers testing DorkOS in an isolated container: sanity-checking local changes before you open a PR, validating a specific published npm version, and understanding what the CI legs actually assert.

## Key Files

| Concept                                                                           | Location                                |
| --------------------------------------------------------------------------------- | --------------------------------------- |
| Multi-stage Dockerfile (targets + install modes)                                  | `Dockerfile`                            |
| Integration test script (runs inside the container)                               | `scripts/smoke-test.sh`                 |
| Build-context allowlist (what Docker can see)                                     | `.dockerignore`                         |
| `docker:*` / `smoke:*` scripts                                                    | `package.json` (root)                   |
| CI workflow (3 jobs, path-filtered)                                               | `.github/workflows/cli-smoke-test.yml`  |
| Per-instance MCP bearer token (for poking a running container)                    | `services/core/auth/mcp-local-token.ts` |
| User-facing production deployment guide (published image, compose, `latest` tags) | `docs/self-hosting/docker.mdx`          |

Note the split with `docs/self-hosting/docker.mdx`: that page is for people running the **published** image in production. This guide is for developers and agents validating **local changes or a specific version** before it ships.

## When to Use What

| Scenario                                                                 | Command                                | Why                                                                                              |
| ------------------------------------------------------------------------ | -------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Quick "does the CLI install and boot" check of local changes             | `pnpm smoke:docker`                    | Builds the `smoke` target and checks `--version`/`--help`/`--post-install-check`/`init`          |
| Full server + client validation of local changes                         | `pnpm smoke:integration`               | Builds the `integration` target and runs `scripts/smoke-test.sh` (health, API, client, terminal) |
| Validate an already-published npm version                                | `DORKOS_VERSION=0.51.0 pnpm smoke:npm` | Builds the `integration` target with `INSTALL_MODE=npm`; no local tarball needed                 |
| Build the runnable product image from local code                         | `pnpm docker:build`                    | Packs the CLI tarball, builds the `runtime` target (what ships)                                  |
| Run that image                                                           | `pnpm docker:run`                      | Thin wrapper around `docker run` for the image `docker:build` tagged                             |
| One-off with a custom port, tag, or build-arg not covered by the scripts | manual `docker build` / `docker run`   | The `pnpm` scripts are conveniences, not the full surface — drop to raw Docker commands          |

## The Target × Install Mode Model

The `Dockerfile` is one file with **three build targets** (a bare `docker build .` produces `runtime`, since it's the last stage) crossed with **two install modes** (`INSTALL_MODE` build-arg, default `tarball`).

### Build targets

| Target        | Purpose                                                                     | Ships mock `claude` binary? | Default target?             |
| ------------- | --------------------------------------------------------------------------- | --------------------------- | --------------------------- |
| `smoke`       | CLI install sanity check only (`--version`, `--help`, `init`)               | Yes                         | No                          |
| `integration` | Full server boot + API/client/terminal validation (`scripts/smoke-test.sh`) | Yes                         | No                          |
| `runtime`     | The published product image                                                 | No                          | Yes (bare `docker build .`) |

### Install modes

| Mode                | Installs from                                                   | Reads the build context? | Failure mode when misconfigured                                           |
| ------------------- | --------------------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------- |
| `tarball` (default) | A locally packed `dorkos-*.tgz` in the build context            | Yes                      | Fails the build loudly if the tarball is missing or ambiguous (see below) |
| `npm`               | The npm registry (`DORKOS_VERSION` build-arg, default `latest`) | Never                    | N/A — always resolves through the registry, independent of local state    |

**Why the modes are split into separate Dockerfile stages** (`install-tarball` and `install-npm`, selected via `FROM install-${INSTALL_MODE} AS install`) rather than one stage with a conditional `COPY`: Docker has no native `if` for `COPY`, so a single unconditional `COPY dorkos-*.tgz` would either silently ride a stale tarball left over from a previous build, or make npm-mode builds depend on build-context contents they should never touch. Splitting into two stages means npm mode genuinely never reads the build context (matching its "always fetch from the registry" contract), and tarball mode can fail loudly — instead of silently succeeding on garbage — when its one required input isn't there.

**The stale-tarball trap and its guard:** because `pnpm pack` writes `dorkos-<version>.tgz` and the glob `dorkos-*.tgz` matches every packed tarball ever left in the repo root, running `pnpm pack` repeatedly across versions (or switching branches) can leave multiple tarballs sitting there, making the `tarball` install ambiguous — which one does the build use? The `docker:build` / `smoke:docker` / `smoke:integration` scripts guard against this by removing any stale `dorkos-*.tgz` files before packing a fresh one, and the `Dockerfile`'s `install-tarball` stage independently fails the build unless exactly one tarball is present in the context. You don't need to manage this yourself — just run the `pnpm` scripts rather than hand-rolling `pnpm pack` + `docker build`.

## Core Patterns

### Clean-install testing of local changes

The default workflow for "did my change break the CLI install or server boot":

```bash
pnpm docker:build
# packs packages/cli into dorkos-*.tgz, builds the `runtime` target, tags it `dorkos`

pnpm docker:run
# docker run --rm -p 4242:4242 -e ANTHROPIC_API_KEY -v dorkos-data:/home/node/.dork dorkos
```

`docker:run` passes through your host's `ANTHROPIC_API_KEY` and mounts a named volume (`dorkos-data`) at `/home/node/.dork` so config and session data survive container restarts. Point a browser at `http://localhost:4242`.

For the install-only or full-integration smoke tests instead of the runtime image:

```bash
pnpm smoke:docker        # builds `smoke` target, checks CLI install only
pnpm smoke:integration   # builds `integration` target, runs scripts/smoke-test.sh
```

### Testing a specific published version

To validate a version that's already on npm, without needing a local tarball at all:

```bash
DORKOS_VERSION=0.51.0 pnpm smoke:npm
```

Or drive the equivalent `docker build` by hand (useful for a version-agnostic check, or to pass extra flags):

```bash
docker build --target integration \
  --build-arg INSTALL_MODE=npm --build-arg DORKOS_VERSION=0.51.0 \
  -t dorkos-integration:npm .
docker run --rm dorkos-integration:npm
```

Omit `DORKOS_VERSION` (or the env var) to test `latest`.

### The mock-claude shim

The `smoke` and `integration` stages both write a fake `claude` binary to `/usr/local/bin/claude` (`echo "claude mock 1.0.0"`) before running. DorkOS's `--post-install-check` and server boot hard-exit without a `claude` binary on `PATH`, and CI containers don't have a real Claude Code install — the shim exists purely so the CLI-install and server-boot paths can be exercised without one. The `runtime` image (what actually ships) does **not** carry this shim; a real user is expected to have Claude Code installed separately.

### What the integration test covers

`scripts/smoke-test.sh` runs inside the `integration` target's container. It starts `dorkos`, waits on `/api/health`, then checks:

- **API**: `GET /api/health` (200, has `status` and `version`), `GET /api/sessions`, `GET /api/config`, `GET /api/models`
- **Client**: `GET /` returns HTML and mentions `dorkos` (the SPA is served, not a 404/blank page)
- **Terminal (node-pty)**: resolves the default working directory via `GET /api/directory/default`, then `POST /api/terminal` to spawn a PTY and `DELETE /api/terminal/:id` to tear it down — this specifically exercises node-pty's native addon and its `spawn-helper` binary, since a broken Linux compile or a non-executable helper only shows up here (see Troubleshooting)

### How CI runs the same three legs

`.github/workflows/cli-smoke-test.yml` builds one tarball (`build-tarball` job) and fans it out to three jobs:

1. **`smoke-test-bare`** — installs the tarball with plain `npm install -g` on bare Ubuntu runners (Node 22 and 24 matrix), no Docker. Checks `--version`, `--help`, `--post-install-check`, `init`.
2. **`smoke-test-docker`** — `docker build --target smoke` + `docker run`, the containerized version of the same install check.
3. **`integration-test`** — `docker build --target integration` + `docker run`, running the full `scripts/smoke-test.sh` suite above.

The workflow triggers on push to main unconditionally, but on pull requests it's path-filtered to `packages/cli/**`, `packages/shared/**`, `apps/server/**`, `apps/client/**`, `Dockerfile`, `.dockerignore`, `scripts/smoke-test.sh`, `pnpm-lock.yaml`, and the workflow file itself — the tarball bundles the built server and client (via esbuild), so changes to any of those gate the PR.

## Run Your Branch in a Throwaway Container

A quick recipe for "let me actually see this running in a container" without touching your real `~/.dork`:

```bash
# 1. Build the runtime image from your current branch
pnpm docker:build

# 2. Run it on a scratch port with a scratch volume
docker run --rm -p 4299:4242 \
  -e ANTHROPIC_API_KEY \
  -v my-test-data:/home/node/.dork \
  dorkos

# 3. Poke it
open http://localhost:4299   # or curl http://localhost:4299/api/health

# 4. When done, throw away the scratch volume (Ctrl-C stops the container; --rm removes it)
docker volume rm my-test-data
```

## Auth-Era Notes for Testers

- The container sets `DORKOS_HOST=0.0.0.0` and `DORKOS_ALLOW_INSECURE_BIND=true`. This isn't a security downgrade — it opts the container out of the non-loopback bind guard that would otherwise refuse to start without a login, because the container itself (not the app) owns the network boundary: Docker's port mapping is the actual exposure control, and `localhost` resolves to `::1` inside the container anyway, which the app can't bind to.
- Mutating `/mcp` tools require the per-instance bearer token, persisted `0600` at `/home/node/.dork/mcp-local-token` inside the container (see `services/core/auth/mcp-local-token.ts`). Read it with:

  ```bash
  docker exec <container> cat /home/node/.dork/mcp-local-token
  ```

  Read-only MCP tools work without it; anything that mutates state needs `Authorization: Bearer <token>`.

## Anti-Patterns

```bash
# ❌ Leaving multiple packed tarballs in the repo root, then building tarball-mode
pnpm pack --pack-destination .   # dorkos-0.51.0.tgz
pnpm pack --pack-destination .   # dorkos-0.52.0.tgz (stale one still present)
docker build -t dorkos .         # which tarball does this use?

# ✅ Let the pnpm scripts handle it — they clear stale tarballs before packing
pnpm docker:build
```

```bash
# ❌ Assuming a bare `docker build .` runs the smoke or integration tests
docker build -t dorkos .   # this builds `runtime` (the product image) — no tests run

# ✅ Pass --target explicitly for anything other than the product image
docker build --target integration -t dorkos-integration .
```

```bash
# ❌ Expecting a real Claude Code install inside the runtime image
docker run --rm dorkos which claude   # not found — the mock shim only exists in smoke/integration

# ✅ Use the smoke/integration targets when you need install-time testing without a real Claude Code
docker build --target smoke -t dorkos-smoke . && docker run --rm dorkos-smoke
```

## Troubleshooting

### Tarball build fails with a missing- or multiple-tarball error

**Cause**: `INSTALL_MODE=tarball` (the default) requires exactly one `dorkos-*.tgz` in the build context. Either none was packed, or a stale one from a previous run is still sitting in the repo root alongside a fresh one.
**Fix**: Run `pnpm docker:build` / `pnpm smoke:docker` / `pnpm smoke:integration` rather than a hand-rolled `pnpm pack` + `docker build` — the scripts clear stale tarballs before packing. If building manually, `rm -f dorkos-*.tgz` before `pnpm pack --pack-destination ../../`.

### `POST /api/terminal` fails in the integration test

**Cause**: node-pty ships no Linux prebuild and compiles via node-gyp during the `builder` stage; either the native addon failed to compile, or its `spawn-helper` binary lost its executable bit somewhere in the copy (node-pty 1.1.0 is known to ship `spawn-helper` non-executable). This is exactly the packaged-artifact regression the terminal ADR (260708-185521) guards against.
**Fix**: Check the `builder` stage's `apt-get install python3 build-essential` step ran, and that nothing in the Dockerfile strips executable bits when copying `node_modules`. Reproduce locally with `pnpm smoke:integration` and read the `POST /api/terminal did not spawn a PTY` line in the output.

### `EACCES` writing to `/home/node/.dork` on first boot

**Cause**: a fresh named Docker volume mounted at `/home/node/.dork` takes root ownership by default, but the `runtime` image runs as the unprivileged `node` user.
**Fix**: The `runtime` stage pre-creates `/home/node/.dork` and `chown`s it to `node:node` before the volume mount happens, so this shouldn't occur with the shipped image. If you hit it anyway, confirm you're running the `runtime` target (not a stage that skips that step) and that the volume wasn't already created root-owned by an earlier container.

### Health check never turns healthy / server never comes up

**Cause**: usually a port mismatch between `-e DORKOS_PORT=<port>` and the exposed/mapped port, or the app failing to bind because `DORKOS_HOST`/`DORKOS_ALLOW_INSECURE_BIND` weren't set (only the `integration` and `runtime` stages set them).
**Fix**: The healthcheck reads `DORKOS_PORT` at check time (default `4242`) rather than a baked-in port, so pass `-e DORKOS_PORT=<port>` if you're not using the default — a `--port` CLI flag alone would beat the env var inside the app and desync the healthcheck. Check `docker logs <container>` for the actual bind error.
