# Implementation Summary: Disciplined Environment Variable Handling

**Created:** 2026-02-25
**Last Updated:** 2026-02-25
**Spec:** specs/env-var-discipline/02-specification.md

## Progress

**Status:** Complete
**Tasks Completed:** 18 / 18

## Tasks Completed

### Session 1 - 2026-02-25

**Phase 1 — Foundation (7 parallel tasks)**

- [x] #1 `apps/server/src/env.ts` — server Zod schema with `boolFlag` helper, typed `env` export, fast-fail on invalid vars
- [x] #2 `apps/client/src/env.ts` — Vite env stub using `import.meta.env`; added `zod` to `@dorkos/client` deps
- [x] #3 `apps/roadmap/src/server/env.ts` — roadmap schema (`ROADMAP_PORT`, `ROADMAP_PROJECT_ROOT`, `NODE_ENV`)
- [x] #4 `apps/web/src/env.ts` — Next.js schema (`NODE_ENV`, `NEXT_PUBLIC_POSTHOG_KEY`, `NEXT_PUBLIC_POSTHOG_HOST`)
- [x] #5 `packages/cli/src/env.ts` — CLI read-only schema (`NODE_ENV`, `DORK_HOME`, `LOG_LEVEL`)
- [x] #6 `.env.example` — added 8 missing vars with inline comments
- [x] #7 `turbo.json` — added 4 vars to `globalPassThroughEnv` (`CLIENT_DIST_PATH`, `DORKOS_VERSION`, `ROADMAP_PORT`, `ROADMAP_PROJECT_ROOT`); sorted list alphabetically

**Phase 1 — Continuation (2 tasks)**

- [x] #8 `eslint.config.js` — added `no-restricted-syntax` warn rule with carve-outs (`**/env.ts`, `**/*.config.ts`, `**/__tests__/**`, `packages/cli/src/cli.ts`)
- [x] #9 `contributing/environment-variables.md` — developer guide (pattern, how-to-add, ESLint rule, test strategy)

**Phase 2 — Server Migration**

- [x] #10 `apps/server/src/index.ts` — replaced 12 `process.env` reads; kept write `process.env.DORK_HOME = dorkHome` (bootstrap)
- [x] #11 `apps/server/src/app.ts`, `lib/dork-home.ts`, `lib/logger.ts` — migrated where feasible; dork-home.ts and logger.ts legitimately kept dynamic reads
- [x] #12 `apps/server/src/routes/config.ts`, `tunnel.ts`, `commands.ts` — all reads migrated; tunnel.ts kept dynamic reads for runtime resolution
- [x] #13 `services/core/config-manager.ts`, `context-builder.ts`, `mcp-tool-server.ts`, `agent-manager.ts`, `openapi-registry.ts`, `services/pulse/pulse-store.ts` — all migrated

**Phase 2 — App Migration**

- [x] #14 `apps/roadmap/src/server/index.ts` — migrated
- [x] #15 `apps/web/src/lib/posthog-server.ts`, `apps/web/instrumentation-client.ts` — migrated
- [x] #16 `packages/cli/src/cli.ts` — reads replaced with `env.*`; `process.env.X = value` writes kept (bootstrap) with no ESLint disable needed (cli.ts is in carve-out list)

**Phase 3 — Tests & Verification**

- [x] #17 `apps/server/src/__tests__/env.test.ts` — 6 unit tests using `vi.stubEnv()` + `vi.resetModules()`; `mcp-tool-server.test.ts` updated to use same pattern
- [x] #18 Full verification passed: typecheck 13/13 ✅, server tests 45 files / 623 tests ✅, client tests 64 files / 705 tests ✅, lint 0 errors ✅

## Files Modified/Created

**Source files:**

- `apps/server/src/env.ts` (new)
- `apps/client/src/env.ts` (new)
- `apps/roadmap/src/server/env.ts` (new)
- `apps/web/src/env.ts` (new)
- `packages/cli/src/env.ts` (new)
- `contributing/environment-variables.md` (new)
- `apps/server/src/index.ts`
- `apps/server/src/app.ts`
- `apps/server/src/routes/config.ts`
- `apps/server/src/routes/commands.ts`
- `apps/server/src/services/core/context-builder.ts`
- `apps/server/src/services/core/mcp-tool-server.ts`
- `apps/server/src/services/core/config-manager.ts`
- `apps/server/src/services/core/agent-manager.ts`
- `apps/server/src/services/core/openapi-registry.ts`
- `apps/server/src/services/pulse/pulse-store.ts`
- `apps/roadmap/src/server/index.ts`
- `apps/web/src/lib/posthog-server.ts`
- `apps/web/instrumentation-client.ts`
- `packages/cli/src/cli.ts`
- `apps/client/package.json` (added `zod` dependency)
- `eslint.config.js`
- `.env.example`
- `turbo.json`

**Test files:**

- `apps/server/src/__tests__/env.test.ts` (new)
- `apps/server/src/services/core/__tests__/mcp-tool-server.test.ts` (updated to use `vi.stubEnv()`)

## Known Issues

**Intentional `process.env` survivors (ESLint warns, not errors):**

- `apps/server/src/index.ts:41` — `process.env.DORK_HOME = dorkHome` (bootstrap write, sets env for child processes)
- `apps/server/src/lib/dork-home.ts` — reads at call time (bootstrap utility called before and after env vars are written)
- `apps/server/src/lib/logger.ts` — reads `NODE_ENV` at call time (called at request time with current env)
- `apps/server/src/routes/tunnel.ts` — reads at request time (for dynamic tunnel port resolution)

These generate 10 `no-restricted-syntax` warnings. All are intentional and documented.

## Implementation Notes

### Session 1

**boolFlag pattern confirmed working:**
```ts
const boolFlag = z.enum(['true', 'false']).default('false').transform(v => v === 'true');
```
Feature flags are now `boolean` type throughout. All `=== 'true'` string comparisons eliminated.

**NodeNext `.js` extension:** All relative imports from env.ts use `'./env.js'` extension as required by NodeNext module resolution.

**Client zod dependency:** `@dorkos/client` did not previously depend on `zod` directly (it was only in `@dorkos/shared`). Added via `pnpm --filter=@dorkos/client add zod`.

**Test strategy confirmed:** `vi.stubEnv()` + `vi.resetModules()` + dynamic `import()` works correctly for testing env schemas. All schema fields have `.default()` so empty env works without `skipValidation`.
