---
slug: cli-install-smoke-testing
number: 84
created: 2026-03-02
status: ideation
---

# CLI Install Smoke Testing — Docker & GitHub Actions

**Slug:** cli-install-smoke-testing
**Author:** Claude Code
**Date:** 2026-03-02
**Branch:** main

---

## 1) Intent & Assumptions

- **Task brief:** Set up Docker and GitHub Actions CI to smoke-test the `dorkos` CLI installation process. The tests should build, pack, install in a clean environment, and verify the CLI binary works — without polluting the local machine.
- **Assumptions:**
  - Tests verify the npm install path (tarball), not the development monorepo setup
  - The Claude Code CLI will not be available in CI/Docker — tests should handle this gracefully (mock stub)
  - `better-sqlite3` (native addon) requires build tools in Docker
  - The user pushes directly to main (no PR-based gating)
- **Out of scope:**
  - Playwright browser e2e tests
  - Testing the actual AI chat flow (requires real API key + Claude CLI)
  - Homebrew formula testing
  - Automated npm publish (to be added later)

## 2) Pre-reading Log

- `packages/cli/package.json`: CLI package identity — `dorkos@0.6.0`, bin field, files array, engine `>=18`, prepublishOnly hook
- `packages/cli/scripts/build.ts`: 3-step esbuild pipeline (Vite client, esbuild server bundle, esbuild CLI entry). Copies drizzle migrations. Injects `__CLI_VERSION__`
- `packages/cli/src/cli.ts`: Entry point. `--post-install-check` flag verifies Claude CLI + prints version. `init --yes` for non-interactive setup. Sets env vars imperatively before importing server
- `packages/cli/src/check-claude.ts`: Runs `claude --version` — exits 1 with install instructions if missing
- `packages/cli/src/init-wizard.ts`: `--yes` skips all prompts, calls `store.reset()`, no TTY needed
- `.github/workflows/update-homebrew.yml`: Only existing workflow — manual dispatch, updates Homebrew tap formula after npm release
- `turbo.json`: `globalPassThroughEnv` for runtime vars, task-level `env` for build vars
- `research/20260301_competitor_install_experience.md`: Recommends `--post-install-check` in install scripts, identifies DorkOS can't produce self-contained binary
- `research/20260302_cli-install-smoke-testing.md`: Full research on Docker base images, GitHub Actions workflow patterns, better-sqlite3 native addon issues, pnpm pack behavior

## 3) Codebase Map

**Primary Components/Modules:**

- `packages/cli/src/cli.ts` — CLI entry point, arg parsing, env setup, server import
- `packages/cli/src/check-claude.ts` — Claude CLI dependency check
- `packages/cli/src/init-wizard.ts` — Interactive setup wizard (`--yes` for CI)
- `packages/cli/scripts/build.ts` — 3-step esbuild build pipeline
- `packages/cli/package.json` — Package identity, dependencies, scripts

**Shared Dependencies:**

- `packages/db/` — Drizzle ORM schemas, depends on `better-sqlite3` (native addon)
- `apps/server/src/` — Express server, bundled by esbuild into CLI
- `apps/client/dist/` — React SPA, built by Vite and copied into CLI

**Data Flow:**
`pnpm build` -> esbuild bundles server + shared -> Vite builds client -> `pnpm pack` -> tarball -> `npm install -g` -> `dorkos` binary

**Feature Flags/Config:**

- `--post-install-check` — lightweight verify mode (no server start)
- `--yes` / `-y` — non-interactive init wizard
- `DORK_HOME` — config directory (defaults to `~/.dork`)

**Potential Blast Radius:**

- `packages/cli/package.json` — must add `better-sqlite3` to dependencies (bug fix)
- New files: `Dockerfile`, `.dockerignore`, `.github/workflows/cli-smoke-test.yml`
- `package.json` (root) — optional npm scripts for local Docker smoke test

## 4) Root Cause Analysis

N/A — not a bug fix.

## 5) Research

**Potential Solutions:**

**1. GitHub Actions — Bare Runner Smoke Test**

- Description: Build + pack tarball in one job, install from tarball on a bare Ubuntu runner in a second job
- Pros: Fast (~2 min), tests real OS, Node version matrix (20, 22), minimal config
- Cons: Runner has pre-installed packages that may mask missing deps
- Complexity: Low
- Maintenance: Low

**2. Docker Smoke Test**

- Description: Single-stage Dockerfile using `node:20-slim`, installs tarball with native addon build tools, runs verify commands
- Pros: Fully isolated clean room, reproducible, parameterizable via build args (Node version, mock Claude), runnable locally
- Cons: Requires Docker Desktop locally, slower than bare runner (~30-60s build)
- Complexity: Low-Medium
- Maintenance: Low

**3. Combined (Recommended)**

- Description: Both bare runner (Node matrix) + Docker (clean room) in the same workflow, running in parallel after a shared build job
- Pros: Best coverage — matrix tests Node compatibility, Docker validates clean install
- Cons: More CI minutes (but runs in parallel so wall time is similar)
- Complexity: Medium
- Maintenance: Low

**Critical bug found during research:** `better-sqlite3` is a transitive dependency of the CLI (via `@dorkos/db` bundled code) but is NOT listed in `packages/cli/package.json:dependencies`. Any `npm install -g dorkos` from npm will crash at runtime with `Cannot find module 'better-sqlite3'`. This must be fixed as a prerequisite.

**Recommendation:** Combined approach (option 3). The bare runner catches Node version incompatibilities fast. Docker catches missing system dependencies and validates the real user install experience. Both reuse the same tarball artifact.

## 6) Decisions

| #   | Decision                 | Choice                          | Rationale                                                                                         |
| --- | ------------------------ | ------------------------------- | ------------------------------------------------------------------------------------------------- |
| 1   | Include auto-publish job | No — smoke tests only           | Keep it simple. User publishes manually. Can add publish automation later                         |
| 2   | Node version matrix      | 20 + 22                         | Node 18 is EOL. 2 versions keeps CI fast while covering LTS + Current                             |
| 3   | Dockerfile location      | Repo root                       | Single file, easiest to run locally (`docker build .`), CI references it directly                 |
| 4   | Docker Compose           | No                              | Single container smoke test doesn't need orchestration. Build args handle variants                |
| 5   | Multiple test configs    | Build args in single Dockerfile | `NODE_VERSION` and `MOCK_CLAUDE` args allow testing different setups without multiple Dockerfiles |
