---
number: 4
title: Adopt Turborepo Monorepo with npm Workspaces
status: accepted
created: 2026-02-11
spec: monorepo-turborepo-migration
superseded-by: null
---

# 0004. Adopt Turborepo Monorepo with npm Workspaces

## Status

Accepted

(2026-08-06 audit) The monorepo decision stands; the app roster named here predates the current client/server/site/desktop/obsidian-plugin/e2e layout.

## Context

The project shipped three independent build targets (React SPA, Express API, Obsidian plugin) from a single `package.json` with 36 flat dependencies. All three builds ran sequentially with no caching. The Obsidian plugin used deep relative imports like `../../server/services/agent-manager` to reach server code, encoding directory structure into business logic. Every `npm install` touched all dependencies regardless of what changed.

## Decision

We will migrate to a Turborepo monorepo with npm workspaces, splitting the codebase into packages grouped as apps and shared libraries. Current shape: 5 apps (`@dorkos/client`, `@dorkos/server`, `@dorkos/web`, `@dorkos/obsidian-plugin`, `@dorkos/roadmap`) and 4 shared packages (`@dorkos/shared`, `@dorkos/typescript-config`, `@dorkos/test-utils`, `dorkos` CLI). Each package owns its `package.json`, build config, and TypeScript config. Imports use workspace package names (`@dorkos/shared/types`) instead of relative paths. Turborepo's `turbo.json` defines task dependency graph for parallel builds.

## Consequences

### Positive

- Build caching skips unchanged packages; client-only changes don't rebuild server or plugin
- Client and server build in parallel after shared completes
- Explicit dependency declarations in each `package.json` prevent accidental cross-package coupling
- New packages (e.g., `packages/cli`) are first-class citizens with isolated configs

### Negative

- Added build system complexity; `turbo.json` task dependencies must be configured correctly
- Each package needs its own `package.json`, `tsconfig.json`, and build config (boilerplate)
- Symlinked packages in `node_modules` can confuse debuggers and stack traces
- Changes to `@dorkos/shared` force rebuilds of all dependent packages
