# MCP Apps Host Support — Ideation

**Date:** 2026-07-08 · **Implements:** Tier 2 of ADR `260708-111459-two-tier-generative-ui.md`
**Spec relied on:** MCP Apps / SEP-1865 (`modelcontextprotocol/ext-apps`, 2026-01-26) + `@mcp-ui/client`.

## Problem

Tier 2 of the generative-UI architecture: render interactive `ui://` HTML apps shipped by MCP servers, in chat (inline) and canvas (fullscreen). The core divergence from Claude.ai/ChatGPT: **their chat host IS the MCP client; DorkOS's MCP connections belong to the runtime.** The client only sees StreamEvents.

## Key findings (investigated 2026-07-08, file evidence in 02-specification.md)

1. **`_meta` does not survive to the client on any runtime** — `ToolCallEventSchema` has no `_meta` field and all three event mappers extract text only. Net-new plumbing on every runtime; v1 does claude-code only.
2. **The Claude Agent SDK has no `resources/read`** — but `mcpServerStatus()` returns each server's resolved connection `config` (stdio command/args/env or http url). DorkOS server can open its **own short-lived MCP client** to the same server to read `ui://` resources.
3. **The approval pipeline gates the agent's tools only** (SDK `canUseTool`, keyed by SDK toolUseID) — app-initiated `tools/call` cannot ride it; needs its own consent gate (v2) or reformulation as an agent turn (v3).
4. **Existing surfaces fit**: canvas URL iframe is the precedent (but its `allow-same-origin` sandbox is too permissive for app HTML); canvas content union extends cleanly; the widget `agent`-action channel is the app→agent precedent; Electron is already hardened.

## Decisions

- **D1 — Server-side short-lived MCP client for resource fetch**, config sourced from `mcpServerStatus()` (claude-code). Rejected: SDK fetch (impossible), re-parsing config files (brittle, later fallback for codex/opencode), client-side MCP connection (client has no MCP transport and shouldn't).
- **D2 — `_meta.ui` propagates as a typed optional `ui` field** on ToolCallEvent/tool_result/ToolCallPart — never a stringified blob.
- **D3 — Hand-rolled sandbox iframe + bridge (or mcp-ui's low-level AppFrame)**, NOT `<AppRenderer/>` — AppRenderer assumes a live client-side MCP client we don't have. Our transport shim proxies `resources/read` to a DorkOS endpoint; consent policy stays ours.
- **D4 — v1 is render-only**: iframe `tools/call` answers "not permitted". Staged: v2 server-side gated tool calls with a DorkOS consent gate; v3 agent-turn relay + codex/opencode + serving our own `ui://` from `/mcp`.
- **D5 — Display modes**: `inline` → chat block; `fullscreen` → canvas (`mcp_app` content variant); `pip` → deferred (no floating surface yet); advertise `["inline","fullscreen"]`.
- **D6 — Sandbox posture stricter than the URL canvas**: dedicated sandbox origin, `sandbox="allow-scripts"` WITHOUT `allow-same-origin`, CSP from `_meta.ui.csp` (spec default fallback), `allow` strictly from declared permissions, postMessage origin checks + JSON-RPC method allowlist.

## Highest-risk unknown (validate FIRST)

Whether the Claude Agent SDK preserves `_meta` on MCP tool-result blocks at all (our mapper drops it, but the SDK may strip it upstream). **Implementation must start with an empirical spike against a live MCP-Apps fixture server; if `_meta` is stripped, the trigger falls back to detecting `ui://` embedded resource blocks in tool results, and the spec must be amended before the rest is built.**

## Out of scope (v1)

App-initiated tool calls, `pip`, `ui/update-model-context` → agent feedback, codex/opencode, server-side app state, DorkOS-authored `ui://` resources on `/mcp`.
