# Connecting External AI Agents to the DorkOS Marketplace

DorkOS exposes its marketplace as an MCP server. Any AI agent that supports MCP can search and install DorkOS packages.

## Endpoint

- Default local endpoint: `http://localhost:4242/mcp`. Copy the actual endpoint from **Settings → Advanced → Tools → Connect other apps to DorkOS**; the configured port can differ.
- Development: `http://localhost:6242/mcp`
- Transport: Streamable HTTP
- Auth: a Bearer credential. Read-only marketplace tools carry `readOnlyCarveOut` where anonymous local reads are permitted; mutation tools need a credential. Use the per-instance local MCP token for local login-off access, a per-user API key where login is required, or the `MCP_API_KEY` override for a login-off headless deployment. Authentication does not grant permission to change packages. See [MCP Server](../docs/integrations/mcp-server.mdx#authentication).
- Approval decisions run two checks: the caller must be allowed to decide, and `requireOperatorCookieUnderLogin` requires a signed-in browser session wherever `personSessionRequired` applies. An API key is not a browser session. The decision routes also refuse an agent identity or approval token. A local instance with no owner can still accept an unmarked loopback program as the operator; this is not an OS isolation boundary.

## Claude Code

```bash
claude mcp add --transport http dorkos-marketplace http://localhost:4242/mcp
```

For tools that require authentication, add the Bearer credential shown by Settings:

```bash
claude mcp add --transport http dorkos-marketplace http://localhost:4242/mcp \
  --header "Authorization: Bearer YOUR_KEY"
```

## Cursor

Add to `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "dorkos-marketplace": {
      "url": "http://localhost:4242/mcp",
      "headers": { "Authorization": "Bearer YOUR_KEY" }
    }
  }
}
```

## Codex

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.dorkos-marketplace]
url = "http://localhost:4242/mcp"
env_http_headers = { Authorization = "DORKOS_MARKETPLACE_AUTHORIZATION" }
```

Supply `DORKOS_MARKETPLACE_AUTHORIZATION` in the environment that starts Codex, with the full `Bearer …` header value. The repository uses this same `mcp_servers.<name>` record and `env_http_headers` shape in `apps/server/src/services/runtimes/codex/mcp-server-config.ts`. These examples are for external clients; DorkOS injects tools into its own managed agents.

## Available Tools

The `Auth` column describes authentication, not permission. “Local read carve-out” applies only where the instance permits anonymous local reads; other access needs the credential described above. Use the client’s live tool list for current schemas.

| Tool                            | Description                                                  | Auth                 |
| ------------------------------- | ------------------------------------------------------------ | -------------------- |
| `marketplace_search`            | Search for packages by query, type, category, tags           | Local read carve-out |
| `marketplace_get`               | Get full package details + README                            | Local read carve-out |
| `marketplace_list_marketplaces` | List configured marketplace sources                          | Local read carve-out |
| `marketplace_list_installed`    | List installed packages                                      | Local read carve-out |
| `marketplace_recommend`         | Recommend packages from a context description                | Local read carve-out |
| `marketplace_install`           | Install a package; confirmation depends on caller permission | Always required      |
| `marketplace_update`            | Check for newer versions (confirmation only with `apply`)    | Always required      |
| `marketplace_uninstall`         | Remove a package; follows permission checks                  | Always required      |
| `marketplace_create_package`    | Scaffold a new package in your personal marketplace          | Always required      |
| `marketplace_link`              | Run a plugin or skill pack from an approved local folder     | Always required      |

## The Confirmation Flow for External Agents

Authentication and the capability gate run before the marketplace handler. If the gate needs a decision, an external call can return `status: 'approval_required'` with an `approvalId` and `approvalToken`. That is a capability approval token, not the handler's `confirmationToken`; follow the returned retry instructions.

When the capability gate allows the call but the handler still needs package confirmation, the install flow is:

1. Agent calls `marketplace_install({ name: 'foo' })`.
2. The handler builds the preview and returns `{ status: 'requires_confirmation', preview, confirmationToken: '...' }`.
3. The person answers the approval card in DorkOS. Decisions use the approval id at `POST /api/approvals/:id/grant` or `/deny`, subject to the caller checks above.
4. Agent re-calls `marketplace_install` with the same arguments plus `confirmationToken`.
5. The handler returns `installed`, `declined`, another confirmation if the package changed, or a structured error.

Keep these distinctions:

- **The TTL is two hours.** `TokenConfirmationProvider` uses `ApprovalService` and `APPROVAL_TTL_MS` in `apps/server/src/services/core/approvals/approval-service.ts`. Expiry is checked when the token is presented.
- **There is no decide-by-token route.** The requester holds the token. Decisions go by approval id; the old `POST /api/marketplace/confirmations/:token` route is gone.
- **`InstallConfirmationDialog` is not this flow.** That modal handles a person's own install from the Marketplace tab. Agent requests use the shared approval card.
- **Uninstall does not always ask twice.** `callerContext` reuses an exact capability approval, an explicit action-level Allowed, or a caller authorized to decide approvals. Uninstall also accepts area-level permission under Trusted. Install, applied update and package creation retain their own confirmation on area-level permission alone. `marketplace_link` has no second handler confirmation; its capability gate binds the folder disclosure.

Tokens are single-use: the first call after a decision spends the token, so a replay reports `declined`.

**A token covers the commands the person read, not just the package name (DOR-647).** The approval binds the executable half of the preview as well as the action: every hook command string (with its event and matcher), every scheduled job (with its cron, permission mode and whether the package asked for it to be switched on), and every program the package starts on its own: MCP servers, language servers, background monitors and the commands its `bin/` puts on the agent's `PATH` (DOR-2195) — `disclosedEffectsOf` in `services/marketplace/preview/disclosed-effects.ts`. When a presented token does not cover the action in front of DorkOS — a different package, a different scope, or a package that now declares different commands — the original approval is left unspent and **DorkOS asks again** rather than proceeding, returning `requires_confirmation` with a fresh token and a `message` naming what the package declares now. That is the same answer the capability tier gate gives a mismatched token (`wrong_action`).

**The binding also pins the package bytes.** `bindingOf` in `apps/server/src/services/marketplace-mcp/confirmation-provider.ts` includes `contentHash` alongside the action, scope and disclosed effects. File lists and conflicts are not separate binding fields, but that does not leave changed package content unbound. `packageContentHash` in `apps/server/src/services/marketplace/lib/content-hash.ts` defines which staged files the hash covers.

**The installer checks its own resolve too.** The retry rebuilds the preview, then `installer.install()` resolves the package again. The tool passes `approvedDisclosure`, `approvedContentHash` and `approvedPackageType`, including on a pre-approved call. A divergence raises `DisclosureChangedError`, returned as `code: 'DISCLOSURE_CHANGED'`, before installation writes. Those hand-off fields are internal; the HTTP install input does not let a caller provide them.

Extension startup has its own enable and approval state; see `apps/server/src/services/extensions/extension-enable-resolution.ts` and [Extension authoring](extension-authoring.md). Do not infer from an install approval that every extension can start, or that every caller will receive another person-approval card.

**Check the invocation context, not just the tier.** In `apps/server/src/services/marketplace-mcp/marketplace-capabilities.ts`, `callerContext` sets `preApproved` for an exact approval, an explicit action-level Allowed, or `context.trusted` (authority to decide approvals). Only uninstall also passes `runsWhenTrusted: true`. The registry's permission check still runs before the handler; `act` does not mean ungated.

## CI / Automation

There is no environment switch that disables marketplace confirmation. The old switch was removed (DOR-501). Calls proceed through permission resolution and the handler's confirmation rules above.

An external automation client can request an install and retry after the person answers its approval in DorkOS:

1. Call the tool and inspect whether it returned a capability approval or a marketplace confirmation.
2. Keep the returned token and ask the person to answer the matching card in DorkOS.
3. Retry the same action using the returned token's protocol.

A per-user API key can authenticate ordinary API requests, but it cannot grant or deny approvals where the browser-session check applies. Do not drop agent identity headers to impersonate the person. `GET /api/approvals/pending` exposes pending requests; it does not authorize the caller to decide them.

The eval harness's `packages/evals/src/runner/approval-driver.ts` is a separate, controlled setup: its sandbox boots with login off and uses local trust to answer the selected approval through the real routes. That is evidence about the sandbox's local-trust flow, not a template for unattended approval on an instance that requires a signed-in browser.
