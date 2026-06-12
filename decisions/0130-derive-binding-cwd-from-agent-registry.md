---
number: 130
title: Derive Binding CWD from Agent Registry Instead of Storing on Binding
status: accepted
created: 2026-03-14
spec: remove-binding-projectpath
superseded-by: null
---

# 130. Derive Binding CWD from Agent Registry Instead of Storing on Binding

## Status

Accepted

## Context

The `AdapterBinding` schema stores both `agentId` and `projectPath`, but agents have a 1:1 mapping with `projectPath` (enforced by a UNIQUE constraint in the DB). This creates data redundancy, discrepancy risk when agent directories move, and empty-string bugs when binding creation paths don't ask for the path. The Slack adapter binding was created with `projectPath: ""`, causing silent routing failures.

## Decision

Remove `projectPath` from the `AdapterBinding` schema entirely. The `BindingRouter` derives CWD at routing time by calling `meshCore.getProjectPath(binding.agentId)`, using the `AdapterMeshCoreLike` interface already available in the adapter manager. The agent registry is the single source of truth for agent working directories.

## Consequences

### Positive

- Single source of truth — agent registry owns the path, no drift or discrepancies
- Eliminates the empty-projectPath bug class entirely
- Simpler binding schema and UI (no manual path entry)
- Agent path changes automatically reflected in routing without binding updates

### Negative

- Breaking schema change requires migration of persisted `bindings.json` files
- MCP `binding_create` tool API changes (external consumers must update)
- BindingRouter gains a new required dependency (`meshCore`)
- If an agent is deleted from the registry but bindings still reference it, routing silently skips (logged as warning)
