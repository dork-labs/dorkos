---
number: 298
title: Ship the flow engine as runnable TypeScript, not compiled .mjs
status: draft
created: 2026-06-27
spec: flow-plugin-extraction
superseded-by: null
---

# 298. Ship the flow engine as runnable TypeScript, not compiled .mjs

## Status

Draft (auto-extracted from spec: flow-plugin-extraction)

## Context

ADR-0294 shipped the decision oracles as esbuild-compiled `.mjs`, which split the TypeScript source
(authored in dorkos) from the shipped artifact (the bundles). Once flow lives in ONE repo (ADR-0297),
that split is unnecessary, and it conflicts with the operator's requirement that the source IS the thing
you edit. The repo already runs `.ts` directly: `.claude/scripts/spec-manifest-ops.ts` ships with a
`#!/usr/bin/env -S node --experimental-strip-types` shebang, and `tsx` is used throughout.

## Decision

Ship the engine as runnable `.ts`. Stage skills call `node --experimental-strip-types scripts/<oracle>.ts`
(tsx as the older-Node fallback). The pure oracles strip to zero-runtime-dependency `.ts`; the single
zod touch (`validate-config`) is kept dependency-free in the shipped path by validating against the
committed `config.schema.json`, with zod retained as a DEV-only dependency for authoring the schema and
running the tests. There is no build step and nothing for a consumer to install. This SUPERSEDES the
esbuild-`.mjs` build of ADR-0294 (its "delete the consumed @dorkos/flow package; the runtime is scripts"
intent stands).

## Consequences

### Positive

- No build step; the source IS the shipped runtime; full TypeScript typing is retained.
- No source/artifact split; the plugin is editable in one place.
- Zero-runtime-dependency shipped plugin: adopters never compile or install.

### Negative

- Requires Node 22.6+ for `--experimental-strip-types` (documented; `tsx` covers older Node).
- `validate-config` needs a zod-free shipped validator (validating against `config.schema.json`) rather
  than reusing the zod schema at runtime.
