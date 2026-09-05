# DorkOS white-label connections

The operator approved this programme on 2026-09-05 and authorized autonomous
execution through /flow, separate adversarial reviews against REVIEW.md, green-CI
PR merges, related follow-up fixes, and cleanup of this programme's worktrees.
All artifact and code writes happen in isolated worktrees, including intent
stages. This explicit authorization supersedes routine skill approval pauses;
it does not waive verification, independent review, or truthful completion.

## Required outcomes

1. Use the Composio SDK behind DorkOS's provider abstraction instead of giving
   agents Composio MCP endpoints. DorkOS-owned MCP delivery to runtimes remains
   an implementation option; a programmable DorkOS CLI must share the same
   permissions and accounting path.
2. A much simpler connection interface: service search, authenticate, choose
   agents. List, rename/edit, reconnect, pause, disconnect, and show usage.
   Support multiple accounts of Gmail, Notion, Linear and other capable services.
   Show access both from the connection and from the agent.
3. Separate use, receive-events, and connection-management authority. Exact
   account selection, operation permissions, immediate future-call revocation,
   no self-grants, and honest same-OS-user isolation limits. Preserve existing
   data and explain session overrides.
4. Preserve native Slack/Telegram messaging adapters, present one service catalog,
   distinguish bot/user identities and messaging/tool intent, and own each event
   subscription once. Add supported Composio events with signature verification,
   deduplication, filtering, explicit agent/destination routing, retry and offline
   delivery. Never promise real-time for polling-only services.
5. Durable agent-initiated discovery and connection requests: users authenticate
   and grant access; resume the agent without requiring manual polling messages.
   Service discovery must not reveal every private connected account.
6. Optional DorkOS-managed white-label service, own Composio account, and alternate
   providers behind one UX. Distinguish provider implementation from configured
   provider instance. Stable DorkOS connection IDs independent of external IDs.
   Managed credentials stay hosted, tenant IDs are authenticated and unique;
   reuse existing cloud account/instance-linking infrastructure where possible.
7. Record authoritative managed usage and local BYO usage now, including logical
   operations versus attempts and payer/provider attribution. Billing, invoicing,
   and charging are explicitly deferred, with an extensible accounting model.
8. DorkOS-branded OAuth where our app configuration exists, truthful custody
   disclosure, no fabricated credentials, unsupported capabilities, or deployment
   success. Complete deployable code and actual available provisioning; record
   any truly external unavailable approval/configuration as a specific blocker.

## Existing evidence and starting points

- packages/shared/src/connector-provider.ts: existing provider port; currently
  exposes toolServerForAccount and requires MCP-shaped execution.
- apps/server/src/services/connectors/: provider registry, Composio REST client,
  Nango/raw-MCP adapters, attachment stores, session exposure, agent capabilities.
- Current Composio identity defaults to dorkos-operator; safe migration to hosted
  tenancy cannot reuse it across customers of a shared project.
- Current agent unassignment leaves hydrated sessions connected; Composio auth
  headers are supplied to runtime MCP configuration.
- apps/client/src/layers/{entities/connectors,features/connections,widgets/connections}.
- packages/relay/src/adapters/{slack,telegram}: preserve existing behavior.
- research/20260718_connector-gateway-spike.md,
  research/20260729_connections-ux-critique.md,
  research/20260803_connection-scoping-prior-art.md: historical findings; validate
  against current source instead of treating old defects as current.

## Current primary references

- https://docs.composio.dev/examples/harness-integration
- https://docs.composio.dev/docs/authentication/white-labeling-authentication
- https://docs.composio.dev/docs/authentication/managing-multiple-connected-accounts
- https://docs.composio.dev/kb/guide/platform-session-tool-policies
- https://docs.composio.dev/docs/triggers
- https://docs.composio.dev/reference/api-reference/organization
- https://docs.composio.dev/docs/auth-configuration/migrating-initiate-to-link

## Run policy

The installed flow model bindings name Claude models unavailable to the current
Codex subagent API. Use explicitly selected gpt-5.6-sol workers for implementation
and independent review, with the root orchestrator retaining architecture and
integration responsibility. Initial discovery agents inherited the root model
before the delegation policy was read. Keep subsequent delegation workhorse-scoped.
Only this programme's worktrees and branches may be cleaned up.
