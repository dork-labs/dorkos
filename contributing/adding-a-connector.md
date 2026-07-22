# Adding a Connector

## Overview

This guide walks through adding a new connector backend behind the `ConnectorProvider` port: the third swappable seam beside `AgentRuntime` and `Transport`. A connector connects a DorkOS agent to a real third-party service (Gmail, Slack, Notion, ...) and lets the agent act for the user, including two accounts of the same service. Follow it end-to-end and your backend gets full DorkOS treatment: discovery, the reference-not-secret connect flow, multi-account addressing, per-session tool exposure over the existing MCP seam, an honest custody disclosure, and cross-provider aggregation with per-provider degradation.

The port mirrors `AgentRuntime` deliberately: one Zod-first contract, N backends, a server-side registry, capability flags, and a shared conformance suite that gates every implementation exactly as `runtimeConformance` gates runtimes. If you have read [adding-a-runtime.md](adding-a-runtime.md), this will feel familiar.

Spec: [`specs/connector-gateway/02-specification.md`](../specs/connector-gateway/02-specification.md). Custody ADR: [`260718-045630`](../decisions/260718-045630-connector-provider-custody-composio-nango-raw-mcp.md). Related ADRs: [0255](../decisions/0255-per-session-runtime-in-session-metadata-table.md) (per-session/first-write-wins binding, mirrored by the connector registry), [0310](../decisions/0310-runtime-owned-session-storage-aggregated-listing.md) (aggregate-with-degradation), [0304](../decisions/0304-file-scoped-rollback-for-marketplace-installs.md) (the git-free install transaction connectors ship over).

## Key Files

| Concept                            | Location                                                                                                                           |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| The contract                       | `packages/shared/src/connector-provider.ts` (`ConnectorProvider`, schemas, `ConnectorRecommendation`)                              |
| MCP connection shape (reused)      | `packages/shared/src/agent-runtime.ts` (`McpAppServerConnection` — imported, never redefined)                                      |
| Conformance suite + fake           | `packages/test-utils/src/connector-conformance.ts`, `packages/test-utils/src/fake-connector-provider.ts`                           |
| Worked example: managed, flagship  | `apps/server/src/services/connectors/providers/composio.ts` (+ `composio-client.ts`)                                               |
| Worked example: single-account     | `apps/server/src/services/connectors/providers/raw-mcp.ts`                                                                         |
| Registry (composition + routing)   | `apps/server/src/services/connectors/registry.ts` (`ConnectorRegistry`)                                                            |
| Routing surface                    | `apps/server/src/services/connectors/routing.ts` (`recommendConnector`)                                                            |
| Custody disclosure (single source) | `apps/server/src/services/connectors/custody-disclosure.ts`                                                                        |
| Session tool exposure + consent    | `apps/server/src/services/connectors/session-exposure.ts` (`SessionConnectorService`)                                              |
| Routing-cache table                | `packages/db/src/schema/connected-accounts.ts` (`connected_accounts`, derived cache, ADR-0043)                                     |
| REST surface                       | `apps/server/src/routes/connectors.ts`                                                                                             |
| Credential funnel                  | `apps/server/src/services/core/credential-provider.ts` + the connect `credentials.ts` / relay `adapter-secrets.ts` DOR-280 pattern |
| Distribution convention            | `packages/marketplace/src/manifest-schema.ts` (`CONNECTOR_ADAPTER_TYPE`)                                                           |
| Setup docs                         | `docs/connectors/*.mdx`                                                                                                            |

## The ConnectorProvider Contract

`packages/shared/src/connector-provider.ts` is the whole surface. Routes and services depend only on this interface, never on a concrete backend. Every method earns its place:

- **`readonly type`** — the backend identifier; must equal `getCapabilities().type`.
- **`getCapabilities()`** — a static `ConnectorCapabilities`: `type`, `supportsMultiAccount`, `custody` (`'managed' | 'self-host' | 'external'`), `exposesOverMcp`, and a typed `features` bag. These are genuinely-boolean backend differences, so there is no forked code across providers.
- **`listToolkits()`** — discovery: which services can be connected. Drives the connect picker.
- **`startConnect(toolkit, { label? })` / `pollConnect(flowId)`** — the reference-not-secret connect flow, modeled on `Transport`'s loopback-PKCE pair. `startConnect` returns a URL plus an opaque flow id; secrets stay server-side. `pollConnect` failure is **typed** (`status: 'failed'` with an `error`), never thrown across the port. A single-account backend rejects a second connect of an already-connected toolkit rather than minting a duplicate.
- **`listAccounts({ toolkit? })` / `disconnect(accountId)`** — multi-account management. `disconnect` is **idempotent**: revoking an unknown or already-revoked id resolves without throwing.
- **`toolServerForAccount(accountId)`** — the single unification point. Every provider ultimately exposes tools as MCP, so its output (`McpAppServerConnection | null`) plugs straight into `AgentRuntime.setMcpServerFactory`. **This is the trap most worth reading twice** (see [The null branch](#the-null-branch-locked)).

Schemas are the authoritative contract (the repo is Zod-first); TS types derive via `z.infer`. The port itself is a runtime port (not a serializable DTO), so it is a TS interface over the derived types. Reuse `McpAppServerConnection` from `agent-runtime.ts` by importing it: never redefine it.

### Capabilities set the honesty bar

`custody` is not cosmetic. It selects the plain-language disclosure a user sees before they connect and on every account row (`custody-disclosure.ts`). Declare it truthfully:

- `managed` — the vendor holds the end-user's tokens in its cloud vault (Composio). Only DorkOS's own vendor key is stored locally.
- `self-host` — the operator's own store holds the tokens (self-hosted Nango). Enforce the operator's encryption key or the promise is false.
- `external` — no token custody by the gateway (raw MCP): the remote server holds its own credentials.

`supportsMultiAccount: false` means one account per configured service. The conformance suite branches on this flag, so declare what your backend genuinely does.

### The null branch (LOCKED)

`toolServerForAccount` returns `McpAppServerConnection | null`. Return `null` — never throw, never silently drop — when the account cannot be exposed right now: `expired` / `revoked` status, no live session URL, a transport this host cannot independently reconnect, or a routine vendor transport failure. Its consumer (`session-exposure.ts` `attach`) awaits it unguarded; a throw would turn an attach-with-warning into a 500. The platform surfaces the null as a per-account warning (`{ accountId, label, reason }`) so the user can reconnect. This is a **required** conformance case, not an optional one.

## Step-by-Step: A New Connector

### 1. Create the provider file

Add `apps/server/src/services/connectors/providers/<name>.ts` implementing `ConnectorProvider`. Work from `composio.ts` (managed, multi-account, an injectable HTTP boundary) or `raw-mcp.ts` (single-account, `external` custody). Keep the vendor SDK or HTTP client behind an **injectable seam** (`ComposioHttpClient` is the model) so the provider is verified hermetically against a fake, with no network and no key.

### 2. Confine the vendor id mapping to one place

Your backend has its own account handle (Composio's `ca_...`, Nango's `connectionId`). Wrap and unwrap it to the opaque, branded `ConnectedAccountId` in **one pair of functions** inside the adapter (`toConnectedAccountId` / `toComposioAccountId` in `composio.ts`). Namespace the id with your `type` prefix. No raw vendor handle may leak past the port: session code treats a `ConnectedAccountId` as opaque and never parses it.

### 3. Store references, never secrets

Vendor keys (an API key, a base URL + secret key) go to `CredentialStore` as `file:` references before any config write, resolved in-memory only (the relay `adapter-secrets.ts` DOR-280 funnel). **On the managed path, upstream OAuth tokens never touch DorkOS's store** — that is the custody point, and the W4 Gmail eval's refined oracle asserts it (the only persisted reference is the vendor API-key ref, never a per-account token ref). Follow `maybeCreateComposioProvider`: build the provider only when its key resolves; a dangling reference returns `null` so an install without a key leaves the registry untouched.

### 4. Wire the conformance suite

Every backend must clear the shared behavioral gate before it registers. Add `apps/server/src/services/connectors/providers/__tests__/<name>.test.ts`:

```typescript
import { connectorConformance } from '@dorkos/test-utils';

connectorConformance(() => new MyProvider({ client: new FakeMyClient() }), {
  name: 'MyProvider (fake client) — ConnectorProvider conformance',
  toolkit: 'gmail',
  makeUnexposableAccount: async () => {
    const provider = new MyProvider({ client: new FakeMyClient() });
    const { flowId } = await provider.startConnect('gmail');
    const { account } = await provider.pollConnect(flowId);
    // Drive the account into a state where toolServerForAccount returns null.
    return { provider, accountId: account!.id };
  },
});
```

`connectorConformance(makeProvider, opts)` registers a `describe` block asserting: capability shape parses and matches `type`; `startConnect`→`pollConnect` reaches `connected` with a well-formed account; `listAccounts` reflects connects and disconnects; the multi-account contract (two distinct ids when `supportsMultiAccount`, exactly one otherwise); `toolServerForAccount` returns a valid connection for an `active` account and **`null`** for an unexposable one (`makeUnexposableAccount` is a required hook); and idempotent `disconnect`. The factory runs once per test. Declare legitimate differences through `opts`, never by weakening assertions.

**The mocking stance (non-negotiable): CI must never require a live vendor account.** Verify against a fake client with recorded behavior. Gate any real-provider smoke behind an env flag and the weekly deep tier (D5), not CI.

### 5. Register the provider (gated on configuration)

Register your provider with the `ConnectorRegistry` at the composition root (`apps/server/src/index.ts`), **only when it is configured** — mirror `maybeCreateComposioProvider` returning `null` when its key is absent. The registry gives you id → provider routing (first-write-wins on `pollConnect`, ADR-0255) and cross-provider aggregation that degrades one unreachable backend to a `warnings[]` entry (ADR-0310). You do not hand-roll routing or aggregation; the registry owns both.

### 6. Confirm routing and the session seam (usually no code)

`recommendConnector` (`routing.ts`) already ranks a registered gateway (rank 1, `managed` before `self-host`) below any purpose-built relay adapter (rank 0) and above a raw-MCP baseline (rank 2). A standard gateway needs no routing change: it appears automatically once registered and listing the service in `listToolkits()`. Likewise `SessionConnectorService` (`session-exposure.ts`) folds your `toolServerForAccount` output into the existing `setMcpServerFactory` record, names each server from toolkit + label only (no provider identity), and enforces the null branch and per-account consent. Add nothing session-side.

### 7. Declare capabilities and disclosure honestly

If your backend introduces a new custody stance, add its copy to `custody-disclosure.ts` (the exhaustiveness guard makes a missing class a compile error, never a blank line). Never report a capability your backend cannot honor: a false `supportsMultiAccount` or `exposesOverMcp` lights up UI that then fails.

### 8. Ship it as an adapter package

Distribute the provider as a marketplace **adapter** package with `type: 'adapter'` and `adapterType: 'connector'` (the well-known `CONNECTOR_ADAPTER_TYPE` in `packages/marketplace/src/manifest-schema.ts`). There is no `PackageTypeSchema` migration: `adapterType` is a free-form string on the same axis relay adapters use. Install places the provider over the git-free staged transaction (ADR-0304); connecting an account is a runtime step (`startConnect`), not an install step, so install behavior does not diverge from any other adapter. Other packages depend on it with `adapter:connector-<name>@^1.0.0`.

### 9. Document the setup

Add or extend a `docs/connectors/<name>.mdx` setup guide, following the [`writing-for-humans`](../.claude/skills/writing-for-humans/SKILL.md) skill: state where the login lives (custody) in plain language, before the steps. **Respect the demo-claim gate** ([AGENTS.md](../AGENTS.md) §Product state): do not claim a provider works end-to-end until its evals are green. Register the new MDX file in [`contributing/INDEX.md`](INDEX.md) (External Docs Coverage + Maintenance) and regenerate the coverage map.

### 10. Verify

```bash
pnpm --filter @dorkos/server typecheck
pnpm --filter @dorkos/server lint          # SDK/HTTP-client confinement holds
pnpm vitest run apps/server/src/services/connectors/providers/__tests__/<name>.test.ts
pnpm --filter @dorkos/site typecheck        # docs MDX participates in the site build
```

## Common Traps

- **Throwing from `toolServerForAccount`.** The single most important rule. A routine vendor failure (a stale key's 401, a 5xx, a timeout) must resolve `null`, because `session-exposure` awaits it unguarded. Reserve a throw for a genuine bug, never a routine transport failure. Do the same for `listToolkits` / `listAccounts` (degrade to an empty list; the registry records the warning) and `pollConnect` (map to a typed `{ status: 'failed' }`).
- **Leaking the vendor into a session.** The injected MCP server name and config must carry no provider identity. `session-exposure` names servers from toolkit + label; keep your `toolServerForAccount` output free of any `composio` / `nango` string. Two Gmail accounts must become two independently-addressable, provider-neutral servers (`gmail-personal`, `gmail-work`).
- **Persisting upstream tokens on the managed path.** Store only your vendor key reference. If you find yourself writing a per-account token to `CredentialStore`, you have broken the `managed` custody promise the disclosure makes.
- **Redefining `McpAppServerConnection`.** Import it from `agent-runtime.ts`. A parallel type drifts from the one the runtime actually injects.
- **Reading the relay catalog's private state.** Routing reads the relay adapter catalog only through the public `getManifest` / `getCatalog` accessors, never the private `manifests` field.
- **Registering a provider whose key is absent.** Gate registration on a resolved credential (`maybeCreate...` returning `null`), so an install without configuration leaves the registry exactly as it was, with no crash.

## Anti-Patterns

```typescript
// NEVER throw a routine vendor failure through toolServerForAccount
async toolServerForAccount(id) {
  const s = await this.client.session(unwrap(id)); // a 401 here throws → 500s the attach route
  return { transport: 'http', url: s.url };
}

// Catch routine transport failures and resolve null (the surfaced warning path)
async toolServerForAccount(id) {
  try {
    const s = await this.client.session(unwrap(id));
    return s ? { transport: 'http', url: s.url } : null;
  } catch (err) {
    if (isTransportError(err)) return null;
    throw err; // a genuine bug still surfaces
  }
}

// NEVER report a capability the backend cannot honor
getCapabilities() { return { ...caps, supportsMultiAccount: true }; } // backend holds one account

// NEVER leak the vendor id into the session tool surface
servers[`composio-${accountId}`] = connection; // provider identity in the server name
```

## Related Guides

- [adding-a-runtime.md](adding-a-runtime.md): the sibling port (`AgentRuntime`); the same conformance-gated pattern
- [architecture.md](architecture.md): where the swappable seams sit in the hexagonal architecture
- [marketplace-packages.md](marketplace-packages.md): the adapter package manifest and distribution
- [relay-adapters.md](relay-adapters.md): the purpose-built two-way adapters that outrank a generic gateway in routing
