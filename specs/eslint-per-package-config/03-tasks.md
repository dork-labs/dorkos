# ESLint Per-Package Config Refactor — Task Breakdown

**Spec:** `specs/eslint-per-package-config/02-specification.md`
**Generated:** 2026-03-06
**Mode:** Full decomposition

---

## Summary

8 tasks across 5 phases. Estimated complexity: 3 large, 4 medium, 1 small.

| Phase | Name | Tasks | Description |
|-------|------|-------|-------------|
| 1 | Foundation | 2 | Create shared config package + move sdk-utils.ts |
| 2 | Per-Package Configs | 4 | Create eslint.config.js for all 11 packages |
| 3 | Build Configuration | 1 | Update turbo.json, thin root config, clean up deps |
| 4 | Verification | 1 | Behavioral equivalence + rule verification |
| 5 | Documentation | 1 | Update CLAUDE.md and architecture.md |

---

## Phase 1: Foundation

### Task 1.1 — Create @dorkos/eslint-config shared package with base, react, node, and test presets

**Size:** Large | **Priority:** High | **Dependencies:** None | **Parallel with:** 1.2

Create the `@dorkos/eslint-config` internal workspace package at `packages/eslint-config/`. This package centralizes all ESLint plugin dependencies and provides four composable preset configs:

- **`base.js`** — JS recommended, TS recommended (syntax-only), general overrides, TSDoc enforcement, `process.env` discipline, Prettier (always last)
- **`react.js`** — Extends base + React, React Hooks (incl. Compiler rules as warnings), jsx-a11y
- **`node.js`** — Extends base (semantic separation for Node.js packages)
- **`test.js`** — Overlay that relaxes rules for test files

Critical constraints:
- `base.js` must NOT include any `no-restricted-imports` rules (package-local only)
- `base.js` must NOT include `process.env` carve-outs (package-local only)
- `eslint-config-prettier` must be the last config object in `base.js`

Run `pnpm install` after creation to register the workspace package.

---

### Task 1.2 — Move sdk-utils.ts into runtimes/claude-code/ and update import paths

**Size:** Small | **Priority:** High | **Dependencies:** None | **Parallel with:** 1.1

Move `apps/server/src/lib/sdk-utils.ts` to `apps/server/src/services/runtimes/claude-code/sdk-utils.ts`. Update two import paths:

| File | Old Import | New Import |
|---|---|---|
| `apps/server/src/routes/config.ts` | `'../lib/sdk-utils.js'` | `'../services/runtimes/claude-code/sdk-utils.js'` |
| `apps/server/src/services/runtimes/claude-code/claude-code-runtime.ts` | `'../../../lib/sdk-utils.js'` | `'./sdk-utils.js'` |

This eliminates the need for any SDK confinement rule carve-out.

---

## Phase 2: Per-Package Configs

### Task 2.1 — Create apps/client/eslint.config.js with FSD boundary enforcement rules

**Size:** Medium | **Priority:** High | **Dependencies:** 1.1 | **Parallel with:** 2.2

Create the most complex per-package config: client with React preset, `process.env` carve-outs, and three FSD layer enforcement `no-restricted-imports` blocks (shared, entities, features). Add `@dorkos/eslint-config` to client devDependencies.

---

### Task 2.2 — Create apps/server/eslint.config.js with SDK confinement and os.homedir ban

**Size:** Medium | **Priority:** High | **Dependencies:** 1.1, 1.2 | **Parallel with:** 2.1

Create the server config with Node preset, server-specific `process.env` carve-outs, and the combined SDK confinement + `os.homedir()` ban rule. The SDK confinement and homedir ban must be in a SINGLE `no-restricted-imports` config object to avoid the flat config overwrite problem. Add `@dorkos/eslint-config` to server devDependencies.

---

### Task 2.3 — Create eslint.config.js for obsidian-plugin, e2e, and CLI packages

**Size:** Medium | **Priority:** High | **Dependencies:** 1.1 | **Parallel with:** 2.4

Create configs for three packages with slightly custom needs:
- **obsidian-plugin** — React preset, ignores `build-plugins/`
- **e2e** — Base only (no test overlay), ignores `test-results/` and `playwright-report/`
- **CLI** — Node preset, `process.env` carve-outs for `cli.ts` and `config-commands.ts`

Add `@dorkos/eslint-config` devDep and `"lint": "eslint ."` script where missing (e2e, CLI).

---

### Task 2.4 — Create eslint.config.js for simple packages: shared, relay, mesh, db, test-utils, icons

**Size:** Medium | **Priority:** High | **Dependencies:** 1.1 | **Parallel with:** 2.3

Create configs for six packages using the simple base+test pattern:
- **shared, relay, mesh, test-utils** — Base + test overlay
- **db** — Base + test overlay, also ignores `drizzle/**` (generated migrations)
- **icons** — Base only (no tests)

Add `@dorkos/eslint-config` devDep to all six. Add `"lint": "eslint ."` script to db, test-utils, icons (currently missing).

---

## Phase 3: Build Configuration

### Task 3.1 — Update turbo.json, thin root eslint.config.js, and clean up root package.json dependencies

**Size:** Medium | **Priority:** High | **Dependencies:** 2.1, 2.2, 2.3, 2.4

Three changes:

1. **turbo.json**: Change lint task `dependsOn` from `["^build"]` to `["^lint"]`
2. **Root eslint.config.js**: Replace 276-line config with ~15-line version that ignores `apps/**` and `packages/**`, imports from `@dorkos/eslint-config/base`
3. **Root package.json**: Remove 7 ESLint plugin devDependencies (moved to shared package), add `@dorkos/eslint-config: workspace:*`, keep `eslint`

Run `pnpm install` to update lockfile.

---

## Phase 4: Verification

### Task 4.1 — Verify behavioral equivalence, SDK confinement, FSD rules, and Turbo cache granularity

**Size:** Medium | **Priority:** High | **Dependencies:** 3.1

Six verification steps:

1. **Behavioral equivalence**: `pnpm lint` produces no new errors and no lost warnings
2. **SDK confinement**: Temporary test file with SDK import outside runtimes/ triggers error
3. **FSD rules**: Temporary test file with cross-layer import triggers error
4. **Per-package isolation**: `eslint .` works standalone in each of 11 package directories
5. **Turbo cache granularity**: Shared config change invalidates all caches; source change only invalidates affected package
6. **TypeScript compilation**: `pnpm typecheck` passes (sdk-utils.ts move is correct)

---

## Phase 5: Documentation

### Task 5.1 — Update CLAUDE.md and contributing/architecture.md with per-package ESLint config documentation

**Size:** Small | **Priority:** Medium | **Dependencies:** 4.1

Update two existing files:

1. **CLAUDE.md** Code Quality section: Describe per-package config pattern, `@dorkos/eslint-config` presets, SDK confinement rule
2. **contributing/architecture.md**: Add ESLint Architecture section describing shared package, per-package pattern, `no-restricted-imports` overwrite constraint, and Turborepo cache integration

No new documentation files created.

---

## Dependency Graph

```
1.1 (shared config pkg) ──┬──► 2.1 (client config) ──┐
                          ├──► 2.3 (obsidian/e2e/cli) ─┤
                          └──► 2.4 (simple packages) ──┤
1.2 (move sdk-utils) ─────┬──► 2.2 (server config) ───┤
                          │                             │
                          └─────────────────────────────┴──► 3.1 (build config) ──► 4.1 (verification) ──► 5.1 (docs)
```

## File Inventory

**New files (17):**
- `packages/eslint-config/package.json`
- `packages/eslint-config/base.js`
- `packages/eslint-config/react.js`
- `packages/eslint-config/node.js`
- `packages/eslint-config/test.js`
- `apps/client/eslint.config.js`
- `apps/server/eslint.config.js`
- `apps/obsidian-plugin/eslint.config.js`
- `apps/e2e/eslint.config.js`
- `packages/shared/eslint.config.js`
- `packages/relay/eslint.config.js`
- `packages/mesh/eslint.config.js`
- `packages/cli/eslint.config.js`
- `packages/db/eslint.config.js`
- `packages/test-utils/eslint.config.js`
- `packages/icons/eslint.config.js`
- `apps/server/src/services/runtimes/claude-code/sdk-utils.ts` (moved)

**Modified files (15):**
- `eslint.config.js` (root, thinned)
- `turbo.json`
- `package.json` (root)
- 8 package.json files (add devDep)
- 3 package.json files (add devDep + lint script)
- `apps/server/src/routes/config.ts` (import path)
- `apps/server/src/services/runtimes/claude-code/claude-code-runtime.ts` (import path)

**Deleted files (1):**
- `apps/server/src/lib/sdk-utils.ts` (moved)
