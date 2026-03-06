---
slug: eslint-per-package-config
number: 98
created: 2026-03-06
status: ideation
---

# ESLint Per-Package Config Refactor

**Slug:** eslint-per-package-config
**Author:** Claude Code
**Date:** 2026-03-06
**Branch:** preflight/eslint-per-package-config

---

## 1) Intent & Assumptions

- **Task brief:** Refactor the monolithic root `eslint.config.js` (~275 lines) into per-package ESLint configs with a shared config package (`@dorkos/eslint-config`), mirroring the existing `@dorkos/typescript-config` pattern. Add new boundary enforcement rules to confine `@anthropic-ai/claude-agent-sdk` imports to `runtimes/claude-code/`, supporting the agent-runtime-abstraction spec (#97).
- **Assumptions:**
  - ESLint 9 flat config is already in use (v9.39.2)
  - Turborepo `lint` task already runs per-package for packages with lint scripts
  - `apps/site` already has its own `eslint.config.mjs` (uses `eslint-config-next`) — this refactor coordinates with it
  - The agent-runtime-abstraction spec (#97) will move SDK-dependent files into `runtimes/claude-code/` — this spec adds the lint guardrail to enforce that boundary
  - `sdk-utils.ts` (which uses `require.resolve` for Claude CLI path) will move into `runtimes/claude-code/` as part of this work
- **Out of scope:**
  - Adding new lint rules beyond SDK confinement and the structural refactor
  - Migrating to a different linter or changing Prettier config
  - Implementing the agent-runtime-abstraction itself (spec #97 handles that)
  - Adding `eslint-plugin-boundaries` (the existing `no-restricted-imports` approach is sufficient for our layer count)

## 2) Pre-reading Log

- `eslint.config.js` (276 lines): Single root config with 11 configuration blocks — base JS/TS, TSDoc, React, 3 FSD boundary rules, env var discipline + carve-outs, dork-home ban, test overrides, Prettier
- `packages/typescript-config/`: Pattern to mirror — `base.json`, `react.json`, `node.json` as composable presets, consumed via `extends` in each package's `tsconfig.json`
- `turbo.json`: `lint` task has `"dependsOn": ["^build"]`, `"cache": true`. Needs update to `"dependsOn": ["^lint"]` for shared config cache invalidation
- `apps/site/eslint.config.mjs`: Already has per-app config using `eslint-config-next`. Proves the per-package pattern is partially established
- Root `package.json`: All ESLint plugin deps in root `devDependencies`. Lint script is `turbo lint`
- Per-package `package.json` files: 8 packages have `"lint": "eslint ."` scripts; 4 packages (cli, db, test-utils, icons) do not
- `apps/server/src/services/runtimes/claude-code/`: 25 files — canonical location for SDK-dependent code
- `apps/server/src/lib/sdk-utils.ts`: Uses `require.resolve('@anthropic-ai/claude-agent-sdk/cli.js')` — Claude-specific, should move into runtimes
- `apps/server/src/services/core/__tests__/`: 31+ test files that mock the SDK via `vi.mock()` — need carve-out from SDK ban
- `packages/cli/scripts/build.ts`: References SDK package name in esbuild externals list — build config, not a runtime import
- `research/20260306_eslint_per_package_config.md`: Full research report with 22 sources covering ESLint 9 flat config monorepo patterns

## 3) Codebase Map

- **Primary components/modules:**
  - `eslint.config.js` — root config being decomposed (276 lines, 11 blocks)
  - `packages/typescript-config/` — pattern to mirror for `@dorkos/eslint-config`
  - `turbo.json` — lint task configuration
  - 12 `package.json` files — need `devDependencies` and `scripts` updates
  - `apps/site/eslint.config.mjs` — existing per-package config (coordinate, don't overwrite)

- **Shared dependencies:**
  - `@eslint/js`, `typescript-eslint`, `eslint-plugin-jsdoc` — all packages
  - `eslint-plugin-react`, `eslint-plugin-react-hooks`, `eslint-plugin-jsx-a11y` — client + obsidian-plugin only
  - `eslint-config-prettier` — all packages (always last)
  - `eslint-config-next` — site only (already in site's own config)

- **Data flow:** Turborepo `lint` task -> per-package `eslint .` -> package's `eslint.config.js` imports from `@dorkos/eslint-config/*` -> ESLint evaluates rules

- **Feature flags/config:** None. This is build tooling, not runtime.

- **Potential blast radius:**
  - **Direct:** Root `eslint.config.js` (decomposed), 12 new/updated `eslint.config.js` files, 12 `package.json` updates, `turbo.json`
  - **Indirect:** Any file that currently has lint warnings may surface new or different warnings if rule evaluation order changes during migration
  - **Tests:** No test code changes needed — lint config doesn't affect test execution
  - **SDK boundary:** `sdk-utils.ts` moves to `runtimes/claude-code/`, import paths update

### Package Boundary Analysis

| Package | Shared Config | Package-Local Rules |
|---------|--------------|-------------------|
| `apps/client` | `react.js` | FSD layer enforcement (3 `no-restricted-imports` blocks) |
| `apps/server` | `node.js` | `os.homedir()` ban, SDK confinement (`@anthropic-ai/claude-agent-sdk`), `process.env` carve-outs for server-specific files |
| `apps/obsidian-plugin` | `react.js` | None currently |
| `apps/site` | Keep existing `eslint-config-next` | Already has own config |
| `apps/e2e` | `base.js` | Playwright-specific if needed |
| `packages/shared` | `base.js` | None |
| `packages/relay` | `base.js` | None |
| `packages/mesh` | `base.js` | None |
| `packages/cli` | `node.js` | `process.env` carve-outs for CLI bootstrap |
| `packages/db` | `base.js` | None |
| `packages/test-utils` | `base.js` + `test.js` | None |
| `packages/icons` | `base.js` | Minimal (asset package) |

### SDK Import Locations (Current State)

| Location | Count | Type | After Refactor |
|----------|-------|------|---------------|
| `services/runtimes/claude-code/` | 26 | Production code | Allowed (inside boundary) |
| `services/core/__tests__/` | 31+ | Test mocks | Carve-out (tests may mock SDK) |
| `services/core/*.ts` shims | 8 | Re-export shims | Deleted (spec #97 removes these) |
| `lib/sdk-utils.ts` | 1 | CLI path resolution | Moved into `runtimes/claude-code/` |
| `packages/cli/scripts/build.ts` | 1 | Build config | Carve-out (string reference in externals) |

## 5) Research

- **Potential solutions:**

  1. **Per-package configs with shared config package (Approach A)**
     - Turborepo's official recommendation; mirrors existing `@dorkos/typescript-config` pattern
     - Each package owns its `eslint.config.js`, imports shared presets
     - Structurally eliminates the `no-restricted-imports` overwrite problem
     - Granular Turbo cache invalidation (change client code, only re-lint client)
     - Pros: clean boundaries, no glob-path confusion, IDE-friendly, plugin deps centralized
     - Cons: ~12 new config files to create (each small and focused)
     - Complexity: Medium-low. Maintenance: Low.

  2. **Split-by-concern in root config (Approach B)**
     - Keep root `eslint.config.js`, extract rule groups into `eslint/` directory
     - Pros: no new package, no workspace dep changes
     - Cons: `no-restricted-imports` overwrite problem persists and worsens, no granular caching, glob explosion
     - Complexity: Low setup, high maintenance.

  3. **Hybrid root orchestrator (Approach C)**
     - Shared config package exists but root config composes everything with path rewriting
     - Pros: single lint invocation
     - Cons: fragile path rewriting, no benefit over A, not Turborepo-recommended
     - Complexity: High. Maintenance: High.

- **Recommendation:** Approach A. Turborepo recommends it, it matches the existing `typescript-config` pattern, and it structurally eliminates the `no-restricted-imports` conflict that the root config already has latently.

- **Key technical insight:** In ESLint flat config, when two config objects both match the same files and both define `no-restricted-imports`, the later one **completely replaces** the earlier one's `patterns`/`paths` arrays. The current root config has this latent problem (FSD rules for `apps/client/src/layers/shared/**` would silently drop the `os.homedir()` ban if they overlapped, but it hasn't surfaced because client files don't import from `os`). Per-package configs eliminate this structurally.

- **`process.env` discipline rule strategy:** The base shared config includes the `no-restricted-syntax` ban on `process.env`. Each package's local config adds carve-outs specific to that package's legitimate `process.env` usage (e.g., server's `env.ts`, `dork-home.ts`, `logger.ts`; CLI's `cli.ts`, `config-commands.ts`).

## 6) Decisions

| # | Decision | Choice | Rationale |
|---|----------|--------|-----------|
| 1 | Add lint to packages without it? | Yes, add to all packages | Consistent coverage across monorepo. Catches issues that currently slip through. Aligns with "every package owns its config" philosophy. |
| 2 | Root `eslint.config.js` fate? | Keep thin root config | Retain minimal config for root-level files (`turbo.json`, `vitest.workspace.ts`, etc.) and as fallback. Turborepo default — some root files need linting too. |
| 3 | `sdk-utils.ts` location? | Move into `runtimes/claude-code/` | `require.resolve('@anthropic-ai/claude-agent-sdk/cli.js')` is a Claude-specific concern. Moving it keeps the SDK boundary clean with zero carve-outs in the confinement rule. |

### Shared Config Package Structure

```
packages/eslint-config/
  package.json       # private, exports ./base, ./react, ./node, ./test
  base.js            # JS + TS recommended + jsdoc + process.env ban + prettier
  react.js           # extends base + react/hooks/a11y plugins
  node.js            # extends base + node-specific settings
  test.js            # test file relaxations (overlays on any config)
```

### New SDK Confinement Rule (in `apps/server/eslint.config.js`)

```javascript
// Ban Claude Agent SDK imports outside runtimes/claude-code/
{
  files: ['src/**/*.ts'],
  ignores: [
    'src/services/runtimes/claude-code/**',
    'src/**/__tests__/**',
  ],
  rules: {
    'no-restricted-imports': ['error', {
      patterns: [{
        group: ['@anthropic-ai/claude-agent-sdk', '@anthropic-ai/claude-agent-sdk/*'],
        message: 'Claude Agent SDK imports are confined to services/runtimes/claude-code/. Import from the AgentRuntime interface instead.',
      }],
      // Also include os.homedir ban in the same rule to avoid overwrite
      paths: [
        { name: 'os', importNames: ['homedir'], message: "Use the resolved dorkHome parameter." },
        { name: 'node:os', importNames: ['homedir'], message: "Use the resolved dorkHome parameter." },
      ],
    }],
  },
},
```

Note: The SDK confinement and `os.homedir()` ban are combined into a single `no-restricted-imports` config object for files matching `src/**/*.ts` to avoid the flat config overwrite problem.
