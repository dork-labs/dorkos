---
id: 260803-233414
title: Manage agent MCP servers by inline injection, not by writing .mcp.json
status: proposed
created: 2026-08-03
spec: mcp-server-management
superseded-by: null
---

# 260803-233414. Manage agent MCP servers by inline injection, not by writing .mcp.json

## Status

Proposed

## Context

DorkOS agents can reach an external MCP server today only via a hand-run
`claude mcp add` or a hand-edited `.mcp.json`. That path produces a confusing
dual trust model: the standalone `claude` CLI reads its own trust store
(`~/.claude.json` → `enabledMcpjsonServers`) while the DorkOS SDK session runs
with `settingSources: ['project']` and a possibly-relocated `CLAUDE_CONFIG_DIR`,
so the two surfaces disagree about whether a server is "approved." DorkOS already
injects its own tool servers (`dorkos`, connector accounts) **inline** per session
via `setMcpServerFactory`, which the SDK auto-trusts.

## Decision

We will store DorkOS-managed MCP servers as agent config (`AgentManifest.mcpServers`)
and apply them by **folding them into the existing inline `setMcpServerFactory`
injection** at session start, converted through `toSdkMcpServerConfig`. We will not
write or manage `.mcp.json` for managed servers. Inline servers are auto-trusted by
the SDK and never touch the CLI trust store, so the dual-trust "pending approval"
confusion cannot arise for them. Live status continues to come from the existing
`getMcpStatus` snapshot. Per-runtime, injection is gated by the existing
`supportsMcp` capability (Claude Code only in v1); a runtime without the seam stores
the config but does not inject it.

## Consequences

### Positive

- Dissolves the CLI-vs-SDK dual-trust confusion by construction rather than by
  reconciling two stores.
- Reuses the proven connector/factory plumbing; covers local **stdio** servers
  (the originating use case).
- Keeps the harness's standing decision that MCP config is not projected as files.
- Live status and tool counts are free via the existing status path.

### Negative

- A managed server is **not portable** to a bare `claude` session (no `.mcp.json`
  is written). Documented as out of scope; a future one-way import can bridge it.
- Injection is Claude-Code-only until Codex/OpenCode apply paths land, so the
  feature degrades per runtime (surfaced honestly in the UI via `supportsMcp`).
- Reading the manifest at session start adds a small, cached disk cost on the
  turn path.
