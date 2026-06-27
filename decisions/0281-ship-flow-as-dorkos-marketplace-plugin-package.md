---
number: 281
title: Ship /flow as a DorkOS Marketplace Plugin-Type Package from P1
status: proposed
created: 2026-06-14
spec: unified-workflow-system
superseded-by: null
---

# 281. Ship /flow as a DorkOS Marketplace Plugin-Type Package from P1

## Status

Proposed

## Context

The system should be one identifiable installable unit and eventually a Claude Code / DorkOS plugin, without a later rewrite to extract it.

## Decision

Build `.agents/flow/` as a DorkOS marketplace `plugin`-type package from Phase 1, embedding a `.claude-plugin/plugin.json` via `requiresClaudePlugin()`. v1 contributes commands/skills/hooks/templates with no `extensions` layer (that server layer is P5). `.agents/` stays the cross-harness glue; the harness manifest syncs skills only, while commands and hooks remain Claude-native (registered, not synced).

## Consequences

### Positive

- One identifiable installable unit on day one; on-mission dogfooding of our own package format.
- Extracting the later product extension is additive, not a rewrite.

### Negative

- Packaging overhead in v1.
- A fully self-contained, fully-synced `.agents/flow/` is the plugin end-state, not the v1 layout.

## Amendments

### 2026-06-26 - repo home resolved + engine ships as `scripts/` (spec #264, DOR-134)

Spec `flow-marketplace-package` (#264, umbrella DOR-133) resolves two open points left by the
original decision. The original Decision and Status above are unchanged; this records what later work
pinned down.

- **Repo home is canonical `.agents/flow/`, with no separate flow repo.** The package is _built and
  projected_ from `.agents/flow/` rather than extracted into its own repository. The projection
  engine plus `dorkos package build` de-risk the drift that a separate repo would otherwise
  introduce, so a single canonical source stays authoritative.
- **The deterministic engine ships as the plugin's `scripts/` (delete `@dorkos/flow`).** The unused
  `@dorkos/flow` workspace package is removed; its decision oracles move to `.agents/flow/engine/`
  (authoring + vitest) and ship as compiled, dependency-free `.mjs` in the plugin's
  `.agents/flow/scripts/`. The stage skills _call_ the scripts instead of re-deriving the ladders in
  prose. See ADR-0294 for the full rationale.

Cross-references: spec #264 (`specs/flow-marketplace-package/`), DOR-134, ADR-0294, ADR-0295,
ADR-0296.
