# Environment Variables

This guide covers the `env.ts` pattern used across DorkOS to validate and type environment variables.

## The Pattern

Raw `process.env` access causes silent runtime failures: accessing an unset variable returns `undefined`, which propagates silently until it causes a crash at an unexpected call site. Feature flags gated on `=== 'true'` string comparisons were spread across 19+ files, making it easy to introduce typos that silently disable features. There was no single place to discover which vars each app required.

Each app and package now exports a typed, validated `env` object from a local `env.ts` file. The schema is validated at process startup with `safeParse`, failing fast with actionable error messages listing every invalid field. Downstream code imports `env.DORKOS_PORT` as a typed `number` rather than parsing strings.

## Where Each env.ts Lives

| App / Package    | env.ts path                              | Env vars covered                                                                                                                                                 |
| ---------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/server`    | `apps/server/src/env.ts`                 | DORKOS_PORT, NODE_ENV, DORKOS_DEFAULT_CWD, DORKOS_BOUNDARY, DORKOS_LOG_LEVEL, DORK_HOME, DORKOS_VERSION, CLIENT_DIST_PATH, DORKOS_PULSE_ENABLED, DORKOS_RELAY_ENABLED, DORKOS_MESH_ENABLED, TUNNEL_ENABLED, TUNNEL_PORT, TUNNEL_AUTH, TUNNEL_DOMAIN, NGROK_AUTHTOKEN |
| `apps/client`    | `apps/client/src/env.ts`                 | MODE, DEV (Vite built-ins)                                                                                                                                       |
| `apps/roadmap`   | `apps/roadmap/src/server/env.ts`         | ROADMAP_PORT, ROADMAP_PROJECT_ROOT, NODE_ENV                                                                                                                     |
| `apps/web`       | `apps/web/src/env.ts`                    | NODE_ENV, NEXT_PUBLIC_POSTHOG_KEY, NEXT_PUBLIC_POSTHOG_HOST                                                                                                      |
| `packages/cli`   | `packages/cli/src/env.ts`                | NODE_ENV, DORK_HOME, LOG_LEVEL                                                                                                                                   |

## How to Add a New Env Var

1. Add the var to the relevant app's `env.ts` schema with its type, default, and validation constraints.
2. Add to `.env.example` with a comment explaining the var. Use `# VAR=value` format for optional vars, `VAR=value` for required ones.
3. Add to `turbo.json` `globalPassThroughEnv` if it is a runtime var that does not affect cache hash. Add to the task-level `env` array if it is a build-time var (e.g., `VITE_*`, `NEXT_PUBLIC_*`) that should invalidate the cache when changed.
4. Update the env var reference table in this document.
5. Access the var via `import { env } from './env'` in server files, or `import { env } from '@/env'` in client files.

## Boolean Feature Flags

The `boolFlag` helper is used for all boolean feature flags:

```ts
const boolFlag = z.enum(['true', 'false']).default('false').transform(v => v === 'true');
```

`z.coerce.boolean()` is explicitly **not** used here. Zod's coerce converts any non-empty string to `true` — including the string `'false'`. This means `DORKOS_PULSE_ENABLED=false` would be interpreted as `true`, which is the opposite of what the user intended.

`z.enum(['true', 'false'])` rejects unexpected values like `'yes'`, `'1'`, or `'enabled'` with a clear validation error, and the `.transform()` produces a TypeScript `boolean`, eliminating all `=== 'true'` string comparisons in downstream code.

## ESLint Rule

A `no-restricted-syntax` rule targeting `MemberExpression[object.name='process'][property.name='env']` is applied to all `.ts` and `.tsx` files. It warns when code accesses `process.env` directly instead of importing from `env.ts`.

The following files are carved out and do not receive the warning:

- `**/env.ts` — env.ts files read process.env by design
- `**/*.config.ts` — vite.config.ts, playwright.config.ts run in Node before bundling
- `**/__tests__/**` — tests stub process.env for mocking
- `**/*.test.ts` and `**/*.spec.ts` — test files
- `packages/cli/src/cli.ts` — CLI bootstrap writes env vars for server subprocess

For any legitimate `process.env` access outside these carve-outs, add an inline disable comment explaining why:

```ts
// eslint-disable-next-line no-restricted-syntax -- CLI bootstrap: sets env for server subprocess
process.env.DORKOS_PORT = String(port);
```

## Test Strategy

All schema fields use `.default()` or `.optional()`, so `env.ts` parses successfully with an empty `process.env`. Tests that need non-default values use `vi.stubEnv()` combined with `vi.resetModules()` to force re-evaluation of the module:

```ts
beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('DORKOS_PORT', '9999');
});

afterEach(() => {
  vi.unstubAllEnvs();
});
```

`vi.stubEnv()` automatically restores the original value after `vi.unstubAllEnvs()`. `vi.resetModules()` clears the module registry so the dynamic `import('../env.js')` call inside each test re-evaluates the module with the stubbed environment.

## Vite Client Env Vars

The client uses `import.meta.env` rather than `process.env`. Vite strips all non-`VITE_*` vars from the browser bundle at build time, so arbitrary `process.env` vars are not available in client code.

To add a new `VITE_*` var:

1. Name it with the `VITE_` prefix in `.env.example`.
2. Add it to `clientEnvSchema` in `apps/client/src/env.ts`.
3. Add it to the `build` task's `env` array in `turbo.json` — not `globalPassThroughEnv` — because it is a build-time var that affects the cache hash.
4. Access it via `import { env } from '@/env'`.

## Complete Env Var Reference

| Variable                  | App            | Type              | Default                   | Description                                                                 |
| ------------------------- | -------------- | ----------------- | ------------------------- | --------------------------------------------------------------------------- |
| NODE_ENV                  | server         | string enum       | `development`             | Runtime environment mode                                                    |
| DORKOS_PORT               | server         | number            | `4242`                    | Express server port                                                         |
| DORKOS_DEFAULT_CWD        | server         | string \| undefined | —                       | Default working directory for new sessions                                  |
| DORKOS_BOUNDARY           | server         | string \| undefined | —                       | Directory access boundary for file browsing security                        |
| DORKOS_LOG_LEVEL          | server         | number \| undefined | —                       | Log verbosity: 0=Error 1=Warn 2=Info 3=Debug 4=Trace                       |
| DORK_HOME                 | server         | string \| undefined | —                       | Config/storage directory (defaults to `~/.dork` in production)             |
| DORKOS_VERSION            | server         | string \| undefined | —                       | Server version injected at build time by CLI package                        |
| CLIENT_DIST_PATH          | server         | string \| undefined | —                       | Path to built React client assets (set by CLI package)                      |
| DORKOS_PULSE_ENABLED      | server         | boolean           | `false`                   | Enable the Pulse scheduler subsystem                                        |
| DORKOS_RELAY_ENABLED      | server         | boolean           | `false`                   | Enable the Relay inter-agent message bus                                    |
| DORKOS_MESH_ENABLED       | server         | boolean           | `false`                   | Enable the Mesh agent discovery registry                                    |
| TUNNEL_ENABLED            | server         | boolean           | `false`                   | Enable ngrok tunnel on startup                                              |
| TUNNEL_PORT               | server         | number \| undefined | —                       | Port to expose via ngrok (defaults to DORKOS_PORT)                          |
| TUNNEL_AUTH               | server         | string \| undefined | —                       | Basic auth credentials for the tunnel (`user:password`)                     |
| TUNNEL_DOMAIN             | server         | string \| undefined | —                       | Custom ngrok domain                                                         |
| NGROK_AUTHTOKEN           | server         | string \| undefined | —                       | ngrok authentication token                                                  |
| MODE                      | client         | string enum       | `development`             | Vite build mode                                                             |
| DEV                       | client         | boolean           | `false`                   | True when running in Vite dev server                                        |
| ROADMAP_PORT              | roadmap        | number            | `4243`                    | Roadmap app Express server port                                             |
| ROADMAP_PROJECT_ROOT      | roadmap        | string            | `process.cwd()`           | Root directory for roadmap project files                                    |
| NODE_ENV                  | roadmap        | string enum       | `development`             | Runtime environment mode                                                    |
| NODE_ENV                  | web            | string enum       | `development`             | Runtime environment mode                                                    |
| NEXT_PUBLIC_POSTHOG_KEY   | web            | string \| undefined | —                       | PostHog analytics project API key                                           |
| NEXT_PUBLIC_POSTHOG_HOST  | web            | string            | `https://app.posthog.com` | PostHog analytics ingestion host                                            |
| NODE_ENV                  | cli            | string enum       | `development`             | Runtime environment mode                                                    |
| DORK_HOME                 | cli            | string \| undefined | —                       | Config/storage directory (displayed in `dorkos config` output)             |
| LOG_LEVEL                 | cli            | string \| undefined | —                       | CLI logging verbosity                                                       |
