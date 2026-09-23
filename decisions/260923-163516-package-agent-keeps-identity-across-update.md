---
id: 260923-163516
title: A marketplace agent's identity files are its own, across update, reinstall and uninstall
status: draft
created: 2026-09-23
spec: marketplace-package-file-ownership
superseded-by: null
---

# 260923-163516. A marketplace agent's identity files are its own, across update, reinstall and uninstall

## Status

Draft (extracted from spec: marketplace-package-file-ownership). Delivers DOR-1791's recommended T1, which was never built.

## Context

An agent package's install root is the agent's working directory. Every agent install, the reinstall half of an update included, called `createAgentWorkspace({ skipTemplateDownload: true })`. That minted a fresh ULID and rewrote `.dork/agent.json`, `.dork/SOUL.md` and `.dork/NOPE.md`. Mesh read the new id at the old path as a branch swap and dropped the old row without the unregister cascade. Anything keyed on the agent id (schedules, room membership, memories, grants) silently lost its agent at every update (DOR-1791 F1).

## Decision

An agent package's `.dork/agent.json`, `.dork/SOUL.md`, `.dork/NOPE.md` and `.dork/MEMORY.md` are the agent's, never the package's. They are never recorded as package files, and a package's shipped copy only seeds an install where the file is absent.

**Install.** Every marketplace agent install, fresh or not, calls `createAgentWorkspace(input, meshCore, { marketplace: true })`. The third parameter is server-internal, never on the public `CreateAgentOptionsSchema`, and requires `skipTemplateDownload`. In that mode the creator:

- restores `.dork/uninstalled-agent.json` to `agent.json` when only the former exists;
- **adopts** a readable `agent.json`: same id, contents untouched, new `agentDefaults` reported rather than applied;
- throws on an unreadable one;
- writes SOUL.md, NOPE.md and MEMORY.md only if absent (a new `writeConventionFileIfAbsent`; today MEMORY.md is always overwritten);
- announces an adoption with the existing `origin: 'registered'`, not `'created'`;
- clears a mesh denial on the directory, since installing is an explicit act, as registering is.

This extends ADR 260903-023414 (registration adopts; the id on disk wins) to the creator path that still minted a new id over an existing manifest.

**Uninstall.** Uninstalling an agent package, not as part of an update, parks `agent.json` as `.dork/uninstalled-agent.json` and then unregisters the agent through mesh as the last side effect: Relay endpoint, schedules and room seats go, as for any removed agent. A reinstall restores the parked id. Schedules come back paused.

## Consequences

### Positive

- An updated or reinstalled marketplace agent keeps its id, persona and memory; mesh sees no branch swap.
- Uninstalling a marketplace agent no longer leaves it running without its package.
- No HTTP caller can ask DorkOS to adopt an arbitrary directory's identity.

### Negative

- Improved `agentDefaults` in a new version do not reach existing installs automatically.
- A reinstalled agent's schedules come back paused, because the unregister cascade disabled them.

## Alternatives Considered

- **Preserve only `agent.json` as a special path.** Rejected: SOUL.md, NOPE.md and MEMORY.md need the same protection, and the general ownership rule already covers them.
- **Put `adopt` on `CreateAgentOptionsSchema`.** Rejected: that schema is the public `createAgent` transport contract.
- **Leave the agent registered on uninstall.** Rejected in design review: a package that is gone must not leave a running agent behind.
- **A new `'adopted'` arrival origin.** Rejected: `'registered'` already means "DorkOS registering a directory that was on disk", and every reaction understands it.
