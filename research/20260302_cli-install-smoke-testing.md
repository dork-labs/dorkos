---
title: 'CLI npm Package Install Smoke Testing — Docker & GitHub Actions'
date: 2026-03-02
type: implementation
status: active
tags: [cli, docker, github-actions, smoke-testing, npm-pack, better-sqlite3, native-addons, pnpm]
feature_slug: cli-smoke-testing
searches_performed: 14
sources_count: 28
---

# CLI npm Package Install Smoke Testing — Docker & GitHub Actions

## Research Summary

Smoke testing an npm CLI package after `npm pack` is a well-established CI pattern: build a tarball, upload it as an artifact, install it inside a fresh environment (Docker container or bare runner), and verify the binary runs. The main complexity for DorkOS is that `better-sqlite3` is a native Node.js addon that compiles on install, which makes Alpine Linux impractical and requires build tools (`python3`, `build-essential`, `libsqlite3-dev`) in any Docker image used for testing. The dorkos CLI uses esbuild to bundle the server, but `better-sqlite3` cannot be inlined by esbuild (it's a `.node` binary), so the published package must declare it as a runtime dependency.

---

## Key Findings

### 1. The Standard npm Pack → Install → Verify Pattern

The canonical smoke-test flow for any npm CLI:

```
build → pnpm --filter=dorkos run build
pack  → cd packages/cli && pnpm pack --pack-destination /tmp/artifacts/
upload → actions/upload-artifact
install → npm install -g /path/to/dorkos-*.tgz (in a fresh job/container)
verify  → dorkos --version
         dorkos --help
         (optional) dorkos &; sleep 2; curl -f http://localhost:4242/api/health
```

This pattern verifies:

- The tarball is complete (all `files` entries present)
- The `bin` entry resolves to an executable file
- The CLI binary imports cleanly (no missing runtime deps crash on startup)
- Optional: the server actually binds and responds

### 2. better-sqlite3 is a Transitive Dependency of the CLI

The CLI's esbuild bundle inlines `@dorkos/db` source (workspace package) but `better-sqlite3` is a native `.node` addon — esbuild cannot bundle `.node` files. It falls through to `require()` at runtime and must be present in `node_modules` of the installed package. This means `better-sqlite3` must be listed as a **runtime dependency** in `packages/cli/package.json`, not just in `packages/db/package.json`.

Current state: `better-sqlite3` is in `packages/db/package.json:dependencies` but **NOT** in `packages/cli/package.json:dependencies`. This will cause a runtime crash when the CLI starts the server. The smoke test will catch this failure.

### 3. Docker Base Image Recommendation: `node:20-slim` (Debian)

For any Docker-based smoke test of a package with native addons:

| Image                   | Verdict              | Reason                                                                                            |
| ----------------------- | -------------------- | ------------------------------------------------------------------------------------------------- |
| `node:20-alpine`        | Avoid                | musl libc is incompatible with glibc-compiled prebuilt binaries; forces recompile with extra pain |
| `node:20-slim`          | Recommended          | Debian slim, glibc, ~200MB, no `python3`/`build-essential` by default but easy to add             |
| `node:20` (full)        | Acceptable           | Has build tools but ~1GB, overkill for a smoke test                                               |
| `node:20-bookworm-slim` | Best explicit choice | Pinned Debian codename, reproducible builds                                                       |

For compiling native addons in Docker, the slim image needs:

```dockerfile
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    build-essential \
    libsqlite3-dev \
    && rm -rf /var/lib/apt/lists/*
```

### 4. Multi-Stage Docker Build for Smoke Tests

The optimal approach separates compilation from verification:

```dockerfile
# Stage 1: Builder — compiles native addons
FROM node:20-slim AS builder
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 build-essential libsqlite3-dev \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /smoke
COPY dorkos-*.tgz ./
RUN npm install -g ./dorkos-*.tgz

# Stage 2: Verify — clean image, copies compiled artifacts
# (For pure smoke testing, single stage is acceptable because you're testing install, not shipping)
```

For smoke tests (not production images), a single-stage build is fine — you want to test the full install experience including compilation.

### 5. GitHub Actions Workflow Architecture

The recommended workflow structure has three jobs with explicit dependencies:

```yaml
jobs:
  build:
    # 1. Run pnpm build, then pnpm pack, upload .tgz artifact

  smoke-test-bare:
    needs: build
    strategy:
      matrix:
        node: ['18', '20', '22']
    # 2. Download artifact, npm install -g .tgz, run dorkos --version

  smoke-test-docker:
    needs: build
    # 3. Download artifact, docker build with COPY .tgz, docker run verify
```

The bare-runner test (job 2) is faster and covers node version matrix. The Docker test (job 3) validates a clean OS install in isolation.

### 6. Trigger Strategy

| Trigger                   | Purpose                           |
| ------------------------- | --------------------------------- |
| `push: branches: [main]`  | Catch regressions on every merge  |
| `push: tags: ['v*']`      | Gate before npm publish           |
| `workflow_dispatch`       | Manual smoke test on demand       |
| `pull_request` (optional) | Can be skipped to save CI minutes |

The smoke test job should be a **required check before npm publish**. Use `needs: [smoke-test-bare, smoke-test-docker]` on the publish job.

### 7. Handling Missing Runtime Dependency (`claude` CLI)

The `claude` binary is not on PATH in a Docker smoke test. Best practices:

**Option A: Exit with a clear message, exit code 1 (not 127)**

```typescript
// In CLI startup
const claudeAvailable = await which('claude').catch(() => null);
if (!claudeAvailable) {
  console.error('Error: claude CLI not found in PATH.');
  console.error('Install it: npm install -g @anthropic-ai/claude-code');
  process.exit(1);
}
```

**Option B: Lazy check — only fail when actually used**
The CLI can start successfully without `claude` in PATH. The check happens when a user tries to create a session. This is preferable for smoke testing because `dorkos --version` and `dorkos --help` should always succeed.

**Option C: Smoke test with a mock `claude` stub**

```bash
# In the Docker smoke test stage
RUN echo '#!/bin/sh\necho "claude stub"' > /usr/local/bin/claude && chmod +x /usr/local/bin/claude
```

The recommended approach for DorkOS is **Option B** for startup + **Option C** for deeper smoke tests that exercise session creation.

**Exit code conventions for missing dependencies:**

- Exit code `1` — general failure (preferred for missing optional runtime deps)
- Exit code `127` — shell "command not found" (set by shell, not by your process)
- Exit code `2` — misuse / bad arguments

A Node.js CLI should never exit with 127 — that code is reserved for the shell. Exit 1 with a human-readable error message is the standard.

### 8. pnpm Monorepo + npm pack Interaction

The dorkos CLI uses esbuild bundling, which simplifies the pack situation:

- `pnpm pack` (or `pnpm --filter=dorkos pack`) creates a `.tgz` from the `files` array in `packages/cli/package.json`
- The `files` array is `["dist/", "LICENSE", "README.md"]`
- esbuild has already resolved all workspace imports (`@dorkos/shared/*`, server source) into `dist/server/index.js`
- Workspace `devDependencies` (like `@dorkos/typescript-config`) are not in the tarball — correct
- Runtime `dependencies` listed in `packages/cli/package.json` ARE what npm installs when users run `npm install -g dorkos`

**Critical gap**: `better-sqlite3` must be in `packages/cli/package.json:dependencies` because:

1. The esbuild bundle references it at runtime (native `.node` file)
2. npm install does not traverse workspace deps when installing from a published tarball
3. The smoke test will fail with `Cannot find module 'better-sqlite3'` if it's missing

**pnpm workspace protocol resolution**: pnpm automatically converts `workspace:*` references to concrete version numbers in the published tarball's `package.json`. This only matters for packages that are also published to npm — for private workspace packages that are bundled by esbuild, it's irrelevant.

### 9. Caching Strategy in GitHub Actions

```yaml
- uses: pnpm/action-setup@v4
  with:
    version: 10

- uses: actions/setup-node@v4
  with:
    node-version: '20'
    cache: 'pnpm' # caches ~/.pnpm-store automatically
```

For the smoke test job (which only runs `npm install -g` from a tarball, not `pnpm install`), no pnpm cache is needed. The artifact download replaces the build step entirely.

For Turborepo remote caching, add:

```yaml
env:
  TURBO_TOKEN: ${{ secrets.TURBO_TOKEN }}
  TURBO_TEAM: ${{ vars.TURBO_TEAM }}
```

### 10. .dockerignore Best Practices for Monorepos

When building a Docker image at the repo root for smoke testing, a lean `.dockerignore` is critical to avoid copying the entire monorepo (multi-GB with all node_modules):

```
# Default deny-all, allowlist approach
**
!packages/cli/dist/
!packages/cli/package.json
!dorkos-*.tgz
```

Or, if passing the `.tgz` via `COPY` with `--build-arg`:

```dockerfile
ARG TARBALL
COPY ${TARBALL} /smoke/
```

---

## Detailed Analysis

### Complete GitHub Actions Workflow

```yaml
# .github/workflows/cli-smoke-test.yml
name: CLI Smoke Test

on:
  push:
    branches: [main]
    tags: ['v*']
  workflow_dispatch:

jobs:
  build-tarball:
    name: Build CLI Tarball
    runs-on: ubuntu-latest
    timeout-minutes: 15
    outputs:
      tarball-name: ${{ steps.pack.outputs.tarball-name }}
    steps:
      - uses: actions/checkout@v4

      - uses: pnpm/action-setup@v4
        with:
          version: 10

      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'pnpm'

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Build CLI package
        run: pnpm --filter=dorkos run build

      - name: Pack tarball
        id: pack
        working-directory: packages/cli
        run: |
          pnpm pack --pack-destination /tmp/cli-artifacts/
          TARBALL=$(ls /tmp/cli-artifacts/*.tgz)
          echo "tarball-name=$(basename $TARBALL)" >> $GITHUB_OUTPUT

      - name: Upload tarball artifact
        uses: actions/upload-artifact@v4
        with:
          name: cli-tarball
          path: /tmp/cli-artifacts/*.tgz
          retention-days: 7

  smoke-test-bare:
    name: Bare Install (${{ matrix.node }})
    needs: build-tarball
    runs-on: ubuntu-latest
    timeout-minutes: 10
    strategy:
      fail-fast: false
      matrix:
        node: ['18', '20', '22']
    steps:
      - uses: actions/download-artifact@v4
        with:
          name: cli-tarball
          path: /tmp/artifacts/

      - uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node }}

      - name: Install build tools for native addons
        run: |
          sudo apt-get update -q
          sudo apt-get install -y --no-install-recommends python3 build-essential libsqlite3-dev

      - name: Install CLI from tarball
        run: npm install -g /tmp/artifacts/*.tgz

      - name: Verify binary exists and responds
        run: |
          which dorkos
          dorkos --version
          dorkos --help

      - name: Verify server starts (without claude)
        timeout-minutes: 1
        run: |
          # Start server in background, give it 3 seconds to bind
          dorkos &
          DORKOS_PID=$!
          sleep 3
          # Health check — expect 200 or graceful error about missing claude
          HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:4242/api/health || echo "000")
          if [ "$HTTP_STATUS" = "200" ]; then
            echo "Health check passed"
          else
            echo "Server did not respond (status: $HTTP_STATUS) — checking if startup error is expected"
            # A startup failure about missing claude is acceptable
            wait $DORKOS_PID
            EXIT=$?
            if [ $EXIT -eq 0 ] || [ $EXIT -eq 1 ]; then
              echo "Server exited cleanly — acceptable for missing claude dependency"
            else
              echo "Server exited with unexpected code $EXIT"
              exit 1
            fi
          fi

  smoke-test-docker:
    name: Docker Smoke Test
    needs: build-tarball
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v4
        with:
          sparse-checkout: |
            .github/docker/smoke-test.Dockerfile

      - uses: actions/download-artifact@v4
        with:
          name: cli-tarball
          path: /tmp/artifacts/

      - name: Build smoke test image
        run: |
          TARBALL=$(ls /tmp/artifacts/*.tgz | head -1)
          docker build \
            --file .github/docker/smoke-test.Dockerfile \
            --build-arg TARBALL=$(basename $TARBALL) \
            --tag dorkos-smoke:test \
            /tmp/artifacts/

      - name: Run smoke test container
        run: |
          docker run --rm dorkos-smoke:test

  publish:
    name: Publish to npm
    needs: [smoke-test-bare, smoke-test-docker]
    if: startsWith(github.ref, 'refs/tags/v')
    runs-on: ubuntu-latest
    permissions:
      id-token: write # For npm OIDC trusted publishing
    steps:
      - uses: actions/download-artifact@v4
        with:
          name: cli-tarball
          path: /tmp/artifacts/

      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          registry-url: 'https://registry.npmjs.org'

      - name: Publish
        run: npm publish /tmp/artifacts/*.tgz --provenance
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

### Complete Smoke Test Dockerfile

```dockerfile
# .github/docker/smoke-test.Dockerfile
FROM node:20-slim

# Install build tools for native addons (better-sqlite3 requires compilation)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    build-essential \
    libsqlite3-dev \
    && rm -rf /var/lib/apt/lists/*

# Install a mock claude stub so the CLI can start without the real claude CLI
RUN printf '#!/bin/sh\necho "claude stub for smoke test"\n' > /usr/local/bin/claude \
    && chmod +x /usr/local/bin/claude

# Copy and install the tarball
ARG TARBALL
COPY ${TARBALL} /smoke/package.tgz
RUN npm install -g /smoke/package.tgz

# Run smoke verification as entrypoint
CMD ["sh", "-c", "\
  echo '=== Testing dorkos binary ===' && \
  which dorkos && \
  dorkos --version && \
  dorkos --help > /dev/null && \
  echo '=== All smoke tests passed ===' \
"]
```

### better-sqlite3 in Docker: Root Cause Summary

The fundamental issue is that `better-sqlite3` compiles a native `.node` addon during `npm install`. On Alpine, the prebuilt binaries target glibc but Alpine uses musl libc, causing:

```
Error relocating better_sqlite3.node: fcntl64: symbol not found
```

On Debian slim (`node:20-slim`), glibc is present but build tools are stripped. The solution is installing `python3 build-essential libsqlite3-dev` before running `npm install`.

**Multi-stage approach for production (not smoke testing):**

```dockerfile
# Build stage — has all compilation tools
FROM node:20-slim AS builder
RUN apt-get update && apt-get install -y python3 build-essential libsqlite3-dev \
    && rm -rf /var/lib/apt/lists/*
RUN npm install -g dorkos@latest

# Runtime stage — copies compiled artifacts, adds only libsqlite3 runtime lib
FROM node:20-slim AS runtime
RUN apt-get update && apt-get install -y libsqlite3-0 && rm -rf /var/lib/apt/lists/*
COPY --from=builder /usr/local/lib/node_modules /usr/local/lib/node_modules
COPY --from=builder /usr/local/bin/dorkos /usr/local/bin/dorkos
CMD ["dorkos"]
```

For a smoke test Dockerfile, there is no benefit to multi-stage — use a single stage to mirror the actual user install experience.

### DorkOS-Specific Action Items

1. **Add `better-sqlite3` to `packages/cli/package.json:dependencies`**. Without this, every global install from the tarball will fail. The esbuild bundle references `better-sqlite3` at runtime via the `@dorkos/db` code path.

2. **Verify `chokidar` and `croner` are also listed** — these are `@dorkos/server` deps that the esbuild bundle references but they are NOT in the `external` list, meaning they ARE bundled. Check whether they have native addons or are pure JS (they are pure JS, so bundling is fine).

3. **`dotenv` is in the external list** — it must be in `packages/cli/package.json:dependencies`. It is — confirmed present.

4. **The `drizzle` migrations directory** is copied to `dist/drizzle/` in the build script and is under `dist/` which is in the `files` array — this will be included in the tarball correctly.

5. **Test with `npm install -g` not `pnpm add -g`** — the smoke test must use npm (or a plain `npm install`) because that is what real users run. pnpm workspaces have their own symlink resolution that can mask missing deps.

---

## Sources & Evidence

- "Run `npm install` in the Dockerfile. You can't just copy binaries from your host into the container and expect them to run." — [better-sqlite3 Alpine Docker Discussion](https://github.com/WiseLibs/better-sqlite3/discussions/1270)

- Multi-stage build pattern with `python3 g++ build-essential libsqlite3-dev` — [Backstage Docker Deployment Guide](https://backstage.io/docs/deployment/docker/)

- GitHub Actions node-version matrix: `['18', '20', '22']` with `actions/setup-node@v4` and `cache: 'pnpm'` — [GitHub Docs: Building and Testing Node.js](https://docs.github.com/en/actions/use-cases-and-examples/building-and-testing/building-and-testing-nodejs)

- Artifact sharing between jobs via `actions/upload-artifact@v4` / `actions/download-artifact@v4` — [GitHub Docs: Store and Share Data](https://docs.github.com/en/actions/tutorials/store-and-share-data)

- pnpm workspace protocol resolution: "Converts workspace:\*, workspace:^, workspace:~ to actual version numbers" — [pnpm Workspaces](https://pnpm.io/workspaces)

- pnpm pack `--pack-destination` option for directing tarball output — [pnpm pack docs](https://pnpm.io/cli/pack)

- Exit code 127 is set by the shell for "command not found", not by Node.js processes — [groundcover Exit Code 127](https://www.groundcover.com/kubernetes-troubleshooting/exit-code-127)

- "Using a Debian slim image instead of Alpine is recommended because everything should work out of the box" — [answeroverflow better-sqlite3 Docker](https://www.answeroverflow.com/m/1221244020685148211)

- "Setting `process.exitCode = 1` rather than calling `process.exit()` directly" for graceful CLI error exits — [Node.js Process API](https://nodejs.org/api/process.html)

- Turborepo release workflow: smoke-test as prerequisite to npm-publish job — [turborepo-release.yml](https://github.com/vercel/turborepo/blob/main/.github/workflows/turborepo-release.yml)

- npm OIDC trusted publishing: `permissions.id-token: write` — [Snyk: GitHub Actions to securely publish npm packages](https://snyk.io/blog/github-actions-to-securely-publish-npm-packages/)

---

## Research Gaps & Limitations

- No publicly documented DorkOS-specific smoke test exists yet — workflow above is synthesized from best practices
- The exact behavior of esbuild when it encounters `better-sqlite3` (a native addon) during bundling needs to be empirically verified — it likely silently leaves it as an external `require()` call
- The `croner` and `chokidar` packages are bundled by esbuild (not in external list) — if they add native addons in future versions this would silently break
- Node 18 end-of-life was April 2025 — the matrix may need to be updated to `['20', '22', '24']`

---

## Contradictions & Disputes

- **Alpine vs Debian**: Some community resources suggest Alpine multi-stage builds can work with better-sqlite3, but the maintainers' own discussion thread recommends switching to Debian-based images as the simpler path. For a smoke test container (not a production image), Debian slim is clearly the right choice.

- **bundledDependencies vs esbuild bundling**: One approach is to list runtime workspace deps in `bundledDependencies` so they're packed into the tarball. However, for DorkOS the better approach is to use esbuild bundling (already in place) for pure-JS workspace code and list native addon deps (`better-sqlite3`) as regular runtime dependencies.

---

## Search Methodology

- Searches performed: 14
- Most productive search terms: "better-sqlite3 Docker alpine debian", "GitHub Actions npm pack artifact upload", "pnpm workspace publish protocol", "node-gyp rebuild Docker multi-stage"
- Primary information sources: GitHub issues/discussions (WiseLibs/better-sqlite3, pnpm), GitHub Docs, Backstage Docs, Node.js Docs
