---
title: 'Linear MCP Server - Official Package and Configuration'
date: 2026-03-28
type: external-best-practices
status: active
tags: [linear, mcp, integration, project-management, model-context-protocol]
searches_performed: 5
sources_count: 8
---

## Research Summary

Linear has an official, first-party MCP server that is centrally hosted and managed by Linear at `https://mcp.linear.app/mcp`. It is a **remote MCP server** using OAuth 2.1 — there is no npm package to install. The recommended connection method is `npx -y mcp-remote https://mcp.linear.app/mcp`. The Anthropic `modelcontextprotocol/servers` repo does NOT include a Linear server; it only contains 7 generic reference implementations.

## Key Findings

1. **Linear has an official first-party MCP server** — hosted remotely at `https://mcp.linear.app/mcp`. It is not an npm package; it is a managed cloud service. Documentation: https://linear.app/docs/mcp

2. **No npm package needed** — Connection is via the `mcp-remote` bridge for clients that do not yet natively support remote/HTTP-stream MCP. Modern clients (Claude, Cursor) can connect directly without any intermediary.

3. **Authentication is OAuth 2.1 by default** — No env vars needed for the standard interactive OAuth flow. API key auth is available as an alternative (non-interactive, suitable for CI/agents).

4. **modelcontextprotocol/servers does NOT include Linear** — The official Anthropic/MCP reference repo only ships 7 generic servers: Everything, Fetch, Filesystem, Git, Memory, Sequential Thinking, and Time.

5. **Third-party packages exist but are superseded** — `jerhadf/linear-mcp-server` (the most-cited community package) now explicitly recommends the official Linear remote server instead.

## Detailed Analysis

### Official Linear MCP Server

- **Endpoint:** `https://mcp.linear.app/mcp`
- **Transport:** HTTP Streams (Streamable HTTP per MCP spec 2024-11-05+). SSE transport was deprecated and is being fully removed.
- **Auth:** OAuth 2.1 with dynamic client registration (interactive browser flow). Alternative: pass an API key or OAuth token in `Authorization: Bearer <token>` header.
- **Hosting:** Centrally hosted and managed by Linear — zero self-hosting required.

### Connection Methods

**For modern MCP clients (Claude Desktop, Cursor, Windsurf):**

```json
{
  "mcpServers": {
    "linear": {
      "url": "https://mcp.linear.app/mcp"
    }
  }
}
```

These clients handle the OAuth flow natively.

**For clients without native remote MCP support (mcp-remote bridge):**

```bash
npx -y mcp-remote https://mcp.linear.app/mcp
```

```json
{
  "mcpServers": {
    "linear": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://mcp.linear.app/mcp"]
    }
  }
}
```

**For non-interactive / API key auth:**
Generate a Linear API key at: Settings > Account > Security & Access > Personal API Keys

```json
{
  "mcpServers": {
    "linear": {
      "url": "https://mcp.linear.app/mcp",
      "headers": {
        "Authorization": "Bearer <YOUR_LINEAR_API_KEY>"
      }
    }
  }
}
```

With mcp-remote: `npx -y mcp-remote https://mcp.linear.app/mcp` then set `LINEAR_API_KEY` env var, or pass via `--header "Authorization: Bearer $LINEAR_API_KEY"`.

### Required Environment Variables

| Variable         | Required                          | Description                           |
| ---------------- | --------------------------------- | ------------------------------------- |
| `LINEAR_API_KEY` | Only for non-OAuth (API key auth) | Personal API key from Linear Settings |

For the default OAuth flow: **no environment variables required**.

### Available Tools (as of Feb 2026)

The official server exposes 21+ tools including:

- List, create, update issues
- List, create, update projects and project milestones
- Create/edit project updates and project labels
- List, create, update teams
- Create/edit initiatives and initiative updates
- Add comments
- Load Linear resources by URL
- Load images

### Third-Party Alternatives (for reference)

| Package                        | Status                          | Notes                                 |
| ------------------------------ | ------------------------------- | ------------------------------------- |
| `jerhadf/linear-mcp-server`    | Deprecated (points to official) | Was the most popular community server |
| `@tacticlaunch/mcp-linear`     | Active community                | npm installable, local runner         |
| `locomotive-agency/linear-mcp` | Active community                | "Production-grade", local runner      |

None of these are recommended when the official hosted server is available.

### modelcontextprotocol/servers Repository

Does NOT include Linear. The 7 reference servers it maintains are generic/educational:
Everything, Fetch, Filesystem, Git, Memory, Sequential Thinking, Time.

## Sources & Evidence

- Linear official MCP docs: [MCP server – Linear Docs](https://linear.app/docs/mcp)
- Linear MCP launch changelog: [Linear MCP server – Changelog](https://linear.app/changelog/2025-05-01-mcp)
- Linear MCP Feb 2026 expansion: [Linear MCP for product management – Changelog](https://linear.app/changelog/2026-02-05-linear-mcp-for-product-management)
- Anthropic reference servers: [modelcontextprotocol/servers – GitHub](https://github.com/modelcontextprotocol/servers)
- Community (deprecated) server: [jerhadf/linear-mcp-server – GitHub](https://github.com/jerhadf/linear-mcp-server)
- PulseMCP listing: [Official Linear MCP Server | PulseMCP](https://www.pulsemcp.com/servers/linear)

## Research Gaps & Limitations

- The exact list of all 21+ tool names was not fully enumerated in public docs (the changelog lists ~10 categories).
- WSL-specific flag (`--transport sse-only`) may no longer be relevant once SSE is fully removed.

## Search Methodology

- Searches performed: 5
- Most productive terms: "Linear app official MCP server 2025 2026", "modelcontextprotocol/servers GitHub Linear"
- Primary sources: linear.app/docs, linear.app/changelog, github.com/modelcontextprotocol/servers
