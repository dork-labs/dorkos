---
id: 260923-163516
title: A marketplace agent keeps its identity across an update by adopting its existing workspace
status: draft
created: 2026-09-23
spec: marketplace-package-file-ownership
superseded-by: null
---

# 260923-163516. A marketplace agent keeps its identity across an update by adopting its existing workspace

## Status

Draft (extracted from spec: marketplace-package-file-ownership). Delivers DOR-1791's recommended T1, which was never built.

## Context

An agent package's install root is the agent's working directory. Every agent install, the reinstall half of an update included, called `createAgentWorkspace({ skipTemplateDownload: true })`. That minted a fresh ULID and rewrote `.dork/agent.json`, `.dork/SOUL.md` and `.dork/NOPE.md`. Mesh read the new id at the old path as a branch swap and dropped the old row without the unregister cascade. Anything keyed on the agent id (schedules, room membership, memories, grants) silently lost its agent at every update (DOR-1791 F1).

## Decision

When the activated root already holds a readable `.dork/agent.json` (carried over under ADR 260923-163513), the agent flow calls `createAgentWorkspace(opts, { adoptExisting: true })`. The creator reuses that id and writes the manifest, SOUL.md and NOPE.md only where they are absent. `adoptExisting` is a server-internal second parameter, never a field on the public `CreateAgentOptionsSchema`, and requires `skipTemplateDownload`. A new version's `agentDefaults` apply to fresh installs only. A differing suggestion is reported, not applied. This is the same rule registration already follows (ADR 260903-023414: a directory holding a readable manifest is adopted, the id on disk wins, and the file is not written over), extended to the one creator path that still minted a new id over an existing manifest.

## Consequences

### Positive

- An updated marketplace agent keeps its id, persona, memory and schedules; mesh sees no branch swap.
- No HTTP caller can ask DorkOS to adopt an arbitrary directory's identity.

### Negative

- Improved `agentDefaults` in a new version do not reach existing installs automatically.

## Alternatives Considered

- **Preserve only `agent.json` as a special path.** Rejected: SOUL.md, NOPE.md and MEMORY.md need the same protection, and the general ownership rule already covers them.
- **Put `adopt` on `CreateAgentOptionsSchema`.** Rejected: that schema is the public `createAgent` transport contract.
