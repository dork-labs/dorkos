---
number: 88
title: Per-Package ESLint Config with Shared Config Package
status: proposed
created: 2026-03-06
spec: eslint-per-package-config
superseded-by: null
---

# 88. Per-Package ESLint Config with Shared Config Package

## Status

Proposed

## Context

The monorepo uses a single root `eslint.config.js` (276 lines, 11 config blocks) that lints all packages from one file. ESLint 9 flat config has a `no-restricted-imports` overwrite problem: when two config objects both match the same files and both define `no-restricted-imports`, the later one completely replaces the earlier one's patterns/paths arrays. As package-specific rules grow (FSD boundaries for client, SDK confinement for server, env var discipline per-package), this conflict risk increases. Additionally, Turborepo can only cache lint results at the granularity of the config — a single root config means changing client code re-lints the entire monorepo.

## Decision

Decompose the root ESLint config into per-package `eslint.config.js` files with a shared `@dorkos/eslint-config` internal workspace package providing composable presets (`base`, `react`, `node`, `test`). This mirrors the existing `@dorkos/typescript-config` pattern. Each package owns its config and any package-specific rules. The shared config package centralizes all ESLint plugin dependencies. All `no-restricted-imports` rules are package-local — never in the shared config.

## Consequences

### Positive

- Structurally eliminates `no-restricted-imports` overwrite problem (each package's config is an independent array)
- Turborepo lint cache becomes per-package (granular invalidation)
- Consistent with Turborepo's official recommendation and existing `@dorkos/typescript-config` pattern
- Each package's ESLint config is readable in isolation — contributors don't need to understand other packages' rules
- Plugin dependencies centralized in one place; no version drift

### Negative

- 17 new files (4 shared config + 12 per-package configs + thinned root)
- Shared config package needs maintenance when adding new universal rules
- `pnpm install` after initial setup to register the new workspace package
