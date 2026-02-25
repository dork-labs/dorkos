---
number: 21
title: Restructure Server Services into Domain Folders
status: draft
created: 2026-02-24
spec: relay-external-adapters
superseded-by: null
---

# 21. Restructure Server Services into Domain Folders

## Status

Draft (auto-extracted from spec: relay-external-adapters)

## Context

The `apps/server/src/services/` directory contains 24 service files in a flat structure. The `.claude/rules/server-structure.md` threshold is: < 15 flat OK, 15-20 suggest grouping, 20+ restructure required. Adding adapter-related services would push the count to ~30. Services naturally cluster into domains: session management, Pulse scheduler, Relay messaging, and core infrastructure.

## Decision

Group server services into four domain folders: `services/core/` (14 files — agent, SDK, config, commands, MCP, tunnel, etc.), `services/session/` (6 files — broadcaster, lock, transcript, parser, tasks), `services/pulse/` (3 files — store, scheduler, state), `services/relay/` (2+ files — state, adapter-manager). Each domain folder gets a barrel `index.ts` for cleaner imports.

## Consequences

### Positive

- Services organized by domain — easier to navigate and understand
- Accommodates adapter-related services cleanly under `services/relay/`
- Barrel exports provide clean import boundaries
- Follows `.claude/rules/server-structure.md` guidance

### Negative

- Requires updating all import paths across `apps/server/` (routes, index.ts, lib/)
- Wider blast radius — touches many files for a mechanical refactor
- Barrel exports add a layer of indirection
