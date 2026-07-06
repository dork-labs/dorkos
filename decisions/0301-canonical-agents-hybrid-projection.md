---
number: 301
title: Project a canonical .agents source to every harness via hybrid discovery and vendored maps
status: accepted
created: 2026-06-29
spec: harness-sync
superseded-by: null
---

# 301. Project a canonical .agents source to every harness via hybrid discovery and vendored maps

## Status

Accepted (implemented in spec: harness-sync, `@dorkos/harness`)

## Context

DorkOS abstracts the agent _runtime_ (`AgentRuntime`) but not the _files each agent reads_ — skills, instructions, hooks, and commands differ per harness (Claude Code, Codex, Cursor, Gemini, Copilot). Today the projection is partial and hand-maintained: per-skill symlinks plus an unschema'd `.agents/harness.manifest.json` that is half derivable boilerplate. The external tools rulesync/ruler cannot read `.agents/`, expose no plugin API, and only copy (never symlink), and their valuable cross-agent maps are module-internal (not importable); the spike (DOR-136) confirmed this against rulesync `9.0.2`.

## Decision

We will keep `.agents/<name>` as the canonical source and project **per artifact type**: symlink identical-format artifacts (skills), scaffold instructions (ADR-302), and generate transformed ones (hooks, commands). Discovery is **hybrid** — a filesystem scan derives the common symlink case, while a **slimmed, Zod-schema'd** manifest carries only non-derivable policy and exceptions. We will **vendor** rulesync's hook-event maps and path constants (MIT, pinned to commit `b4bf09d5`, attributed) rather than adopt rulesync-the-tool, authoring Gemini's maps in-repo (rulesync has none). We own the projector, which emits an explicit per-harness drop list (honesty over false parity).

## Consequences

### Positive

- Preserves live single-source skill editing (symlinks), with full control over targets and fields.
- No fork-maintenance burden; the vendored slice is small, static, and MIT.
- The slimmed manifest removes ~half its entries, so every remaining line is genuine intent and drift is structurally reduced.
- An honest, always-emitted drop list (no silent omission) — the adoption gate for source-reading users.

### Negative

- We maintain the vendored maps and a periodic re-vendor checklist (the upstream surfaces move).
- We own and test the projector itself.
- The existing manifest needs a one-time slim + schema migration.
