---
number: 42
title: Use Manual Zod Validation for Env Vars, Not T3 Env
status: draft
created: 2026-02-25
spec: env-var-discipline
superseded-by: null
---

# 42. Use Manual Zod Validation for Env Vars, Not T3 Env

## Status

Draft (auto-extracted from spec: env-var-discipline)

## Context

DorkOS needed a strategy for centralizing env var validation across a Turborepo monorepo with five distinct runtime targets: a Node.js Express server, a React/Vite browser SPA, a Next.js SSR marketing site, a CLI package bundled with esbuild to CJS, and a roadmap Express server. Each app reads a different set of env vars from `process.env` (or `import.meta.env` in the client). T3 Env (`@t3-oss/env-core`) is the de-facto community standard for this use case in T3-stack projects and provides server/client separation, `extends` composition for monorepos, and Vite/Next.js adapters. Zod is already a core dependency across all DorkOS packages.

## Decision

Use hand-written Zod schemas in per-app `env.ts` files rather than adopting T3 Env. Each app defines its own `z.object({...}).safeParse(process.env)` schema and exports a typed `env` object. No new library dependency is added.

## Consequences

### Positive

- Zod is already a dependency everywhere — zero new packages, no additional supply chain surface
- Defaults (`z.coerce.number().default(4242)`) always apply, including during Vitest test runs — no special `skipValidation` escape hatch needed
- Works identically in CJS (esbuild CLI bundle) and ESM contexts — T3 Env is ESM-only
- Schema style is consistent with the existing `packages/shared/src/config-schema.ts` pattern the team already writes
- Predictable behavior: there are no hidden modes, platform adapters, or library-specific runtime checks to understand

### Negative

- No runtime enforcement of the server/client boundary — relies on FSD layer import rules and Vite's `VITE_*` prefix stripping instead of a T3 Env runtime throw
- Env var names shared across apps (e.g., `NODE_ENV`, `DORK_HOME`) are declared independently in each app's schema — minor duplication
- T3 Env's `extends` composition for monorepo-level schema sharing is not available

### Why T3 Env was rejected

Three open GitHub issues confirmed reliability problems in test environments: `skipValidation` does not apply Zod defaults (issues #155 and #266), and extended configurations do not inherit `skipValidation` from the consuming app (issue #323). As of Feb 2026 these remain unresolved. Relying on `skipValidation` to make tests pass — and having it silently break `.default()` values — is a worse trade-off than the minor code duplication from per-app schemas.
