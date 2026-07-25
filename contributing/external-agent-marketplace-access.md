# Connecting External AI Agents to the DorkOS Marketplace

DorkOS exposes its marketplace as an MCP server. Any AI agent that supports MCP can search and install DorkOS packages.

## Endpoint

- Production: `https://dorkos.local/mcp`
- Development: `http://localhost:6242/mcp`
- Transport: Streamable HTTP
- Auth: a Bearer credential. Read-only tools (search, get, list, recommend) carry `readOnlyCarveOut` and answer tokenless in the default login-off posture; the mutation tools (install, uninstall, create_package) need a credential **and** a human approval. Which credential depends on posture: the per-instance local MCP token (login off), a per-user API key (login on), or the `MCP_API_KEY` override (headless). See [MCP Server](../docs/integrations/mcp-server.mdx#authentication).

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

When an external agent calls `marketplace_install`, DorkOS does not silently install the package: a person must approve it first. The flow:

1. Agent calls `marketplace_install({ name: 'foo' })`.
2. DorkOS responds with `{ status: 'requires_confirmation', preview, confirmationToken: '...' }`.
3. The approval lands on the operator's approval card (`ApprovalCard` in `apps/client/src/layers/features/approvals/ui/`, surfaced by `ApprovalsIndicator` in `apps/client/src/layers/widgets/approvals-indicator/ui/`, mounted in the app header at `AppShell.tsx:462`, and by `PendingApprovalsSection` on the dashboard). They grant or deny it **by approval id**, through `POST /api/approvals/:id/grant` or `/deny`.
4. Agent re-calls `marketplace_install({ name: 'foo', confirmationToken: '...' })`.
5. DorkOS returns either `{ status: 'installed', ... }` or `{ status: 'declined', reason: '...' }`.

Three things to keep straight here, each of which a previous version of this doc got wrong:

- **The TTL is two hours, not five minutes.** `TokenConfirmationProvider` is backed by `ApprovalService`, so unresolved tokens expire on `APPROVAL_TTL_MS` (`services/core/approvals/approval-service.ts`). Expiry is checked when the token is presented.
- **There is no decide-by-token route.** The requester holds the token, so a decide-by-token path would let it approve its own request. Decisions go by approval id only; the older `POST /api/marketplace/confirmations/:token` route is gone.
- **`InstallConfirmationDialog` is not this flow.** That modal (`features/marketplace/ui/`) blocks a **human's own** install from the Marketplace tab and shows a permission preview. An agent's request never reaches it; it lands on the approval card instead. Do not name the dialog when documenting the agent path.
- **`marketplace_uninstall` is gated twice.** It is the one `destructive`-tier capability, so the registry's tier gate answers first with `status: 'approval_required'` (plus `approvalId` + `approvalToken`), before this handler's own `requires_confirmation` flow ever runs. A test asserting "the package survived" therefore proves nothing about the tier gate. See `contributing/agent-operator-surface.md` for the discrimination rule.

Tokens are single-use: the first call after a decision spends the token, so a replay reports `declined`.

## CI / Automation

For server-side automation (e.g., a CI pipeline that pre-installs packages), set `MARKETPLACE_AUTO_APPROVE=1` before starting the DorkOS server. Every confirmation request will return `approved` immediately.
