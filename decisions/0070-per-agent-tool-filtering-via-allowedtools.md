---
number: 70
title: Per-Agent Tool Filtering via Domain-Level allowedTools
status: accepted
created: 2026-03-04
spec: agent-tools-elevation
superseded-by: null
---

# 70. Per-Agent Tool Filtering via Domain-Level allowedTools

## Status

Accepted

## Context

DorkOS injects MCP tools into agent sessions via `createDorkOsToolServer`. Until now, all tools were available to all agents — the same tool set regardless of agent role. Spec #88 introduced global config toggles for context blocks, but no per-agent MCP tool filtering. Three approaches were considered: (1) per-session `allowedTools` filtering on a single shared MCP server, (2) dynamic per-agent MCP server creation, (3) context-only gating with no MCP filtering.

## Decision

Use the SDK's `allowedTools` option to filter MCP tools per session based on the agent's `enabledToolGroups` manifest field. A single MCP server registers all tools globally. Per session, `buildAllowedTools()` computes the allowed tool name list from the intersection of the agent's manifest config and global feature flags. Core tools (ping, get_server_info, get_session_count, agent_get_current) are always included.

## Consequences

### Positive

- Uses the SDK's intended mechanism for per-session tool access control
- No dynamic server creation — avoids resource leak risks and complexity
- Dual gating (allowedTools + context block omission) ensures tools and context stay in sync
- Backward-compatible: agents without `enabledToolGroups` get all tools (existing behavior)

### Negative

- Requires maintaining an explicit list of tool names per domain (fragile if tool names change)
- `allowedTools` wildcard behavior with prefixes is not fully documented in the SDK — may need testing
- Tool filtering is advisory, not a hard security boundary — agents can still attempt equivalent actions via Bash
