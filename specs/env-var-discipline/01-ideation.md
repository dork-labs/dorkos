---
slug: env-var-discipline
number: 64
created: 2026-02-25
status: ideation
---

# Disciplined Environment Variable Handling

**Slug:** env-var-discipline
**Author:** Claude Code
**Date:** 2026-02-25
**Branch:** preflight/env-var-discipline
**Related:** N/A

---

## 1) Intent & Assumptions

- **Task brief:** Replace all direct `process.env` access scattered across 18+ files with validated, typed env modules. Each app/package exports an `env.ts` that runs the full env var set through a Zod schema at startup — failing fast with human-readable errors rather than silently producing `undefined` or `NaN` at runtime. ESLint enforces the pattern. `.env.example` and documentation are brought up to date.
- **Assumptions:**
  - Zod is already a dependency of every package that needs env validation (confirmed: `packages/shared` and `apps/server` both use it)
  - T3 Env is **not** adopted — it has open bugs with `skipValidation` breaking Zod defaults (#155, #266, #323) and is ESM-only (conflicts with CLI's esbuild CJS output)
  - The CLI's imperative `process.env` mutations (setting up the server's environment before it loads) are legitimate and intentional — they are not replaced, only annotated
  - `*.config.ts` files (`vite.config.ts`, `playwright.config.ts`) are excluded from the ESLint rule since they run in Node.js before the bundler and cannot import from `src/env.ts`
- **Out of scope:**
  - Secrets management beyond `.env.example` annotations (vault, AWS SSM, etc.)
  - The Obsidian plugin — it delegates env-dependent behavior to the server via Transport and has no direct `process.env` access
  - Adding new env vars beyond those already used (this spec audits and consolidates; new vars come later)
  - `apps/web` Next.js-specific `NEXT_PUBLIC_*` validation at build time (out of scope for now; can add `@t3-oss/env-nextjs` later)

---

## 2) Pre-reading Log

- `apps/server/src/index.ts`: 19 direct `process.env` reads — the single highest-impact file; accesses DORKOS_PORT, all feature flags, tunnel config
- `packages/cli/src/cli.ts`: 20+ env var reads AND imperative assignments — unique bootstrap role, gets partial treatment
- `.env.example`: 11 vars documented; 8+ vars used in code but missing from the file
- `turbo.json`: `globalPassThroughEnv` has 14 vars but is missing ROADMAP_PORT, ROADMAP_PROJECT_ROOT, CLIENT_DIST_PATH, DORKOS_VERSION
- `packages/shared/src/config-schema.ts`: Existing Zod validation pattern for the **persistent config file** (not env vars) — good reference for style
- `.temp/env.example.ts`: Provided example from user showing the exact target pattern (Zod schema → `.safeParse()` → human-readable error output → `process.exit(1)` on failure → export typed `env` object)
- `research/20260225_env_var_discipline.md`: Full research artifact from research agent

---

## 3) Codebase Map

**Files to create (new `env.ts` modules):**

| File                             | Vars declared                                                                                                                                                                                                                                                        |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/server/src/env.ts`         | NODE_ENV, DORKOS_PORT, DORKOS_DEFAULT_CWD, DORKOS_BOUNDARY, DORKOS_LOG_LEVEL, DORK_HOME, DORKOS_VERSION, CLIENT_DIST_PATH, DORKOS_PULSE_ENABLED, DORKOS_RELAY_ENABLED, DORKOS_MESH_ENABLED, TUNNEL_ENABLED, TUNNEL_PORT, TUNNEL_AUTH, TUNNEL_DOMAIN, NGROK_AUTHTOKEN |
| `apps/client/src/env.ts`         | MODE, DEV (Vite built-ins; stub with comment showing VITE\_\* pattern)                                                                                                                                                                                               |
| `apps/roadmap/src/server/env.ts` | ROADMAP_PORT, ROADMAP_PROJECT_ROOT                                                                                                                                                                                                                                   |
| `apps/web/src/env.ts`            | NEXT_PUBLIC_POSTHOG_KEY, NEXT_PUBLIC_POSTHOG_HOST, NODE_ENV                                                                                                                                                                                                          |
| `packages/cli/src/env.ts`        | DORK_HOME, LOG_LEVEL, NODE_ENV (only vars CLI itself reads; bootstrap mutations stay in cli.ts)                                                                                                                                                                      |

**Files to update (migrate `process.env` reads → `env`):**

_apps/server (12 files):_

- `src/index.ts` — 19 accesses → `import { env } from './env'`
- `src/app.ts` — 2 accesses (NODE_ENV, CLIENT_DIST_PATH)
- `src/lib/dork-home.ts` — 2 accesses (DORK_HOME, NODE_ENV)
- `src/lib/logger.ts` — 1 access (NODE_ENV)
- `src/routes/config.ts` — 3 accesses (DORKOS_PORT, TUNNEL_AUTH, NGROK_AUTHTOKEN)
- `src/routes/tunnel.ts` — 4 accesses (TUNNEL_PORT, NODE_ENV, DORKOS_PORT, NGROK_AUTHTOKEN)
- `src/routes/commands.ts` — 1 access (DORKOS_DEFAULT_CWD)
- `src/services/core/config-manager.ts` — 1 access (DORK_HOME)
- `src/services/core/context-builder.ts` — 2 accesses (DORKOS_VERSION, DORKOS_PORT)
- `src/services/core/mcp-tool-server.ts` — 2 accesses (DORKOS_PORT, DORKOS_VERSION)
- `src/services/core/agent-manager.ts` — 1 access (DORKOS_DEFAULT_CWD)
- `src/services/pulse/pulse-store.ts` — 1 access (DORK_HOME)

_apps/web (2 files):_

- `src/lib/posthog-server.ts` — 2 accesses
- `instrumentation-client.ts` — 2 accesses

_apps/roadmap (1 file):_

- `src/server/index.ts` — 2 accesses

**Files to update (config/tooling):**

- `.env.example` — add 8 missing vars with comments
- `turbo.json` — add ROADMAP_PORT, ROADMAP_PROJECT_ROOT, CLIENT_DIST_PATH, DORKOS_VERSION to `globalPassThroughEnv`
- `eslint.config.js` — add `no-restricted-syntax` rule with carve-outs

**Files to create (documentation):**

- `contributing/environment-variables.md` — new developer guide: pattern, how to add vars, ESLint rule, test strategy

**Shared dependencies:**

- `zod` (already installed in all relevant packages)

**Data flow:**

```
process.env (populated by CLI bootstrap / shell / .env file)
  → env.ts (Zod schema → parse → typed export)
  → consumers (index.ts, routes, services) import { env } from '../env'
```

**Feature flags/config:** No external feature flags; the feature flags ARE the env vars being migrated.

**Potential blast radius:**

- Direct: 18 source files + 5 new env.ts files + 3 config files
- Indirect: All server modules that currently receive env vars as function params or constructor args may need signature updates (unlikely — most read `process.env` inline)
- Tests: 6 test files that manipulate `process.env` directly will need review (they set `process.env.FOO = 'bar'` in `beforeEach`). Strategy: use `vi.stubEnv()` + `vi.resetModules()` — they already test env-dependent behavior; the existing technique stays valid.

---

## 4) Root Cause Analysis

N/A — this is a refactoring task, not a bug fix.

---

## 5) Research

Full details in `research/20260225_env_var_discipline.md`. Summary:

**T3 Env vs Manual Zod — Recommendation: Manual Zod**

T3 Env's primary value-adds are (a) a runtime server/client firewall and (b) monorepo `extends` composition. Both are redundant for DorkOS:

- Server/client separation is enforced by FSD layer rules and Vite's `VITE_*` prefix stripping — no runtime check needed
- The apps share very few env vars, so `extends` composition adds complexity for minimal gain

T3 Env's open bugs make it a poor fit:

- `skipValidation` does not apply Zod defaults (issues #155, #266) — tests that skip validation get `undefined` for vars with defaults
- Extended configs don't inherit `skipValidation` (issue #323) — monorepo setup breaks silently in CI
- ESM-only: CLI's esbuild CJS output would require workarounds

The manual Zod pattern matches the style of `packages/shared/src/config-schema.ts`, requires zero new dependencies, and behaves predictably in tests because defaults always apply.

**Test strategy:** Design schemas so all non-secret vars have `.default()` values. Vitest can import `env.ts` with an empty `process.env` and get valid defaults. For tests that need non-default values: `vi.stubEnv('DORKOS_PORT', '9999')` + `vi.resetModules()`.

**Boolean feature flags:** Use `z.enum(['true', 'false']).default('false').transform(v => v === 'true')` — callers get a real `boolean`, removing 19 scattered `=== 'true'` comparisons from the codebase.

**Vite client:** Client has no custom `VITE_*` vars. Create a stub `env.ts` that validates Vite built-ins (`import.meta.env`) and shows the pattern for adding vars in the future.

**Lint enforcement:** `no-restricted-syntax` with AST selector `MemberExpression[object.name='process'][property.name='env']`. Carve-outs for `**/env.ts`, `**/*.config.ts`, `**/__tests__/**`, and `packages/cli/src/cli.ts`.

---

## 6) Decisions

| #   | Decision                    | Choice                                 | Rationale                                                                                                                                                                                                                                           |
| --- | --------------------------- | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Spec scope                  | Foundation + full migration            | One complete PR, no half-finished state. ESLint rule without migration would be immediately noisy.                                                                                                                                                  |
| 2   | Library choice              | Manual Zod (no T3 Env)                 | T3 Env has open bugs with `skipValidation` + defaults. Zod already a dep; patterns consistent with config-schema.ts.                                                                                                                                |
| 3   | Boolean feature flag typing | Transform to `boolean`                 | `env.DORKOS_PULSE_ENABLED` reads as a real boolean everywhere; removes 19 `=== 'true'` comparisons.                                                                                                                                                 |
| 4   | CLI env.ts scope            | Thin env.ts + keep bootstrap mutations | CLI _sets_ env vars to bootstrap the server process — this is intentional. `cli/src/env.ts` validates only what the CLI itself reads (DORK_HOME, LOG_LEVEL, NODE_ENV). Bootstrap assignments get an inline ESLint disable with explanatory comment. |
| 5   | Client env.ts               | Create stub                            | Establishes the pattern and import path. Prevents future ad-hoc `import.meta.env` access from accumulating. Schema validates Vite built-ins; comment shows VITE\_\* pattern.                                                                        |

---

## Appendix: Schema Sketches

### `apps/server/src/env.ts`

```ts
import { z } from 'zod';

const boolFlag = z
  .enum(['true', 'false'])
  .default('false')
  .transform((v) => v === 'true');

const serverEnvSchema = z.object({
  // Runtime
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  DORKOS_PORT: z.coerce.number().int().min(1).max(65535).default(4242),
  DORKOS_DEFAULT_CWD: z.string().optional(),
  DORKOS_BOUNDARY: z.string().optional(),
  DORKOS_LOG_LEVEL: z.coerce.number().int().min(0).max(5).optional(),
  DORK_HOME: z.string().optional(),
  DORKOS_VERSION: z.string().optional(),
  CLIENT_DIST_PATH: z.string().optional(),
  // Feature flags
  DORKOS_PULSE_ENABLED: boolFlag,
  DORKOS_RELAY_ENABLED: boolFlag,
  DORKOS_MESH_ENABLED: boolFlag,
  // Tunnel
  TUNNEL_ENABLED: boolFlag,
  TUNNEL_PORT: z.coerce.number().int().min(1).max(65535).optional(),
  TUNNEL_AUTH: z.string().optional(),
  TUNNEL_DOMAIN: z.string().optional(),
  NGROK_AUTHTOKEN: z.string().optional(),
});

const result = serverEnvSchema.safeParse(process.env);

if (!result.success) {
  console.error('\n  Missing or invalid environment variables:\n');
  result.error.issues.forEach((i) => console.error(`  - ${i.path.join('.')}: ${i.message}`));
  console.error('\n  Copy .env.example to .env\n');
  process.exit(1);
}

export const env = result.data;
export type ServerEnv = typeof env;
```

### `apps/client/src/env.ts`

```ts
import { z } from 'zod';

// DorkOS client has no custom VITE_* variables yet.
// Vite strips non-VITE_* vars from the browser bundle automatically.
// To add a validated client env var:
//   1. Prefix it with VITE_ in .env.example
//   2. Add it to clientEnvSchema below
//   3. Access via: import { env } from '@/env'
const clientEnvSchema = z.object({
  MODE: z.enum(['development', 'production', 'test']).default('development'),
  DEV: z.boolean().default(false),
});

export const env = clientEnvSchema.parse(import.meta.env);
export type ClientEnv = typeof env;
```

### `apps/roadmap/src/server/env.ts`

```ts
import { z } from 'zod';

const roadmapEnvSchema = z.object({
  ROADMAP_PORT: z.coerce.number().int().min(1).max(65535).default(4243),
  ROADMAP_PROJECT_ROOT: z.string().default(process.cwd()),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
});

const result = roadmapEnvSchema.safeParse(process.env);
if (!result.success) {
  console.error('\n  Roadmap: invalid environment variables:');
  result.error.issues.forEach((i) => console.error(`  - ${i.path.join('.')}: ${i.message}`));
  process.exit(1);
}

export const env = result.data;
```

### `packages/cli/src/env.ts`

```ts
import { z } from 'zod';

// CLI env — only vars the CLI itself reads before the server starts.
// The CLI imperatively sets DORKOS_PORT, TUNNEL_*, DORKOS_*_ENABLED etc.
// via process.env assignments in cli.ts to configure the child server process.
// Those assignments are intentional and remain in cli.ts.
const cliEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  DORK_HOME: z.string().optional(),
  LOG_LEVEL: z.string().optional(),
});

export const env = cliEnvSchema.parse(process.env);
export type CliEnv = typeof env;
```

### ESLint rule addition

```js
// eslint.config.js — add to main rules block:
{
  rules: {
    'no-restricted-syntax': [
      'warn', // warn-first per project convention; escalate to error after migration
      {
        selector: "MemberExpression[object.name='process'][property.name='env']",
        message: "Import env vars from the app's env.ts instead of accessing process.env directly.",
      },
    ],
  },
},
// Carve-outs:
{
  files: [
    '**/env.ts',        // env.ts files read process.env by design
    '**/*.config.ts',   // vite.config.ts, playwright.config.ts run in Node before bundling
    '**/__tests__/**',  // tests set process.env for mocking
    'packages/cli/src/cli.ts', // CLI bootstrap imperatively sets env vars
  ],
  rules: { 'no-restricted-syntax': 'off' },
},
```

### Missing `.env.example` entries to add

```bash
# Relay messaging subsystem (disabled by default)
DORKOS_RELAY_ENABLED=false

# Mesh agent discovery (disabled by default)
DORKOS_MESH_ENABLED=false

# Injected at build time by CLI; not set manually
# DORKOS_VERSION=

# Roadmap app (runs separately on port 4243)
ROADMAP_PORT=4243
ROADMAP_PROJECT_ROOT=

# Analytics (apps/web only)
NEXT_PUBLIC_POSTHOG_KEY=
NEXT_PUBLIC_POSTHOG_HOST=https://app.posthog.com

# Client dev server port (proxies /api to DORKOS_PORT)
VITE_PORT=4241
```

### `turbo.json` additions to `globalPassThroughEnv`

```json
"ROADMAP_PORT",
"ROADMAP_PROJECT_ROOT",
"CLIENT_DIST_PATH",
"DORKOS_VERSION"
```
