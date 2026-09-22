---
slug: mcp-apps-read-through-cli
id: 260922-223211
created: 2026-09-22
status: ideation
---

# Read MCP App resources through the Claude Code connection

**Author:** Claude Code (from the 0.3.268 → 0.3.280 SDK upgrade triage)
**Research:** [`research/runtime-upgrades/claude-agent-sdk/0.3.268-to-0.3.280/impact-assessment.md`](../../research/runtime-upgrades/claude-agent-sdk/0.3.268-to-0.3.280/impact-assessment.md) (MEDIUM: `readMcpResource` + `tools[]._meta`)
**Blocked by:** the claude-agent-sdk 0.3.280 bump; and `Query.readMcpResource` leaving `@alpha`

## Problem

DorkOS's MCP Apps host (`routes/session-mcp-app-resource-handler.ts`, `resolveAppResource`, ADR `260708-141143`) dials each MCP server a second time with its own short-lived client, built from a server-side cache of stdio/http configs. That duplicates connections, needs its own stdio-command handling, and cannot reach OAuth servers whose credentials only the CLI holds.

## Suggested approach

- Read `ui://` resources with `Query.readMcpResource(serverName, uri)` (SDK 0.3.280), which goes through the connection the CLI already holds; gate on `mcp_read_resource_v1` in `system/init.capabilities`.
- Take each tool's `ui` metadata from `McpServerStatus.tools[]._meta` (`mcp_tool_ui_meta_v1`) instead of parsing it.
- Keep the current path as the fallback for CLIs without the capability and for SDK-type servers (the method rejects them).
- Retire the per-cwd MCP config cache once the fallback is no longer needed.

## Open questions

- Wait for the method to leave `@alpha`, or adopt behind the capability check now?
