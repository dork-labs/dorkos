# Connecting External AI Agents to the DorkOS Marketplace

DorkOS exposes its marketplace as an MCP server. Any AI agent that supports MCP can search and install DorkOS packages.

## Endpoint

- Production: `https://dorkos.local/mcp`
- Development: `http://localhost:6242/mcp`
- Transport: Streamable HTTP
- Auth: Optional `MCP_API_KEY` Bearer token. Read-only tools (search, get, list, recommend) work without auth; mutation tools (install, uninstall, create_package) require both an API key and user confirmation.

## Claude Code

```bash
claude mcp add --transport http dorkos-marketplace https://dorkos.local/mcp
```

With API key:

```bash
claude mcp add --transport http dorkos-marketplace https://dorkos.local/mcp \
  --header "Authorization: Bearer YOUR_KEY"
```

## Cursor

Add to `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "dorkos-marketplace": {
      "url": "http://localhost:6242/mcp",
      "transport": "streamable-http"
    }
  }
}
```

## Codex

Add to `~/.codex/config.toml`:

```toml
[[mcp_servers]]
name = "dorkos-marketplace"
url = "http://localhost:6242/mcp"
```

## Available Tools

| Tool                            | Description                                         | Auth     |
| ------------------------------- | --------------------------------------------------- | -------- |
| `marketplace_search`            | Search for packages by query, type, category, tags  | None     |
| `marketplace_get`               | Get full package details + README                   | None     |
| `marketplace_list_marketplaces` | List configured marketplace sources                 | None     |
| `marketplace_list_installed`    | List installed packages                             | None     |
| `marketplace_recommend`         | Recommend packages from a context description       | None     |
| `marketplace_install`           | Install a package (requires user confirmation)      | Required |
| `marketplace_uninstall`         | Remove a package (requires user confirmation)       | Required |
| `marketplace_create_package`    | Scaffold a new package in your personal marketplace | Required |

## The Confirmation Flow for External Agents

When an external agent calls `marketplace_install`, DorkOS does not silently install the package — the user must approve it first. The flow:

1. Agent calls `marketplace_install({ name: 'foo' })`.
2. DorkOS responds with `{ status: 'requires_confirmation', preview, confirmationToken: '...' }`.
3. The user opens DorkOS, sees the install confirmation dialog with the package preview, and approves or declines.
4. Agent re-calls `marketplace_install({ name: 'foo', confirmationToken: '...' })`.
5. DorkOS returns either `{ status: 'installed', ... }` or `{ status: 'declined', reason: '...' }`.

Tokens expire after 5 minutes and are single-use.

## CI / Automation

For server-side automation (e.g., a CI pipeline that pre-installs packages), set `MARKETPLACE_AUTO_APPROVE=1` before starting the DorkOS server. Every confirmation request will return `approved` immediately.
