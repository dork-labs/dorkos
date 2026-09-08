# Adding a Connector

## Overview

A connector provider lets DorkOS connect an agent to a service such as Gmail, Slack, or Notion. Every backend implements the instance-bound `ConnectorProvider` port. Routes and services use that port instead of importing a vendor SDK.

Each configured provider has its own stable `instanceId`. Two instances may use the same provider type while holding different credentials, custody, or billing. A connected account also has two identities:

- `ConnectionId` is the stable DorkOS ID used by public APIs, attachments, grants, and usage records.
- `ConnectorExternalAccountRef` is the provider's private account handle. It stays inside the server and provider adapter.

Never expose, log, or derive a public ID from a private provider reference.

The current contract is defined by the [Connections specification](../specs/white-label-connections/02-specification.md). The original provider design remains useful background in the [Connector Gateway specification](../specs/connector-gateway/02-specification.md).

## Key files

| Concept                                               | Location                                                                                                     |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Provider port                                         | `packages/shared/src/connector-provider.ts`                                                                  |
| Stable IDs, operation, capability, and review schemas | `packages/shared/src/connector-schemas.ts`                                                                   |
| Conformance suite and fake                            | `packages/test-utils/src/connector-conformance.ts`, `packages/test-utils/src/fake-connector-provider.ts`     |
| Confined vendor SDK adapters                          | `packages/connector-providers/src/`                                                                          |
| Provider implementations                              | `apps/server/src/services/connectors/providers/`                                                             |
| Instance registry and stable connection store         | `apps/server/src/services/connectors/registry.ts`, `apps/server/src/services/connectors/connection-store.ts` |
| Durable database schema                               | `packages/db/src/schema/connectors/connections.ts`, `packages/db/src/schema/connectors/connector-events.ts`  |
| SDK import guard                                      | `scripts/__tests__/composio-sdk-import-boundary.test.ts`                                                     |
| Broker and authorization                              | `apps/server/src/services/connectors/execution/`                                                             |

## The provider contract

`ConnectorProvider` is one configured provider instance. Its `instanceId` must equal `getCapabilities().instanceId`; its `type` must equal `getCapabilities().type`.

The capability descriptor states whether this instance supports catalog discovery, authentication, accounts, operation schemas, execution, and triggers. Declare unsupported behavior with `{ status: 'unsupported', reason }`. Do not infer support from the presence of a method or return an empty result that looks like a successful capability.

The main methods are:

- `listToolkitPage(request)` returns one bounded catalog page, a cursor when more results exist, and an honest `truncated` value.
- `resolveToolkitVersion(toolkit, signal)` returns the exact trusted version that every following operation page must use. It never infers `latest`.
- `listOperationSchemas(request)` returns one bounded page of immutable operation metadata. Each operation includes the provider instance, toolkit, stable operation slug, toolkit version, input schema and hash, and `read`, `write`, or `destructive` classification.
- `startConnect()` and `pollConnect()` perform the reference-only connect flow. Secrets remain behind the adapter.
- `listAccounts()` and `disconnect(externalAccountRef)` address exact private provider accounts.
- `execute(command)` receives the exact private account reference and immutable operation revision selected by DorkOS. It must honor the supplied abort signal and return a normalized, secret-free envelope.
- Optional `events: ConnectorEventCapability` supplies bounded immutable `listDefinitions`, exact physical trigger reconciliation and mutation, and raw webhook verification. Its definition metadata preserves actual webhook, polling, or unknown delivery timing; caller intent is never a provider trigger reference. See `packages/shared/src/connector-events.ts` for the complete port and guarded mutation contracts.

### Stable identity and lifecycle

The provider reports authentication status for its private account. DorkOS separately owns the stable connection ID, operator pause, disconnect tombstone, attachments, and grants. Provider inventory must not resume a paused connection or reactivate a disconnected connection. Reusing a disconnected stable ID requires validated upstream identity evidence; a label, email address, or matching credential is never enough. When an adapter cannot prove that identity, reconnect creates a new ungranted connection and leaves the old one disconnected.

The registry may contain several instances of one type. Route active work by `instanceId`, not by `type`. Removing one instance must leave its same-type siblings registered and routable.

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

An authenticated runtime receives five private DorkOS tools. Two read-only tools list only its currently executable connections and the exact immutable schemas already granted to its agent or session. Three classified tools execute read, write, or destructive revisions from that list. The runtime never supplies an owner, agent, session, provider instance, or external account selector; DorkOS derives those facts from its turn-bound principal and rechecks them before returning discovery data or dispatching work. The ordinary and external MCP projections do not expose these private tools.

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

## Related guides

- [Adding a Runtime](adding-a-runtime.md)
- [Architecture](architecture.md)
- [Marketplace Packages](marketplace-packages.md)
- [Relay Adapters](relay-adapters.md)
