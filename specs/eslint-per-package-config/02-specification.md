# ESLint Per-Package Config Refactor

**Status:** Draft
**Authors:** Claude Code, 2026-03-06
**Spec Number:** 98
**Ideation:** `specs/eslint-per-package-config/01-ideation.md`
**Research:** `research/20260306_eslint_per_package_config.md`

---

## Overview

Refactor the monolithic root `eslint.config.js` (276 lines, 11 config blocks) into per-package ESLint configs with a shared `@dorkos/eslint-config` internal package, mirroring the existing `@dorkos/typescript-config` pattern. Add an SDK confinement lint rule that enforces `@anthropic-ai/claude-agent-sdk` imports are confined to `services/runtimes/claude-code/`, supporting ADR-0085 (AgentRuntime interface).

## Background / Problem Statement

### The `no-restricted-imports` Overwrite Problem

In ESLint 9 flat config, when two config objects both match the same files and both define `no-restricted-imports`, the later one **completely replaces** the earlier one's `patterns`/`paths` arrays. The current root config has this latent problem: FSD rules for `apps/client/src/layers/shared/**` would silently drop the `os.homedir()` ban if they overlapped. It hasn't surfaced because client files don't import from `os`, but as rules grow this will cause silent rule loss.

### Monorepo Lint Granularity

Turborepo's lint task currently runs ESLint from root context. A change to client code re-lints the entire monorepo. Per-package configs enable granular cache invalidation — changing client code only re-lints client.

### SDK Boundary Enforcement

ADR-0085 encapsulates the Claude Agent SDK inside `ClaudeCodeRuntime`. A lint rule is needed to prevent SDK imports from leaking outside `services/runtimes/claude-code/`, ensuring the `AgentRuntime` interface remains the only abstraction layer.

## Goals

- Decompose 276-line root config into focused, per-package configs (~10-40 lines each)
- Create `@dorkos/eslint-config` shared package with composable presets (`base`, `react`, `node`, `test`)
- Eliminate the `no-restricted-imports` overwrite problem structurally
- Enable granular Turborepo lint cache invalidation per-package
- Add SDK confinement rule preventing `@anthropic-ai/claude-agent-sdk` imports outside `runtimes/claude-code/`
- Move `sdk-utils.ts` into `runtimes/claude-code/` to keep SDK boundary clean
- Add `lint` scripts to 5 packages that currently lack them (cli, db, test-utils, icons, e2e)
- Maintain behavioral equivalence — zero new lint errors from migration

## Non-Goals

- Adding new lint rules beyond SDK confinement and the structural refactor
- Migrating to a different linter or changing Prettier config
- Implementing the agent-runtime-abstraction itself (spec #97 / ADR-0085)
- Adding `eslint-plugin-boundaries` (existing `no-restricted-imports` is sufficient for our layer count)
- Refactoring `apps/site/eslint.config.mjs` — it stays standalone with `eslint-config-next`

## Technical Dependencies

| Dependency                  | Version                       | Purpose                       |
| --------------------------- | ----------------------------- | ----------------------------- |
| `eslint`                    | `^9.39.2` (already installed) | Core linter                   |
| `@eslint/js`                | `^9.39.2` (already installed) | JS recommended rules          |
| `typescript-eslint`         | `^8.55.0` (already installed) | TS rules (syntax-only)        |
| `eslint-plugin-jsdoc`       | `^62.5.5` (already installed) | TSDoc enforcement             |
| `eslint-plugin-react`       | `^7.37.5` (already installed) | React rules                   |
| `eslint-plugin-react-hooks` | `^7.0.1` (already installed)  | Hooks + Compiler rules        |
| `eslint-plugin-jsx-a11y`    | `^6.10.2` (already installed) | Accessibility                 |
| `eslint-config-prettier`    | `^10.1.8` (already installed) | Prettier compat (always last) |
| `eslint/config`             | Built into ESLint 9.15+       | `defineConfig()` helper       |

No new dependencies are introduced. All plugins move from root `devDependencies` to `@dorkos/eslint-config`'s `dependencies`.

## Detailed Design

### Architecture

```
BEFORE:                              AFTER:

eslint.config.js (276 lines)         packages/eslint-config/
├── global ignores                   ├── base.js  (shared rules)
├── base JS                          ├── react.js (extends base)
├── TS recommended                   ├── node.js  (extends base)
├── general overrides                ├── test.js  (overlay)
├── TSDoc enforcement                └── package.json
├── React rules
├── FSD boundary (×3)                eslint.config.js (root, ~15 lines)
├── process.env discipline           apps/client/eslint.config.js (~45 lines)
├── process.env carve-outs           apps/server/eslint.config.js (~55 lines)
├── os.homedir ban                   apps/obsidian-plugin/eslint.config.js (~15 lines)
├── test overrides                   apps/e2e/eslint.config.js (~10 lines)
└── prettier                         packages/shared/eslint.config.js (~10 lines)
                                     packages/relay/eslint.config.js (~10 lines)
                                     packages/mesh/eslint.config.js (~10 lines)
                                     packages/cli/eslint.config.js (~20 lines)
                                     packages/db/eslint.config.js (~10 lines)
                                     packages/test-utils/eslint.config.js (~10 lines)
                                     packages/icons/eslint.config.js (~10 lines)
```

### Shared Config Package: `@dorkos/eslint-config`

Mirrors the `@dorkos/typescript-config` pattern (private workspace package with named exports).

**`packages/eslint-config/package.json`:**

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
    "@eslint/js": "^9.39.2",
    "typescript-eslint": "^8.55.0",
    "eslint-plugin-jsdoc": "^62.5.5",
    "eslint-plugin-react": "^7.37.5",
    "eslint-plugin-react-hooks": "^7.0.1",
    "eslint-plugin-jsx-a11y": "^6.10.2",
    "eslint-config-prettier": "^10.1.8"
  }
}
```

All ESLint plugin dependencies live here. Consuming packages add only `"@dorkos/eslint-config": "workspace:*"` and `"eslint": "^9"` to their `devDependencies`.

**`packages/eslint-config/base.js`:**

Contains the universal rules applied to all packages:

- `@eslint/js` recommended rules
- `typescript-eslint` recommended (syntax-only, no type-checking)
- General TypeScript overrides (unused-vars pattern, no-explicit-any as warn, etc.)
- TSDoc/JSDoc enforcement (warn-first via `eslint-plugin-jsdoc`)
- `process.env` discipline rule (`no-restricted-syntax` banning raw `process.env`)
- `eslint-config-prettier` as the final config object

**Critical design constraint:** `base.js` does NOT include any `no-restricted-imports` rules. All `no-restricted-imports` are package-local to avoid the flat config overwrite problem.

The `process.env` carve-outs are NOT in `base.js` — each package adds its own carve-outs for files that legitimately access `process.env`, relative to its own root.

**`packages/eslint-config/react.js`:**

Extends `base.js` and adds:

- `eslint-plugin-react` (flat recommended, `react-in-jsx-scope` off, `prop-types` off)
- `eslint-plugin-react-hooks` (recommended-latest + React Compiler rules as warnings)
- `eslint-plugin-jsx-a11y` (recommended, with accessibility warnings)
- React settings (`version: 'detect'`)

**`packages/eslint-config/node.js`:**

Extends `base.js`. Currently identical to base but provides semantic separation for Node.js server/CLI packages. Reserved for future Node-specific rules (e.g., `no-process-exit`, buffer safety).

**`packages/eslint-config/test.js`:**

An overlay config (not standalone — applied on top of any other config) that relaxes rules for test files:

- `@typescript-eslint/no-explicit-any`: off
- `@typescript-eslint/no-non-null-assertion`: off
- `@typescript-eslint/no-unsafe-*` family: off
- `require-yield`: off
- `react/display-name`: off
- `jsdoc/require-jsdoc`: off
- `jsdoc/require-description`: off

Applied via `files: ['**/__tests__/**/*.{ts,tsx}', '**/*.test.{ts,tsx}', '**/*.spec.{ts,tsx}']`.

### Per-Package Config Patterns

Each per-package `eslint.config.js` uses `defineConfig()` from `eslint/config` for auto-flattening, type hints, and the `extends` scoping feature.

#### `apps/client/eslint.config.js` (~45 lines)

```javascript
import { defineConfig } from 'eslint/config';
import reactConfig from '@dorkos/eslint-config/react';
import testConfig from '@dorkos/eslint-config/test';

export default defineConfig([
  { ignores: ['dist/**', '.turbo/**'] },
  ...reactConfig,

  // process.env carve-outs (client-specific)
  {
    files: ['**/env.ts', '**/*.config.ts', '**/__tests__/**', '**/*.test.ts'],
    rules: { 'no-restricted-syntax': 'off' },
  },

  // FSD Layer Enforcement: shared/ cannot import higher layers
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

  // FSD Layer Enforcement: entities/ cannot import features or widgets
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

  // FSD Layer Enforcement: features/ cannot import widgets
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

  ...testConfig,
]);
```

#### `apps/server/eslint.config.js` (~55 lines)

```javascript
import { defineConfig } from 'eslint/config';
import nodeConfig from '@dorkos/eslint-config/node';
import testConfig from '@dorkos/eslint-config/test';

export default defineConfig([
  { ignores: ['dist/**', 'dist-server/**', '.turbo/**'] },
  ...nodeConfig,

  // process.env carve-outs (server-specific)
  {
    files: [
      '**/env.ts',
      '**/*.config.ts',
      '**/__tests__/**',
      '**/*.test.ts',
      'src/lib/dork-home.ts',
      'src/lib/logger.ts',
      'src/routes/tunnel.ts',
    ],
    rules: { 'no-restricted-syntax': 'off' },
  },

  // SDK confinement + os.homedir() ban (combined to avoid overwrite)
  {
    files: ['src/**/*.ts'],
    ignores: [
      'src/services/runtimes/claude-code/**',
      'src/lib/dork-home.ts',
      'src/**/__tests__/**',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@anthropic-ai/claude-agent-sdk', '@anthropic-ai/claude-agent-sdk/*'],
              message:
                'Claude Agent SDK imports are confined to services/runtimes/claude-code/. Import from the AgentRuntime interface instead.',
            },
          ],
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
]);
```

**Critical:** The SDK confinement and `os.homedir()` ban are combined into a single `no-restricted-imports` config object to avoid the flat config overwrite problem. Both target `src/**/*.ts` with the same ignores.

#### `apps/obsidian-plugin/eslint.config.js` (~15 lines)

```javascript
import { defineConfig } from 'eslint/config';
import reactConfig from '@dorkos/eslint-config/react';
import testConfig from '@dorkos/eslint-config/test';

export default defineConfig([
  { ignores: ['dist/**', 'dist-obsidian/**', '.turbo/**', 'build-plugins/**'] },
  ...reactConfig,
  ...testConfig,
]);
```

#### `apps/e2e/eslint.config.js` (~10 lines)

```javascript
import { defineConfig } from 'eslint/config';
import baseConfig from '@dorkos/eslint-config/base';

export default defineConfig([
  { ignores: ['.turbo/**', 'test-results/**', 'playwright-report/**'] },
  ...baseConfig,
]);
```

#### Simple package configs (shared, relay, mesh, db, icons) (~10 lines each)

```javascript
import { defineConfig } from 'eslint/config';
import baseConfig from '@dorkos/eslint-config/base';
import testConfig from '@dorkos/eslint-config/test';

export default defineConfig([{ ignores: ['dist/**', '.turbo/**'] }, ...baseConfig, ...testConfig]);
```

Packages without tests (icons) omit `testConfig`.

#### `packages/cli/eslint.config.js` (~20 lines)

```javascript
import { defineConfig } from 'eslint/config';
import nodeConfig from '@dorkos/eslint-config/node';

export default defineConfig([
  { ignores: ['dist/**', '.turbo/**'] },
  ...nodeConfig,

  // process.env carve-outs (CLI-specific)
  {
    files: ['src/cli.ts', 'src/config-commands.ts', '**/env.ts', '**/*.config.ts'],
    rules: { 'no-restricted-syntax': 'off' },
  },
]);
```

#### `packages/test-utils/eslint.config.js` (~10 lines)

```javascript
import { defineConfig } from 'eslint/config';
import baseConfig from '@dorkos/eslint-config/base';
import testConfig from '@dorkos/eslint-config/test';

export default defineConfig([
  { ignores: ['dist/**', '.turbo/**'] },
  ...baseConfig,
  // test-utils is entirely test infrastructure — relax rules
  ...testConfig,
]);
```

#### Root `eslint.config.js` (thinned, ~15 lines)

```javascript
import { defineConfig } from 'eslint/config';
import baseConfig from '@dorkos/eslint-config/base';

export default defineConfig([
  {
    ignores: ['apps/**', 'packages/**', 'node_modules/**', '.scratch/**', 'coverage/**'],
  },
  ...baseConfig,
]);
```

The root config only lints root-level files (e.g., `vitest.workspace.ts`, stray scripts). It ignores all apps/packages since each has its own config.

### `sdk-utils.ts` Move

Move `apps/server/src/lib/sdk-utils.ts` to `apps/server/src/services/runtimes/claude-code/sdk-utils.ts`.

**Import path updates (2 files):**

| File                                                                   | Old Import                    | New Import                                        |
| ---------------------------------------------------------------------- | ----------------------------- | ------------------------------------------------- |
| `apps/server/src/routes/config.ts`                                     | `'../lib/sdk-utils.js'`       | `'../services/runtimes/claude-code/sdk-utils.js'` |
| `apps/server/src/services/runtimes/claude-code/claude-code-runtime.ts` | `'../../../lib/sdk-utils.js'` | `'./sdk-utils.js'`                                |

This eliminates the need for any carve-out in the SDK confinement rule — the only file importing `@anthropic-ai/claude-agent-sdk` is already inside `runtimes/claude-code/`.

### Turborepo Configuration

**`turbo.json` lint task update:**

```json
"lint": {
  "dependsOn": ["^lint"],
  "cache": true
}
```

Changed from `"^build"` to `"^lint"`. This ensures that when `@dorkos/eslint-config` changes, all dependent packages' lint caches are invalidated. The `@dorkos/eslint-config` package itself does not need a `lint` script — the workspace dependency edge is sufficient for cache invalidation.

### `package.json` Updates

**Root `package.json`:** Remove all ESLint-related dependencies from `devDependencies`:

- `@eslint/js`
- `eslint-config-prettier`
- `eslint-plugin-jsdoc`
- `eslint-plugin-jsx-a11y`
- `eslint-plugin-react`
- `eslint-plugin-react-hooks`
- `typescript-eslint`

Keep `eslint` in root `devDependencies` (needed for root-level linting).

**Each consuming package `package.json`:** Add to `devDependencies`:

```json
"@dorkos/eslint-config": "workspace:*"
```

(`eslint` is hoisted from root — no need to add per-package unless Turbo cache correctness requires it. If cache issues arise, add `"eslint": "^9"` per-package.)

**Packages missing `lint` script:** Add `"lint": "eslint ."` to:

- `packages/cli/package.json`
- `packages/db/package.json`
- `packages/test-utils/package.json`
- `packages/icons/package.json` (if it has any `.ts` files to lint; otherwise skip)
- `apps/e2e/package.json`

### File Inventory

**New files (17):**

| File                                                         | Lines (est.) | Purpose                             |
| ------------------------------------------------------------ | ------------ | ----------------------------------- |
| `packages/eslint-config/package.json`                        | 20           | Shared config package manifest      |
| `packages/eslint-config/base.js`                             | 80           | Base JS/TS/TSDoc/env/prettier rules |
| `packages/eslint-config/react.js`                            | 50           | React/hooks/a11y extension          |
| `packages/eslint-config/node.js`                             | 10           | Node.js extension                   |
| `packages/eslint-config/test.js`                             | 25           | Test file relaxations overlay       |
| `apps/client/eslint.config.js`                               | 45           | Client config (FSD rules)           |
| `apps/server/eslint.config.js`                               | 55           | Server config (SDK+homedir ban)     |
| `apps/obsidian-plugin/eslint.config.js`                      | 15           | Obsidian plugin config              |
| `apps/e2e/eslint.config.js`                                  | 10           | E2E test config                     |
| `packages/shared/eslint.config.js`                           | 10           | Shared package config               |
| `packages/relay/eslint.config.js`                            | 10           | Relay package config                |
| `packages/mesh/eslint.config.js`                             | 10           | Mesh package config                 |
| `packages/cli/eslint.config.js`                              | 20           | CLI package config                  |
| `packages/db/eslint.config.js`                               | 10           | DB package config                   |
| `packages/test-utils/eslint.config.js`                       | 10           | Test utils config                   |
| `packages/icons/eslint.config.js`                            | 10           | Icons package config                |
| `apps/server/src/services/runtimes/claude-code/sdk-utils.ts` | 44           | Moved from `lib/sdk-utils.ts`       |

**Modified files (15):**

| File                                                                   | Change                             |
| ---------------------------------------------------------------------- | ---------------------------------- |
| `eslint.config.js` (root)                                              | Thinned to ~15 lines               |
| `turbo.json`                                                           | `lint.dependsOn` → `["^lint"]`     |
| `package.json` (root)                                                  | Remove ESLint plugin devDeps       |
| `apps/client/package.json`                                             | Add `@dorkos/eslint-config` devDep |
| `apps/server/package.json`                                             | Add `@dorkos/eslint-config` devDep |
| `apps/obsidian-plugin/package.json`                                    | Add `@dorkos/eslint-config` devDep |
| `apps/e2e/package.json`                                                | Add devDep + `lint` script         |
| `packages/shared/package.json`                                         | Add `@dorkos/eslint-config` devDep |
| `packages/relay/package.json`                                          | Add `@dorkos/eslint-config` devDep |
| `packages/mesh/package.json`                                           | Add `@dorkos/eslint-config` devDep |
| `packages/cli/package.json`                                            | Add devDep + `lint` script         |
| `packages/db/package.json`                                             | Add devDep + `lint` script         |
| `packages/test-utils/package.json`                                     | Add devDep + `lint` script         |
| `apps/server/src/routes/config.ts`                                     | Update sdk-utils import path       |
| `apps/server/src/services/runtimes/claude-code/claude-code-runtime.ts` | Update sdk-utils import path       |

**Deleted files (2):**

| File                                                   | Reason                           |
| ------------------------------------------------------ | -------------------------------- |
| `apps/server/src/lib/sdk-utils.ts`                     | Moved to `runtimes/claude-code/` |
| (root `eslint.config.js` is **replaced**, not deleted) |                                  |

## User Experience

This is a developer-facing infrastructure change. No end-user impact.

**Developer impact:**

- Each package now has a self-contained `eslint.config.js` — readable in isolation
- IDE ESLint integration works per-package (no need to understand root context)
- `pnpm lint` still works from root (Turborepo orchestrates)
- `eslint .` works inside any package directory
- Package-specific rules are co-located with the code they guard

## Testing Strategy

### Behavioral Equivalence Verification

The primary test is behavioral equivalence — the migration must not change which files are linted, which rules apply, or which errors/warnings are reported.

**Verification approach:**

1. **Before migration:** Run `pnpm lint 2>&1` from root and capture the output (warnings + errors)
2. **After migration:** Run `pnpm lint 2>&1` from root and compare output
3. **Expected:** Identical warnings/errors on the same files. No new errors. No lost warnings.

This is a manual verification step during implementation — no automated test file needed.

### SDK Confinement Rule Verification

Create a temporary test file (not committed) that imports from the SDK outside `runtimes/claude-code/` to verify the rule catches it:

```typescript
// Temporary file: apps/server/src/routes/__test-sdk-import.ts
import { query } from '@anthropic-ai/claude-agent-sdk'; // Should error
```

Run `eslint apps/server/src/routes/__test-sdk-import.ts` and verify the error message matches the confinement rule. Delete the file after verification.

### Per-Package Isolation Verification

Verify each package can lint independently:

```bash
cd apps/client && eslint .    # Should work standalone
cd apps/server && eslint .    # Should work standalone
cd packages/shared && eslint . # Should work standalone
# ... repeat for all packages
```

### FSD Rule Preservation

Verify FSD boundary enforcement still works by checking existing violations (if any) or by creating a temporary import violation:

```typescript
// Temporary: apps/client/src/layers/shared/test-fsd.ts
import { ChatPanel } from '@/layers/features/chat'; // Should error
```

### Turbo Cache Invalidation

1. Run `pnpm lint` twice — second run should be cached (`>>> FULL TURBO`)
2. Touch a file in `packages/eslint-config/base.js`
3. Run `pnpm lint` — all packages should re-lint (cache invalidated)
4. Touch a file in `apps/client/src/` only
5. Run `pnpm lint` — only `@dorkos/client` should re-lint; others remain cached

## Performance Considerations

**Positive impact:**

- Turborepo lint cache becomes granular per-package — changing one package only re-lints that package
- Parallel lint execution: Turborepo can lint independent packages concurrently (already supported)

**Neutral:**

- Total cold-lint time should be roughly equivalent (same number of files, same rules)
- `pnpm install` adds one internal workspace dependency per package (negligible)

## Security Considerations

No security impact. This is build tooling only — no runtime code changes except the `sdk-utils.ts` move (which preserves identical behavior).

The SDK confinement rule adds a security-adjacent benefit: it prevents accidental coupling to the Claude Agent SDK outside the designated runtime implementation, supporting the principle of least privilege in module dependencies.

## Documentation

**Updates needed:**

| Document                       | Change                                                                                                          |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `CLAUDE.md`                    | Update "Code Quality" section to describe per-package ESLint config pattern and `@dorkos/eslint-config` package |
| `contributing/architecture.md` | Add section on ESLint architecture (shared config package + per-package pattern)                                |

No new documentation files needed.

## Implementation Phases

This is a single-phase, atomic migration (one PR). The implementation order within the PR matters for correctness:

### Step 1: Create Shared Config Package

1. Create `packages/eslint-config/` directory
2. Write `package.json` with exports and dependencies
3. Write `base.js` — extract base/TS/TSDoc/env-discipline/prettier rules from root config
4. Write `react.js` — extract React/hooks/a11y rules from root config
5. Write `node.js` — create Node.js preset (extends base)
6. Write `test.js` — extract test file relaxations from root config
7. Run `pnpm install` to register the new workspace package

### Step 2: Create Per-Package Configs

For each package (in any order):

1. Create `eslint.config.js` importing from `@dorkos/eslint-config`
2. Add package-local rules (FSD for client, SDK+homedir for server, env carve-outs)
3. Add `"@dorkos/eslint-config": "workspace:*"` to package's `devDependencies`
4. Add `"lint": "eslint ."` script if missing

### Step 3: Move `sdk-utils.ts`

1. Move `apps/server/src/lib/sdk-utils.ts` to `apps/server/src/services/runtimes/claude-code/sdk-utils.ts`
2. Update import in `apps/server/src/routes/config.ts`
3. Update import in `apps/server/src/services/runtimes/claude-code/claude-code-runtime.ts`

### Step 4: Update Build Configuration

1. Update `turbo.json` lint task: `"dependsOn": ["^lint"]`
2. Remove ESLint plugin dependencies from root `package.json` `devDependencies`
3. Run `pnpm install` to update lockfile

### Step 5: Thin Root Config

1. Replace root `eslint.config.js` with the thinned version (ignores apps/packages, lints root files only)

### Step 6: Verify

1. Run `pnpm install` to ensure all workspace dependencies resolve
2. Run `pnpm lint` — must pass with no new errors
3. Verify SDK confinement rule with temporary test file
4. Verify FSD rules still enforced in client
5. Verify Turbo cache granularity

## Open Questions

No open questions remain — all decisions were made during ideation and the interactive decision-gathering phase.

## Related ADRs

| ADR      | Title                                           | Relevance                                                                                    |
| -------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------- |
| ADR-0002 | Adopt Feature-Sliced Design                     | FSD boundary enforcement rules move to `apps/client/eslint.config.js`                        |
| ADR-0042 | Manual Zod Env Validation, Not T3 Env           | `process.env` discipline rule and carve-out pattern stays, just moves to per-package configs |
| ADR-0085 | AgentRuntime Interface as Universal Abstraction | SDK confinement rule enforces the boundary that ADR-0085 establishes architecturally         |

## References

- **Ideation:** `specs/eslint-per-package-config/01-ideation.md`
- **Research:** `research/20260306_eslint_per_package_config.md` (22 sources)
- **Turborepo ESLint guide:** https://turborepo.dev/docs/guides/tools/eslint
- **ESLint flat config `defineConfig()`:** https://eslint.org/blog/2025/03/flat-config-extends-define-config-global-ignores/
- **ESLint shareable configs:** https://eslint.org/docs/latest/extend/shareable-configs
- **Existing pattern:** `packages/typescript-config/` (3-file shared config package)
- **Root config being decomposed:** `eslint.config.js` (276 lines)
