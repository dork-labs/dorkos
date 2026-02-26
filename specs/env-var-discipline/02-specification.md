---
slug: env-var-discipline
number: 64
created: 2026-02-25
status: draft
---

# Spec 64: Disciplined Environment Variable Handling

**Status:** Draft
**Author:** Claude Code
**Date:** 2026-02-25
**Ideation:** [01-ideation.md](./01-ideation.md)

---

## Overview

Replace 60+ scattered `process.env` accesses across 18 source files with validated, typed `env.ts` modules — one per app/package. Each module runs its env vars through a Zod schema at module load time, failing fast with human-readable errors instead of silently producing `undefined` or `NaN`. An ESLint rule enforces the pattern going forward. `.env.example` and `turbo.json` are updated to cover all vars. A developer guide is added to `contributing/`.

---

## Background / Problem Statement

The DorkOS codebase currently has no centralized env var validation. The result:

- **Silent runtime failures**: `process.env.DORKOS_PORT` returns `undefined` if the var is missing → `parseInt(undefined)` → `NaN` → server starts on port `NaN`
- **Stringly-typed booleans**: Feature flags are checked with `process.env.DORKOS_PULSE_ENABLED === 'true'` in 19 different files — one typo and it silently defaults to `false`
- **Documentation drift**: 8 env vars used in code are absent from `.env.example`; 4 are absent from `turbo.json` `globalPassThroughEnv`
- **Discoverability**: No single place to look up what env vars exist, what they do, or what their defaults are

---

## Goals

- Each app/package exports a typed, validated `env` object from an `env.ts` module
- Server fails fast on startup if required env vars are missing/invalid, with actionable error messages
- Boolean feature flags are typed as `boolean`, not `string`
- `process.env` access outside of `env.ts` and explicitly-carved-out files triggers an ESLint warning
- `.env.example` is complete (all vars used in code are listed)
- `turbo.json` `globalPassThroughEnv` covers all runtime vars
- `contributing/environment-variables.md` documents the pattern end-to-end
- All existing tests continue to pass without modification

---

## Non-Goals

- Secrets management (vault, AWS SSM, etc.)
- New env vars beyond those already in use
- The Obsidian plugin (no direct `process.env` access)
- Next.js build-time `NEXT_PUBLIC_*` validation via `@t3-oss/env-nextjs`
- T3 Env adoption (rejected: open bugs #155/#266/#323 with `skipValidation` + ESM-only constraint)

---

## Technical Dependencies

| Dependency | Already available | Purpose |
|---|---|---|
| `zod` | ✅ All relevant packages | Schema validation |
| `eslint` flat config | ✅ Root `eslint.config.js` | `no-restricted-syntax` rule |

No new packages required.

---

## Detailed Design

### Pattern Overview

Each app/package that uses env vars gets an `env.ts` at its source root:

```ts
import { z } from 'zod';

const schema = z.object({
  PORT: z.coerce.number().default(4242),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
});

const result = schema.safeParse(process.env);
if (!result.success) {
  console.error('\n  Missing or invalid environment variables:\n');
  result.error.issues.forEach(i => console.error(`  - ${i.path.join('.')}: ${i.message}`));
  console.error('\n  Copy .env.example to .env\n');
  process.exit(1);
}

export const env = result.data;
export type Env = typeof env;
```

Consumers import from the module:

```ts
import { env } from '../env';

const port = env.DORKOS_PORT; // number, not string
```

### Boolean Flag Helper

A reusable Zod type for feature flags, defined once in the server `env.ts`:

```ts
const boolFlag = z.enum(['true', 'false']).default('false').transform(v => v === 'true');
```

- Input: `'true'`, `'false'`, or `undefined` (which defaults to `'false'`)
- Output: TypeScript `boolean`
- Eliminates all `=== 'true'` string comparisons

### Test Compatibility

All schemas use `.default()` for every non-secret variable. Vitest can import `env.ts` with an empty `process.env` and receive valid typed defaults — no mocking required in most tests. For tests that need non-default values:

```ts
beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('DORKOS_PORT', '9999');
});
```

`vi.stubEnv()` automatically restores the original value after each test. `vi.resetModules()` forces `env.ts` to re-evaluate with the stubbed value.

### CLI Bootstrap Special Case

`packages/cli/src/cli.ts` is the process bootstrap — it sets `process.env.DORKOS_PORT`, `process.env.TUNNEL_ENABLED`, etc. to configure the server subprocess before importing the server. These are imperative writes, not reads, and cannot be replaced by `env.ts`.

Resolution:
- `packages/cli/src/env.ts` validates only what the CLI itself reads: `DORK_HOME`, `LOG_LEVEL`, `NODE_ENV`
- Bootstrap `process.env` assignments in `cli.ts` keep the ESLint carve-out for that file
- Each such assignment gets an inline disable comment:

```ts
// eslint-disable-next-line no-restricted-syntax -- CLI bootstrap writes env vars for the server subprocess
process.env.DORKOS_PORT = String(port);
```

### Vite Client Environment

The client (`apps/client`) uses `import.meta.env` (not `process.env`). Vite strips non-`VITE_*` vars from the browser bundle automatically. Currently there are no custom `VITE_*` vars — only `import.meta.env.DEV` (a Vite built-in).

A stub `env.ts` is created to:
1. Validate Vite built-ins with a Zod schema
2. Establish the canonical import path (`@/env`)
3. Show developers how to add `VITE_*` vars in comments

---

## Files to Create

### `apps/server/src/env.ts`

```ts
import { z } from 'zod';

/** Reusable Zod type for 'true'/'false' env flags → boolean. */
const boolFlag = z.enum(['true', 'false']).default('false').transform(v => v === 'true');

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
  // Feature flags (boolean after transform)
  DORKOS_PULSE_ENABLED: boolFlag,
  DORKOS_RELAY_ENABLED: boolFlag,
  DORKOS_MESH_ENABLED: boolFlag,
  // Tunnel (ngrok integration — all optional)
  TUNNEL_ENABLED: boolFlag,
  TUNNEL_PORT: z.coerce.number().int().min(1).max(65535).optional(),
  TUNNEL_AUTH: z.string().optional(),
  TUNNEL_DOMAIN: z.string().optional(),
  NGROK_AUTHTOKEN: z.string().optional(),
});

const result = serverEnvSchema.safeParse(process.env);

if (!result.success) {
  console.error('\n  Missing or invalid environment variables:\n');
  result.error.issues.forEach(i => console.error(`  - ${i.path.join('.')}: ${i.message}`));
  console.error('\n  Copy .env.example to .env\n');
  process.exit(1);
}

export const env = result.data;
export type ServerEnv = typeof env;
```

### `apps/client/src/env.ts`

```ts
import { z } from 'zod';

// DorkOS client currently has no custom VITE_* variables.
// Vite's built-in env vars (MODE, DEV, PROD, SSR) are validated here.
//
// To add a validated client env var:
//   1. Prefix the var name with VITE_ in .env.example
//   2. Add it to clientEnvSchema below
//   3. Add it to turbo.json build task env[]
//   4. Access via: import { env } from '@/env'
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
  console.error('\n  Roadmap: invalid environment variables:\n');
  result.error.issues.forEach(i => console.error(`  - ${i.path.join('.')}: ${i.message}`));
  process.exit(1);
}

export const env = result.data;
export type RoadmapEnv = typeof env;
```

### `apps/web/src/env.ts`

```ts
import { z } from 'zod';

// Next.js makes NEXT_PUBLIC_* vars available server-side and client-side.
// Non-public vars are server-only.
const webEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  NEXT_PUBLIC_POSTHOG_KEY: z.string().optional(),
  NEXT_PUBLIC_POSTHOG_HOST: z.string().url().default('https://app.posthog.com'),
});

export const env = webEnvSchema.parse(process.env);
export type WebEnv = typeof env;
```

### `packages/cli/src/env.ts`

```ts
import { z } from 'zod';

// Only vars the CLI itself reads (e.g., to display the current DORK_HOME).
// The CLI imperatively sets DORKOS_PORT, TUNNEL_*, DORKOS_*_ENABLED, etc.
// via process.env assignments in cli.ts to configure the server subprocess.
// Those assignments remain in cli.ts with ESLint inline disables.
const cliEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  DORK_HOME: z.string().optional(),
  LOG_LEVEL: z.string().optional(),
});

export const env = cliEnvSchema.parse(process.env);
export type CliEnv = typeof env;
```

---

## Files to Modify

### ESLint: `eslint.config.js`

Add two config blocks. The first adds the rule; the second provides carve-outs.

**Important**: The existing global `ignores` block matches `*.config.ts` at the repository root only (no `**/` prefix). Vite config files inside `apps/` are NOT currently ignored. The new carve-out uses `**/*.config.ts` to cover all config files.

```js
// Add after the existing general rule overrides block:

// Env var discipline: no raw process.env access outside env.ts
{
  files: ['**/*.ts', '**/*.tsx'],
  rules: {
    'no-restricted-syntax': [
      'warn', // warn-first per project convention; escalate to error once migration verified
      {
        selector: "MemberExpression[object.name='process'][property.name='env']",
        message:
          "Import env vars from the app's env.ts instead of accessing process.env directly.",
      },
    ],
  },
},

// Carve-outs for files that legitimately access process.env
{
  files: [
    '**/env.ts',             // env.ts files read process.env by design
    '**/*.config.ts',        // vite.config.ts, playwright.config.ts run in Node before bundling
    '**/__tests__/**',       // tests stub process.env for mocking
    '**/*.test.ts',          // flat test files
    '**/*.spec.ts',          // e2e spec files
    'packages/cli/src/cli.ts', // CLI bootstrap sets env vars for server subprocess
  ],
  rules: { 'no-restricted-syntax': 'off' },
},
```

### `.env.example`

Add the following missing vars:

```bash
# Relay messaging subsystem (disabled by default)
# DORKOS_RELAY_ENABLED=true

# Mesh agent discovery subsystem (disabled by default)
# DORKOS_MESH_ENABLED=true

# Version (injected at build time by the CLI package — do not set manually)
# DORKOS_VERSION=

# Client dev server port (Vite; proxies /api to DORKOS_PORT)
# VITE_PORT=4241

# Roadmap app (runs independently on a separate port)
# ROADMAP_PORT=4243
# ROADMAP_PROJECT_ROOT=

# Analytics — apps/web marketing site only (optional)
# NEXT_PUBLIC_POSTHOG_KEY=phc_...
# NEXT_PUBLIC_POSTHOG_HOST=https://app.posthog.com
```

### `turbo.json`

Add four vars to `globalPassThroughEnv`:

```json
"globalPassThroughEnv": [
  "DORKOS_PORT",
  "DORKOS_DEFAULT_CWD",
  "DORKOS_BOUNDARY",
  "DORKOS_LOG_LEVEL",
  "DORK_HOME",
  "DORKOS_PULSE_ENABLED",
  "DORKOS_RELAY_ENABLED",
  "DORKOS_MESH_ENABLED",
  "TUNNEL_ENABLED",
  "TUNNEL_PORT",
  "TUNNEL_AUTH",
  "TUNNEL_DOMAIN",
  "NGROK_AUTHTOKEN",
  "VITE_PORT",
  "ROADMAP_PORT",
  "ROADMAP_PROJECT_ROOT",
  "CLIENT_DIST_PATH",
  "DORKOS_VERSION"
]
```

### `apps/server/src/index.ts` (12 server files total)

Import `env` at the top and replace all `process.env.*` reads. Examples:

**Before:**
```ts
const PORT = parseInt(process.env.DORKOS_PORT ?? String(DEFAULT_PORT), 10);
const pulseEnabled = process.env.DORKOS_PULSE_ENABLED === 'true';
const relayEnabled = process.env.DORKOS_RELAY_ENABLED === 'true';
const meshEnabled = process.env.DORKOS_MESH_ENABLED === 'true';
const defaultCwd = process.env.DORKOS_DEFAULT_CWD ?? process.cwd();
```

**After:**
```ts
import { env } from './env';

const PORT = env.DORKOS_PORT; // already a number
const pulseEnabled = env.DORKOS_PULSE_ENABLED; // already a boolean
const relayEnabled = env.DORKOS_RELAY_ENABLED;
const meshEnabled = env.DORKOS_MESH_ENABLED;
const defaultCwd = env.DORKOS_DEFAULT_CWD ?? process.cwd();
```

**Complete list of server files to migrate:**

| File | Vars to migrate |
|------|----------------|
| `src/index.ts` | DORKOS_PORT, DORKOS_LOG_LEVEL, DORKOS_BOUNDARY, DORKOS_PULSE_ENABLED, DORKOS_RELAY_ENABLED, DORKOS_MESH_ENABLED, DORKOS_DEFAULT_CWD, TUNNEL_ENABLED, TUNNEL_PORT, NGROK_AUTHTOKEN, TUNNEL_AUTH, TUNNEL_DOMAIN |
| `src/app.ts` | NODE_ENV, CLIENT_DIST_PATH |
| `src/lib/dork-home.ts` | DORK_HOME, NODE_ENV |
| `src/lib/logger.ts` | NODE_ENV |
| `src/routes/config.ts` | DORKOS_PORT, TUNNEL_AUTH, NGROK_AUTHTOKEN |
| `src/routes/tunnel.ts` | TUNNEL_PORT, NODE_ENV, DORKOS_PORT, NGROK_AUTHTOKEN |
| `src/routes/commands.ts` | DORKOS_DEFAULT_CWD |
| `src/services/core/config-manager.ts` | DORK_HOME |
| `src/services/core/context-builder.ts` | DORKOS_VERSION, DORKOS_PORT |
| `src/services/core/mcp-tool-server.ts` | DORKOS_PORT, DORKOS_VERSION |
| `src/services/core/agent-manager.ts` | DORKOS_DEFAULT_CWD |
| `src/services/pulse/pulse-store.ts` | DORK_HOME |

**Note on `routes/config.ts`:** This route currently reads `DORKOS_PORT` via `parseInt(process.env.DORKOS_PORT!, 10)`. After migration, `env.DORKOS_PORT` is already typed as `number` — remove the `parseInt` wrapper.

### `apps/web/src/lib/posthog-server.ts` and `instrumentation-client.ts`

```ts
import { env } from '../env'; // or '../env' depending on relative path

// Before: process.env.NEXT_PUBLIC_POSTHOG_KEY
// After:  env.NEXT_PUBLIC_POSTHOG_KEY
```

### `apps/roadmap/src/server/index.ts`

```ts
import { env } from './env';

const port = env.ROADMAP_PORT;         // replaces parseInt(process.env.ROADMAP_PORT ?? '4243', 10)
const projectRoot = env.ROADMAP_PROJECT_ROOT; // replaces process.env.ROADMAP_PROJECT_ROOT ?? process.cwd()
```

### `packages/cli/src/cli.ts` (partial)

Replace reads only. Keep all imperative writes with inline ESLint disables:

```ts
import { env } from './env';

// Replace reads:
const dorkHome = env.DORK_HOME;   // was: process.env.DORK_HOME
const logLevel = env.LOG_LEVEL;   // was: process.env.LOG_LEVEL

// Keep writes (with inline disable):
// eslint-disable-next-line no-restricted-syntax -- CLI bootstrap: sets env for server subprocess
process.env.DORKOS_PORT = String(port);
// eslint-disable-next-line no-restricted-syntax -- CLI bootstrap: sets env for server subprocess
process.env.TUNNEL_ENABLED = String(tunnelEnabled);
// (repeat pattern for each assignment)
```

---

## New Documentation: `contributing/environment-variables.md`

The guide must cover:

1. **The Pattern** — why `env.ts` exists, what problem it solves
2. **Where Each `env.ts` Lives** — table of app → file path → env vars covered
3. **How to Add a New Env Var** — step-by-step checklist:
   1. Add to the app's `env.ts` schema
   2. Add to `.env.example` with a comment explaining the var
   3. Add to `turbo.json` `globalPassThroughEnv` (runtime vars) or task `env` (build-time vars)
   4. Update `contributing/environment-variables.md` env var reference table
4. **Boolean Feature Flags** — explain the `boolFlag` helper, why `z.coerce.boolean()` is NOT used (coerces any non-empty string to `true`, including `'false'`)
5. **ESLint Rule** — what it catches, list of carve-out files, how to add an inline disable when legitimate
6. **Test Strategy** — `vi.stubEnv()` + `vi.resetModules()` pattern with code example
7. **Vite Client Env Vars** — `VITE_*` prefix requirement, how to add them to the client stub
8. **Complete Env Var Reference** — table of all env vars with: name, app, type, default, description

---

## Architecture Changes

- No new packages
- No API changes
- No database changes
- Import paths: `import { env } from './env'` (server/roadmap/CLI) or `import { env } from '@/env'` (client with path alias)
- Type surface: `ServerEnv`, `ClientEnv`, `RoadmapEnv`, `WebEnv`, `CliEnv` are exported for any file that needs the type

---

## User Experience

No user-facing changes. The improvement is entirely developer-facing:

- Starting the server with a misconfigured var now prints: `Missing or invalid environment variables: - DORKOS_PORT: Expected number, received nan` and exits 1 (instead of starting silently with a broken port)
- `env.DORKOS_PULSE_ENABLED` is autocompleted and type-safe in IDEs
- Adding a new env var follows a documented checklist

---

## Testing Strategy

### Existing Tests

No changes required. All schema fields have `.default()` values or `.optional()`, so `env.ts` parses successfully with an empty `process.env`. Tests that manipulate `process.env` directly continue to work since they fall under the `__tests__/**` ESLint carve-out.

### New Unit Tests: `apps/server/src/__tests__/env.test.ts`

```ts
/**
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

describe('serverEnv', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('uses default port when DORKOS_PORT is not set', async () => {
    vi.stubEnv('DORKOS_PORT', '');
    const { env } = await import('../env');
    // When empty string, coerce.number() fails — verify default 4242 kicks in
    // (or test with completely unset var)
    expect(typeof env.DORKOS_PORT).toBe('number');
    expect(env.DORKOS_PORT).toBe(4242);
  });

  it('parses DORKOS_PORT as a number', async () => {
    vi.stubEnv('DORKOS_PORT', '6942');
    const { env } = await import('../env');
    expect(env.DORKOS_PORT).toBe(6942);
    expect(typeof env.DORKOS_PORT).toBe('number');
  });

  it('feature flags default to false', async () => {
    const { env } = await import('../env');
    expect(env.DORKOS_PULSE_ENABLED).toBe(false);
    expect(env.DORKOS_RELAY_ENABLED).toBe(false);
    expect(env.DORKOS_MESH_ENABLED).toBe(false);
  });

  it('feature flag "true" string becomes boolean true', async () => {
    vi.stubEnv('DORKOS_PULSE_ENABLED', 'true');
    const { env } = await import('../env');
    expect(env.DORKOS_PULSE_ENABLED).toBe(true);
  });

  it('feature flag "false" string becomes boolean false', async () => {
    vi.stubEnv('DORKOS_PULSE_ENABLED', 'false');
    const { env } = await import('../env');
    expect(env.DORKOS_PULSE_ENABLED).toBe(false);
  });

  it('rejects an out-of-range port', async () => {
    // Since env.ts calls process.exit(1) on failure, mock it
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.stubEnv('DORKOS_PORT', '99999');
    await import('../env');
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });
});
```

### Verification After Migration

After all `process.env` reads are replaced, run:

```bash
# Should return zero results (only hits in carve-out files are acceptable)
pnpm lint 2>&1 | grep "no-restricted-syntax"
```

---

## Performance Considerations

- `env.ts` runs once at module load and caches the result — zero repeated parsing
- Zod schema validation on a plain object is microsecond-level, negligible for server startup

---

## Security Considerations

- **Server secrets stay server-side**: `NGROK_AUTHTOKEN`, `TUNNEL_AUTH` are in `apps/server/src/env.ts` only. The client `env.ts` uses `import.meta.env` — Vite strips non-`VITE_*` vars from the browser bundle.
- **No logging of env object**: `env.ts` must not `console.log(env)` or log the full object. Only log individual non-secret values at startup if needed.
- **`.gitignore`**: Unchanged — `.env` is already gitignored, `.env.example` is committed.
- **`NGROK_AUTHTOKEN` is `.optional()`**: Server starts without it; tunnel features are opt-in.

---

## Documentation Changes

| Document | Change |
|---|---|
| `contributing/environment-variables.md` | Create — full pattern guide + complete env var reference table |
| `docs/` (user-facing) | No immediate changes — the env var reference can be added to user docs in a follow-up |
| `CLAUDE.md` | No changes needed — architecture section already describes env var precedence |

---

## Implementation Phases

### Phase 1: Foundation (no behavior changes)

1. Create `apps/server/src/env.ts`
2. Create `apps/client/src/env.ts`
3. Create `apps/roadmap/src/server/env.ts`
4. Create `apps/web/src/env.ts`
5. Create `packages/cli/src/env.ts`
6. Add ESLint rule + carve-outs to `eslint.config.js`
7. Update `.env.example` with missing vars
8. Update `turbo.json` `globalPassThroughEnv`
9. Create `contributing/environment-variables.md`

After Phase 1: ESLint warns on all existing `process.env` accesses. The app still works.

### Phase 2: Server Migration

10. Migrate all 12 `apps/server/src/**` files
11. Migrate `apps/roadmap/src/server/index.ts`
12. Migrate `apps/web/src/lib/posthog-server.ts` and `instrumentation-client.ts`
13. Partially migrate `packages/cli/src/cli.ts` (reads only; writes stay with inline disables)

After Phase 2: Server boots from `env.ts`. ESLint warnings should be reduced to only the CLI carve-out mutations.

### Phase 3: Verification & Tests

14. Write `apps/server/src/__tests__/env.test.ts`
15. Run `pnpm typecheck` — verify all types flow correctly
16. Run `pnpm test` — verify all existing tests pass
17. Run `pnpm lint` — verify only CLI carve-out `process.env` accesses remain

---

## Open Questions

None. All decisions were resolved during ideation:

| Decision | Resolution |
|---|---|
| Library | Manual Zod — no T3 Env |
| Architecture | Per-app `env.ts` — no shared `packages/env/` |
| Boolean flags | Transform to `boolean` via `z.enum(['true','false']).transform()` |
| CLI treatment | Thin `env.ts` for reads; writes stay in `cli.ts` with inline disables |
| Client env.ts | Create stub now; VITE_* vars added later as needed |

---

## Related ADRs

- `decisions/0005-monorepo-turborepo-migration.md` — documents Turborepo env var passthrough conventions
- `decisions/0032-dorkos-config-file-system.md` — config file system (separate from env vars; both systems coexist)

---

## References

- Ideation document: `specs/env-var-discipline/01-ideation.md`
- Research artifact: `research/20260225_env_var_discipline.md`
- Example `env.ts` pattern: `.temp/env.example.ts`
- T3 Env open bug (skipValidation + defaults): https://github.com/t3-oss/t3-env/issues/266
- Vite env var documentation: https://vite.dev/guide/env-and-mode
