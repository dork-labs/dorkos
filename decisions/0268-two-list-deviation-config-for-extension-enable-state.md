---
number: 268
title: Two-List Deviation Config for Extension Enable State
status: draft
created: 2026-06-13
spec: core-extensions
superseded-by: null
---

# 268. Two-List Deviation Config for Extension Enable State

## Status

Draft (auto-extracted from spec: core-extensions)

## Context

DorkOS's config stored extension state as a single `extensions.enabled: string[]` — an opt-in allowlist that cannot express "default-on." A fresh user's empty config means "everything off," which is wrong for a Core Extensions tier where some extensions (e.g. Dork Hub) should ship enabled. Alternatives considered: a per-extension `{ [id]: boolean }` map (ambiguous default for IDs absent on upgrade) and a tri-state map (correct but verbose, still needs a per-tier default lookup).

## Decision

Represent user choices as two **deviation lists**: keep `enabled` (IDs turned on that default off) and add `disabled` (IDs turned off that default on). Resolution: a default-on extension is enabled unless its id is in `disabled`; a default-off extension is enabled only if its id is in `enabled`. Both lists record deviations from each extension's baseline, mirroring JetBrains' `disabled_plugins.txt` generalized to two defaults. A new core extension shipped on upgrade is absent from both lists and resolves to its declared default — no migration needed for the common case.

## Consequences

### Positive

- Cleanly expresses both default-on and default-off extensions with one model.
- Backward-compatible and additive (existing `enabled` semantics unchanged); a single version-keyed migration backfills `disabled: []`.
- Upgrade behavior is unambiguous: new core extensions adopt their declared default automatically.

### Negative

- Two lists are slightly less obvious to a config hand-editor (mitigated by a load-time warning when a default-on id appears in `enabled`).
- Resolution logic must be centralized to avoid drift between discovery and toggle code (addressed via a shared pure helper).
