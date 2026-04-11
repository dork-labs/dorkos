---
number: 241
title: Runtime Self-Declares Supported Permission Modes
status: draft
created: 2026-04-10
spec: permission-mode-management
superseded-by: null
---

# 241. Runtime Self-Declares Supported Permission Modes

## Status

Draft (auto-extracted from spec: permission-mode-management)

## Context

The `PermissionModeSchema` defines a superset of all known permission modes across all possible runtimes. Different runtimes may support different subsets — Claude Code supports all 6, but a future OpenCode runtime might only support 2-3. The client UI needs to know which modes to render for the current runtime without hardcoding a shared list.

## Decision

Each runtime declares its supported permission modes via `RuntimeCapabilities.supportedPermissionModes`. The client fetches capabilities via `GET /api/capabilities` (cached with `staleTime: Infinity`) and passes the array as a `supportedModes` prop to `PermissionModeItem`. The dropdown renders only modes the current runtime supports. The `PermissionModeSchema` Zod enum remains the cross-runtime superset for validation; the UI filters by capabilities for rendering.

## Consequences

### Positive

- Adding a new runtime requires only declaring its `supportedPermissionModes` — no client code changes
- UI adapts automatically to runtime capabilities — no hardcoded mode lists in the client
- Clean separation: schema validates (all known modes), capabilities render (this runtime's modes)

### Negative

- If `supportedPermissionModes` is undefined (missing from capabilities), the UI falls back to showing all modes — could show unsupported modes for a misconfigured runtime
- Capabilities are cached indefinitely (`staleTime: Infinity`) — runtime hot-reloads that change supported modes won't be reflected until page refresh
