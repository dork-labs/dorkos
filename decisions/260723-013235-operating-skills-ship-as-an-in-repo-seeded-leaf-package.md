---
id: 260723-013235
title: Operating DorkOS skills ship as an in-repo leaf package with hash-stamped seeding
status: accepted
created: 2026-07-23
spec: agents-as-operators
superseded-by: null
---

# 260723-013235. Operating DorkOS skills ship as an in-repo leaf package with hash-stamped seeding

## Status

Accepted

## Context

No first-party skills taught agents how to operate DorkOS; fresh agent workspaces got only an AGENTS.md stub and a two-URL pointer block (ADR-0185). The knowledge had to reach every harness (Harness Sync projects `.agents/skills/`), survive the CLI's esbuild bundle, and update across releases without clobbering user edits. Marketplace distribution was considered and rejected for v1: it adds cross-repo coordination with no phase-1 benefit.

## Decision

We will ship the five "Operating DorkOS" skills as `@dorkos/operating-skills`, an in-repo leaf package (mirroring `@dorkos/harness`) whose skill bodies are TypeScript string constants. Seeding runs at agent creation and on every DorkBot boot, wrapped in try/catch so a failure degrades to a warning and never blocks boot or creation. Each seeded SKILL.md carries a frontmatter stamp (pack marker, pack version, body content hash); re-seeding overwrites only when the pack version is newer AND the on-disk body still matches its stamp, so user-modified copies and foreign same-name skills are always preserved. Marketplace distribution is revisited in phase 4 when agents author skills.

## Consequences

### Positive

- Every new agent and DorkBot get operating knowledge automatically, projected to all harnesses by the existing Harness Sync engine with zero engine changes.
- The stamp protocol makes seeding idempotent and edit-safe, and generalizes to any future first-party content pack.

### Negative

- Skill content updates require a DorkOS release (acceptable pre-launch; the phase-4 marketplace path lifts this).
- Skill bodies as TS constants are less pleasant to author than plain markdown files; the tradeoff buys esbuild-bundle survival.
