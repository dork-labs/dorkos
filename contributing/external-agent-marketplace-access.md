# Connecting External AI Agents to the DorkOS Marketplace

DorkOS exposes its marketplace as an MCP server. Any AI agent that supports MCP can search and install DorkOS packages.

## Endpoint

- Production: `https://dorkos.local/mcp`
- Development: `http://localhost:6242/mcp`
- Transport: Streamable HTTP
- Auth: a Bearer credential. Read-only tools (search, get, list, recommend) carry `readOnlyCarveOut` and answer tokenless in the default login-off posture; the mutation tools (install, uninstall, create_package) need a credential **and** an approval. Which credential depends on posture: the per-instance local MCP token (login off), a per-user API key (login on), or the `MCP_API_KEY` override (headless). See [MCP Server](../docs/integrations/mcp-server.mdx#authentication).
- **"A human approval" is only literally true under `signed-in-operator`.** With login on, deciding requires a verified account, so an unauthenticated caller cannot approve its own install however it is shaped. With login off (the default `local-trust` posture), `decision-authority.ts` refuses any caller that presents an agent identity **or** an approval token, which stops an honest agent and stops the requester specifically, but a bare credential-free loopback request is indistinguishable from the cockpit's. So the accurate sentence is "needs an approval the requester cannot grant itself", and only login makes it "needs a person". Write it that way in user-facing copy too.

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

The `Auth` column is **posture-dependent**. "None (login off)" means the `readOnlyCarveOut` lets the call through tokenless while `auth.enabled` is `false`; with login on, every row needs a credential.

| Tool                            | Description                                         | Auth             |
| ------------------------------- | --------------------------------------------------- | ---------------- |
| `marketplace_search`            | Search for packages by query, type, category, tags  | None (login off) |
| `marketplace_get`               | Get full package details + README                   | None (login off) |
| `marketplace_list_marketplaces` | List configured marketplace sources                 | None (login off) |
| `marketplace_list_installed`    | List installed packages                             | None (login off) |
| `marketplace_recommend`         | Recommend packages from a context description       | None (login off) |
| `marketplace_install`           | Install a package (requires confirmation)           | Always required  |
| `marketplace_uninstall`         | Remove a package (requires confirmation)            | Always required  |
| `marketplace_create_package`    | Scaffold a new package in your personal marketplace | Always required  |

## The Confirmation Flow for External Agents

When an external agent calls `marketplace_install`, DorkOS does not silently install the package: a person must approve it first. The flow:

1. Agent calls `marketplace_install({ name: 'foo' })`.
2. DorkOS responds with `{ status: 'requires_confirmation', preview, confirmationToken: '...' }`.
3. The approval lands on the operator's approval card (`ApprovalCard` in `apps/client/src/layers/features/approvals/ui/`, surfaced by `ApprovalsIndicator` in `apps/client/src/layers/widgets/approvals-indicator/ui/`, mounted in the app header at `AppShell.tsx:462`, and by the pinned triage header on the home tab). They grant or deny it **by approval id**, through `POST /api/approvals/:id/grant` or `/deny`.
4. Agent re-calls `marketplace_install({ name: 'foo', confirmationToken: '...' })`.
5. DorkOS returns either `{ status: 'installed', ... }` or `{ status: 'declined', reason: '...' }`.

Three things to keep straight here, each of which a previous version of this doc got wrong:

- **The TTL is two hours, not five minutes.** `TokenConfirmationProvider` is backed by `ApprovalService`, so unresolved tokens expire on `APPROVAL_TTL_MS` (`services/core/approvals/approval-service.ts`). Expiry is checked when the token is presented.
- **There is no decide-by-token route.** The requester holds the token, so a decide-by-token path would let it approve its own request. Decisions go by approval id only; the older `POST /api/marketplace/confirmations/:token` route is gone.
- **`InstallConfirmationDialog` is not this flow.** That modal (`features/marketplace/ui/`) blocks a **human's own** install from the Marketplace tab and shows a permission preview. An agent's request never reaches it; it lands on the approval card instead. Do not name the dialog when documenting the agent path.
- **`marketplace_uninstall` is gated twice.** It is the one `destructive`-tier capability **on the registry** (there are three destructive actions in all; the other two, `tasks_delete` and `mesh_unregister`, are hand-registered tools declared in `mcp-tool-tiers.ts`), so the registry's tier gate answers first with `status: 'approval_required'` (plus `approvalId` + `approvalToken`), before this handler's own `requires_confirmation` flow ever runs. A test asserting "the package survived" therefore proves nothing about the tier gate. See `contributing/agent-operator-surface.md` for the discrimination rule.

Tokens are single-use: the first call after a decision spends the token, so a replay reports `declined`.

## CI / Automation

**There is no way to switch the confirmation off.** An environment variable used to do that; it was deleted (DOR-501). A switch that turns a consent gate off is a second code path nobody watches, and every test that used it was measuring the switch instead of the product.

Automation answers the confirmation the same way a person does, through the same two routes:

1. Call `marketplace_install`; keep the `confirmationToken` from the `requires_confirmation` response.
2. Poll `GET /api/approvals/pending` until the matching approval appears, and read its `approvalId`.
3. `POST /api/approvals/:id/grant`.
4. Re-call `marketplace_install` with the `confirmationToken`.

With Require login on (`config.auth.enabled`), steps 2 and 3 sit behind the app-wide session gate, so the caller needs a per-user API key (`Authorization: Bearer <key>`, minted from the Security tab in Settings) — a credential-free request is refused before it ever reaches the approval logic. The caller doing step 3 must not present the `X-DorkOS-Agent` or `X-DorkOS-Approval` headers: `resolveDecisionAuthority` refuses both, in every posture, so that a requester can never approve its own request. DorkOS's own eval harness works exactly this way (`packages/evals/src/runner/approval-driver.ts`), which is why its marketplace-install run is evidence about the shipped install path rather than about a test-only branch.
