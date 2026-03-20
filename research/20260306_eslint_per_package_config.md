---
title: 'ESLint 9 Flat Config — Per-Package Monorepo Refactor Patterns'
date: 2026-03-06
type: external-best-practices
status: active
tags: [eslint, monorepo, flat-config, turborepo, pnpm, linting, code-quality]
feature_slug: eslint-per-package-config
searches_performed: 14
sources_count: 22
---

# ESLint 9 Flat Config — Per-Package Monorepo Refactor Patterns

## Research Summary

ESLint 9 flat config is fully compatible with per-package monorepo architectures, and Turborepo officially recommends a shared config package pattern (`@repo/eslint-config`) as the canonical approach. The key finding is that this refactor is straightforward structurally but has one significant gotcha: **`no-restricted-imports` rules do NOT merge across config objects — later definitions completely overwrite earlier ones**, which matters for the FSD boundary rules and the `os.homedir()` ban that currently coexist in the root config. The recommended resolution is to keep these rules inside the shared config package with well-scoped `files` globs. A new ESLint 9.15+ `extends` keyword and `defineConfig()` helper simplify composition further but are not strictly required.

## Key Findings

1. **Turborepo recommends Approach A (shared config package + per-package configs)**
   - Official docs show `packages/eslint-config/` with `base.js`, `react-internal.js`, `next.js` etc.
   - All ESLint plugin dependencies live in the shared package only — no duplication across consuming packages
   - turbo.json `lint` task uses `"dependsOn": ["^lint"]` which correctly invalidates downstream lint caches when the shared config changes

2. **`no-restricted-imports` last-wins problem is real but manageable**
   - In ESLint flat config, when two config objects both match the same files and both define `no-restricted-imports`, the later one completely replaces the earlier one's `patterns` / `paths` arrays
   - The fix: consolidate all `no-restricted-imports` rules for a given file set into a **single config object**, not across multiple config objects
   - Within a single rule declaration, multiple entries in the same `paths` array DO all apply (ESLint 9 fixed the old "last name wins" bug within a single rule declaration)

3. **ESLint 9.15+ `defineConfig()` and `extends` simplify composition**
   - `defineConfig()` from `"eslint/config"` auto-flattens nested arrays, eliminating spread operators
   - The `extends` key in a config object applies a shared config scoped to a file subset, without rewriting paths
   - For `@eslint/config-helpers` backport: available for older ESLint 9.x versions

4. **Turborepo cache invalidation works correctly with `"dependsOn": ["^lint"]`**
   - When the shared `@dorkos/eslint-config` package changes, all dependent packages' lint caches are invalidated
   - The config package itself does not need a `lint` script — the dependency edge is sufficient
   - The current `turbo.json` already has `"lint": { "dependsOn": ["^build"] }` but switching to `"^lint"` is the Turborepo-recommended pattern for config propagation

5. **Per-package `eslint.config.js` with root file glob paths is the correct mental model**
   - When ESLint runs inside a package directory, its `files` globs are relative to that package root, not the monorepo root
   - FSD boundary rules that reference `@/layers/...` paths only need to exist in `apps/client/eslint.config.js` — they have no meaning in server or packages
   - The `os.homedir()` ban only needs to exist in `apps/server/eslint.config.js`

6. **`eslint-plugin-boundaries` is a viable alternative to `no-restricted-imports` for architectural enforcement**
   - Declarative element-type taxonomy with allow/deny matrix
   - More expressive than `no-restricted-imports` for complex layered architectures
   - Adds a new dependency; `no-restricted-imports` is zero-cost
   - For FSD enforcement with only 4 layers (shared/entities/features/widgets), `no-restricted-imports` is sufficient and battle-tested in this codebase

## Detailed Analysis

### How ESLint 9 Flat Config Resolves in a Monorepo

When `eslint` runs inside `apps/client/`, it looks for an `eslint.config.js` starting in `apps/client/` and walking up ancestor directories until it finds one. If `apps/client/eslint.config.js` exists, that is the **only** config loaded for that package — it does **not** cascade and merge with the root `eslint.config.js`.

This is a break from the old `.eslintrc` cascade behavior and the key design choice that makes per-package configs work cleanly. Each package fully owns its config.

**Implication for path globs:** Inside `apps/client/eslint.config.js`, the glob `src/layers/shared/**/*.{ts,tsx}` is relative to `apps/client/` (the directory containing the config file), so it correctly matches `apps/client/src/layers/shared/...`. No path rewriting needed.

**Implication for running from root:** If `turbo lint` runs `eslint .` from the repo root and there is no `apps/client/eslint.config.js`, it falls back to the root `eslint.config.js` (which is the current setup). Once per-package configs exist, running `eslint .` from the repo root will pick up each package's own config as it descends. Turborepo's per-package lint task (`pnpm --filter @dorkos/client run lint`) runs inside the package directory and always picks up the package config.

### Shared Config Package Structure

Modeled on `@dorkos/typescript-config` pattern already in use:

```
packages/eslint-config/
├── package.json
├── base.js           # JS + TS recommended + jsdoc + prettier + no-restricted-syntax (process.env)
├── react.js          # extends base + react/hooks/a11y plugins
├── node.js           # extends base + node-specific settings
└── test.js           # test file relaxations (applies on top of any config)
```

**`package.json`:**

```json
{
  "name": "@dorkos/eslint-config",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    "./base": "./base.js",
    "./react": "./react.js",
    "./node": "./node.js",
    "./test": "./test.js"
  },
  "dependencies": {
    "@eslint/js": "...",
    "typescript-eslint": "...",
    "eslint-plugin-jsdoc": "...",
    "eslint-plugin-react": "...",
    "eslint-plugin-react-hooks": "...",
    "eslint-plugin-jsx-a11y": "...",
    "eslint-config-prettier": "..."
  }
}
```

All plugin dependencies live here. Consumer packages add only:

```json
"devDependencies": {
  "@dorkos/eslint-config": "workspace:*",
  "eslint": "^9"
}
```

### Consuming Package Pattern

**`apps/client/eslint.config.js`:**

```js
import { defineConfig } from 'eslint/config';
import reactConfig from '@dorkos/eslint-config/react';
import testConfig from '@dorkos/eslint-config/test';

export default defineConfig([
  { ignores: ['dist/**', '.turbo/**'] },
  ...reactConfig,
  // FSD boundary enforcement — client-only rules
  {
    files: ['src/layers/shared/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@/layers/entities/*', '@/layers/entities'],
              message: 'FSD violation: shared/ cannot import from entities/',
            },
            {
              group: ['@/layers/features/*', '@/layers/features'],
              message: 'FSD violation: shared/ cannot import from features/',
            },
            {
              group: ['@/layers/widgets/*', '@/layers/widgets'],
              message: 'FSD violation: shared/ cannot import from widgets/',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/layers/entities/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@/layers/features/*', '@/layers/features'],
              message: 'FSD violation: entities/ cannot import from features/',
            },
            {
              group: ['@/layers/widgets/*', '@/layers/widgets'],
              message: 'FSD violation: entities/ cannot import from widgets/',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/layers/features/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@/layers/widgets/*', '@/layers/widgets'],
              message: 'FSD violation: features/ cannot import from widgets/',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['**/__tests__/**/*.{ts,tsx}', '**/*.test.{ts,tsx}'],
    ...testConfig[0], // test relaxations
  },
  prettier,
]);
```

**`apps/server/eslint.config.js`:**

```js
import nodeConfig from '@dorkos/eslint-config/node';
import testConfig from '@dorkos/eslint-config/test';

export default [
  { ignores: ['dist/**', 'dist-server/**', '.turbo/**'] },
  ...nodeConfig,
  // Server-specific: ban os.homedir() outside dork-home.ts
  {
    files: ['src/**/*.ts'],
    ignores: ['src/lib/dork-home.ts', 'src/**/__tests__/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'os',
              importNames: ['homedir'],
              message: 'Use the resolved dorkHome parameter. See .claude/rules/dork-home.md',
            },
            {
              name: 'node:os',
              importNames: ['homedir'],
              message: 'Use the resolved dorkHome parameter. See .claude/rules/dork-home.md',
            },
          ],
        },
      ],
    },
  },
  ...testConfig,
  prettier,
];
```

### The `no-restricted-imports` Overwrite Problem

This is the most critical technical detail for this refactor:

**Problem:** In flat config, if two config objects both match a file and both define `no-restricted-imports`, the last one **completely replaces** the earlier one. Example:

```js
// Config object A (from shared base config)
{ files: ['**/*.ts'], rules: { 'no-restricted-imports': ['error', { paths: [{ name: 'os', importNames: ['homedir'], ... }] }] } }

// Config object B (FSD rules for shared layer)
{ files: ['apps/client/src/layers/shared/**/*.ts'], rules: { 'no-restricted-imports': ['error', { patterns: [...FSD rules...] }] } }
```

If a file in `apps/client/src/layers/shared/` matches both A and B, and B is defined later, the `os.homedir()` ban from A is silently dropped for those files.

**The fix:** Do not put `no-restricted-imports` in the shared base config at all. Instead, each package's local `eslint.config.js` defines a single `no-restricted-imports` entry with ALL restrictions for that file glob combined. Because per-package configs are separate files (not one merged array), there is no conflict — the server package has its own `no-restricted-imports` for `os.homedir()`, and the client package has its own FSD rules, and they never compete.

**This is actually an argument FOR per-package configs.** The current root config already has this latent problem (the FSD rules for `apps/client/src/layers/shared/**` would silently drop the `os.homedir()` ban for any file matching that glob if both configs were evaluated against the same file, but because client files don't import from `os`, it hasn't surfaced as a bug).

**Within a single `no-restricted-imports` declaration:** Multiple entries with the same `name` in the `paths` array DO all apply since ESLint v9.0.0. This only applies to the internal entries within one rule call — not across separate config objects.

### Turborepo Task Configuration

Current `turbo.json`:

```json
"lint": { "dependsOn": ["^build"], "cache": true }
```

Recommended update for per-package lint:

```json
"lint": {
  "dependsOn": ["^lint"],
  "cache": true,
  "inputs": ["src/**", "eslint.config.*", "../../packages/eslint-config/**"]
}
```

The `"dependsOn": ["^lint"]` (not `"^build"`) ensures that when `@dorkos/eslint-config` changes, all packages that depend on it (via their workspace dep) automatically have their lint caches invalidated. The `@dorkos/eslint-config` package does not need its own `lint` script — the dependency edge is what matters.

The optional `inputs` array makes the cache key explicit: a change to any source file or any eslint config (including shared) invalidates the cache for that package.

### Approach Comparison

#### Approach A: Per-Package Configs with Shared Config Package (RECOMMENDED)

```
packages/eslint-config/    ← new package
  base.js
  react.js
  node.js
  test.js
  package.json

apps/client/eslint.config.js    ← new, ~40 lines (FSD rules + react config)
apps/server/eslint.config.js    ← new, ~25 lines (server rules + node config)
apps/site/eslint.config.js      ← new, ~15 lines (next.js or react config)
apps/obsidian-plugin/eslint.config.js  ← new, ~15 lines (react config)
apps/e2e/eslint.config.js       ← new, ~10 lines (playwright env + base config)
packages/shared/eslint.config.js      ← new, ~10 lines (base config)
packages/relay/eslint.config.js       ← new, ~10 lines (base config)
packages/mesh/eslint.config.js        ← new, ~10 lines (base config)
packages/cli/eslint.config.js         ← new, ~10 lines (node config)
packages/db/eslint.config.js          ← new, ~10 lines (base config)
# root eslint.config.js deleted or kept as thin orchestrator
```

**Pros:**

- Consistent with Turborepo's official recommendation
- Consistent with the existing `@dorkos/typescript-config` pattern
- Package-specific rules live with the package (FSD rules in client, server rules in server)
- No glob-path confusion — paths are relative to each package root
- `no-restricted-imports` conflicts impossible (each package's config is a separate array)
- Turbo lint runs per-package; cache invalidation is granular (change in server code doesn't re-lint client)
- Plugin dependencies centralized in one place; no version drift
- ESLint can run standalone inside each package without knowing the monorepo root

**Cons:**

- Initial setup: ~8-10 new `eslint.config.js` files to create
- The shared config package needs its own `package.json` and proper exports
- Slightly more files to navigate (offset by the fact that each file is small and focused)
- Package `devDependencies` need to be updated to add `@dorkos/eslint-config: "workspace:*"`

**Complexity:** Medium-low. One-time setup cost, then straightforward to maintain.
**Maintenance:** Low. Rules live next to the code they guard; the shared package enforces consistency.

#### Approach B: Split-by-Concern in Root Config

Keep one root `eslint.config.js` but extract rule groups into separate files:

```
eslint/
  base.js
  react.js
  fsd.js
  server.js
  test.js
eslint.config.js   ← imports and composes everything with file globs
```

**Pros:**

- No new package, no workspace dep changes
- Single `eslint` run from root; simple mental model
- Works today without any migration

**Cons:**

- File glob explosion: rules for `apps/client/src/layers/shared/**` alongside rules for `apps/server/src/**` in the same array — hard to read, easy to accidentally overlap
- The `no-restricted-imports` overwrite problem is fully present and gets worse as more rules are added
- Turborepo cache is per-root-run, not per-package — a client change re-lints the entire monorepo
- No clean way to add package-specific rules later without the root config growing again
- Less isolation: a syntax error in server rules can block client linting

**Complexity:** Low to set up (just file splits), high to maintain long-term.
**Maintenance:** Medium-high. Root config continues to grow; requires careful glob management.

#### Approach C: Hybrid — Shared Config Package with Root Orchestrator

Shared config package exists, but root `eslint.config.js` composes everything for a single top-level run:

```js
// root eslint.config.js
import reactConfig from '@dorkos/eslint-config/react';
import nodeConfig from '@dorkos/eslint-config/node';

export default [
  ...reactConfig.map((c) => ({
    ...c,
    files: c.files?.map((f) => `apps/client/${f}`) ?? ['apps/client/**'],
  })),
  ...nodeConfig.map((c) => ({
    ...c,
    files: c.files?.map((f) => `apps/server/${f}`) ?? ['apps/server/**'],
  })),
  // FSD rules targeting apps/client/src/layers/...
  // server rules targeting apps/server/src/...
];
```

**Pros:**

- Shared config package is reusable and version-controlled
- Single `eslint` invocation from root (easier for some editors/scripts)

**Cons:**

- Path rewriting is error-prone and fragile (requires manually prefixing all glob paths)
- `eslint-flat-config-utils` library exists to help with this but adds another dependency
- No real benefit over Approach A — same number of files/rules, more complexity
- `no-restricted-imports` conflict problem is still present (multiple config objects in the same array)
- Not the pattern Turborepo recommends

**Complexity:** High. Path rewriting is where bugs hide.
**Maintenance:** High. Any structural change to packages requires root config updates.

### Handling the `no-restricted-imports` Problem in Approach A

The FSD rules in `apps/client/eslint.config.js` target three different file globs (shared, entities, features), each with a separate config object and their own `no-restricted-imports` entry. Within that package, these three config objects target **non-overlapping** file globs (a file is in either `shared/` or `entities/` or `features/`, not multiple), so there is no conflict.

The server's `os.homedir()` ban lives in `apps/server/eslint.config.js` targeting `src/**/*.ts`. The base config from `@dorkos/eslint-config/node` should NOT include `no-restricted-imports` — leave that for the server package to define locally. This eliminates the conflict entirely.

**Summary rule:** Any `no-restricted-imports` that encodes a project-specific architectural constraint should live in the consuming package's `eslint.config.js`, not in the shared config package.

The shared config package should only include `no-restricted-imports` entries that are universal across all packages (e.g., banning `lodash` across the entire codebase if that were a policy). For DorkOS, there are no such universal import bans — the server and client bans are package-specific.

### Process.env Discipline Rule

The `no-restricted-syntax` rule banning raw `process.env` access is cross-cutting. It belongs in `base.js` in the shared config. The carve-out files (`env.ts`, `*.config.ts`, `__tests__/**`, etc.) need to be listed relative to each package's root in that package's local `eslint.config.js`. The shared config exports the base rule; each package adds the carve-outs appropriate for its structure.

### Per-Package `package.json` Updates

Each app/package that gets its own `eslint.config.js` needs:

```json
{
  "devDependencies": {
    "@dorkos/eslint-config": "workspace:*",
    "eslint": "^9"
  },
  "scripts": {
    "lint": "eslint ."
  }
}
```

Currently, ESLint is likely in the root `devDependencies` only. It needs to be in each package's `devDependencies` (or at minimum accessible via workspace hoisting, but explicit is better for Turbo cache correctness).

## Sources & Evidence

- Official Turborepo ESLint guide (2025): recommends `packages/eslint-config/` with modular exports and `"dependsOn": ["^lint"]` — [ESLint — Turborepo](https://turborepo.dev/docs/guides/tools/eslint)
- Turborepo guide specifies: "The `"dependsOn": ["^lint"]` pattern ensures that modifications to the shared configuration package invalidate dependent packages' lint caches"
- ESLint shareable configs: "Shareable configs are simply npm packages that export a configuration object or array" — [Share Configurations — ESLint](https://eslint.org/docs/latest/extend/shareable-configs)
- ESLint flat config evolution, `defineConfig()` and `extends` introduced 2025: [Evolving flat config with extends](https://eslint.org/blog/2025/03/flat-config-extends-define-config-global-ignores/)
- ESLint configure rules: "When more than one configuration object specifies the same rule, the rule configuration is merged with the later object taking precedence over any previous objects" — [Configure Rules — ESLint](https://eslint.org/docs/latest/use/configure/rules)
- Confirmed `no-restricted-imports` within-rule fix in v9: multiple `paths` entries with same `name` now all apply — [ESLint commit 57089cb](https://github.com/eslint/eslint/commit/57089cb5166acf8b8bdba8a8dbeb0a129f841478)
- Per-package structure tutorial: [How to Create an ESLint Config Package in Turborepo — DEV](https://dev.to/saiful7778/how-to-create-an-eslint-config-package-in-turborepo-1ag2)
- Turborepo cache invalidation issue when shared config changes: [Issue #4041](https://github.com/vercel/turborepo/issues/4041) — solved by `"dependsOn": ["^lint"]`
- `eslint-plugin-boundaries` for declarative boundary enforcement: [GitHub](https://github.com/javierbrea/eslint-plugin-boundaries)

## Research Gaps & Limitations

- Did not verify exact ESLint version in the current `package.json` — need to confirm it supports `defineConfig()` (requires ESLint 9.x, which the codebase already uses per CLAUDE.md)
- The `eslint-flat-config-utils` package (for path rewriting in Approach C) was not deeply investigated since Approach A makes it unnecessary
- Did not verify whether Turborepo's task-level `inputs` array with `../../packages/eslint-config/**` globs works correctly for nested workspace packages — this is an optimization and not strictly required for correctness

## Contradictions & Disputes

- The ESLint docs say "the later object takes precedence" for rule merging, but there is a subtle distinction: within a single rule declaration, the v9 fix allows multiple `paths` entries with the same `name` to all apply. These are different concepts and both are true. The overwrite behavior is at the **config object level** (one config object's `no-restricted-imports` replaces another's), not at the **entry level within a single rule call**.
- Some community sources describe Approach C (root orchestrator) as viable, but Turborepo's own docs clearly favor Approach A. The root orchestrator's path-rewriting requirement is a significant practical downside that community tutorials sometimes understate.

## Recommendation

**Use Approach A: Per-Package Configs with Shared Config Package.**

Rationale:

1. It is what Turborepo officially recommends, and DorkOS already follows this pattern for TypeScript configs
2. It eliminates the `no-restricted-imports` overwrite problem structurally — no rules from different packages can conflict because they live in separate config arrays
3. Turborepo lint caching becomes properly granular — changing client code only re-lints the client
4. The one-time setup cost (creating the `@dorkos/eslint-config` package + 8-10 thin `eslint.config.js` files) is modest and pays off immediately in maintainability
5. Each package's ESLint config is readable in isolation — a contributor working on `apps/server` doesn't need to understand the FSD rules for `apps/client`

**Migration Path:**

1. Create `packages/eslint-config/` with `base.js`, `react.js`, `node.js`, `test.js`
2. Move all ESLint plugin deps from root `devDependencies` into `packages/eslint-config/package.json`
3. Add `"@dorkos/eslint-config": "workspace:*"` to each app/package `devDependencies`
4. Create `eslint.config.js` in each app/package, importing from `@dorkos/eslint-config`
5. Add package-specific rules (FSD in client, server bans in server) to each local config
6. Update `turbo.json` lint task to `"dependsOn": ["^lint"]`
7. Delete or thin out the root `eslint.config.js` (it can remain as a fallback for root-level files like `turbo.json` linting or be deleted if Turbo always runs per-package)
8. Add `"scripts": { "lint": "eslint ." }` to each package that doesn't already have it

## Search Methodology

- Searches performed: 14
- Most productive search terms: "ESLint 9 flat config shared config package monorepo", "Turborepo ESLint flat config per-package", "no-restricted-imports last wins overwrite merge flat config", "eslint-plugin-boundaries alternative"
- Primary sources: eslint.org docs, turborepo.dev docs, GitHub issues/discussions, DEV Community articles
