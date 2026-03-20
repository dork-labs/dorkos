---
title: 'Turborepo + dotenv-cli: Environment Variable Handling Research'
date: 2026-02-22
type: implementation
status: active
tags: [turborepo, env-vars, dotenv, strict-mode, passthrough, build]
---

# Turborepo + dotenv-cli: Environment Variable Handling Research

**Date**: 2026-02-22
**Research Depth**: Deep
**Searches Performed**: 12
**Scope**: Best practices, known issues, alternatives for env var management in Turborepo monorepos

---

## Research Summary

The DorkOS root `package.json` pattern of `"dev": "dotenv -- turbo dev"` is a widely used but imperfect approach. It works, but only because DorkOS is running without `envMode: strict` and the `dev` task has `cache: false`. The core issue is that Turborepo 2.0 made strict env var mode the **default**, which broke dotenv-cli for many teams. The current DorkOS setup sidesteps this because `dev` is persistent/uncached, but `build`, `test`, and `typecheck` commands may silently not receive vars loaded by dotenv-cli if strict mode filtering intercepts them. There are cleaner, more explicit alternatives that remove this ambiguity entirely.

---

## Key Findings

### 1. The dotenv-cli + turbo Pattern: Partially Recommended

The `"dev": "dotenv -- turbo dev"` pattern appears in Turborepo's own older handbook documentation and is a community-standard approach. However:

- **Turborepo 2.0 (released 2024) changed the default to strict env mode**, which filters out env vars not explicitly declared in `turbo.json`. This broke the pattern for many users post-upgrade.
- dotenv-cli loads vars into the shell environment that invokes `turbo`, and `turbo` then decides what to pass down to child task processes — the "child process receives nothing" failure mode is caused by turbo's strict mode filtering, not by dotenv-cli itself.
- The issue tracker shows this as a persistent pain point: [Discussion #7056](https://github.com/vercel/turborepo/discussions/7056), [Issue #8454](https://github.com/vercel/turborepo/issues/8454), [Discussion #8905](https://github.com/vercel/turborepo/discussions/8905).
- Turborepo maintainers closed Issue #8454 as "not planned" — they consider strict mode the correct default and expect teams to explicitly declare vars.

**DorkOS current situation**: Because the `dev` task has `cache: false` and `persistent: true`, Turborepo's caching engine is not involved and does not filter env vars by hash key. This means dotenv-cli vars _do_ reach the server/client dev processes in practice. However, this is not guaranteed to be the documented behavior — it is a side effect of the caching being disabled.

### 2. The Three Configuration Axes in turbo.json

Turborepo provides three independent mechanisms, frequently confused with each other:

| Config Key                                | Scope         | Affects Cache Hash? | Purpose                                                                            |
| ----------------------------------------- | ------------- | ------------------- | ---------------------------------------------------------------------------------- |
| `env` / `globalEnv`                       | Task / Global | **Yes**             | Variables that should bust cache when they change                                  |
| `passThroughEnv` / `globalPassThroughEnv` | Task / Global | **No**              | Variables that must be available at runtime but should not affect caching          |
| `envMode`                                 | Global        | N/A                 | `strict` (default) = filter to declared vars only; `loose` = pass all vars through |

**The core rule**: In `strict` mode (default since Turborepo 2.0), only vars declared in `env`, `globalEnv`, `passThroughEnv`, or `globalPassThroughEnv` reach task processes. All others are silently filtered out regardless of whether dotenv-cli loaded them.

**For dev tasks specifically**: `cache: false` + `persistent: true` means the cache hash calculation doesn't run, so `env`/`globalEnv` declarations are irrelevant for runtime. But in strict mode, the runtime filter still applies. You must use `passThroughEnv` (not `env`) for vars that should be available to dev processes without affecting cache.

### 3. Turborepo 2.0 Breaking Change Summary

The Turborepo 2.0 upgrade silently broke dotenv-cli patterns for many teams:

- **Before 2.0**: All shell env vars were automatically passed through (loose mode was the default)
- **After 2.0**: Strict mode became the default; unlisted vars are silently filtered
- **Symptom**: `process.env.MY_VAR` is `undefined` inside the task, despite dotenv-cli loading the `.env` file successfully
- **The filter happens at the turbo orchestrator level**, before the task subprocess is spawned
- Confirmed via: [Discussion #8432](https://github.com/vercel/turborepo/discussions/8432), [Issue #8454](https://github.com/vercel/turborepo/issues/8454)

### 4. dotenv-cli Override Behavior

dotenv-cli (the `entropitor/dotenv-cli` package used in DorkOS) has a specific priority model:

- **Default behavior**: Shell env vars win over `.env` file values. If `DORKOS_PORT` is already set in the shell, dotenv-cli will **not** override it.
- **To force .env values to win**: Use the `-o` / `--override` flag: `dotenv -o -- turbo dev`
- **Multiple files**: `dotenv -e .env -e .env.local -- turbo dev` (first file wins for conflicts)
- **Source of truth**: [entropitor/dotenv-cli README](https://github.com/entropitor/dotenv-cli)

This is the correct behavior for most workflows — developers can override individual vars in their shell without editing `.env`. But it means a CI environment that pre-sets `DORKOS_PORT` will silently ignore the `.env` file value.

### 5. Turborepo Does Not Load .env Files Itself

This is frequently misunderstood: **Turborepo has no `.env` loading capability**. The `globalDotEnv` and `dotEnv` configuration keys in `turbo.json` exist only to tell Turborepo to **watch those files for changes** and include their contents in the **cache hash calculation**. They do not cause Turborepo to actually inject the variables into task environments.

The actual loading must be done by:

- The app's framework (Vite, Next.js, etc. load their own `.env.*` files)
- dotenv-cli wrapping the turbo command
- dotenvx
- Node.js `--env-file` flag (Node 20.6+)

Turborepo's official guidance: "We recommend placing your `.env` files into the Application Packages where they're used." Root-level `.env` files are acknowledged only for incremental monorepo migrations.

---

## Analysis of DorkOS Current Setup

```json
// package.json
"dev": "dotenv -- turbo dev"
"build": "dotenv -- turbo build"
"test": "dotenv -- turbo test"

// turbo.json
"dev": { "cache": false, "persistent": true }
"build": { "env": ["NODE_ENV", "VITE_*", "DORKOS_PORT", "NGROK_*", ...] }
```

**What works correctly**:

- `npm run dev`: dotenv-cli loads `.env`, passes vars to turbo. Because `dev` is `cache:false/persistent`, the caching machinery does not filter vars. The server process receives them.
- The `.env.example` documents exactly which vars exist, which is good hygiene.

**What has risk**:

- `npm run build` / `npm run test`: dotenv-cli loads vars into the turbo invocation environment, but turbo 2.x strict mode will only pass declared vars to child processes. The `build` task declares `DORKOS_PORT`, `VITE_*` etc. in `env` — these are covered. But any vars from `.env` that are NOT in the `env` array will be silently dropped.
- `npm run test` / `npm run typecheck`: No `env` declarations at all. In strict mode, custom vars from `.env` will not be available to test processes unless they are declared.
- **The `turbo` binary at version `^2.8.7` is running in strict mode by default** — this is the current version in DorkOS.

**Specific gap**: `DORK_HOME`, `DORKOS_LOG_LEVEL`, `DORKOS_DEFAULT_CWD`, `DORKOS_BOUNDARY`, `DORKOS_PULSE_ENABLED`, `TUNNEL_*`, `NGROK_*` vars are loaded by dotenv-cli but not all are declared in `turbo.json`. The build task covers `NGROK_*` and `TUNNEL_*` via wildcards, and `DORKOS_PORT`. But `DORK_HOME`, `DORKOS_LOG_LEVEL`, `DORKOS_DEFAULT_CWD`, `DORKOS_BOUNDARY`, `DORKOS_PULSE_ENABLED` are not in the `build` task's `env` array and are absent from `test`/`typecheck` entirely.

---

## Recommended Alternatives

### Option A: Use `passThroughEnv` for Runtime-Only Vars (Preferred for DorkOS)

This is the most correct approach given DorkOS's structure. Vars like `DORKOS_PORT`, `DORK_HOME`, `DORKOS_LOG_LEVEL` should not bust the build cache when changed — they are runtime configuration, not build-time inputs. They belong in `passThroughEnv`, not `env`.

```json
// turbo.json
{
  "globalPassThroughEnv": [
    "DORKOS_PORT",
    "DORKOS_DEFAULT_CWD",
    "DORKOS_BOUNDARY",
    "DORKOS_LOG_LEVEL",
    "DORK_HOME",
    "DORKOS_PULSE_ENABLED",
    "TUNNEL_ENABLED",
    "TUNNEL_PORT",
    "TUNNEL_AUTH",
    "TUNNEL_DOMAIN",
    "NGROK_AUTHTOKEN"
  ],
  "tasks": {
    "build": {
      "env": ["NODE_ENV", "VITE_*", "NEXT_PUBLIC_*", "POSTHOG_*"]
      // Remove runtime vars from env, they don't affect build outputs
    },
    "dev": {
      "cache": false,
      "persistent": true
      // passThroughEnv inherited from globalPassThroughEnv
    }
  }
}
```

`globalPassThroughEnv` makes vars available to all tasks at runtime without affecting any cache keys. The dotenv-cli wrapper in `package.json` continues to handle loading from `.env`.

### Option B: Add `"envMode": "loose"` to turbo.json

The quickest escape hatch. Restores Turborepo 1.x behavior — all shell vars pass through to all tasks.

```json
// turbo.json
{
  "envMode": "loose",
  ...
}
```

**Downsides**: Undermines Turborepo's cache correctness guarantees. Build cache may produce false hits if an unlisted env var affects a build artifact. The Turborepo team discourages this except as a migration step.

### Option C: Per-workspace .env Files + Framework Loading

Move away from root `.env` entirely. Let each app load its own env via its framework:

- `apps/server/.env` — loaded by the Express startup code via `dotenv.config()` or the `--env-file` Node.js flag
- `apps/client/.env` — loaded automatically by Vite
- Root `.env` removed

This is Turborepo's official recommended pattern. It requires each workspace to explicitly `dotenv.config()` at startup (the server already likely does this via the `config-manager`).

**Advantage**: Eliminates the need for dotenv-cli at the root level entirely. No more `dotenv --` wrapping. Each framework handles its own env loading.

**Downside for DorkOS**: The server shares vars with multiple concerns (DORKOS_PORT used by both server and client dev proxy). Would require duplication or a shared env-loading package.

### Option D: dotenvx (Modern Replacement)

Drop dotenv-cli, install dotenvx. Same syntax but adds encryption support and better monorepo handling.

```json
"dev": "dotenvx run -- turbo dev"
```

No behavioral difference for the core passthrough problem — dotenvx still loads vars into the shell before turbo runs, and turbo's strict mode still filters them. But dotenvx provides encryption for production secrets in `.env.production`.

### Option E: Node.js 20.6+ `--env-file` Flag (Server-specific)

For the server app specifically, use Node's built-in env loading:

```json
// apps/server/package.json
"dev": "node --env-file=../../.env --watch src/index.ts"
```

Bypasses dotenv-cli entirely for the server. Vite has its own `--env-file` mechanism as well. This only works if Turborepo's strict mode isn't blocking the vars — but since `dev` is `cache:false`, it doesn't.

---

## Red Flags in the Current Pattern

1. **Silent failures**: If a var in `.env` is not declared in `turbo.json`'s `env` or `passThroughEnv`, it silently becomes `undefined` in build/test tasks. No warning is emitted.

2. **turbo 2.x strict mode is active**: `turbo: "^2.8.7"` means strict mode is the default. The `dev` task avoids this (no caching), but `build`, `test`, and `typecheck` are subject to it.

3. **Vars in `build.env` that shouldn't be there**: `DORKOS_PORT` in `build.env` means changing the server port causes a build cache miss. This is probably not the intended behavior — port is runtime config, not build input. It should be in `passThroughEnv` if needed at build time.

4. **Root .env with Turborepo = known footgun**: Turborepo explicitly discourages root-level `.env` files. The requirement to use dotenv-cli to load a root `.env` is itself a sign of friction with Turborepo's model.

5. **No `env` declarations on `test` task**: Tests that read `process.env.DORKOS_PORT` will get `undefined` in CI if strict mode is active and the var is not declared. Server tests that mock services avoid this, but integration tests or tests that read env defaults could be silently incorrect.

---

## Concrete Recommendation for DorkOS

Given DorkOS's specific structure (root `.env`, monorepo-wide vars, Express server + Vite client):

**Short term** (low risk, high correctness gain): Add `globalPassThroughEnv` to `turbo.json` for all DorkOS runtime vars, and move `DORKOS_PORT` out of `build.env` into `globalPassThroughEnv`. Keep dotenv-cli as the loader.

```json
{
  "$schema": "https://turbo.build/schema.json",
  "ui": "tui",
  "globalPassThroughEnv": [
    "DORKOS_PORT",
    "DORKOS_DEFAULT_CWD",
    "DORKOS_BOUNDARY",
    "DORKOS_LOG_LEVEL",
    "DORK_HOME",
    "DORKOS_PULSE_ENABLED",
    "TUNNEL_ENABLED",
    "TUNNEL_PORT",
    "TUNNEL_AUTH",
    "TUNNEL_DOMAIN",
    "NGROK_AUTHTOKEN"
  ],
  "tasks": {
    "build": {
      "dependsOn": ["generate:api-docs", "^build"],
      "outputs": ["dist/**", "dist-server/**", "dist-obsidian/**", ".next/**"],
      "env": ["NODE_ENV", "VITE_*", "NEXT_PUBLIC_*", "POSTHOG_*"]
    },
    ...
  }
}
```

**Medium term** (cleaner architecture): Move env loading into the apps. Remove root dotenv-cli dependency. Let Vite and the Express server load their own `.env` files.

**Do not use `envMode: loose`** — it defeats caching and is a temporary escape hatch, not a permanent solution.

---

## Contradictions and Disputes

- Turborepo docs say "place `.env` files in apps", but the same docs acknowledge root `.env` is acceptable for incremental migrations — DorkOS's root `.env` is effectively a permanent fixture, which creates ongoing friction.
- Some community members argue `envMode: loose` is fine for dev-only repos that don't use remote caching — they're not wrong, but it's an implicit design choice that should be explicit.
- The Turborepo team closed Issue #8454 ("dotenv-cli broken in 2.0.3") as "not planned," treating strict mode as the correct behavior. The community largely disagrees for dev-only use cases. The eventual addition of `envMode: loose` as a turbo.json option (shipped in v2.1.0) was a concession to this pressure.

---

## Research Gaps

- No definitive documentation on whether `cache: false` + `persistent: true` tasks bypass strict mode env filtering at runtime (as opposed to at hash time). Empirical reports suggest they do not bypass it, meaning strict mode still filters vars even for uncached tasks. This needs verification.
- Turborepo changelog for 2.1.x–2.8.x not fully reviewed for additional env var behavior changes.

---

## Sources and Evidence

- [Using Environment Variables (turborepo.dev)](https://turborepo.dev/docs/crafting-your-repository/using-environment-variables) — Official reference for env, passThroughEnv, envMode
- [Configuring turbo.json Reference](https://turborepo.dev/docs/reference/configuration) — Full config schema with all env options
- [Discussion #7056: Env vars not passing through as documented](https://github.com/vercel/turborepo/discussions/7056) — Community reports of dotenv-cli issues
- [Issue #8454: dotenv-cli broken after 2.0.3 upgrade](https://github.com/vercel/turborepo/issues/8454) — Closed as "not planned"; strict mode confirmed as root cause
- [Discussion #8905: Env vars not passing through in CI after 2.0 upgrade](https://github.com/vercel/turborepo/discussions/8905) — `--env-mode=loose` as only workaround for some teams
- [Discussion #8432: 2.0 migration env var difficulties](https://github.com/vercel/turborepo/discussions/8432) — Maintainer acknowledges documentation gaps
- [Discussion #8611: Allow envMode:loose in turbo.json](https://github.com/vercel/turborepo/discussions/8611) — Feature request, eventually shipped in v2.1.0
- [Discussion #9458: Composing environment variables](https://github.com/vercel/turborepo/discussions/9458) — Community patterns for monorepo env management
- [Discussion #10447: Root .env undefined](https://github.com/vercel/turborepo/discussions/10447) — Confirms Turborepo does not load .env files
- [entropitor/dotenv-cli GitHub](https://github.com/entropitor/dotenv-cli) — Default behavior (shell vars win), -o flag for override
- [dotenvx Turborepo integration](https://dotenvx.com/docs/monorepos/turborepo) — Encrypted .env alternative
- [Turborepo Handbook: Environment Variables](https://turborepo.dev/repo/docs/handbook/environment-variables) — Discourages root .env, recommends per-app placement

---

## Search Methodology

- Searches performed: 12
- Most productive terms: "turborepo 2.0 dotenv-cli strict mode", "passThroughEnv globalPassThroughEnv", "envMode loose turbo.json", "root .env undefined turborepo"
- Primary sources: turborepo.dev official docs, github.com/vercel/turborepo issues/discussions, github.com/entropitor/dotenv-cli
