# Task Breakdown: Spec 64 — Disciplined Environment Variable Handling

**Spec:** `specs/env-var-discipline/02-specification.md`
**Generated:** 2026-02-25
**Mode:** Full
**Total Tasks:** 15

---

## Overview

This spec replaces 60+ scattered `process.env` accesses across 18 source files with validated, typed `env.ts` modules — one per app/package. The implementation is organized into 3 phases:

- **Phase 1 (Foundation):** Create all `env.ts` files and supporting infrastructure (ESLint rule, `.env.example`, `turbo.json`, docs). No behavior changes.
- **Phase 2 (Migration):** Migrate all source files from direct `process.env` access to `env.*`.
- **Phase 3 (Verification):** Write unit tests and run full verification suite.

---

## Phase 1: Foundation

Tasks 1.1–1.5 are fully parallel (no dependencies between them). Tasks 1.6–1.9 depend on 1.1–1.5 being complete (so ESLint can validate the new env.ts files exist) and are parallel with each other.

### Task 1.1 — Create `apps/server/src/env.ts`

**Size:** Small | **Priority:** High | **Parallel with:** 1.2, 1.3, 1.4, 1.5

Create the server environment validation module at `apps/server/src/env.ts`. This is the most critical file — it validates 16 env vars and provides the `boolFlag` helper that converts `'true'`/`'false'` strings to TypeScript `boolean`.

Key design: `boolFlag = z.enum(['true', 'false']).default('false').transform(v => v === 'true')` — NOT `z.coerce.boolean()`, which would treat the string `'false'` as `true` (any non-empty string coerces to `true`).

All fields have `.default()` or `.optional()` so `env.ts` parses successfully in test environments with an empty `process.env`.

---

### Task 1.2 — Create `apps/client/src/env.ts`

**Size:** Small | **Priority:** High | **Parallel with:** 1.1, 1.3, 1.4, 1.5

Create a stub client environment module at `apps/client/src/env.ts`. The client uses `import.meta.env` (not `process.env`) because Vite strips non-`VITE_*` vars from the browser bundle. Currently there are no custom `VITE_*` vars — only Vite built-ins (`MODE`, `DEV`).

This file establishes the canonical import path (`@/env`) and documents the steps for adding `VITE_*` vars in comments.

---

### Task 1.3 — Create `apps/roadmap/src/server/env.ts`

**Size:** Small | **Priority:** High | **Parallel with:** 1.1, 1.2, 1.4, 1.5

Create the roadmap server environment module at `apps/roadmap/src/server/env.ts`. Covers `ROADMAP_PORT` (coerced to `number`, default 4243) and `ROADMAP_PROJECT_ROOT` (default `process.cwd()`).

---

### Task 1.4 — Create `apps/web/src/env.ts`

**Size:** Small | **Priority:** High | **Parallel with:** 1.1, 1.2, 1.3, 1.5

Create the web marketing site environment module at `apps/web/src/env.ts`. Covers `NEXT_PUBLIC_POSTHOG_KEY` (optional) and `NEXT_PUBLIC_POSTHOG_HOST` (default `https://app.posthog.com`). T3 Env was explicitly rejected due to open bugs with `skipValidation` + ESM-only constraints.

---

### Task 1.5 — Create `packages/cli/src/env.ts`

**Size:** Small | **Priority:** High | **Parallel with:** 1.1, 1.2, 1.3, 1.4

Create the CLI environment module at `packages/cli/src/env.ts`. The CLI has a special bootstrap role — it WRITES to `process.env` to configure the server subprocess. This thin `env.ts` covers only what the CLI READS: `DORK_HOME`, `LOG_LEVEL`, `NODE_ENV`. The imperative writes stay in `cli.ts` with inline ESLint disable comments (handled in task 2.7).

---

### Task 1.6 — Add ESLint `no-restricted-syntax` rule and carve-outs

**Size:** Small | **Priority:** High | **Depends on:** 1.1–1.5 | **Parallel with:** 1.7, 1.8, 1.9

Add two new config blocks to `eslint.config.js` between the FSD layer enforcement blocks and the test file overrides block:

1. **Rule block** (`files: ['**/*.ts', '**/*.tsx']`): `no-restricted-syntax` warning on `MemberExpression[object.name='process'][property.name='env']` with message directing developers to the app's `env.ts`.

2. **Carve-out block**: Turns off `no-restricted-syntax` for: `**/env.ts`, `**/*.config.ts`, `**/__tests__/**`, `**/*.test.ts`, `**/*.spec.ts`, `packages/cli/src/cli.ts`.

Note: The existing global `ignores` block only matches `*.config.ts` at repo root (no `**/` prefix). The carve-out uses `**/*.config.ts` to cover Vite configs inside `apps/`.

After Phase 1, ESLint will warn on all existing `process.env` accesses. The app still works — this is a warn-first rule per project convention.

---

### Task 1.7 — Update `.env.example` with missing variables

**Size:** Small | **Priority:** Medium | **Depends on:** (none) | **Parallel with:** 1.6, 1.8, 1.9

Add 8 missing vars to the root `.env.example`. Currently missing:

| Var | Purpose |
|-----|---------|
| `DORKOS_RELAY_ENABLED` | Relay messaging subsystem feature flag |
| `DORKOS_MESH_ENABLED` | Mesh agent discovery feature flag |
| `DORKOS_VERSION` | Version injected at build time by CLI |
| `VITE_PORT` | Client dev server port (proxies /api to DORKOS_PORT) |
| `ROADMAP_PORT` | Roadmap app server port |
| `ROADMAP_PROJECT_ROOT` | Roadmap project root directory |
| `NEXT_PUBLIC_POSTHOG_KEY` | PostHog analytics key (apps/web only) |
| `NEXT_PUBLIC_POSTHOG_HOST` | PostHog host URL (apps/web only) |

---

### Task 1.8 — Update `turbo.json` `globalPassThroughEnv`

**Size:** Small | **Priority:** Medium | **Depends on:** (none) | **Parallel with:** 1.6, 1.7, 1.9

Add 4 missing vars to `globalPassThroughEnv` in `turbo.json`:
- `ROADMAP_PORT`
- `ROADMAP_PROJECT_ROOT`
- `CLIENT_DIST_PATH`
- `DORKOS_VERSION`

These are runtime vars (don't affect cache hash) so they belong in `globalPassThroughEnv`, not task-level `env` arrays.

---

### Task 1.9 — Create `contributing/environment-variables.md`

**Size:** Medium | **Priority:** Medium | **Depends on:** 1.1–1.5 | **Parallel with:** 1.6, 1.7, 1.8

Create the developer guide covering all 8 required sections:

1. The Pattern (why env.ts exists, what problems it solves)
2. Where Each `env.ts` Lives (table: app → file path → vars covered)
3. How to Add a New Env Var (4-step checklist)
4. Boolean Feature Flags (the `boolFlag` helper, why NOT `z.coerce.boolean()`)
5. ESLint Rule (what it catches, carve-out files, inline disable syntax)
6. Test Strategy (`vi.stubEnv()` + `vi.resetModules()` pattern)
7. Vite Client Env Vars (`VITE_*` prefix requirement, how to add them)
8. Complete Env Var Reference Table (all vars from all 5 env.ts files)

---

## Phase 2: Server Migration

All Phase 2 tasks depend on their respective Phase 1 `env.ts` files. Tasks 2.1–2.4 all depend on task 1.1 (server env.ts). Within Phase 2, tasks can be run in parallel where noted.

### Task 2.1 — Migrate `apps/server/src/index.ts`

**Size:** Medium | **Priority:** High | **Depends on:** 1.1 | **Parallel with:** 2.2, 2.3

The largest single migration target — 13 `process.env.*` accesses. Add `import { env } from './env.js'` and replace:

| Before | After |
|--------|-------|
| `parseInt(process.env.DORKOS_PORT \|\| String(DEFAULT_PORT), 10)` | `env.DORKOS_PORT` |
| `process.env.DORKOS_LOG_LEVEL ? parseInt(...) : undefined` | `env.DORKOS_LOG_LEVEL` |
| `process.env.DORKOS_BOUNDARY \|\| undefined` | `env.DORKOS_BOUNDARY` |
| `process.env.DORKOS_PULSE_ENABLED === 'true'` | `env.DORKOS_PULSE_ENABLED` |
| `process.env.DORKOS_RELAY_ENABLED === 'true'` | `env.DORKOS_RELAY_ENABLED` |
| `process.env.DORKOS_MESH_ENABLED === 'true'` | `env.DORKOS_MESH_ENABLED` |
| `process.env.DORKOS_DEFAULT_CWD ?? process.cwd()` | `env.DORKOS_DEFAULT_CWD ?? process.cwd()` |
| `process.env.TUNNEL_ENABLED === 'true'` (condition + host) | `env.TUNNEL_ENABLED` |
| `parseInt(process.env.TUNNEL_PORT \|\| String(PORT), 10)` | `env.TUNNEL_PORT ?? PORT` |
| `process.env.NGROK_AUTHTOKEN` | `env.NGROK_AUTHTOKEN` |
| `process.env.TUNNEL_AUTH` | `env.TUNNEL_AUTH` |
| `process.env.TUNNEL_DOMAIN` | `env.TUNNEL_DOMAIN` |

Line 41 (`process.env.DORK_HOME = dorkHome;`) is a WRITE — keep it. The server sets `DORK_HOME` after resolving it so downstream processes can inherit it.

---

### Task 2.2 — Migrate `app.ts`, `lib/dork-home.ts`, `lib/logger.ts`

**Size:** Small | **Priority:** High | **Depends on:** 1.1 | **Parallel with:** 2.1, 2.3

Three files with straightforward migrations:

- **`app.ts`**: Replace `process.env.NODE_ENV` and `process.env.CLIENT_DIST_PATH`
- **`lib/dork-home.ts`**: Replace `process.env.DORK_HOME` and `process.env.NODE_ENV`
- **`lib/logger.ts`**: Replace `process.env.NODE_ENV`

---

### Task 2.3 — Migrate route files (`config.ts`, `tunnel.ts`, `commands.ts`)

**Size:** Small | **Priority:** High | **Depends on:** 1.1 | **Parallel with:** 2.1, 2.2

Three route files:

- **`routes/config.ts`**: Replace `parseInt(process.env.DORKOS_PORT!, 10)` with `env.DORKOS_PORT` (already `number`), and `process.env.TUNNEL_AUTH`, `process.env.NGROK_AUTHTOKEN`
- **`routes/tunnel.ts`**: Replace `TUNNEL_PORT`, `NODE_ENV`, `DORKOS_PORT`, `NGROK_AUTHTOKEN`
- **`routes/commands.ts`**: Replace `DORKOS_DEFAULT_CWD`

---

### Task 2.4 — Migrate service files (config-manager, context-builder, mcp-tool-server, agent-manager, pulse-store)

**Size:** Medium | **Priority:** High | **Depends on:** 1.1 | **Parallel with:** (none — run after 2.1–2.3 to avoid conflicts)

Five service files:

| File | Vars to migrate |
|------|----------------|
| `services/core/config-manager.ts` | `DORK_HOME` |
| `services/core/context-builder.ts` | `DORKOS_VERSION`, `DORKOS_PORT` |
| `services/core/mcp-tool-server.ts` | `DORKOS_PORT`, `DORKOS_VERSION` |
| `services/core/agent-manager.ts` | `DORKOS_DEFAULT_CWD` |
| `services/pulse/pulse-store.ts` | `DORK_HOME` |

---

### Task 2.5 — Migrate `apps/roadmap/src/server/index.ts`

**Size:** Small | **Priority:** Medium | **Depends on:** 1.3 | **Parallel with:** 2.6, 2.7

Replace `parseInt(process.env.ROADMAP_PORT ?? '4243', 10)` with `env.ROADMAP_PORT` and `process.env.ROADMAP_PROJECT_ROOT ?? process.cwd()` with `env.ROADMAP_PROJECT_ROOT`.

---

### Task 2.6 — Migrate `apps/web` PostHog files

**Size:** Small | **Priority:** Medium | **Depends on:** 1.4 | **Parallel with:** 2.5, 2.7

Migrate `apps/web/src/lib/posthog-server.ts` and `apps/web/src/instrumentation-client.ts`. Both access `process.env.NEXT_PUBLIC_POSTHOG_KEY` and `process.env.NEXT_PUBLIC_POSTHOG_HOST`.

---

### Task 2.7 — Partially migrate `packages/cli/src/cli.ts`

**Size:** Small | **Priority:** Medium | **Depends on:** 1.5 | **Parallel with:** 2.5, 2.6

Split migration for the CLI bootstrap file:

- **Reads** → replace with `env.*` (DORK_HOME, LOG_LEVEL, NODE_ENV)
- **Writes** → keep `process.env.FOO = ...` but add `// eslint-disable-next-line no-restricted-syntax -- CLI bootstrap: sets env for server subprocess` before each one

---

## Phase 3: Verification and Tests

### Task 3.1 — Write unit tests for `apps/server/src/env.ts`

**Size:** Medium | **Priority:** High | **Depends on:** 1.1, 2.1–2.4 | **Parallel with:** 3.2

Create `apps/server/src/__tests__/env.test.ts` with 6 test cases:

1. Uses default port 4242 when `DORKOS_PORT` is not set
2. Parses `DORKOS_PORT` as a `number`
3. Feature flags default to `false`
4. Feature flag string `'true'` becomes boolean `true`
5. Feature flag string `'false'` becomes boolean `false`
6. Rejects an out-of-range port (calls `process.exit(1)`)

Test pattern: `vi.resetModules()` + `vi.stubEnv()` before each, `vi.unstubAllEnvs()` + `vi.resetModules()` in `afterEach`. Dynamic import (`await import('../env.js')`) forces `env.ts` to re-evaluate with stubbed values.

---

### Task 3.2 — Run full verification suite

**Size:** Small | **Priority:** High | **Depends on:** 2.1–2.7, 3.1 | **Parallel with:** (none — final gate)

Run the complete verification sequence:

```bash
pnpm typecheck                          # Must exit 0
pnpm test -- --run                      # Must exit 0, all tests pass
pnpm lint 2>&1 | grep no-restricted-syntax  # Must return 0 results from non-carve-out files
```

If `pnpm lint` still shows `no-restricted-syntax` warnings in non-carve-out files, identify and migrate the remaining files before marking this task complete.

---

## Dependency Graph

```
1.1 ─┬─ 2.1 ─┐
     ├─ 2.2 ─┤
     ├─ 2.3 ─┤
     └─ 2.4 ─┤
              ├─ 3.1 ─┐
1.2           │       │
1.3 ─── 2.5 ─┤       ├─ 3.2
1.4 ─── 2.6 ─┤       │
1.5 ─── 2.7 ─┘       │
1.6 ──────────────────┘
1.7 (independent)
1.8 (independent)
1.9 (deps on 1.1–1.5, independent of 2.x)
```

## Summary

| Phase | Tasks | Can Parallelize | Key Output |
|-------|-------|----------------|------------|
| 1 | 9 | 1.1–1.5 in parallel; 1.6–1.9 in parallel | 5 env.ts files, ESLint rule, .env.example, turbo.json, contributing guide |
| 2 | 7 | 2.1–2.3 in parallel; 2.5–2.7 in parallel | All process.env reads replaced |
| 3 | 2 | 3.1 in parallel with early 3.2 setup | Tests passing, lint clean |
