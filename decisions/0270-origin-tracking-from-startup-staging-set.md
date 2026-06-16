---
number: 270
title: Derive Extension Origin from the Startup Staging Set
status: proposed
created: 2026-06-13
spec: core-extensions
superseded-by: null
---

# 270. Derive Extension Origin from the Startup Staging Set

## Status

Proposed

## Context

The Core Extensions tier needs to distinguish first-party "core" extensions from user-installed ones (to drive the settings UI split and tier-aware enable resolution). Core extensions are staged into the same `{dorkHome}/extensions/` directory as user-global extensions, so runtime location alone cannot distinguish them. Options considered: a marker file per staged dir (brittle), a separate runtime directory (changes the discovery contract), or a manifest `core: true` claim (spoofable by user extensions).

## Decision

Derive `origin: 'core' | 'user'` from the startup staging step. `ensureCoreExtensions()` scans the bundled `apps/server/src/core-extensions/` source tree and returns the exact set of IDs it staged plus their tier metadata. That set is threaded into discovery, which sets `origin = coreIds.has(id) ? 'core' : 'user'` after the global/local merge. This mirrors VS Code's `isBuiltin` (knowledge of what shipped) rather than trusting a manifest field. `origin` is added to `ExtensionRecord`/`ExtensionRecordPublic` and surfaced to the client.

## Consequences

### Positive

- Authoritative and unspoofable — origin reflects what the app actually bundled, not a self-declared field.
- No new runtime directory or marker files; the discovery contract (`{dorkHome}/extensions/`) is unchanged.
- Tier metadata (`defaultEnabled`, `canDisable`) travels with the same staging result, single source of truth.

### Negative

- Discovery gains a dependency on the staging result (must be threaded from `index.ts` through the manager).
- A local `.dork/extensions/<id>` override of a core id is an edge case; origin stays `core` by id membership while using the overriding code.
