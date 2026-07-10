---
id: 260708-141143
title: The DorkOS server, not the client or runtime, fetches MCP App ui:// resources
status: accepted
created: 2026-07-08
spec: mcp-apps-host
superseded-by: null
---

# 260708-141143. The DorkOS server, not the client or runtime, fetches MCP App ui:// resources

## Status

Accepted

## Context

MCP Apps (SEP-1865) assumes the chat host is the MCP client: when a tool result references `_meta.ui.resourceUri`, the host reads the `ui://` resource over its own connection. DorkOS diverges structurally — MCP connections belong to the agent runtime (e.g. inside Claude Agent SDK sessions), the SDK exposes no `resources/read`, and the browser client has no MCP transport at all. Someone must own the fetch. Investigated alternatives: fetching through the runtime (impossible — no SDK API), re-parsing per-runtime MCP config files ourselves (brittle, duplicates the SDK's env/scope resolution), or giving the client its own MCP connections (wrong trust boundary and heavy).

## Decision

We will have the DorkOS **server** open its own short-lived MCP client connection to the same server the runtime uses, sourcing the exact resolved connection config from the SDK's `mcpServerStatus()` (captured server-side only — stdio command/env never reaches the client). Resources are read via standard `resources/read`, validated (`ui://` scheme, `text/html;profile=mcp-app`, server ∈ the session's MCP set), cached briefly, and served to the client over a session-scoped endpoint. App-initiated `tools/call` is not executed in v1; when added, it flows through a DorkOS-owned consent gate on this same server-side connection, never silently through the agent's approval pipeline (which gates the agent's own tools only).

## Consequences

### Positive

- Works with unmodified third-party MCP-Apps servers; no per-runtime config parsing; trust boundary stays server-side with one auditable choke point for consent policy.
- The same mechanism extends to codex/opencode later via config-file fallback, and to v2 gated tool calls.

### Negative

- A second connection per (session, server) — stdio servers get re-spawned for resource reads unless pooled; connection lifecycle is ours to manage.
- DorkOS-side fetch can observe resources the runtime's own connection never requested — mitigated by restricting to `ui://` URIs referenced from tool results of that session.
