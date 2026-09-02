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
3. The approval lands on the operator's approval card (`ApprovalCard` in `apps/client/src/layers/features/approvals/ui/`, surfaced by `InboxBell` in `apps/client/src/layers/widgets/inbox-bell/ui/`, mounted in the app header at `AppShell.tsx:644`, and by the pinned triage header on the home tab). They grant or deny it **by approval id**, through `POST /api/approvals/:id/grant` or `/deny`.
4. Agent re-calls `marketplace_install({ name: 'foo', confirmationToken: '...' })`.
5. DorkOS returns either `{ status: 'installed', ... }` or `{ status: 'declined', reason: '...' }`.

Three things to keep straight here, each of which a previous version of this doc got wrong:

- **The TTL is two hours, not five minutes.** `TokenConfirmationProvider` is backed by `ApprovalService`, so unresolved tokens expire on `APPROVAL_TTL_MS` (`services/core/approvals/approval-service.ts`). Expiry is checked when the token is presented.
- **There is no decide-by-token route.** The requester holds the token, so a decide-by-token path would let it approve its own request. Decisions go by approval id only; the older `POST /api/marketplace/confirmations/:token` route is gone.
- **`InstallConfirmationDialog` is not this flow.** That modal (`features/marketplace/ui/`) blocks a **human's own** install from the Marketplace tab and shows a permission preview. An agent's request never reaches it; it lands on the approval card instead. Do not name the dialog when documenting the agent path.
- **`marketplace_uninstall` is gated twice.** It is the marketplace's one `destructive`-tier capability (the registry has others, `operator.update_agent_boundaries` among them, and `tasks_delete` and `mesh_unregister` are hand-registered tools declared in `mcp-tool-tiers.ts`), so the registry's tier gate answers first with `status: 'approval_required'` (plus `approvalId` + `approvalToken`), before this handler's own `requires_confirmation` flow ever runs. A test asserting "the package survived" therefore proves nothing about the tier gate. See `contributing/agent-operator-surface.md` for the discrimination rule.

Tokens are single-use: the first call after a decision spends the token, so a replay reports `declined`.

**A token covers the commands the person read, not just the package name (DOR-647).** The approval binds the executable half of the preview as well as the action: every hook command string (with its event and matcher) and every scheduled job (with its cron, permission mode and whether it starts switched on) — `disclosedEffectsOf` in `services/marketplace/disclosed-effects.ts`. When a presented token does not cover the action in front of DorkOS — a different package, a different scope, or a package that now declares different commands — the original approval is left unspent and **DorkOS asks again** rather than proceeding, returning `requires_confirmation` with a fresh token and a `message` naming what the package declares now. That is the same answer the capability tier gate gives a mismatched token (`wrong_action`).

**There are two re-resolves, and both are checked.** Step 4 re-resolves once to rebuild the preview (checked against the approval by the binding above) and `installer.install()` resolves a SECOND time to stage the package it actually writes. That second one is compared against the disclosure the approval covered, inside `MarketplaceInstaller.install()`, using the preview it already builds for the conflict gate — a divergence throws `DisclosureChangedError`, which the tool reports as `code: 'DISCLOSURE_CHANGED'` with both descriptions, before any flow touches disk. `InstallRequest.approvedDisclosure` is the internal hand-off that carries it; it is deliberately absent from `InstallRequestBodySchema`, so no HTTP caller can supply or blank it. Callers that hold no approval (the CLI, the cockpit route) pass nothing and the check does not fire.

**What stays out of the binding, and why each one is safe** — three different arguments, so do not relax them as a group:

| Out                                      | Why it is safe to leave out                                                                                                                                                                                                                                                                   |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fileChanges`, `conflicts`, `requires`   | Genuinely renumbering between resolves, and none of it runs. Re-asking over a new README trains an operator to click past the card that matters.                                                                                                                                              |
| `extensions`, `secrets`, `externalHosts` | A **second person-approval** stands between them and any code: a marketplace extension defaults OFF (`extension-enable-resolution.ts`) and running one in-process needs its id in `config.extensions.approvedToRun` (DOR-516). Secrets and hosts are read off those same manifests.           |
| `npmDependencies`                        | Cannot execute at install time: the fetch runs `npm install --ignore-scripts`, pinned by a test that ships a package declaring `ignore-scripts=false` in its own `.npmrc`. A changed dependency is a changed library the package may later import — the residual this binding does not cover. |

**One honest gap, pre-existing.** `MarketplaceConfirmationContext.preApproved` is set for `context.approval` **or** `context.trusted`, and `trusted` is not tier-scoped — so a caller that may decide approvals installs with no card at all, even though `marketplace.install` is tier `act` and nothing gates it upstream. That is the standing posture and is arguably right (a caller who can grant its own approval gains nothing from being asked), but the field's own docs used to claim it was `destructive`-only. Whether `trusted` should short-circuit an `act` capability's own confirmation is a separate question, left to a follow-up.

## CI / Automation

**There is no way to switch the confirmation off.** An environment variable used to do that; it was deleted (DOR-501). A switch that turns a consent gate off is a second code path nobody watches, and every test that used it was measuring the switch instead of the product.

Automation answers the confirmation the same way a person does, through the same two routes:

1. Call `marketplace_install`; keep the `confirmationToken` from the `requires_confirmation` response.
2. Poll `GET /api/approvals/pending` until the matching approval appears, and read its `approvalId`.
3. `POST /api/approvals/:id/grant`.
4. Re-call `marketplace_install` with the `confirmationToken`.

With Require login on (`config.auth.enabled`), steps 2 and 3 sit behind the app-wide session gate, so the caller needs a per-user API key (`Authorization: Bearer <key>`, minted from the Security tab in Settings) — a credential-free request is refused before it ever reaches the approval logic. The caller doing step 3 must not present the `X-DorkOS-Agent` or `X-DorkOS-Approval` headers: `resolveDecisionAuthority` refuses both, in every posture, so that a requester can never approve its own request. DorkOS's own eval harness works exactly this way (`packages/evals/src/runner/approval-driver.ts`), which is why its marketplace-install run is evidence about the shipped install path rather than about a test-only branch.
