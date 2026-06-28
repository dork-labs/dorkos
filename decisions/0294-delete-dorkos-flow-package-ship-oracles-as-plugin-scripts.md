---
number: 294
title: Delete @dorkos/flow; ship the deterministic oracles as the plugin's scripts/
status: superseded
created: 2026-06-26
spec: flow-marketplace-package
superseded-by: 298
---

# 294. Delete @dorkos/flow; ship the deterministic oracles as the plugin's scripts/

## Status

Superseded by ADR-0298.

## Context

`@dorkos/flow` is a private, version-0.0.0 workspace package imported by nothing in the running
application; it holds the pure decision oracles (`selectDispatch`, `resolveInvolvement`, gates,
recovery, dedup) and the config schema. Its decision oracles import only types, so they compile to
dependency-free JavaScript. Today the `/flow` stage skills re-describe the same ranking and calibration
ladders in prose, which is both token-expensive and a drift risk (two encodings of one logic). The
`agentskills.io` standard and Anthropic's own guidance endorse bundling tested deterministic code in a
skill's `scripts/` ("sorting a list via token generation is far more expensive than running a sorting
algorithm").

## Decision

Delete the `@dorkos/flow` package. Move the oracle TypeScript source and its vitest suite into
`.agents/flow/engine/` and ship compiled, dependency-free `.mjs` in the plugin's `.agents/flow/scripts/`.
Stage skills **call** `node scripts/<oracle>.mjs` (JSON in, JSON out) instead of re-deriving the ladder
in prose. The single Zod touch (the config-schema validator) is a self-contained script. The future P5
server consumes the same scripts by shell-out or vendoring, not by `import`.

## Consequences

### Positive

- One source of truth for the deterministic logic; the prose/engine drift is eliminated.
- Ranking and gating run instantly, at ~0 tokens, and identically every time.
- The engine and the prose ship as one unit from one source (`.agents/flow/`), assembled into the package.

### Negative

- The P5 server (DOR-88 / DOR-90 / DOR-130) must shell-out to or vendor the scripts rather than import a
  package; those issues carry alignment notes.
- A small slice (the config validator) needs a runtime with on-the-fly dependency resolution (bun/deno) or
  a bundled Zod.
