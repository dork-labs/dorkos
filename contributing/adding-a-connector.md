# Adding a Connector

## Overview

A connector provider lets DorkOS connect an agent to a service such as Gmail, Slack, or Notion. Every backend implements the instance-bound `ConnectorProvider` port. Routes and services use that port instead of importing a vendor SDK.

Each configured provider has its own stable `instanceId`. Two instances may use the same provider type while holding different credentials, custody, or billing. A connected account also has two identities:

- `ConnectionId` is the stable DorkOS ID used by public APIs, attachments, grants, and usage records.
- `ConnectorExternalAccountRef` is the provider's private account handle. It stays inside the server and provider adapter.

Never expose, log, or derive a public ID from a private provider reference.

The current contract is defined by the [Connections specification](../specs/white-label-connections/02-specification.md). The original provider design remains useful background in the [Connector Gateway specification](../specs/connector-gateway/02-specification.md).

## Key files

| Concept                                               | Location                                                                                                                                 |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Provider port                                         | `packages/shared/src/connector-provider.ts`                                                                                              |
| Stable IDs, operation, capability, and review schemas | `packages/shared/src/connector-schemas.ts`                                                                                               |
| Conformance suite and fake                            | `packages/test-utils/src/connector-conformance.ts`, `packages/test-utils/src/fake-connector-provider.ts`                                 |
| Confined vendor SDK adapters                          | `packages/connector-providers/src/`                                                                                                      |
| Provider implementations                              | `apps/server/src/services/connectors/providers/`                                                                                         |
| Instance registry and stable connection store         | `apps/server/src/services/connectors/registry.ts`, `apps/server/src/services/connectors/connection-store.ts`                             |
| Durable database schema                               | `packages/db/src/schema/connectors/connections.ts`, `packages/db/src/schema/connectors/connector-events.ts`                              |
| SDK import guard                                      | `scripts/__tests__/composio-sdk-import-boundary.test.ts`                                                                                 |
| Broker and authorization                              | `apps/server/src/services/connectors/execution/`                                                                                         |
| Agent grant precedence (session, agent, every agent)  | `apps/server/src/services/connectors/execution/agent-grant-scope.ts`                                                                     |
| Agent requests for an app                             | `apps/server/src/services/connectors/agent-request-service.ts`, `packages/shared/src/connector-agent-request-schemas.ts`                 |
| Agent request routes                                  | `apps/server/src/routes/connector-management.ts` (`/api/connectors/agent-requests*`)                                                     |
| Agent request card (chat, room, Connections page)     | `apps/client/src/layers/features/connections/ui/agent-request/`, `apps/client/src/layers/features/connections/lib/agent-request-call.ts` |

## The provider contract

`ConnectorProvider` is one configured provider instance. Its `instanceId` must equal `getCapabilities().instanceId`; its `type` must equal `getCapabilities().type`.

The capability descriptor states whether this instance supports catalog discovery, authentication, accounts, operation schemas, execution, and triggers. Declare unsupported behavior with `{ status: 'unsupported', reason }`. Do not infer support from the presence of a method or return an empty result that looks like a successful capability.

The main methods are:

- `listToolkitPage(request)` returns one bounded catalog page, a cursor when more results exist, and an honest `truncated` value. Callers never page it directly: the registry keeps each instance's whole list for as long as its type warrants (`catalogKeepingFor` in `services/connectors/resources/catalog-cache.ts`; add your type there), optionally on disk under `<dorkHome>/cache/connectors/catalog/`, and drops it when the instance is unregistered. Paging and search slice that kept list, so an adapter need not cache anything itself, and a failed listing must throw rather than return an empty page.
- `resolveToolkitVersion(toolkit, signal)` returns the exact trusted version that every following operation page must use. It never infers `latest`.
- `listOperationSchemas(request)` returns one bounded page of immutable operation metadata. Each operation includes the provider instance, toolkit, stable operation slug, toolkit version, input schema and hash, and `read`, `write`, or `destructive` classification.
- `startConnect()` and `pollConnect()` perform the reference-only connect flow. Secrets remain behind the adapter.
- `listAccounts()` and `disconnect(externalAccountRef)` address exact private provider accounts.
- `execute(command)` receives the exact private account reference and immutable operation revision selected by DorkOS. It must honor the supplied abort signal and return a normalized, secret-free envelope.
- Optional `events: ConnectorEventCapability` supplies bounded immutable `listDefinitions`, exact physical trigger reconciliation and mutation, and raw webhook verification. Its definition metadata preserves actual webhook, polling, or unknown delivery timing; caller intent is never a provider trigger reference. See `packages/shared/src/connector-events.ts` for the complete port and guarded mutation contracts.

### Stable identity and lifecycle

The provider reports authentication status for its private account. DorkOS separately owns the stable connection ID, operator pause, disconnect tombstone, attachments, and grants. Provider inventory must not resume a paused connection or reactivate a disconnected connection. Reusing a disconnected stable ID requires validated upstream identity evidence; a label, email address, or matching credential is never enough. When an adapter cannot prove that identity, reconnect creates a new ungranted connection and leaves the old one disconnected.

The registry may contain several instances of one type. Route active work by `instanceId`, not by `type`. Removing one instance must leave its same-type siblings registered and routable.

### Keeping sign-in status fresh

A sign-in can end at the service without DorkOS taking part, so DorkOS asks. `SignInRefresher` (`services/connectors/resources/sign-in-refresh.ts`) calls `ConnectorRegistry.refreshSignIns()` every 15 minutes and when the owner opens Connections (at most once a minute). That lists each instance's accounts and records the status each kept account is listed with, plus `connections.last_verified_at`: the last time the service itself confirmed that status. Every connection check the bootstrapper runs is also a listing, so boot records statuses the same way. Your adapter's part:

- `listAccounts()` reports each account's real status (`active`, `expired`, `revoked`, or `pending` while a sign-in is unfinished) and throws when the listing fails. When the service's answer does not say (no status field, or a value you don't recognize), report `unknown`: DorkOS records nothing from it. Never guess `revoked`. Nango, for example, reports sign-in trouble as an `auth` entry in a connection's `errors`, not as a status. Follow every page of the listing, bounded; the refresh gives each way 20 seconds (`DEFAULT_SIGN_IN_REFRESH_TIMEOUT_MS`), longer than a page read gets. A listing that throws leaves every account as it was, and a partial listing only refreshes what it returns; neither may pretend an account ended.
- A refresh never adds, closes, relabels or moves an account. It changes only the status and `last_verified_at`, and only on kept accounts that are still connected. A fact recorded after the listing began (a sign-in finishing, an action refused for an ended sign-in) wins over that listing.
- When `execute` learns from the service that the account's own sign-in has ended, return an error with one of `CONNECTOR_SIGN_IN_ENDED_CODES` (`packages/shared/src/connector-provider.ts`) and the signed-out agent line from `CONNECTION_READINESS_COPY` (`packages/shared/src/connector-schemas.ts`). The broker records the status at once, and later calls are refused with readiness's words for the agent. Use these codes only on that precise signal, never for a rate limit, an outage, a refused key or an operation the service rejected for another reason.
- A way whose check or listing fails for a reason that can pass is checked again by itself (`WAY_RECHECK_DELAYS_MS` in `bootstrap.ts`); an error carrying HTTP status 401 or 403 is treated as a refused key and waits for the owner. For the DorkOS account the rule is narrower: only `unauthorized` and `permission_upgrade_required` wait for the owner; any other refused request is checked again. Put the HTTP status on your client's error as `status` so the bootstrapper can tell them apart. `ConnectorProviderBootstrapper.nextWayCheckAt(instanceId)` says when the next automatic check is due.

### Operation classification

Classification is part of an immutable operation revision fingerprint. A schema, toolkit version, or classification change creates a new revision and requires review before it can replace a grant.

Use a provider's trustworthy operation metadata to classify an operation. If that metadata is missing or ambiguous, report the capability as unsupported or classify the operation at the narrowest safe boundary. Never treat an unknown operation as read-only and never create a wildcard grant.

### Custody

`custody` drives the plain-language disclosure shown before connect and on each account row:

- `managed`: a vendor cloud vault holds the user's tokens.
- `self-host`: the operator's own infrastructure holds the tokens.
- `external`: the remote service handles authentication outside the gateway.

`mode` and custody answer different questions. A Composio instance configured with the operator's own key is `mode: 'byo'` and still has `custody: 'managed'` because Composio holds the end-user token.

Mode also determines who supplies and pays for the provider project. In DorkOS-managed mode,
DorkOS supplies the server project key. In BYO mode, the operator supplies and pays for it. Do not
describe a BYO Composio route as self-hosted merely because its project key is stored locally.

## Add a provider

### 1. Create one instance-bound adapter

Add `apps/server/src/services/connectors/providers/<name>.ts` and implement `ConnectorProvider`. Accept or create a stable instance ID in the provider constructor. Keep the provider type separate from that ID.

Put vendor HTTP or SDK calls behind a small injectable client. Tests must use a fake client and no network. Provider code returns normalized shared types, never vendor response objects.

### 2. Confine SDK imports

Vendor SDK imports belong only in their adapter roots. For `@composio/core`, the allowed roots are:

- `packages/connector-providers/src/composio/`

The import-boundary test detects static imports, dynamic imports, re-exports, and CommonJS `require`. Add reusable vendor transport code to the confined package, then inject it into the server or hosted adapter. Do not import the SDK from routes, registry code, session code, site code, or shared contract packages.

### 3. Keep private references private

Map the vendor's account handle to `ConnectorExternalAccountRef` in one adapter function. Return that private reference from provider methods. Let `ConnectionStore` assign and persist the stable `ConnectionId`.

Provider account responses must not contain credentials, authorization headers, connect URLs, or session URLs. Public REST and Transport DTOs use `ConnectionId` and omit provider instance IDs and external references.

An authenticated runtime receives seven private DorkOS tools (`CONNECTOR_RUNTIME_CAPABILITY_IDS` in `services/connectors/runtime-capability-scope.ts`). Two read-only tools list only its currently executable connections and the exact immutable schemas granted to it, whether through its session, its own agent grant, or an every-agent grant (`agent-grant-scope.ts` holds the precedence). Two request tools ask the owner for an app and check that request; see [Agent requests for an app](#agent-requests-for-an-app). Three classified tools execute read, write, or destructive revisions from the granted list. The runtime never supplies an owner, agent, session, provider instance, or external account selector; DorkOS derives those facts from its turn-bound principal and rechecks them before returning discovery data or dispatching work. The ordinary and external MCP projections do not expose these private tools.

### 4. Declare capabilities honestly

Return every capability in `getCapabilities()`. When a capability is unavailable, return typed unsupported results from the matching method. Paginate catalog and operation discovery to a configured ceiling and surface truncation; do not silently use a vendor's default subset as the complete catalog.

For events, return a stable `eventType`, immutable definition generation, delivery timing, and
`filterSchema` for each supported activity. Receiving an event is a separate grant from performing
an operation. Each subscription must name one exact connection, definition, validated filter,
agent, and destination. Never infer receive access from an operation grant or silently retarget a
deleted destination.

Event content enters DorkOS through the protected durable inbox. Audit receipts remain payload-free,
so provider-specific delivery metadata must support deduplication and verification without copying
secrets into receipts. Direct BYO delivery depends on the upstream service's webhook retry behavior;
it has no hosted offline buffer. Managed delivery may retain encrypted content for its documented
window. Neither path promises exactly-once delivery.

Raw MCP is an inventory route. It performs an authenticated protocol initialization and tool-list
request using credentials already configured on the remote server. It does not start OAuth, and its
unversioned tools are not eligible for agent execution until a provider can supply the immutable
version and classification required by the broker.

### 5. Wire the conformance suite

Every provider must pass `connectorConformance` with an injectable fake:

```typescript
connectorConformance(
  () =>
    new MyProvider({
      instanceId: 'provider-my-test',
      client: new FakeMyClient(),
    }),
  {
    name: 'MyProvider — ConnectorProvider conformance',
    toolkit: 'gmail',
  }
);
```

The suite checks:

- provider instance identity and complete capability declarations;
- bounded catalog and operation pagination, cursors, and truncation;
- immutable schema version, hash, and classification metadata;
- exact private-account authentication, listing, execution, and disconnect;
- abort behavior before and during execution;
- result envelopes that exclude credentials, vendor execution URLs, private references, and transport metadata while preserving legitimate service content such as document links;
- trigger metadata and typed unsupported behavior;
- multi-account behavior and exact-account disconnect.

Declare legitimate provider differences through the conformance options. Do not weaken the shared assertions.

### 6. Register only configured instances

Create providers at the composition root and register each exact instance. A missing credential or required setting leaves that instance unavailable with a safe health message. It must not remove another instance of the same type.

Credential references go through `CredentialStore`. End-user tokens stay wherever the custody declaration says they stay. Never persist a managed provider's upstream OAuth token in DorkOS.

### 7. Verify the public boundaries

Add provider tests, registry tests, and public route tests. At minimum, prove:

- two instances of the same type do not collide;
- the same external reference may exist under two different instances;
- no public DTO exposes an external reference or provider instance ID;
- inventory cannot undo a local pause or disconnect tombstone;
- disconnect is idempotent and invalidates any cached successful connect result;
- operation and trigger pagination reaches its ceiling and reports truncation;
- unknown classification and incomplete metadata fail closed;
- SDK imports outside the adapter root fail the import guard.

Use the repository's pinned Node version for local checks:

```bash
pnpm --use-node-version=24.14.1 vitest run apps/server/src/services/connectors/providers/__tests__/<name>.test.ts
pnpm --use-node-version=24.14.1 vitest run scripts/__tests__/composio-sdk-import-boundary.test.ts
pnpm --use-node-version=24.14.1 --filter @dorkos/server typecheck
pnpm --use-node-version=24.14.1 --filter @dorkos/server lint
```

No CI test may require a live vendor account. Put any real-provider smoke behind its own explicit spending or credential flag.

## Agent requests for an app

When no granted connection covers the work, an agent calls `connectors.request_connection` with an exact `serviceSlug` (from `connector_list_toolkits`), a reason, a level (`access`: `read` or `read-write`, the same two levels the person answers with) and any events it needs. It never names an action or an account, and never grants itself anything. A service is requestable when `serviceDirectory` (in `resources/operator-query-service.ts`, the same read the agent's lookup tool uses) finds at least one account route a person can sign in through. So a provider only needs to list the toolkit with an account route; the rest of the flow does not depend on the provider.

| Step     | Where                                                  | What happens                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| -------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Create   | `ConnectorAgentRequestService.create`                  | Rechecks the live runtime principal and refuses a slug that is not requestable. One agent keeps one open request per app whatever the reason says: asking again reuses it, asking for more raises it in place, and the same app from another chat is refused (`request_open_elsewhere`). New requests are capped per agent (`CONNECTOR_REQUEST_RATE_LIMIT`, `request_rate_limited`). Requests expire after two hours.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Hold     | `waitForResolution`                                    | The tool call stays open for up to `CONNECTOR_REQUEST_LIVE_HOLD_MS` (ten minutes) waiting for the owner. Every runtime's ceiling for one connection-tool call is derived from it (`CONNECTOR_RUNTIME_TOOL_TIMEOUT_MS` for Codex and OpenCode, `DORKOS_MCP_TOOL_TIMEOUT_MS` for Claude Code). A request answered later resumes the session through the private-message source adapter (`ConnectorAgentRequestSourceAdapter`) and `reconcile()`, which also runs at startup.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Announce | `onChanged` → `connectorAgentRequestsChangedAnnouncer` | Broadcasts a content-free `connector_agent_requests_changed` event to the operator on `/api/events`. `useConnectorAgentRequestsSync` (mounted in `AppShell`) invalidates every request query.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Show     | Client                                                 | In a chat, `AssistantMessageContent` draws `ChatAgentRequest` in place of the `request_connection` tool call, matched by `findCallRequest` against the owner's session list. In a room, `RoomAgentRequests` shows pending requests whose `roomId` matches. The Connections page lists them in `NeedsYou` and opens the same card in `AgentRequestDialog`. Non-owners cannot read requests, so they see the ordinary tool card or nothing.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Connect  | `POST /agent-requests/:id/authentication-flows`        | Starts sign-in bound to that request. Finishing sign-in never answers the request by itself.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Answer   | `POST /agent-requests/:id/decision`                    | `denied`, or `current_access` with the exact event scopes chosen, if the request asked for events (see below). There is no other answer. When the chosen updates can't be set up (`event_selection_unavailable`) the recorded answer is taken back and its review is undone in one transaction (`ConnectorEventGrantPort.withdraw`): subscriptions it created are stopped, ones it took over get their earlier state back, and its consent is cleared. On a managed account a generation only moves forward: the earlier state is written at a new, higher generation and its hosted command is staged in the same transaction (`ManagedEventConsentStaging.stage`), so hosted events always carry the version the local row has. Any other account gets its exact earlier generation back, which the person's own review names, so its recovery can resume it. A subscription that already delivers exactly the update asked for is used as it is (`liveMatch`), whichever review first chose it; the stored-approval lookup reads the review whose selected set matches exactly. The person can then pick a different set, answer without updates or say no, and no update arrives for an answer taken back. An answer whose updates never go live ends at the request's two hours as allowed without updates, and its note says so. |

All routes are owner-only under `/api/connectors/agent-requests`. `GET /agent-requests` takes optional `state` (`pending` or `resolved`) and `sessionId`.

The one answer model is `AgentRequestCard`, in a chat, a room and the Connections page alike. It connects the app if needed, asks for a fix if the account is paused, signed out or waiting on review (the server's `ConnectionReadiness`, read through `lib/readiness.ts`), then shows the shared `ConnectionAccessCard` in one-agent mode, starting at the level the agent asked for, then the updates step when the request named events. Allow is two writes: the access card saves that one agent's access, then the card answers with `current_access`. The server writes no grant for `current_access`. It answers with the access the agent already holds on that account, so this path can never lower access or touch another agent. It refuses with `session_access_off` when a session override shuts the agent out, `selection_invalid` when the agent holds nothing live, and `authority_sync_failed` while a managed grant (the agent's own or every-agent) has not been applied yet.

Invariants:

- The agent-facing status (`ConnectorAgentRequestStatusSchema`) never includes the owner's account list. Only `granted` carries a `ConnectionId`, plus `notGranted`: what was asked for and left out, compared by class (`read`, `write`), never by action name. A class the account has no action of is never reported as left out.
- Every status carries a `note`: what happens next, in plain words the agent can pass on, with no ids or links. `requestNote` in the service is the one place that writes them, and the follow-up message in the chat reuses it.
- A request read by a different agent, session, runtime or agent path returns the same `request_not_found` as a missing one.
- Only an explicit owner decision resolves a request. A request whose origin no longer passes `revalidateOrigin` resolves as `target_deleted`.
- Error codes are the `ConnectorAgentRequestError` union; the card maps each one it can meet to plain copy, so add a case there when you add a code an owner's answer can hit. The create-time refusals (`request_open_elsewhere`, `request_rate_limited`) reach only the agent, and their message is the words it relays.

Tests: `services/connectors/__tests__/agent-request-service.test.ts`, the test-mode scenario `services/runtimes/test-mode/connection-request-scenarios.ts`, the browser module `apps/e2e/tests/connections/chat-connect-card.ts`, and the credentialed eval `packages/evals/src/suite/connection-request.ts`.

## Managed-cloud errors

A managed-connector call the control plane refuses throws `ManagedConnectorCloudError` (`apps/server/src/services/core/auth/cloud-link-client.ts`), never a bare `Error`. It carries the refusal's category (`code`), the HTTP `status`, the cloud's own `cloudCode` from its `{error, reason?}` body, a `reason` capped at 200 characters, and the method and path without a query string. Each refusal writes exactly one log line from that file; do not log it again further up.

Every route that can reach the managed cloud maps it through `sendManagedCloudError` (`apps/server/src/routes/managed-cloud-error.ts`) to an honest HTTP status and a stable `code` the client branches on:

| Error `code`                                                  | Status | Route `code`              |
| ------------------------------------------------------------- | ------ | ------------------------- |
| `unauthorized`                                                | 401    | `cloud_link_required`     |
| `permission_upgrade_required`                                 | 409    | `cloud_link_needs_update` |
| `unavailable`, `network_error`                                | 503    | `cloud_unavailable`       |
| `request_failed`, `invalid_response`, `not_found`, `conflict` | 502    | `cloud_refused`           |

Never let a managed-cloud error fall through to a route's own generic 500 or outage answer (the connector events router checks it before its `events_unavailable` fallback): call `sendManagedCloudError(res, error)` before any catch-all. A service that wraps the error (as the app-actions listing does) keeps it as `cause`, and its route checks the cause first. The client reads the same `code` through `cloudFailure()` (`apps/client/src/layers/entities/connectors/lib/cloud-failure.ts`), and `LoadFailedState` (or its `RelinkButton`) shows it. For the two link codes the button opens Settings › Access with the `SETTINGS_RELINK_SECTION` section, and the account panel starts a new link itself: a link that needs updating is still linked, so landing on the panel alone would leave nothing to press.

## Common mistakes

- Using provider `type` as the configured instance key.
- Sending a private external account reference through REST, Transport, logs, or agent-visible results.
- Letting provider inventory reactivate a locally disconnected connection.
- Mutating an operation revision after it has been reviewed.
- Treating missing classification or incomplete discovery as read access.
- Calling a vendor SDK outside its adapter root.
- Exposing a provider MCP endpoint or arbitrary credentialed method/path proxy to a runtime.
- Storing upstream OAuth tokens while declaring managed custody.
- Returning a default provider subset as a complete catalog.
- Resolving an agent request when sign-in finishes, or letting the chat card write a grant for anyone but the agent that asked.
- Sending the owner's account list, or a request's existence, to an agent that did not create it.

## Related guides

- [Adding a Runtime](adding-a-runtime.md)
- [Architecture](architecture.md)
- [Marketplace Packages](marketplace-packages.md)
- [Relay Adapters](relay-adapters.md)
