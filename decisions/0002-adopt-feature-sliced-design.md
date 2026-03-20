---
number: 2
title: Adopt Feature-Sliced Design for Client Architecture
status: accepted
created: 2026-02-15
spec: fsd-architecture
superseded-by: null
---

# 0002. Adopt Feature-Sliced Design for Client Architecture

## Status

Accepted

## Context

The client started with an ad-hoc domain-grouped structure (`components/{domain}/`, `hooks/`, `stores/`, `lib/`) that created friction as the codebase grew. Any file could import from any other file, making dependency direction unclear. Hooks used by a single feature lived in a global `hooks/` directory with no ownership signal. As the project anticipated scaling, the lack of import discipline and public API boundaries made refactoring risky and onboarding slow.

## Decision

We will adopt Feature-Sliced Design (FSD) with strict unidirectional layer imports in `apps/client/src/layers/`. The hierarchy is: `shared` (UI primitives, utilities) <- `entities` (business domain hooks) <- `features` (user-facing features) <- `widgets` (feature compositions). Every module exports a barrel `index.ts` defining its public API. Cross-layer peer imports (e.g., `features/chat` -> `features/status`) are forbidden for models/hooks, though UI composition is allowed.

## Consequences

### Positive

- Clear ownership: new developers can infer where code belongs from the layer and module name
- Encapsulation via barrel exports makes refactoring internal module structure safe
- Scales from 5 to 500 files; new features are self-contained slices
- Reduced coupling between features prevents spaghetti dependencies

### Negative

- Initial overhead: ~20 directories and barrel files required before writing the first feature
- Simple 1-2 file features still require module directories with `ui/`, `model/`, and `index.ts`
- Layer rules are enforced as ESLint hard errors via `no-restricted-imports` in `eslint.config.js`, but cross-feature _model_ imports rely on `.claude/rules/fsd-layers.md` and code review rather than static analysis
