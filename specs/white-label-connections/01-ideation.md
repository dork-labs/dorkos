---
id: 260905-204014
title: DorkOS Connections — managed and BYO accounts, scoped agent access, usage, and events
status: ideation
created: 2026-09-05
provenance: { tracker: linear, project: 51f95eb0-bae7-488e-9b24-8b33028d5fd4 }
---

# DorkOS Connections — managed and BYO accounts, scoped agent access, usage, and events

**Slug:** white-label-connections  
**Author:** Dorian + Codex (autonomous ideation under the 2026-09-05 programme authorization)  
**Date:** 2026-09-05  
**Umbrella:** [DOR-1792](https://linear.app/dorkspace/issue/DOR-1792/deliver-dorkos-connections-managed-and-byo-accounts-agent-access-usage), project [DorkOS Connections](https://linear.app/dorkspace/project/dorkos-connections-590cb6b444ca)

---

## 1) Intent & Assumptions

- **Task brief:** Make Connections a complete DorkOS-owned account and event surface. Composio supplies catalog, authentication, execution, and triggers behind the `ConnectorProvider` seam; an agent never receives a Composio MCP endpoint or credential. A person can search for a service, connect one or several accounts, choose exactly which agents may use which operations or receive which events, manage and revoke access, see usage, and optionally use a DorkOS-managed hosted provider without bringing a platform key. BYO provider instances continue to work beside the managed service. A programmable DorkOS CLI uses the same authorization and accounting path as the app and MCP surface.
- **Authorization already granted:** the operator authorized autonomous IDEATE → SPECIFY → DECOMPOSE and implementation/review/merge work in isolated worktrees. This removes routine intent-stage approval pauses while preserving verification, independent review, and truthful release claims.
- **Assumptions:**
  - `ConnectorProvider` remains the swappable seam. The contract changes from “mint an MCP server” to provider-neutral discovery, auth, operation execution, connection lifecycle, and event capabilities.
  - Provider implementation and provider instance are different identities. More than one Composio or alternate-provider instance may be configured, and managed plus BYO instances may coexist.
  - Existing `connected_accounts`, `agent_connector_attachments`, and `session_connector_attachments` data is migrated through numbered Drizzle schema changes plus an atomic, ledgered application backfill. The current per-account ladder remains: an explicit session attach/detach overrides the agent-level default for that session.
  - A DorkOS account is the hosted tenant boundary. The cloud derives it from a verified linked-instance API key; no request supplies an owner id, tenant id, Composio user id, or execution URL.
  - Composio holds third-party account tokens for Composio-backed connections. DorkOS holds only its own infrastructure credentials, stable DorkOS identifiers, policy, routing, and accounting records.
  - Managed availability is reported per capability. A real project key and selected OAuth/auth config gate managed connection/execution; webhook configuration gates events only. Code or tests cannot stand in for production provisioning evidence.
- **Out of scope:**
  - Charging, plans, invoices, payment collection, or enforcing a paid quota. Usage is recorded with payer attribution so billing can be added later.
  - Replacing the native Slack and Telegram Relay adapters. They keep owning chat delivery and bot identity.
  - Claiming exactly-once event delivery. The contract is durable at-least-once delivery with idempotent persistence and explicit `received`, `dispatched`, and `completed` states.
  - Expanding DOR-740 beyond its existing chat-front-door scope or duplicating DOR-738’s raw-MCP authenticated-initialize fix. This programme reuses DOR-740 for the in-scope agent request/grant/resume front door; DOR-738 remains a separately executing rollout prerequisite.
  - Claiming unsupported provider capabilities, branded OAuth before a custom auth configuration exists, or a production deployment before a live provisioning smoke passes.

## 2) Pre-reading Log

- `specs/white-label-connections/00-brief.md`: authoritative required outcomes and programme authorization.
- `packages/shared/src/connector-provider.ts`: current provider type doubles as the configured-provider identity; account IDs are provider-scoped external handles; the mandatory execution primitive is `toolServerForAccount()`.
- `apps/server/src/services/connectors/{registry,session-exposure,attachment-store}.ts`: current routing cache, session MCP hydration, agent standing attachments, and `attached|detached` session tombstones. A disconnected account cascades persisted attachments, but agent detach does not immediately invalidate already hydrated sessions.
- `apps/server/src/routes/{connectors,agent-connectors,session-connectors}.ts`: account enumeration and connector mutations currently have no connector-specific caller policy; a caller can name arbitrary session/account identifiers.
- `apps/server/src/services/connectors/connector-capabilities.ts`: agents can list every connected account and start/poll connect flows; current in-memory flow bindings are lost on restart.
- `apps/server/src/services/connectors/providers/{composio,composio-client,nango-proxy-mcp}.ts`: Composio is a hand-written REST/MCP adapter using the fixed `dorkos-operator` identity; Nango proxy execution is a generic request and cannot truthfully inherit a read-only classification.
- `packages/db/src/schema/{connected-accounts,connector-attachments}.ts`: the local durable state to migrate. `connected_accounts` is a derived provider-routing cache; attachments use the external account id as their key.
- `apps/client/src/layers/{entities/connectors,features/connections,widgets/connections}`: existing service grid, account list, provider setup, agent/session attachment surfaces, loading/error states, and the FSD boundaries implementation must preserve.
- `apps/site/src/lib/instance-service.ts`, `apps/site/src/db/instance-schema.ts`, `apps/server/src/services/core/auth/cloud-link*.ts`: reusable Better Auth device link, scoped instance API key, owner derivation from `referenceId`, linked-instance ownership/revocation, and local token lifecycle.
- `apps/server/src/lib/{caller-authority,caller-principal}.ts`, `services/core/{approvals,capabilities}/`: shared identity and decision-authority model. With login off, DorkOS honestly cannot distinguish the app from a same-OS-user process that strips an agent header; login-on can require the operator’s browser cookie.
- `specs/connection-scoping/` and `research/20260803_connection-scoping-prior-art.md`: rationale for the agent/session two-level ladder and the consent risks of broad account access.
- `research/20260718_connector-gateway-spike.md`, `research/20260729_connections-ux-critique.md`: provider/custody history and the trust cost of surprising people with an aggregator-branded consent screen.
- ADR `260718-045630`: preserves the provider abstraction and structural custody disclosure.
- ADR `260729-234626`: chose direct OAuth first and rejected a DorkOS platform key. The operator’s 2026-09-05 request deliberately reverses that target choice; proposed ADR `260905-205123` records the partial amendment while implementation is pending.
- ADR `260804-021140`: preserves “Connections” as the user-facing umbrella, with Messaging and Accounts distinguished by intent.
- Current Composio docs (read 2026-09-05): the harness integration explicitly supports raw schemas plus `session.execute`; multiple accounts accept an exact connected-account id; custom auth configs supply white-label OAuth; triggers and webhook subscriptions expose signed event delivery; projects scope credentials/resources; usage APIs distinguish tool-call counts. References are carried into the specification.

## 3) Codebase Map

- **Shared contracts:** `packages/shared/src/{connector-provider,transport}.ts`, connector schemas and the connector conformance suite in `packages/test-utils`.
- **Local control plane:** `apps/server/src/services/connectors/`, connector routes, external/in-session MCP capability registry, config/credential storage, caller authority, approval service, session trigger/resume machinery, and SQLite schemas in `packages/db`.
- **Runtime delivery:** the existing DorkOS MCP surface is the only runtime-facing connector gateway. It exposes DorkOS operations and calls a local execution service; it never forwards provider execution URLs or credentials.
- **Client:** connector entity hooks, Connections feature UI, Connections widgets, agent settings, session inspector, global events/query invalidation, and `Transport` implementations/stubs.
- **CLI:** `packages/cli` gains account-free discovery and declared-agent list/execution/usage. Operator mutations create durable review requests and open the app; the existing API-key program identity never becomes an operator by omission.
- **Hosted control/data plane:** `apps/site` gains Node.js route handlers, tenant-scoped Postgres tables, the managed Composio adapter, signed webhook ingress, event inbox/lease APIs, and usage views. Better Auth and the linked-instance registry remain its identity source.
- **Native messaging:** `packages/relay/src/adapters/{slack,telegram}` and Relay bindings remain unchanged in behavior. Catalog presentation distinguishes bot/message access from a user/tool account and prevents duplicate ownership of the same event subscription.
- **Data flow:** authenticated caller → DorkOS authorization service → exact connection + operation/event policy → provider instance adapter → provider SDK/API → normalized result/receipt → usage ledger. Managed calls add local instance bearer → hosted tenant derivation → tenant-scoped provider adapter/ledger.
- **Blast radius:** shared contracts, local DB/config migrations, every connector route/capability, Composio/Nango adapters, client Transport and UI, CLI, site auth/schema/routes, cloud-link client, event delivery, docs/OpenAPI/e2e.

## 4) Research and Options

1. **Provider MCP session vs direct SDK execution**
   - Keep provider MCP URLs: smallest change, but long-lived URLs/headers bypass per-call account selection, revocation, operation policy, and DorkOS accounting.
   - **Direct provider execution behind DorkOS (chosen):** fetch provider-neutral operation schemas, expose DorkOS-owned MCP capabilities, and dispatch every execution through one service. This keeps policy and usage authoritative and matches Composio’s harness-integration guidance.
2. **Configured provider identity**
   - Use provider type as today: cannot represent managed and BYO Composio together or two instances of one alternate provider.
   - **Stable provider-instance ID (chosen):** type selects implementation; instance ID selects configuration/custody/payer and owns external account references.
3. **Hosted tenant isolation**
   - Accept a client-supplied Composio `userId`: simple and insecure across accounts.
   - **Derive a random tenant row from the verified Better Auth owner (chosen):** instance bearer verification yields `referenceId`; instance metadata and registry ownership must match; a tenant’s Composio identity is stored server-side and unique. Every domain query includes tenant scope.
4. **Operation policy shape**
   - Toolkit-wide access: convenient but new upstream tools silently widen access.
   - **Immutable operation-revision allowlist (chosen):** grants reference the reviewed toolkit, slug, provider version, schema hash/input schema, and classification snapshot; unknown, changed, or reclassified revisions default denied until user review. General DorkOS approval/autonomy gates still apply, so a connector grant never widens unrelated authority.
5. **Event delivery**
   - Hosted-only relay: durable while a local instance is offline, but silently makes ordinary BYO events depend on a DorkOS cloud link.
   - Local-only webhook: keeps BYO independent, but cannot promise hosted retention while the instance is offline.
   - **Two signed ingresses with one local router (chosen):** managed webhooks enter the hosted lease/cursor inbox; BYO webhooks enter a provider-instance-scoped local route exposed through the existing tunnel or configured endpoint. Both persist and dedupe before ACK and share dispatch states; BYO offline delivery is limited to provider retries unless managed relay is explicitly selected.
6. **Managed multitenancy**
   - One provider project per DorkOS tenant: strongest provider-side partition, but adds org-key provisioning and per-tenant key custody before demand proves it necessary.
   - **One DorkOS production project with unique server-derived Composio user identity per tenant (chosen for v1):** DorkOS authorization and tenant-scoped records prevent cross-account references; provider project credentials never leave the site. Project-per-tenant remains possible behind the provider-instance seam if policy or scale later requires it.
7. **Agent connect completion**
   - Return a URL and ask the user to tell the agent when finished: current behavior, fragile across long auth flows/restarts, and violates the requested resume experience.
   - **Durable request + live hold/follow-up resume (chosen):** a live capability wait resumes the same tool call; after restart, a claimed durable resume record triggers one deduplicated follow-up turn in the original session.

## 5) Recommendation

Adopt stable provider-instance and DorkOS connection identities; replace provider-MCP execution with direct SDK/API execution behind `ConnectorExecutionService`; centralize caller, grant, revocation, and usage checks for REST, MCP, CLI, and hosted calls; add the managed provider to `apps/site` by reusing the linked-instance identity; deliver events through signed hosted managed and local BYO ingresses with one persist-before-ACK router; and make agent connection requests durable and self-resuming.

Sequence the programme as seven independently reviewable branches: contracts/migration; authorization and local execution; complete UI/CLI/REST management; managed hosted service; events; agent request/resume; rollout/legacy removal/provisioning evidence. Contracts lead to execution; the complete local experience and managed service then proceed in parallel; events and agent resume follow their listed dependencies. The managed service, event UI, and request flow remain unavailable with an honest reason until their dependencies and real provisioning gates clear.

## 6) Decisions

| #   | Decision           | Choice                                                                                                                                                                                   | Rationale                                                                                                    |
| --- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 1   | Execution boundary | Composio SDK/API behind `ConnectorProvider`; no Composio MCP endpoint reaches an agent                                                                                                   | Enables exact account/operation checks, immediate revocation, and accounting on every call                   |
| 2   | Identity           | Separate provider type, configured provider-instance ID, and stable DorkOS connection ID                                                                                                 | Managed and BYO coexist; external IDs never become public authorization handles                              |
| 3   | Access             | Grants reference immutable operation revisions; event subscriptions and operator management are separate authority                                                                       | New/reclassified operations require review; use, receive-events, and management do not imply one another     |
| 4   | Session semantics  | Preserve explicit session attach/detach precedence during migration; grant/connection revocation always dominates                                                                        | Avoids data loss while fixing stale live access                                                              |
| 5   | Agent removal      | Remove its standing and session-scoped grants/subscriptions and invalidate live access by default                                                                                        | Matches the immediate-revocation promise; preservation requires an explicit future operator action           |
| 6   | Managed tenancy    | Better Auth owner → random tenant row → unique Composio user identity; never client supplied                                                                                             | Reuses verified cloud linking and prevents cross-account identifier substitution                             |
| 7   | Managed home       | Node.js routes and Postgres models in `apps/site`, not a new app                                                                                                                         | Reuses deployed auth/data infrastructure and keeps one hosted account boundary                               |
| 8   | Events             | Hosted managed inbox with leases plus signed local BYO ingress; protected durable payload/retry state is separate from audit receipts                                                    | Managed survives offline instances; BYO remains cloud-independent; both recover after local worker restart   |
| 9   | Review requests    | Versioned discriminated operator actions with canonical validated payloads; agent requests link a separate resume record                                                                 | CLI/agent requests cannot smuggle arbitrary mutations, and restart state has one owner                       |
| 10  | Usage              | Logical operation separated from attempts and linked to the executed operation revision; payer/provider/surface attributed; no payload capture                                           | Supports current visibility and later billing without recording sensitive content                            |
| 11  | OAuth branding     | Use custom Composio auth config where DorkOS credentials exist; otherwise name the provider and custody before redirect                                                                  | Never fabricates DorkOS-branded OAuth                                                                        |
| 12  | Native messaging   | Preserve Slack/Telegram adapters and show message/bot intent separately from tool/user-account intent                                                                                    | One service catalog without collapsing two identity and consent models                                       |
| 13  | Prior direction    | Propose amending ADR 260729-234626’s “no DorkOS-held platform key” choice and ADR 260718-045630’s provider-MCP execution assumption; preserve their remaining provider/custody decisions | The operator explicitly requested a managed option with hosted tenancy and accounting; BYO remains available |

No unresolved product ambiguities remain under the programme authorization. External production credentials, auth-config approval, webhook configuration, and deployment are evidence gates, not design questions.

**Next step:** SPECIFY, then DECOMPOSE.
