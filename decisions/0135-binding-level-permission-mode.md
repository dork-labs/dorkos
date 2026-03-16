---
number: 135
title: Binding-Level Permission Mode for Adapter Sessions
status: draft
created: 2026-03-15
spec: agent-permission-mode
superseded-by: null
---

# 135. Binding-Level Permission Mode for Adapter Sessions

## Status

Draft (auto-extracted from spec: agent-permission-mode)

## Context

When messages arrive via external adapters (Slack, Telegram), agent sessions are created without a configured permission mode. Claude Code's "default" mode causes tools to be auto-denied in headless contexts, meaning agents silently skip tool usage rather than completing work. The permission mode could be configured at four levels: binding (per adapter-agent pair), adapter (per adapter instance), agent/runtime (per agent), or per-message.

## Decision

Permission mode is configured at the **binding level** — each adapter-agent pair has its own `permissionMode` field in `AdapterBindingSchema`. The default is `acceptEdits`, matching the Pulse scheduler's precedent for headless agent runs. The binding router passes this mode to session creation via `ensureSession()`. The UI filters available modes by `RuntimeCapabilities.supportedPermissionModes` and shows a security warning when `bypassPermissions` is selected on external-facing adapters.

## Consequences

### Positive

- Maximum granularity: different trust levels per adapter-agent pair (Slack = acceptEdits, Telegram = plan)
- Natural UI placement alongside existing binding permissions (canReply, canInitiate, canReceive)
- Leverages all existing infrastructure (PermissionModeSchema, RuntimeCapabilities, SessionOpts)
- Backward compatible: existing bindings default to `acceptEdits`

### Negative

- Adds one more field to the binding schema — marginally increases binding complexity
- Users must configure permission mode per binding rather than setting a single agent-wide default
- Runtime capability data must be available in the client to filter the selector (may require an additional query)
