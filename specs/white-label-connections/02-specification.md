---
id: 260905-204014
title: DorkOS Connections — managed and BYO accounts, scoped agent access, usage, and events
status: specified
created: 2026-09-05
provenance: { tracker: linear, project: 51f95eb0-bae7-488e-9b24-8b33028d5fd4 }
---

# DorkOS Connections — managed and BYO accounts, scoped agent access, usage, and events

**Status:** Approved  
**Author:** Dorian + Codex (specified autonomously under the 2026-09-05 programme authorization)  
**Date:** 2026-09-05  
**Umbrella:** [DOR-1792](https://linear.app/dorkspace/issue/DOR-1792/deliver-dorkos-connections-managed-and-byo-accounts-agent-access-usage), project [DorkOS Connections](https://linear.app/dorkspace/project/dorkos-connections-590cb6b444ca)

## Overview

DorkOS Connections becomes the complete control plane for accounts an agent may use and events an agent may receive. A person searches one catalog, authenticates an account, chooses agents and exact operations or events, and can later rename, edit, reconnect, pause, disconnect, or inspect usage. Gmail, Notion, Linear, and any provider that supports it may have several accounts, each with a stable DorkOS connection ID.

Composio is an implementation behind DorkOS, never an MCP endpoint handed to an agent. DorkOS reads operation schemas and executes through the provider SDK/API after checking the caller, tenant, agent, connection, operation, status, and approval policy. The same execution service serves the DorkOS MCP capability, operator REST API, and programmable CLI, and writes the same usage ledger. Native Slack and Telegram messaging stays on Relay; the catalog distinguishes a bot/message connection from a user/tool account.

An optional DorkOS-managed provider runs as Node.js routes and Postgres data in `apps/site`. It reuses Better Auth device linking and scoped instance API keys. The hosted service derives tenant ownership from the verified key and never trusts a request-supplied tenant, owner, provider user ID, or execution URL. Managed credentials stay hosted. BYO provider instances remain local and may coexist with the managed provider in the same UI.

## Background / Problem Statement

The shipped connector gateway proves catalog, multi-account metadata, connection flows, agent/session attachment, and provider degradation, but its execution boundary is wrong for the requested product. `ConnectorProvider.toolServerForAccount()` produces a vendor MCP session URL and headers that a runtime can keep using without DorkOS seeing each call. DorkOS therefore cannot reliably enforce an operation allowlist, revoke the next call, attribute logical operations versus retries, or provide one path shared by MCP, REST, and CLI.

The current provider `type` also acts as a configured-instance identity. That prevents managed Composio, a user’s BYO Composio project, and an alternate provider from coexisting cleanly. `ConnectedAccountId` is the provider’s external account handle, so public authorization and persisted attachments depend on a vendor identifier. Composio uses one fixed `dorkos-operator` user id, which cannot be shared across hosted customer accounts.

Authorization is incomplete at the public seam. Connector account listing returns every private account to any caller that reaches the capability. Connector connect/disconnect and agent/session attach/detach routes do not apply connector-specific caller policy, and detach accepts an arbitrary session id. The current agent-detach path removes durable standing intent while already hydrated sessions retain the cached vendor MCP connection. A provider credential or URL in a runtime is therefore stronger than the data model’s revocation promise.

Events and durable agent connection requests do not exist. Composio connect-flow bindings are process-memory only. Users have to tell the agent to poll after authentication. A hosted event sent while the local instance is offline has nowhere durable to wait. Current account/provider aggregation also cannot say which party pays for a call.

The programme must fix those gaps without losing existing connected-account or attachment data, weakening the session override semantics, replacing Relay messaging, inventing production credentials, or claiming that polling-only provider triggers are real-time.

## Goals

- Put all provider execution behind a provider-neutral DorkOS service that enforces exact connection and operation access on every call.
- Keep provider SDK imports inside named Composio adapter boundaries used by the local server and hosted site, sharing a narrow implementation package only when code reuse warrants it.
- Separate provider implementation type, configured provider instance, stable DorkOS connection, and external provider account reference.
- Support managed and BYO provider instances together and several accounts of the same service.
- Give operators a simple service-search and account-management UI with list, label/edit, reconnect, pause/resume, disconnect, exact agent access, event routing, and usage.
- Separate operation use, event receipt, and connection/grant management authority. Prevent agent/program self-grants and cross-account identifier substitution.
- Preserve existing agent/session connector intent and explain inherited versus session-overridden access.
- Record authoritative managed usage and authoritative local BYO usage, distinguishing a logical operation from attempts and payer attribution.
- Add a deployable hosted managed service on the existing site account/instance infrastructure.
- Verify, dedupe, filter, queue, retry, and route provider events. Managed subscriptions add hosted offline retention; direct BYO subscriptions use provider-dependent webhook retries and make no hosted offline guarantee.
- Let an agent request a service without learning private accounts, let a person authenticate and grant one exact account, and resume work without a manual “I’m done” message.
- Keep custody and availability claims truthful at every step.

## Non-Goals

- Billing, pricing, invoices, charging, paid quota enforcement, or payment-provider work.
- Replacing Slack/Telegram Relay adapters or routing ordinary chat messages through Composio.
- Exactly-once event or tool execution. Tool calls use idempotency where the upstream supports it and never blindly retry an ambiguous non-idempotent result; events are at least once.
- Promising that an upstream polling trigger is real-time.
- Per-tenant Composio project provisioning in v1. The provider-instance seam allows it later; v1 uses one DorkOS project and unique server-derived provider user identities.
- Importing third-party OAuth tokens into DorkOS or displaying provider secrets/execution URLs.
- Expanding DOR-740 beyond its existing chat-front-door scope or duplicating DOR-738. This programme reuses DOR-740 for agent request/grant/resume where its scope fits; DOR-738 must be green before the final rollout gate.
- Keeping deprecated connector endpoints or types after active consumers migrate. Boundary aliases exist only when a live consumer requires a short same-program transition and are removed in the final workstream.

## Technical Dependencies

- `@composio/core`, pinned by the workspace lockfile and imported only inside an approved Composio adapter boundary. The implementation must inspect the selected SDK and reconcile its Node engine floor with every supported CLI, CI, server, desktop, and hosted runtime before shipping; a lockfile pin that cannot run on a supported DorkOS Node version fails acceptance. It may use separate thin local/site adapters if sharing would couple runtimes. Every executable operation stores the discovered toolkit/schema version and passes that exact version to `tools.execute`; the global dangerous “latest” bypass is forbidden.
- Existing `ConnectorProvider`, connector conformance, `Transport`, capability registry, approval service, caller authority/principal readers, credential-provider reference discipline, and runtime DorkOS MCP surface.
- Existing SQLite/Drizzle database for local provider instances, connections, immutable operation revisions/grants, session overrides, typed review/agent requests, usage, event inbox, and receipts.
- Existing Next.js 16 Node.js routes, Neon Postgres/Drizzle, Better Auth, device authorization, instance API keys, and `apps/site/src/lib/instance-service.ts` ownership checks.
- Existing cloud-link manager and scoped instance bearer token for local-to-hosted calls.
- Existing session trigger/turn-settlement and approval-hold machinery for live and post-restart request resumption.
- Composio APIs: catalog, connected accounts, custom auth configs, direct operation schemas/execution, triggers, webhook subscriptions/signature verification, and provider log IDs.
- Related prerequisite: DOR-738 must verify raw-MCP authenticated initialization rather than report a fabricated connection success. Related follow-up: DOR-740 owns the broader chat-front-door experience.

## Detailed Design

### 1. Stable identities and provider contract

The public model has three separate identifiers:

```ts
type ConnectorProviderType = string; // implementation, e.g. composio, nango, raw-mcp
type ConnectorProviderInstanceId = string & { readonly __brand: 'ConnectorProviderInstanceId' };
type ConnectionId = string & { readonly __brand: 'ConnectionId' };
```

`ConnectorProviderInstanceId` identifies configuration and payer. It carries `type`, `mode: 'managed' | 'byo'`, display name, custody, capabilities, health, and a secret reference or cloud link. `ConnectionId` is a DorkOS-generated opaque ID. A private provider binding maps it to the provider instance and external account reference. External account references, auth-config IDs, SDK session IDs, headers, tenant IDs, and execution URLs never cross a public DTO.

The `ConnectorProvider` port becomes instance-bound and capability-based. Exact method names may follow established naming, but the conformance contract is normative:

- catalog discovery and search return stable toolkit/service metadata without user account data;
- begin/complete/reconnect auth return reference-shaped flows and typed status;
- list/reconcile provider accounts writes normalized connection metadata through the registry;
- list/get operation schemas returns stable operation slug, JSON Schema, toolkit/schema version, capability classification, and upstream delivery limits. Catalog and operation discovery follow every cursor/page to a configured hard ceiling and surface truncation; raw-tool discovery requests an explicit search/limit or `important: false` when complete enumeration is intended, because the SDK’s default important subset is not a complete catalog;
- execute accepts the server-only provider account reference plus exact operation, arguments, logical operation id, attempt id, and abort signal, and returns normalized data/error/provider log id;
- event capability discovery and subscription creation/removal are optional and declared honestly; in-place subscription update and pause controls are deferred;
- unsupported capabilities return a typed `unsupported` result and do not render as available.

`toolServerForAccount()` is removed from the required port after consumers migrate. No Composio MCP URL or auth header is placed in `McpAppServerConnection`. DorkOS may expose connector actions to runtimes through its own existing MCP server, but that server calls the same execution service used by REST and CLI.

SDK confinement is a hard guard. Allowed roots are the local Composio adapter under `apps/server/src/services/connectors/providers/composio/**`, the hosted adapter under `apps/site/src/lib/connectors/composio/**`, and, only if the implementation extracts meaningful transport-neutral reuse, one narrow internal package dedicated to the Composio adapter. A repository guard enumerates imports from `@composio/core` from the source of truth and fails for every other path. The site must not be forced into hand-written REST duplication merely to satisfy a server-only import rule.

### 2. Local durable model and transactional migration

Local SQLite adds:

- `connector_provider_instances(id, type, mode, display_name, custody, capability_json, credential_ref, status, error, created_at, updated_at)`;
- `connections(id, provider_instance_id, external_account_ref, toolkit, label, identity_hint, status, lifecycle_state, enabled, auth_config_ref, grant_reconciliation_status, created_at, updated_at, last_verified_at)`, where provider-reported authentication, the local disconnect tombstone, and operator pause remain independent;
- `connector_operation_revisions(id, provider_instance_id, toolkit, operation_slug, toolkit_version, schema_hash, capability_classification, input_schema_json, discovered_at)`; rows are immutable and unique for the provider instance, operation, version, schema hash, and capability classification;
- `connection_operation_grants(id, subject_type, subject_id, agent_id, connection_id, operation_revision_id, created_by, created_at, revoked_at)` where `subject_type` is `agent|session`;
- `connector_event_subscriptions(id, connection_id, agent_id, destination_kind, destination_id, event_type, filter_json, filter_hash, delivery_mode, enabled, created_by, created_at, updated_at)`;
- `connector_review_requests(id, action_kind, action_version, requester_kind, requester_id, target_kind, target_id, action_payload_json, state, expires_at, idempotency_key, created_at, resolved_at, resolved_by, resolution_summary)`; `action_payload_json` is encoded only after a versioned discriminated Zod action schema validates it and is decoded through that same schema, never accepted as arbitrary JSON;
- `connector_agent_requests(id, review_request_id, agent_id, session_id, service_slug, requested_operations_json, requested_events_json, reason, resume_state, resume_token, created_at)`; the linked review request owns operator resolution while this row owns private agent intent and resume state;
- `connector_usage_attempts(attempt_id, logical_operation_id, attempt_index, surface, actor_kind, actor_id, agent_id, session_id, connection_id, provider_instance_id, provider_type, payer, operation_revision_id, outcome, provider_log_id, started_at, completed_at, error_code)`;
- `connector_event_inbox(id, provider_instance_id, subscription_id, provider_event_id, payload_schema_version, normalized_payload, payload_protection, state, attempt_count, next_attempt_at, expires_at, lease_owner, leased_until, received_at, dispatched_at, completed_at, failure_code)` with atomic claim/lease fields and a unique dedupe key;
- `connector_event_receipts(id, inbox_id, subscription_id, provider_event_id, state, recorded_at, destination_receipt_id, failure_code)` as the append-only audit of inbox delivery transitions, without owning retry payload/state.

An operation revision freezes the toolkit, operation slug, provider version, input schema hash/body, and read/write/destructive classification that the operator reviewed. Grants and usage attempts reference its ID. If discovery produces a new schema hash, toolkit version, or classification, DorkOS inserts a new revision and requires user review before replacing the grant; it never mutates a granted revision or silently follows the operation slug to new behavior.

The session override table remains the canonical precedence record, renamed/rekeyed to stable connection IDs if needed: `attached` means use session-scoped operation grants; `detached` suppresses inherited agent grants; no row inherits agent grants. A session row never creates authority by itself. An operation must still have an unrevoked grant for that subject. Connection pause/revoke and grant revocation dominate the ladder.

A numbered Drizzle schema migration adds the tables and a connector application-migration ledger without destructive legacy changes. Connector backfill then runs at an explicit application boundary:

1. Resolve provider operation metadata outside the SQLite transaction. Network access is never held inside the database transaction; an unavailable schema yields a staged `migration_needs_reconcile` decision rather than a broad grant.
2. In one SQLite transaction, claim the migration-ledger version, seed every configured provider instance plus an unavailable default for each legacy-only provider type, copy every `connected_accounts` row to a generated stable `connections.id`, and retain the external id only in the private binding. The first configured instance of a legacy type is its deterministic backfill owner; later reconciliation may move it only through explicit operator review.
3. Rewrite agent/session attachment references through that mapping, insert immutable operation revisions and grants only for the resolved operation set, preserve every `attached|detached` override exactly, verify counts and foreign references, and mark the ledger complete. Agent consent is copied only for a currently registered agent that has no durable legacy-removal marker. The marker survives a failed backfill and same-ID re-registration so retained old consent cannot return as authority; it does not block a new explicit canonical attachment or grant. A migrated session override gains an agent owner only from the exact current `session_metadata.agent_path -> agents.project_path` relationship and the same removal check. An unresolved row remains durable as `needs_reconciliation`, receives no authority, and requires explicit operator review.
4. Switch all active consumers, then remove superseded columns/tables/types with the consumer-owned numbered migration. No open-ended dual-write window remains.

Failure rolls back the claimed application backfill and preserves every legacy row. The server continues serving unrelated domains, while the connector subsystem reports a stable `migration_failed` health response, blocks connector reads and writes, and retries idempotently on restart; it never switches to an empty or mixed inventory. The foundation workstream exposes temporary legacy DTO/method projections only for active consumers; it does not install a dormant destructive boot migration. Execution consumers cut over and remove provider-MCP methods in workstream 2, management/Transport consumers cut over and remove the last legacy projections/tables in workstream 3, and each deletion lands with its last consumer. No legacy table remains writable beside the new source of truth. A real old-shape fixture covers multiple accounts for the same toolkit, missing provider configuration, expired accounts, tombstones, process interruption, and a second idempotent start; a separate new-shape test proves the same external account reference can exist under two provider instances without collision.

Agent-level removal is stronger than today. Removing a connection from an agent deletes/revokes its agent grants, event subscriptions, and session-scoped grants/overrides for sessions belonging to that agent, then invalidates live runtime exposure before returning. A future explicit operator flow may preserve session overrides, but v1 does not expose it and no default preserve occurs.

### 3. Authorization and immediate revocation

`ConnectorAuthorizationService` is the only way to manage or execute a connection. Routes and capabilities pass a `CallerPrincipal`/decision-authority context; they do not rebuild policy from headers.

- Catalog discovery is public to an authenticated/local caller and contains no connected-account metadata.
- An operator may list and manage their own local connections. With login enabled, connect, reconnect, pause, disconnect, provider credential changes, grant changes, and subscription changes require the signed-in operator’s cookie. An API-key program can execute only through a declared agent and cannot become an operator by omitting that identity.
- With login disabled, default local onboarding continues to work. The UI/API posture explicitly says DorkOS cannot distinguish the app from another process running as the same OS user that strips identity headers. It never claims account-grade isolation in this posture.
- An agent sees catalog metadata, its own request statuses, and only connection aliases/operations already granted to it. It cannot list other private connected accounts, start auth as the operator, attach itself, widen operation access, create a receive-events subscription, or mutate connection state.
- A bridged caller cannot manage connections or grants.
- A program/agent may never supply an owner, tenant, external account reference, provider session URL, or provider user id. Stable IDs are resolved under the authenticated owner first. A mismatch returns the same not-found response as an absent record.

The execution authorization key is `(owner, agentId or operator actor, connectionId, operationRevisionId)`. The service verifies, in order: caller identity, owner scope, provider-instance health, connection `active` state, subject/session precedence, exact unrevoked revision grant, immutable schema/version/classification, existing DorkOS autonomy/approval gate, then dispatch. An operation slug resolves only through the granted revision; unknown, new, or reclassified revisions default denied. A connector grant does not bypass the ordinary capability tier or approval system.

Every future call rechecks durable state. Schemas may be cached, but authorization, connection status, and grant revision may not. Pause, disconnect, agent removal, session detach, and grant removal bump/revoke policy state and invalidate any runtime-visible operation cache synchronously. Because runtimes hold only the DorkOS MCP surface, no vendor URL remains available to evade the next check.

Every security guard gets a public-seam mutation test: prove the request succeeds with the guard, remove or invert that guard locally, and prove the intended test fails while the green baseline passes. Tests name the exact actor/account/connection they assert. Generic Nango proxy requests are classified write-capable and cannot pass a read-only operation policy; providers without trustworthy operation classification expose the narrower honest capability or remain unavailable.

### 4. Execution, MCP, REST, and CLI

`ConnectorExecutionService.execute()` takes a normalized command:

```ts
interface ConnectorExecutionCommand {
  connectionId: ConnectionId;
  operation: string;
  arguments: Record<string, unknown>;
  agentId?: string;
  sessionId?: string;
  logicalOperationId: string;
  idempotencyKey?: string;
}
```

It resolves the connection/provider instance privately, authorizes, opens an attempt row, calls the provider, closes the attempt, and returns a normalized result plus a receipt. It does not store request arguments or response data in the usage ledger. A transport error before a provider acknowledgement may retry only when the operation/provider declares safe idempotency; an ambiguous write is returned as `outcome_unknown` for human reconciliation. Attempts share one logical operation ID and increment `attemptIndex`.

The private turn-bound DorkOS MCP surface exposes two read-only discovery tools, `connectors.list_granted_connections` and `connectors.list_granted_operations`, beside the three classified execution tools `connectors.execute_read`, `connectors.execute_write`, and `connectors.execute_destructive`. Discovery derives owner, agent, and session from the authenticated runtime principal and returns only currently executable connections and exact immutable operation schemas already granted to that turn. Execution requires the listed exact `connectionId` and `operationRevisionId`; no “first Gmail account” fallback exists when several are connected. Account-free toolkit discovery remains on the ordinary DorkOS surface. Connector management capabilities are operator-only and are not offered to an agent as a self-grant path.

Operator REST uses resource-oriented routes under `/api/connectors`:

- `GET /catalog?q=&cursor=`;
- `GET|POST /provider-instances`, `PATCH|DELETE /provider-instances/:id`;
- `GET|POST /connections`, `GET|PATCH|DELETE /connections/:id`;
- `POST /connections/:id/reconnect`, `/pause`, and `/resume`;
- `GET|PUT|DELETE /connections/:id/agents/:agentId/access`;
- `GET /agents/:agentId/connections`;
- `GET|POST|PATCH|DELETE /connections/:id/subscriptions...`;
- `GET /usage` and `GET /connections/:id/usage`;
- `POST /execute` for authenticated programmatic calls.

Connect flows are durable rows bound to caller/owner/provider instance and callback state, not a process map. Polling remains an internal UI transport detail; callback/reconciliation updates the row and broadcasts a state event.

The CLI uses its existing API-key program identity and never imports a provider SDK. Catalog search is account-free. Connections list/show, operation discovery, calls, subscriptions, request status, and usage require `--agent <id>` and return only that agent’s granted aliases and scope; `connection call` always names an exact connection and operation. There is no operator-by-omission mode.

Commands that need operator authority—connect, edit, reconnect, pause/resume, disconnect, access changes, subscription mutation, and request resolution—create a typed `connector_review_requests` action and open or print its local app URL. The versioned discriminated action union defines the exact target and allowed fields for each mutation; parsing rejects unknown fields and stores a canonical validated payload, requester principal, expiry, idempotency key, and later resolution actor/summary. The API-key request may describe the desired action but cannot execute it. The app resolves the request through the existing cookie-authenticated operator posture, or the disclosed same-OS-user posture when login is off; the CLI may poll the opaque request status and exits successfully only after the operator-applied mutation is observable. This handshake reuses existing browser authority instead of adding a general CLI operator credential. Exit codes and error codes distinguish awaiting review, denied, unavailable, expired, unknown outcome, and upstream failure.

### 5. Usage and payer attribution

One logical operation may have zero or more attempts. The local ledger is authoritative for BYO calls. The hosted ledger is authoritative for managed calls because it observes the provider call; the local instance stores a mirror receipt for UI continuity and reconciles by hosted attempt ID.

Each attempt records provider instance/type, payer (`operator_byo` or `dorkos_managed`), surface (`mcp|rest|cli|event`), actor, optional agent/session, exact connection/operation, outcome, timestamps, and provider log ID. It never records arguments, results, tokens, account email beyond the connection’s existing display label, or raw provider errors that may contain data. Logical-operation totals and attempt totals are both shown. Provider-reported usage may be displayed as a reconciliation source, but it does not overwrite DorkOS’s execution ledger.

Billing and charging remain absent. Schema fields allow later quantity/unit/cost records without interpreting current counts as an invoice.

### 6. Managed hosted service

Managed routes run in the existing `apps/site` deployment with `runtime = 'nodejs'`. They share Better Auth and Neon; no new app or independent identity system is introduced.

The local instance authenticates with its existing scoped instance bearer key. Hosted middleware verifies the key, reads `verified.key.referenceId`, reads the bound `instanceId` from key metadata, and requires a live instance registry row owned by that same user. It then loads or creates one random `connector_tenants` row keyed uniquely to the user. That row owns a unique provider user identity. Request bodies cannot override any part of this chain.

Hosted tables are tenant-scoped: provider connection bindings, durable auth flows, immutable operation revisions and grants relevant to hosted enforcement, usage attempts that reference revisions, subscriptions, event inbox, instance delivery leases/cursors, and audit entries. Every unique key and query begins with tenant ID where records can collide. Stable managed connection IDs are site-owned and remain stable across local relinks; local mirrors are namespaced to the managed provider instance.

The hosted Composio adapter uses the SDK directly. It creates/reuses a per-tenant Composio session with `manageConnections: false`, sandbox disabled, exact toolkit/operation/connected-account filters, and custom auth-config IDs where configured. Execution pins the exact `connectedAccountId`; no SDK “most recent account” or default-account fallback is allowed. Each execution uses the toolkit version stored with the granted operation schema, refreshes/reviews that schema before a version change, and never disables the SDK version guard globally. Provider SDK sessions are never returned to the local instance.

Managed account linking uses an HTTPS callback verifier route in `apps/site`. Before redirect, the site creates a single-use, expiring flow bound to the signed-in Better Auth owner, provider instance, server-derived provider user ID, auth config, browser state, and PKCE/CSRF verifier where the upstream supports it. Completion requires the same signed-in owner, matching state/verifier, and the one unused `session_uri`; it ignores a caller-supplied callback URL whenever project callback verification is enabled. Success consumes the flow atomically before the connection becomes visible. Replays, signed-out callbacks, another user/browser, changed provider user ID/auth config, expired state, and callback URL substitution all fail without revealing account metadata. The implementation verifies these fields against the selected SDK/API version rather than copying an older documentation example.

Deployment configuration is Zod-validated and fail-closed. It includes an enable flag, a DorkOS-owned Composio project API key, a toolkit→custom-auth-config map, public callback origin, webhook subscription/signing secret, and any SDK-required project/version configuration. Secrets stay in hosted environment/secret storage; auth-config IDs may be configuration. Availability is per capability: catalog may stay available while authentication lacks a custom auth config; connection and execution may stay available while events lack webhook configuration; only the affected capability reports `unavailable` with a plain reason. Missing webhook setup must not globally disable connection execution.

The code workstream is incomplete until deployable routes, migrations, tests, and operational docs exist. Product availability is a separate external gate: provision the real Composio project/key, create and verify each custom OAuth app/auth config, register/rotate the webhook secret, deploy migrations/routes, link a real instance, complete one real grant, execute a harmless read through the production path, verify its hosted and mirrored usage receipts, revoke it, and prove the next call is denied. If credentials, OAuth approval, or deploy access is unavailable, record the exact blocker and keep managed UI unavailable; never substitute mocks as production evidence.

### 7. One catalog and complete account UX

The Connections page remains the outside-world umbrella. It presents one searchable service catalog. A Slack result can show two explicit intents: “Messages through a Slack bot” (Relay, bot identity, where people reach agents) and “Use a Slack account” (connector, user identity, operations/events). Telegram follows the same principle where a tool-account provider exists. Existing Relay adapters, bindings, and behavior remain untouched.

Selecting account intent follows the short happy path: service → sign in → choose agents. The healthy default route shows one short custody line; **Change provider** exposes alternate routes, and BYO configuration stays in advanced settings. If a DorkOS custom auth config exists, consent may be described as DorkOS-branded; otherwise copy names Composio/provider before the person leaves. Inventory rows stay concise and open a drawer for access, events, usage, and lifecycle details. No unavailable service, trigger, auth mode, or brand is shown as working.

Connected accounts group by service and retain individual labels. Each row shows identity hint, custody, managed/BYO payer, status, agents with access, event routes, recent logical operations/attempts, and actions: rename/edit, reconnect, pause/resume, disconnect. Disconnect requires a concrete review of agents/subscriptions that will lose access. Pause preserves metadata and grants but denies new operations and event dispatch. Reconnect updates the private external binding while retaining the stable connection ID and requires the operator to review retained grants if the upstream identity changed.

Access is editable from both directions: a connection shows agents; an agent profile shows connections. The simple editor offers **Read** and **Read + write** presets that resolve to a reviewed, explicit set of operation slugs pinned to the catalog/toolkit schema version. Advanced mode edits individual operations and events. The stored grant is always the resolved explicit snapshot; newly appearing or reclassified provider operations are off until an operator reviews them. Session UI explains `Inherited from agent`, `Allowed only in this session`, or `Disabled in this session`; it never implies a detached session can override a paused/revoked connection or revoked grant.

Every surface handles loading, empty, partial-provider warning, auth pending, popup/redirect failure, expired, paused, disconnected, managed unavailable, event polling, retry, and usage-unavailable states. Controls are keyboard reachable, use stable accessible names/test IDs, theme tokens, visible focus, mobile/tablet/desktop layouts, and no copy-bound Playwright locators.

### 8. Event subscriptions, managed and BYO ingress, and local routing

Operation use does not imply event receipt. An operator creates a subscription by selecting an exact connection, supported event type, provider-declared filter fields, one target linked instance, one agent, and an explicit destination:

- `agent`: trigger a private agent/session turn;
- `room`: post to an existing DorkOS room through its durable entry path;
- `channel`: deliver through an existing DorkOS channel/binding path when that destination supports it.

For managed subscriptions, the hosted server validates that the target instance and connection belong to the same tenant. For BYO subscriptions, the local server validates provider-instance ownership plus agent/destination existence. A canonical `filterHash` plus the owning scope, connection, event type, target, agent, and destination owns one subscription; retries do not create duplicate upstream triggers. Version 1 creates and removes subscriptions; in-place editing is deferred. The connection page is the owner. Relay retains ownership of ordinary Slack/Telegram chat ingestion; a provider event subscription is created only for explicit account-event intent.

Both ingress paths read the raw body, require the provider signature identifiers and timestamp, verify HMAC with a constant-time comparison or SDK verifier, and reject timestamps outside the provider’s replay window (300 seconds for Composio). Managed ingress resolves the upstream trigger under the hosted tenant and writes the hosted inbox with uniqueness `(tenantId, subscriptionId, providerEventId)`. BYO ingress resolves a provider-instance webhook-secret reference and subscription locally, through a signed endpoint exposed by the existing DorkOS tunnel or an operator-configured public endpoint, then writes the same normalized durable local receipt/inbox with uniqueness `(providerInstanceId, subscriptionId, providerEventId)`. Duplicate valid delivery returns success without enqueueing twice. Invalid signatures, unknown subscriptions, cross-owner account IDs, and oversized bodies never create rows.

The inbox owns the normalized payload and restart-safe retry state; receipts only audit state transitions and destination acknowledgements. Inbox state is `received -> leased -> dispatched -> completed`, with `failed|expired` terminal states. An atomic claim changes an eligible row to `leased`, increments `attemptCount`, assigns `leaseOwner/leasedUntil`, and prevents two workers from dispatching the same active lease. `nextAttemptAt` and `expiresAt` bound retry and retention. Managed pull responses lease a bounded batch to one intended linked instance; an expired lease may be redelivered. A per-instance monotonic cursor improves scanning but is not the dedupe key. BYO inbox rows enter the same local dispatch state machine directly and need no cloud link or hosted lease. Sensitive normalized payload is minimized or encrypted according to its schema and deleted at expiry; logs and receipts contain IDs/status only.

For managed subscriptions, the local worker pulls only while cloud linked and persists `(subscriptionId, providerEventId)` plus the normalized payload before ACK. For BYO subscriptions, local signed ingress performs that durable persistence before acknowledging the provider. Both paths then use one routing worker through the existing durable room/channel/session boundary, record `dispatched`, wait for the destination receipt or turn completion that the path can actually prove, and record `completed`. A crash after local persistence but before ACK may cause provider redelivery and hits the local dedupe row. Managed delivery has the hosted lease/retry/TTL contract; direct BYO offline delivery depends on the upstream provider’s webhook retry policy and is described honestly. A hosted relay for a BYO provider instance is deferred; cloud linking is not required for BYO execution or direct events. The UI may say delivered/completed according to recorded states; it never says exactly once.

Trigger metadata declares `deliveryMode: webhook|polling|none` and expected cadence when known. The UI says “Checks about every …” for polling-backed services. Subscription removal, receive-authorization revocation, connection pause/revoke, provider-instance revoke, or destination deletion stops new dispatch immediately and moves queued work to an explicit cancelled/failed reason; it does not silently retarget. Removing an operation-only grant does not stop an independently authorized event subscription. Agent-wide connection removal revokes both operation grants and receive subscriptions by contract.

### 9. Durable agent requests and automatic resume

An agent calls a DorkOS capability with service slug, reason, requested operation slugs, and optional event needs. The response path creates a typed `agent_connection_request` review action plus its linked `connector_agent_requests` resume record; it does not enumerate the operator’s accounts. Repeated calls with the same agent/session/service and unresolved intent use the review idempotency key and return the same request.

The app shows the request with the agent’s reason and requested scope. The operator may deny it, choose an already connected exact account, or authenticate a new account. They then choose the final operation/event allowlist. The server performs the grant; the agent never invokes a grant mutation. If the chosen account belongs to a different authenticated owner or the agent/session is no longer valid, resolution fails without revealing whether the foreign record exists.

While the originating turn is live, the connector capability uses the existing approval-hold pattern to wait and resume with a real result naming the stable connection and granted operations. The durable request is still written first. If the process restarts, the live hold expires, or the runtime cannot resume an in-flight tool call, a reconciler claims `resume_state=pending` and sends one system-authored follow-up turn to the original session through the existing trigger/staged-context path. A durable dedupe token prevents two resumes. The follow-up says the request was granted/denied/expired and instructs the agent to continue the original intent; the user sends no polling message.

Deleted sessions, removed agents, denied requests, auth failure, and request expiry reach explicit terminal states and never grant access. Connection flow completion broadcasts a request-specific event so the UI and live hold update without manual polling.

## API and Data Contract Changes

The shared Zod schemas are authoritative. `Transport` gains every catalog, provider-instance, connection lifecycle, access, immutable operation revision, execution, subscription, typed review/agent request, and usage method. `HttpTransport` uses REST; embedded/DirectTransport either calls the same service or returns a typed unsupported state where hosted auth cannot run. No client component uses raw `fetch`.

Existing account/attach DTOs migrate to stable `ConnectionId`. Public account shapes never include provider type unless presented as a custody route chosen by the operator, and never include external IDs. OpenAPI is regenerated after routes settle. Existing connector MCP tools either change atomically with their only consumers or receive a short boundary alias removed by workstream 7; no dual behavior or dead types remain.

## User Experience

1. Open Connections and search “Gmail.”
2. Choose “Use a Gmail account,” then DorkOS-managed or one of the configured BYO routes. Read who stores login access and who pays before continuing.
3. Complete the provider’s auth page. The connection returns with a stable label; connect another account the same way.
4. Pick agents and reviewed operation revisions. Optionally add supported events, filters, and a destination. New or reclassified upstream revisions stay disabled.
5. Use the account from an agent, CLI, or operator API. Every call names one exact connection and appears in usage as one logical operation with its attempts.
6. From the connection or agent profile, change access, pause, reconnect, or disconnect. The next call/event observes the change.

If an agent needs a missing service, the conversation shows a durable request card. The user selects or connects an account and grants scope; the same live turn continues when possible, otherwise DorkOS starts one follow-up turn automatically.

## Testing Strategy

- **Contract/conformance:** extend connector conformance for provider instances, stable IDs, multi-account, operation schemas/execution, typed unsupported capabilities, exact external-account pinning, abort/timeout, event capability declarations, and no provider URL leakage. Add an SDK-import confinement guard that enumerates actual imports. Run the selected Composio adapter under every supported Node runtime used by the CLI/server/desktop and CI, and verify the hosted build against the same SDK engine contract.
- **Migration:** open a real old SQLite fixture with multiple accounts for one toolkit, agent attachments, session attached/detached overrides, expired rows, and missing provider config. Assert numbered Drizzle migration plus application-ledger claim, stable IDs, counts, exact ladder behavior, fail-closed unreconciled grants, no network inside the atomic backfill, rollback on injected write failure, and idempotent second boot. Separately create the same external reference under two new provider instances and prove both remain addressable.
- **Authorization:** route/MCP/CLI integration tests use real caller middleware and principal readers. Assert operator cookie, program, agent, bridged, login-off posture, foreign-owner substitution, arbitrary session, self-grant, new/reclassified revision default deny, pause/disconnect/grant/agent-removal immediate denial, and generic proxy write classification. Mutation-check each security guard through the public seam.
- **Execution/accounting:** fake provider records exact connection/operation revision and returns log IDs. Assert an immutable version/schema hash/classification snapshot, explicit re-review for a new or reclassified revision, usage reference to the executed revision, logical operation versus attempts, no blind ambiguous-write retry, safe idempotent retry, payer attribution, managed receipt reconciliation, cancellation, and absence of args/results/secrets from rows/logs.
- **Hosted integration:** a memory/Neon-compatible Better Auth harness creates two users and three linked instances. Drive real route handlers with valid, revoked, wrong-owner, program, and absent keys. Prove every table/query is tenant scoped and no request field can select another tenant/provider user/execution URL. Drive account-link callback verification through matching, replayed, signed-out, wrong-user/browser, altered-state/verifier, expired, changed-provider-user/auth-config, and callback-URL-substitution cases; only the matching flow consumes its single-use `session_uri` and creates a connection.
- **Webhook/events:** use raw signed fixtures against both hosted managed ingress and local BYO ingress. Cover valid/invalid/replayed/stale signatures, duplicates, wrong tenant/owner/provider instance, large bodies, normalized protected payload recovery after restart, atomic claim, managed lease expiry, two workers, offline intervals, retry ceiling/TTL, persist-before-ACK crash, local dedupe, deleted target, subscription/receive revocation, connection pause/revoke, operation-only grant removal, and all destination kinds. Prove an operation-only removal leaves an independent event active, agent-wide removal closes both, BYO direct events and execution work with no cloud link, managed offline events resume after relink, BYO offline guarantees match provider retry metadata, and polling copy is selected from metadata.
- **Review requests and agent resume:** validate every versioned CLI/agent review action and reject unknown action kinds, versions, fields, targets, requester substitution, expired/replayed idempotency keys, and unvalidated JSON. Drive capability request → linked review and resume records → operator selection/auth/grant → live held result; then repeat with process restart and assert exactly one automatic follow-up turn. Negative controls cover denial, expiry, deleted agent/session, auth failure, duplicate resolver, and private-account non-disclosure.
- **Client units:** use mock `Transport` through `TransportProvider`; cover every state named in §7 and bidirectional access editing. Ensure FSD imports use barrels.
- **Browser:** run the Connections flow at desktop and mobile sizes with fake local and managed adapters: catalog search, multi-account auth, access changes from both directions, session override explanation, usage, event route, agent request, pause/revoke. Read the accessibility tree and inspect screenshots in light/dark. Browser tests use stable roles/test IDs.
- **Production provisioning smoke:** after deployment and only with explicit real credentials, perform one harmless read, verify usage, revoke, and prove denial. This evidence is separate from hermetic tests.

Every test includes a purpose comment and exact subject/count assertions. Security tests must first prove a green baseline and then prove removal of the intended guard turns the specific test red.

## Performance Considerations

- Cache catalog and operation schemas by provider instance/version with bounded TTL; never cache authorization decisions.
- Provider calls have deadlines and cancellation. Catalog/provider aggregation degrades per instance without blocking healthy instances.
- Index grants by subject/connection/operation revision, usage by connection/time/logical operation/revision, review requests by requester/state/expiry/idempotency, agent requests by unresolved session/service, inbox by tenant/instance/state/next-attempt, and receipts by subscription/event.
- Event pulls and usage lists are cursor-paginated and batch bounded. Leases prevent two local workers from actively processing the same delivery.
- Local/hosted usage writes are append-only attempt records; aggregate asynchronously for display if volume warrants it.
- Connection reconciliation avoids boot-time provider sweeps; it refreshes on demand/background cadence and surfaces stale health.

## Security Considerations

- No agent receives a Composio MCP URL, API key, auth-config ID, external account ID, provider user ID, access token, or webhook secret.
- Stable public IDs are always resolved inside authenticated owner/tenant scope before authorization. Foreign and absent IDs are indistinguishable.
- Operation grants reference immutable reviewed revisions; provider additions or reclassifications default off. Unknown classification defaults deny/destructive, never read-only. Event receive authorization remains independent from operation grants.
- Management/grant mutation requires operator decision authority; agent and ordinary program identities cannot self-grant by omitting headers. Login-off limitations are disclosed rather than overstated.
- Hosted identity comes only from verified Better Auth instance keys plus registry ownership/revocation. Instance revoke invalidates managed calls and event leases immediately.
- Webhooks require raw-body signature verification, constant-time comparison, bounded replay window, body limit, dedupe, and subscription/tenant match before persistence.
- Usage/audit records exclude arguments, responses, credentials, and raw event content. Error messages are normalized and secret-free.
- Custody copy is server-owned and based on the selected provider instance. DorkOS branding appears only for a configured custom auth app.
- Disconnect/revoke cleans private provider bindings, grants, subscriptions, session overrides, queued deliveries, and runtime exposure in an ordered, idempotent transaction/saga; partial external revocation is surfaced and local access still closes.
- SDK import confinement, public-seam authorization tests, and caller-path scans are required review gates.

## Documentation

- Rewrite connector/account guides around the service catalog, managed versus BYO custody, multi-account labels, exact agent operation/event access, pause/revoke, usage, and login-off limits.
- Add a CLI reference with scoped `--agent` JSON examples, operator-review handoff, and error/exit-code contract.
- Add hosted operations docs for required environment fields, Composio project/custom auth configs, webhook registration/rotation, migrations, health, incident revocation, and the live provisioning checklist.
- Update `contributing/adding-a-connector.md` for provider-instance capabilities, SDK confinement, conformance, operation classification, and event delivery metadata.
- Regenerate OpenAPI and update architecture/custody ADR references. ADR `260905-205123` is accepted; it amends the platform-key/default-lane clauses in ADR `260729-234626` and the provider-MCP execution assumption in ADR `260718-045630`. Both parent ADRs remain accepted for their surviving decisions. ADR `260804-021140` remains accepted with a 2026-09-07 implementation note for the later stable public `ConnectionId` migration.
- Add one changelog fragment per implementation PR. Do not claim managed production availability until the external gate passes.

## Implementation Phases

- **Phase 1 — Contracts and migration:** stable IDs, provider-instance/capability contracts, local schema, numbered Drizzle migrations, ledgered atomic application backfill, and conformance.
- **Phase 2 — Authorization and execution:** shared policy, direct Composio SDK/API execution, DorkOS MCP/REST/CLI call path, local usage.
- **Phase 3 — Complete local experience:** Transport and Connections/agent/session UI for catalog, lifecycle, access, usage, and honest capability states.
- **Phase 4 — Managed service:** site tenant models/routes, Better Auth instance authorization, hosted Composio connection/execution/usage, cloud client, deployability and unavailable posture.
- **Phase 5 — Events:** provider subscription ownership, signed hosted managed inbox, signed local BYO ingress, lease/cursor/retry/TTL where applicable, shared local persist-before-ACK and explicit routing.
- **Phase 6 — Agent request/resume:** private discovery, durable request, operator resolution, live hold, restart-safe follow-up turn.
- **Phase 7 — Rollout:** remove superseded paths, cross-runtime/browser/security verification, docs/OpenAPI/changelog, DOR-738 prerequisite, and separate live production provisioning evidence.

The dependency graph is `1 → 2 → {3, 4}`, then `{2, 4} → 5` and `{2, 3, 4} → 6`; phases 5 and 6 may proceed in parallel, and phase 7 waits for all six. Managed hosting depends on phase 2 because its local mirror, revocation, execution, and usage acceptance reuse that completed service contract.

## Open Questions

- ~~Should the managed provider replace BYO configuration?~~ **(RESOLVED)** No. Managed and BYO provider instances coexist behind the same catalog and stable connection model. Rationale: the operator explicitly requires an optional managed service and alternate providers behind one UX.
- ~~Can provider MCP sessions remain the Composio execution path?~~ **(RESOLVED)** No Composio MCP endpoint reaches an agent. DorkOS executes through the SDK/API after a fresh authorization/accounting check. Rationale: long-lived provider endpoints bypass exact operation policy and immediate revocation.
- ~~May an agent start auth or grant itself access?~~ **(RESOLVED)** It may create a durable request for a service/scope, but only an operator selects/authenticates the account and writes grants. Rationale: no self-grants and private-account non-disclosure.
- ~~How is hosted tenancy selected?~~ **(RESOLVED)** A verified linked-instance key yields the Better Auth owner; a random unique tenant row maps that owner to the provider identity. Request input cannot select it. Rationale: cross-account substitution must be impossible by contract.
- ~~Do existing session overrides survive?~~ **(RESOLVED)** Yes, transactionally and exactly; revoked grants/connections always dominate. Agent removal also revokes that agent’s session grants by default. Rationale: preserve data without preserving stale authority.
- ~~What delivery guarantee is promised for events?~~ **(RESOLVED)** Durable at least once with dedupe and explicit received/dispatched/completed states. Rationale: provider retry plus offline local instances makes exactly once untrue.
- ~~When is managed hosting “available”?~~ **(RESOLVED)** Only after code/deploy readiness and the separate real provisioning smoke both pass. Until then the capability is unavailable with a specific reason. Rationale: no fabricated credentials or deployment success.

## Related ADRs

- Accepted ADR `260905-205123` — DorkOS-brokered SDK/API execution plus a tenant-scoped managed provider; partially amends the next two accepted ADRs.
- ADR `260718-045630` — provider abstraction and structural custody disclosure remain; its provider-MCP execution assumption is amended.
- ADR `260729-234626` — direct/BYO connections remain available; its direct-default and no-platform-key clauses are amended by the operator-approved managed option.
- ADR `260804-021140` — Connections is the outside-world umbrella; preserved.
- ADR `0319` — account-first cloud identity and device linking; reused for managed tenancy.
- ADR `260707-010338` — cloud account-linking policy; reused for linked-instance ownership/revocation.
- ADR `0043` — file/derived-cache ownership principles; connection state here is SQLite-owned consent/routing data, while provider credentials remain external.
- ADR `0310` — per-provider degradation; extended from provider type to provider instance.

## References

- `specs/white-label-connections/00-brief.md`
- `specs/white-label-connections/01-ideation.md`
- `specs/{connector-gateway,connector-completion,connection-scoping,connections-redesign,direct-connect}/`
- `research/20260718_connector-gateway-spike.md`
- `research/20260729_connections-ux-critique.md`
- `research/20260803_connection-scoping-prior-art.md`
- `packages/shared/src/{connector-provider,transport}.ts`
- `apps/server/src/services/connectors/**`
- `apps/server/src/lib/{caller-authority,caller-principal}.ts`
- `apps/site/src/lib/instance-service.ts`, `apps/server/src/services/core/auth/cloud-link*.ts`
- [Composio harness integration](https://docs.composio.dev/examples/harness-integration)
- [Composio TypeScript tools](https://docs.composio.dev/reference/sdk-reference/typescript/tools)
- [Connected accounts and exact account execution](https://docs.composio.dev/docs/auth-configuration/connected-accounts)
- [Session operation policies](https://docs.composio.dev/kb/guide/platform-session-tool-policies)
- [Webhook subscriptions and signatures](https://docs.composio.dev/reference/api-reference/webhook-subscriptions)
- [Receiving events](https://docs.composio.dev/docs/setting-up-triggers/subscribing-to-events)
- [Composio projects](https://docs.composio.dev/reference/v3/api-reference/projects)
- [Composio usage API](https://docs.composio.dev/reference/api-reference/organization)
