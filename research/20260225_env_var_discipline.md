---
title: "Disciplined Environment Variable Handling in TypeScript Monorepos"
date: 2026-02-25
type: implementation
status: active
tags: [env-vars, zod, validation, turborepo, typescript, monorepo]
feature_slug: env-var-discipline
---

# Research: Disciplined Environment Variable Handling in TypeScript Monorepos

**Date**: 2026-02-25
**Feature Slug**: env-var-discipline
**Depth**: Deep Research

---

## Research Summary

Two mature approaches exist for disciplined env var handling in TypeScript monorepos: T3 Env (`@t3-oss/env-core`) and the manual Zod validation pattern. T3 Env adds framework-specific niceties (client/server separation, Vite/Next.js awareness, `extends` for monorepo composition) but carries meaningful caveats — `skipValidation` breaks Zod defaults, extended configs don't inherit it, and it is ESM-only. The manual Zod pattern is simpler, more predictable in test environments, and fits the DorkOS codebase's existing conventions better. For DorkOS specifically, per-app `env.ts` files with manual Zod validation is the recommended approach.

---

## Key Findings

### 1. T3 Env Overview

T3 Env (`@t3-oss/env-core`, currently v0.13.10) wraps Zod (or any Standard Schema validator) with a `createEnv()` function that enforces:

- **Server / client / shared separation**: Variables declared in `server` throw at runtime if accessed in a browser context. Variables declared in `client` must use the configured `clientPrefix`.
- **`runtimeEnv` / `runtimeEnvStrict`**: `runtimeEnv` accepts `process.env` or `import.meta.env` directly. `runtimeEnvStrict` requires you to destructure every variable explicitly, catching accidental omissions at build time.
- **`emptyStringAsUndefined: true`**: Recommended for new projects — treats `PORT=` as undefined so Zod `.default()` kicks in.
- **`skipValidation`**: A boolean that, when true, returns the raw env object without running Zod. Useful for Docker builds and lint CI runs. **Critical caveat**: with `skipValidation` enabled, Zod defaults are NOT applied, meaning optional variables with `.default(3000)` will be `undefined` at runtime in tests.
- **`extends`**: Accepts an array of other `createEnv()` results or platform preset functions (e.g., `vercel()`, `railway()`). Enables monorepo composition — a package-level `env.ts` can be extended by an app-level `env.ts`.
- **`onValidationError` / `onInvalidAccess`**: Callbacks for customising the error thrown when validation fails or when server vars are accessed on the client.
- **Vite support**: Use `@t3-oss/env-core` (not the Next.js variant), set `clientPrefix: 'VITE_'`, and point `runtimeEnv: import.meta.env`.

**Known Issues (from GitHub)**:
- `skipValidation` does not propagate to extended configs (Issue #323) — if `packages/auth/env.ts` does not set `skipValidation`, it will throw even when the consuming app sets it.
- `skipValidation` skips defaults entirely (Issue #266) — so any code relying on `.default(value)` will see `undefined`.
- The package is ESM-only, which can complicate CJS consumers or certain Jest/Vitest setups.

### 2. Manual Zod Validation Pattern

```ts
import { z } from 'zod';

const envSchema = z.object({
  DORKOS_PORT: z.coerce.number().int().default(4242),
  DORK_HOME: z.string().optional(),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
});

export const env = envSchema.parse(process.env);
export type Env = z.infer<typeof envSchema>;
```

Characteristics:
- Zod is already a project dependency, so no new package.
- `z.coerce.number()` handles string-to-number coercion automatically (all env vars arrive as strings).
- `envSchema.parse()` throws a `ZodError` with human-readable field-level errors.
- Defaults always apply, including during tests.
- No server/client firewall — that discipline is enforced by not importing server `env.ts` in client code.
- Straightforward to mock in tests: set `process.env.DORKOS_PORT = '9999'` before the module imports, or use `vi.stubEnv()`.

### 3. Current State in DorkOS

The codebase currently accesses `process.env` directly throughout `apps/server/src/index.ts` (14+ direct reads) and `packages/cli/src/cli.ts` (20+ direct reads). The client (`apps/client/src/`) only uses `import.meta.env.DEV` (2 occurrences) for gating dev-only UI.

No `env.ts` files exist anywhere in the monorepo. All coercion is done inline with `parseInt()` calls, and all feature flag checks use `=== 'true'` string comparisons.

---

## Detailed Analysis

### Vite Client Env Vars

Vite exposes only variables prefixed with `VITE_` via `import.meta.env`. Non-prefixed variables are stripped from the client bundle at build time — this is Vite's built-in server-secret protection. Currently DorkOS uses `import.meta.env.DEV` (a Vite built-in boolean, not a custom var) in two places.

If the client ever needs a real runtime config variable (e.g., `VITE_API_BASE_URL` for a custom API endpoint in different environments), the recommended pattern is:

```ts
// apps/client/src/env.ts
import { z } from 'zod';

const clientEnvSchema = z.object({
  MODE: z.enum(['development', 'production', 'test']).default('development'),
  DEV: z.boolean().default(false),
  // Add VITE_* vars here as needed:
  // VITE_API_BASE_URL: z.string().url().optional(),
});

export const env = clientEnvSchema.parse(import.meta.env);
```

For build-time validation of Vite env vars (fail fast before the dev server starts), the `@julr/vite-plugin-validate-env` package supports Zod schemas and runs at `vite dev` / `vite build` time with zero runtime overhead.

With T3 Env + Vite, the pattern is:
```ts
import { createEnv } from '@t3-oss/env-core';
import { z } from 'zod';

export const env = createEnv({
  clientPrefix: 'VITE_',
  client: { VITE_API_BASE_URL: z.string().url() },
  runtimeEnv: import.meta.env,
});
```

DorkOS currently has no `VITE_*` variables. The two `import.meta.env.DEV` usages are Vite built-ins and need no schema.

### Monorepo Architecture: Per-App vs. Shared Package

**Option A: One shared env package** (`packages/env/`)

Centralises all schemas in one place. Apps import and `.pick()` only what they need:

```ts
// packages/env/src/server.ts  — all server vars declared here
// apps/server/src/env.ts
import { serverEnvAllSchema } from '@dorkos/env';
export const env = serverEnvAllSchema.pick({
  DORKOS_PORT: true, DORK_HOME: true, ...
}).parse(process.env);
```

Pros: Single source of truth for all env var definitions; change a type once and all consumers get it.
Cons: Requires a new package; the `pick()` dance adds boilerplate; if the shared package imports `process.env` at module init, it runs in client bundles.

This approach is recommended by the create-t3-turbo project for large teams where many apps share many env vars (see GitHub issue #87 in that repo).

**Option B: Per-app `env.ts`** (each app owns its own schema)

Each app declares and validates only the env vars it actually uses:

```
apps/server/src/env.ts     — DORKOS_PORT, DORK_HOME, DORKOS_*, TUNNEL_*, NGROK_*
apps/client/src/env.ts     — import.meta.env.DEV (currently, no custom VITE_ vars)
packages/cli/src/env.ts    — DORK_HOME, DORKOS_PORT, EDITOR, LOG_LEVEL, ...
apps/web/src/env.ts        — NEXT_PUBLIC_*, build-time vars
```

Pros: Zero cross-package coupling; schemas are exactly as wide as needed; no risk of server env code touching client bundle; easy to understand and maintain.
Cons: Some vars (e.g., `DORK_HOME`, `NODE_ENV`) are re-declared in multiple schemas — minor duplication.

**Recommendation for DorkOS**: Per-app `env.ts`. The apps in this monorepo share very few env vars, each has a distinct runtime environment (Vite browser, Node.js Express, Next.js SSR, Electron), and the codebase favors low coupling. The duplication of `DORK_HOME` or `NODE_ENV` in two schemas is acceptable given the clarity gained.

### Test Environment Strategy

The core problem: `envSchema.parse(process.env)` runs at import time. If a required variable is absent in a test environment, Vitest fails before any test runs.

**Pattern 1: `.safeParse()` with defaults (preferred)**

Design schemas so that every variable either has a `.default()` or is `.optional()`. For required vars in production, make them optional but assert presence at server startup (not at import time):

```ts
// apps/server/src/env.ts
const envSchema = z.object({
  DORKOS_PORT: z.coerce.number().int().default(4242),
  DORK_HOME: z.string().optional(),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  // Feature flags default to disabled
  DORKOS_PULSE_ENABLED: z.enum(['true', 'false']).default('false'),
  DORKOS_RELAY_ENABLED: z.enum(['true', 'false']).default('false'),
  DORKOS_MESH_ENABLED: z.enum(['true', 'false']).default('false'),
});

export const env = envSchema.parse(process.env);
```

With this schema, Vitest can import `env.ts` with no env vars set and get sensible defaults. No `skipValidation` needed.

**Pattern 2: `vi.stubEnv()` for overrides**

Vitest provides `vi.stubEnv(key, value)` which sets `process.env[key]` and automatically restores it after each test. Since `env.ts` is a module singleton, combine with `vi.resetModules()` if you need different env values per test:

```ts
beforeEach(() => {
  vi.resetModules(); // force env.ts to re-evaluate
  vi.stubEnv('DORKOS_PORT', '9999');
});
```

**Pattern 3: `skipValidation` (T3 Env only — avoid for DorkOS)**

```ts
skipValidation: !!process.env.VITEST || process.env.NODE_ENV === 'test'
```

This bypasses all validation AND all Zod defaults, leaving variables as raw strings or `undefined`. It is fragile: code that expects `env.port` to be a `number` will get `undefined`. The issues on the T3 Env GitHub tracker (especially #155 and #266) confirm this causes real bugs.

**Pattern 4: `.env.test` file**

Create `apps/server/.env.test` with minimal test values. Configure Vitest to load it:

```ts
// vitest.config.ts
export default defineConfig({
  test: {
    env: { DORKOS_PORT: '4242', NODE_ENV: 'test' },
  },
});
```

This is a valid fallback when some variables genuinely have no safe default.

**Recommendation**: Design schemas with `.default()` values for all non-secret variables. The current DorkOS env vars (DORKOS_PORT, DORKOS_*, TUNNEL_*) all have obvious safe defaults. This eliminates the need for `skipValidation` or test-env files entirely.

### Security Considerations

1. **Server secrets never in client bundles**: Vite only includes `VITE_*` prefixed variables in the client bundle. Non-prefixed vars (DATABASE_URL, NGROK_AUTHTOKEN, etc.) are stripped. Never import the server `env.ts` from client code.

2. **Avoid `process.env` in client components**: Once a server env.ts exists, the discipline rule is simple — client code imports `@/env` (which uses `import.meta.env`), server code imports `~/env` (which uses `process.env`). Cross-importing triggers a Vite build error because `process` is not available in browser context.

3. **`.env.example` over `.env` in git**: Already followed in DorkOS — `NGROK_AUTHTOKEN` and `TUNNEL_AUTH` are commented out in `.env.example`. The `env.ts` schema should mark these as `.optional()` so the server starts without them (tunnel features are opt-in).

4. **Don't log env at startup**: The server `index.ts` should never `console.log(env)` or log the full env object. Log individual values only when necessary (e.g., "Server started on port 4242").

5. **Type-correct boolean flags**: The current pattern `process.env.DORKOS_PULSE_ENABLED === 'true'` scattered across 19 server files is fragile. A schema with `z.enum(['true', 'false']).transform(v => v === 'true').default('false')` consolidates this once.

---

## Potential Solutions

### 1. T3 Env (`@t3-oss/env-core`)

**Description**: Official library for validated env vars with server/client separation, framework adapters, and monorepo `extends` composition.

**Pros**:
- Built-in server-vs-client firewall enforced at runtime
- `clientPrefix` enforcement prevents misnamed client vars
- `extends` allows sharing schemas across packages without code duplication
- Widely used in the T3 ecosystem, well-documented

**Cons**:
- ESM-only — may require build config changes for CJS consumers (CLI package uses esbuild CJS output)
- `skipValidation` breaks Zod defaults — unreliable in test environments
- Extended configs don't inherit `skipValidation` (open bug #323 as of Feb 2026)
- Adds a new dependency; `@t3-oss/env-core` + `@t3-oss/env-nextjs` = two packages
- The client/server firewall requires disciplined import hygiene anyway — FSD layer rules already enforce this
- `runtimeEnvStrict` requires enumerating every var twice (schema + runtimeEnv object)

**Complexity**: Medium (initial setup) / Low (ongoing)
**Maintenance**: Low

### 2. Manual Zod Validation

**Description**: Each app exports `const env = z.object({...}).parse(process.env)` from a dedicated `env.ts` file, with coercion and defaults baked into the schema.

**Pros**:
- Zero new dependencies (Zod already used throughout the project)
- Defaults always work, including in test environments
- Predictable behavior — no hidden modes or escape hatches
- Easy to understand and adjust without consulting library docs
- No ESM-only constraints; works in esbuild CJS output
- Consistent with existing Zod patterns in `packages/shared/src/config-schema.ts`
- `vi.stubEnv()` and `vi.resetModules()` are sufficient for test overrides

**Cons**:
- No runtime enforcement of server/client boundary (relies on import hygiene + FSD layer rules)
- Some env var names repeated across per-app schemas (minor duplication)
- Does not auto-integrate with Next.js `NEXT_PUBLIC_` bundle splitting

**Complexity**: Low
**Maintenance**: Low

### 3. `@julr/vite-plugin-validate-env` (supplementary, Vite only)

**Description**: A Vite plugin that validates env vars at build/dev time (not runtime), providing early failure before the dev server even starts. Supports Zod schemas.

**Pros**:
- Zero runtime overhead (all validation at build time)
- Integrates directly into Vite's plugin pipeline
- Catches missing vars before the browser loads anything

**Cons**:
- Vite-only (does not help with Express server or CLI)
- Adds another dev dependency
- Redundant with a runtime `env.ts` that already validates at startup

**Recommendation**: Skip this for DorkOS. The client currently has no custom `VITE_*` vars. Add it only if client-side env var usage grows significantly.

---

## Monorepo Architecture Recommendation

Use **per-app `env.ts` files**. Create one in each app and in the CLI package:

```
apps/server/src/env.ts        # process.env, all DORKOS_* + TUNNEL_* + NGROK_*
apps/client/src/env.ts        # import.meta.env, currently minimal (DEV built-in only)
apps/web/src/env.ts           # process.env + NEXT_PUBLIC_* (Next.js specific)
packages/cli/src/env.ts       # process.env, CLI-resolved vars before server starts
```

The `apps/obsidian-plugin` does not use process.env directly (it delegates to the server via Transport) and does not need an env.ts.

Shared vars (`NODE_ENV`, `DORK_HOME`) are re-declared in each schema independently. This is intentional — each app only validates what it uses, and the duplication is two lines of Zod schema.

Do NOT create a `packages/env/` shared package for DorkOS. The complexity of cross-package Zod schema composition is not justified given the small number of shared vars.

---

## Recommendation

**Recommended Approach**: Manual Zod Validation (per-app `env.ts` files)

**Rationale**: Zod is already a core dependency, the schemas are simple to write and read, and the defaults-always-work behavior eliminates an entire class of test environment bugs that T3 Env's `skipValidation` introduces. The FSD layer architecture already enforces server/client import boundaries more effectively than T3 Env's runtime check, making T3 Env's primary differentiating feature redundant. The manual pattern is also consistent with the existing `packages/shared/src/config-schema.ts` style that the team already writes.

**Caveats**:
- The client `env.ts` must use `import.meta.env`, not `process.env` — Vite will strip unknown vars from the browser bundle silently.
- For Next.js (`apps/web`), consider `@t3-oss/env-nextjs` or the Next.js-specific pattern of importing `env.ts` in `next.config.ts` to get build-time validation. The Next.js app is separate enough that its env handling can differ from the Express server.
- The CLI package (`packages/cli/src/cli.ts`) sets `process.env` variables imperatively before the server starts (it is the bootstrap that writes DORKOS_PORT etc. into process.env). Its `env.ts` should be validated after that bootstrap phase, or use a lazy initializer pattern.

---

## Sources & Evidence

- T3 Env introduction and core docs — [env.t3.gg/docs/introduction](https://env.t3.gg/docs/introduction), [env.t3.gg/docs/core](https://env.t3.gg/docs/core)
- T3 Env customization (skipValidation, onValidationError, extends) — [env.t3.gg/docs/customization](https://env.t3.gg/docs/customization)
- T3 Env Next.js integration — [env.t3.gg/docs/nextjs](https://env.t3.gg/docs/nextjs)
- T3 Env GitHub repository — [github.com/t3-oss/t3-env](https://github.com/t3-oss/t3-env)
- "skipValidation doesn't set defaults" open issue — [github.com/t3-oss/t3-env/issues/155](https://github.com/t3-oss/t3-env/issues/155)
- "Default values skipped when using SKIP_ENV_VALIDATION" — [github.com/t3-oss/t3-env/issues/266](https://github.com/t3-oss/t3-env/issues/266)
- "Extended configurations do not respect skipValidation" — [github.com/t3-oss/t3-env/issues/323](https://github.com/t3-oss/t3-env/issues/323)
- Monorepo env validation patterns from create-t3-turbo community — [github.com/t3-oss/create-t3-turbo/issues/87](https://github.com/t3-oss/create-t3-turbo/issues/87)
- Vite env vars and modes official docs — [vite.dev/guide/env-and-mode](https://vite.dev/guide/env-and-mode)
- vite-plugin-validate-env — [github.com/Julien-R44/vite-plugin-validate-env](https://github.com/Julien-R44/vite-plugin-validate-env)
- Manual Zod env validation pattern — [creatures.sh/blog/env-type-safety-and-validation/](https://www.creatures.sh/blog/env-type-safety-and-validation/)
- T3 Env DeepWiki (monorepo + Vite patterns) — [deepwiki.com/t3-oss/t3-env](https://deepwiki.com/t3-oss/t3-env)

---

## Research Gaps & Limitations

- The Obsidian plugin (`apps/obsidian-plugin`) is not fully analysed — it runs in Electron and uses Vite lib mode. It may need a custom `env.ts` if it reads Electron-specific env vars.
- How the CLI's imperative `process.env` mutation interacts with a lazy-loaded `env.ts` in the server process has not been prototyped. The recommended approach is to move the CLI's env.ts validation to after the mutation phase in `cli.ts`.
- The `apps/roadmap` app was not researched for env var usage.

---

## Search Methodology

- Searches performed: 10
- Most productive search terms: "T3 Env @t3-oss/env-core Vite Turborepo monorepo", "T3 Env skipValidation vitest test", "monorepo env.ts per-app vs shared package Zod"
- Primary information sources: env.t3.gg official docs, github.com/t3-oss/t3-env issue tracker, deepwiki.com/t3-oss/t3-env, vite.dev/guide/env-and-mode
- Codebase inspection: 19 server files with direct `process.env` access, 2 client files with `import.meta.env`, no existing `env.ts` files
