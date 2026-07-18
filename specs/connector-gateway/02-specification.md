---
slug: connector-gateway
id: 260718-050609
created: 2026-07-18
status: specified
linearIssue: DOR-371
---

# ConnectorProvider gateway — one port for many connector backends

**Status:** Draft (frozen for DECOMPOSE)
**Author:** spec-connector-gateway (SPECIFY stage, Shapes program W5)
**Date:** 2026-07-18
**Tracker:** DOR-371 · Shapes program W5 · depends on D4
**Research basis:** `research/20260718_connector-gateway-spike.md` (MERGED, REVIEW-verified). Ideation: `specs/connector-gateway/01-ideation.md`.

## Overview

DorkOS agents can only act on services they can already reach. This spec adds the coordination-layer piece that lets an agent connect to a real third-party service (Gmail, Slack, Notion, Linear, …) and act for the user — including **two accounts of the same service** — through **one provider-neutral port**, `ConnectorProvider`, cut to the same pattern as the shipped `AgentRuntime` and `Transport` seams.

Three backends implement the port: **Composio** (managed vault, flagship), **Nango** (self-hostable, privacy cohort), and a **raw-MCP** adapter (single-account baseline). A session never learns which backend is behind a connection — it sees only MCP tool servers named by service + account label. A routing surface sends "Connect to Slack" to the purpose-built **Relay Slack adapter** over the generic gateway, while "Connect to my Gmail" goes to the gateway. Custody (where the OAuth tokens live) is a first-class field with mandatory plain-language disclosure before connect. Connectors distribute as marketplace `adapter` packages.

This spec covers the **port + baseline + registry + routing + custody + Composio adapter** as the first implementation phase, with the **Nango adapter** as a gated follow-on phase. It is the direct input to the W4 connector evals.

## Background / Problem Statement

**The gap is real and protocol-level (spike §1.1).** Raw MCP cannot cleanly address multiple end-user accounts of the same service through one connection. The MCP authorization spec is single-account-per-connection by construction; the ecosystem's own workaround for two Atlassian accounts is "add a second MCP connection." Google Workspace MCP bolted on a per-server `login_hint`. GitHub discussion #234 ("Multi-user Authorization") was closed by its author; #193/#483 stall open; SEP-1299 never progressed; the 2026-07-28 hardening SEPs and Enterprise-Managed Authorization go the _opposite_ way (EMA removes interactive account selection). **A first-class `connectedAccountId` addressing layer over many upstreams is exactly the value a gateway adds.**

**Why now.** The Shapes program's business-shape ladder (CRM-lite P4, content pipeline P3) needs a connector spine, and W4 must be able to express connector evals against a stable interface. D4 decided the custody _direction_; the spike (W5) did the evidence work and made the provider picks. This spec makes them buildable.

**Why a port, not point integrations.** DorkOS already abstracts swappable backends twice (`AgentRuntime`, `Transport`) and reaps the payoff: the client depends only on the port; adding a backend is additive; a conformance suite gates every implementation. Connectors get the same treatment so vendor choice never leaks into session code and swapping/self-hosting a provider is a config change, not a rewrite.

## Decisions (LOCKED from ideation + spike §6)

These are founder-delegated-to-evidence or ideation-locked. **Do not relitigate in DECOMPOSE.**

1. **Composio** = flagship managed provider (`custody: 'managed'`). **Nango** = first self-hostable (`custody: 'self-host'`), adopted after the build-time re-check vs `oomol-lab/open-connector`. **Raw MCP** = single-account baseline (`custody: 'external'`).
2. **`ConnectorProvider` is the third swappable seam** — one port, N backends, a `ConnectorRegistry`, a shared conformance suite, capability flags.
3. **Accounts are addressed by an opaque, provider-scoped `ConnectedAccountId`.** A server-side connected-account registry binds each id → owning provider (first-write-wins, mirroring `runtimeRegistry`). The session tool surface carries no provider identity.
4. **Tool exposure reuses the MCP seam.** `toolServerForAccount(id): Promise<McpAppServerConnection | null>` — the null branch is designed explicitly (spike-review correction: `getMcpServerConfig?` is optional and nullable).
5. **Custody is disclosed before connect, per account**, in plain language (§Detailed Design 4).
6. **Routing precedence: purpose-built Relay adapter > gateway > raw-MCP**, surfaced by `recommendConnector(serviceSlug)`.
7. **Distribute as the marketplace `adapter` type**, unless install behavior genuinely diverges (resolved in §Detailed Design 6).
8. **Self-host honesty (spike §1.3):** enforce `NANGO_ENCRYPTION_KEY`; wrap Nango's free Auth+Proxy into DorkOS MCP tools; never depend on Nango's Enterprise-gated MCP server.

## Decisions resolved in SPECIFY

- **`adapter` vs new `connector` package type (ideation OQ1). RESOLVED: reuse `adapter`.** A connector _is_ a service adapter; the marketplace `adapter` type already carries a free-form `adapterType: z.string()` discriminator (`manifest-schema.ts:162`), so a connector package sets `adapterType: 'connector'` inside the existing enum member — no `PackageTypeSchema` migration, no second enum change alongside the planned `shape` type. The one connector-specific install concern (a post-install "connect an account" step vs. adapters' field-config) is handled by the connect flow being **runtime**, not install-time: install places the provider adapter; connecting an account happens later through `ConnectorProvider.startConnect`. So install behavior does **not** diverge, and `adapter` is correct.
- **Connected-account registry storage (OQ2). RESOLVED: a derived SQLite table** (`@dorkos/db`), keyed by `accountId`, holding `{ accountId, provider, toolkit, label, custody, status, createdAt }`. It is a queryable derived cache (like the `agents` table, ADR-0043), never hand-edited; the provider vaults remain the source of truth for the tokens themselves. Chosen over a JSON file because addressing/aggregation are lookup-shaped.
- **Consent granularity (OQ5). RESOLVED: per-account → session**, modeled on relay's `BindingSubsystem`. A session receives a tool server only for accounts explicitly attached to it. Per-agent affinity (a default set of accounts an agent tends to use) is a soft hint layered on top later, not the first-class binding.

## Goals

- **G1** — A Zod-first `ConnectorProvider` port in `@dorkos/shared`, with capability flags, and a `runtimeConnectorConformance`-style suite in `@dorkos/test-utils` every backend must pass.
- **G2** — Multi-account addressing end-to-end: two Gmail accounts yield two distinct `ConnectedAccountId`s, both listable and both independently exposable as session tool servers, with **zero** provider identity in the session tool surface.
- **G3** — Tool exposure through the existing MCP seam only (`McpAppServerConnection`), with an explicit, surfaced null branch.
- **G4** — A custody-disclosure primitive that renders truthful, plain-language copy before connect and per account, for all three custody classes.
- **G5** — A `recommendConnector(serviceSlug)` routing surface with Relay-adapter-first precedence, against which the W4 "Connect to Slack" routing eval and "Connect to my Gmail" gateway eval are directly expressible.
- **G6** — Connectors ship as marketplace `adapter` packages (`adapterType: 'connector'`).
- **G7** — First implementation phase lands: port + raw-MCP baseline + custody + registry + routing + **Composio** adapter. Nango is a gated follow-on.

## Non-Goals

- **Not** a full multi-vendor GA in one pass — Nango follows Composio; `oomol-lab/open-connector` is watch-only (spike §4.1).
- **Not** a new session-side tool-injection mechanism — reuse `setMcpServerFactory`/`getMcpServerConfig`.
- **Not** a Nango Enterprise MCP dependency — wrap Auth+Proxy (spike §1.3).
- **Not** a Composio backend self-host (Enterprise-gated; "self-host Composio" is not the privacy answer — that's Nango's job).
- **Not** any AGPL backend as a bundled default (spike §5 guardrail).
- **Not** the model-provider auth path (Runtime Connect) or the dorkos.ai instance link (Cloud-link) — adjacent, distinct (spike §3.5).
- **Not** real-provider CI — CI uses mock providers; real Gmail/Slack sandboxes run on the weekly deep cadence (D5).

## Technical Dependencies

- `@dorkos/shared` — new `connector-provider.ts` module (port + Zod schemas); reuses the exported `McpAppServerConnection` type from `agent-runtime.ts`.
- `@dorkos/test-utils` — new `connectorConformance` harness + a `FakeConnectorProvider` (mock backend, mirrors `FakeAgentRuntime`).
- `@dorkos/db` — new `connected_accounts` table (Drizzle, SQLite).
- `apps/server` — new `services/connectors/` domain; reuses `credential-provider.ts`, relay `adapter-secrets.ts` patterns, `BindingSubsystem`.
- `packages/marketplace` — `adapterType: 'connector'` convention (no schema change); `marketplace-installer.ts` unchanged.
- **External (Phase 3+):** Composio API key + `@composio/*` / Rube MCP endpoint; (Phase 4) a self-hosted Nango base URL + secret key.

## Detailed Design

### 1. The `ConnectorProvider` port (Zod-first)

New module `packages/shared/src/connector-provider.ts`. Schemas are the authoritative contract (the repo is Zod-first); TS types derive via `z.infer`. The port interface itself is a runtime port (not a serializable DTO), so it is a TS interface over the derived types, referencing the existing `McpAppServerConnection`.

```typescript
import { z } from 'zod';
import type { McpAppServerConnection } from './agent-runtime.js';

/** Where a provider keeps end-user OAuth tokens at rest — drives the custody disclosure (§4). */
export const ConnectorCustodySchema = z.enum([
  'managed', // vendor cloud vault (Composio) — tokens leave the machine
  'self-host', // operator's own store (self-hosted Nango, your Postgres) — tokens stay in your infra
  'external', // no token custody by the gateway (raw MCP — the server holds its own)
]);
export type ConnectorCustody = z.infer<typeof ConnectorCustodySchema>;

/** Opaque, provider-scoped handle for ONE account of one service. The primitive raw MCP lacks. */
export const ConnectedAccountIdSchema = z.string().min(1).brand('ConnectedAccountId');
export type ConnectedAccountId = z.infer<typeof ConnectedAccountIdSchema>;

/** Static capability + custody descriptor for one backend (mirrors RuntimeCapabilities). */
export const ConnectorCapabilitiesSchema = z.object({
  type: z.string(), // 'composio' | 'nango' | 'mcp'
  /** Can one user hold N accounts of the same service? Raw-MCP: false. */
  supportsMultiAccount: z.boolean(),
  /** Custody stance — the honest disclosure the UI renders. */
  custody: ConnectorCustodySchema,
  /** Can the backend expose connected tools to a session over MCP? */
  exposesOverMcp: z.boolean(),
  /** Backend-specific metadata that doesn't merit a first-class field (cf. RuntimeCapabilities.features). */
  features: z.record(z.string(), z.unknown()).default({}),
});
export type ConnectorCapabilities = z.infer<typeof ConnectorCapabilitiesSchema>;

/** A service the provider can connect to (Gmail, Slack, …). */
export const ConnectorToolkitSchema = z.object({
  slug: z.string(), // 'gmail'
  displayName: z.string(),
  authKind: z.enum(['oauth2', 'api-key', 'none']),
  /** Composio's max_accounts_per_toolkit; undefined = unbounded/one. */
  maxAccountsPerUser: z.number().int().positive().optional(),
});
export type ConnectorToolkit = z.infer<typeof ConnectorToolkitSchema>;

export const ConnectedAccountStatusSchema = z.enum(['active', 'expired', 'revoked', 'pending']);

/**
 * One connected account, provider-neutral. `provider` is SERVER-ONLY (the registry needs it to
 * route); it is stripped from any session-facing view — the session tool surface never sees it.
 */
export const ConnectedAccountSchema = z.object({
  id: ConnectedAccountIdSchema,
  provider: z.string(), // owning backend type — server-only, never in the session tool surface
  toolkit: z.string(), // 'gmail'
  label: z.string(), // 'dorian@personal' — user-facing disambiguator (Composio alias / Nango tag)
  status: ConnectedAccountStatusSchema,
  custody: ConnectorCustodySchema, // echoes provider custody so each row can disclose per-account
});
export type ConnectedAccount = z.infer<typeof ConnectedAccountSchema>;

/** Begin a connect flow — mirrors startOpenRouterOAuth's loopback-PKCE shape. */
export const ConnectStartSchema = z.object({
  authorizeUrl: z.string().url(), // vendor consent screen or loopback authorize
  flowId: z.string().min(1), // opaque flow id to poll; code_verifier/secrets stay server-side
});
export type ConnectStart = z.infer<typeof ConnectStartSchema>;

export const ConnectPollSchema = z.object({
  status: z.enum(['pending', 'connected', 'failed']),
  account: ConnectedAccountSchema.optional(),
  error: z.string().optional(), // failure-typed, never thrown across the port
});
export type ConnectPoll = z.infer<typeof ConnectPollSchema>;

/**
 * Universal connector backend contract — the third swappable seam beside AgentRuntime and
 * Transport. Composio (managed), Nango (self-host), and a raw-MCP adapter (baseline) each
 * implement it; a shared conformance suite gates every one, exactly as runtimeConformance
 * gates runtimes.
 */
export interface ConnectorProvider {
  readonly type: string;
  getCapabilities(): ConnectorCapabilities;

  /** Discovery: which services can be connected. */
  listToolkits(): Promise<ConnectorToolkit[]>;

  /** Begin connecting `toolkit`; returns a URL + pollable flow id (secrets stay server-side). */
  startConnect(toolkit: string, opts?: { label?: string }): Promise<ConnectStart>;
  /** Poll a connect flow to completion; resolves to the new account handle (failure-typed). */
  pollConnect(flowId: string): Promise<ConnectPoll>;

  /** Multi-account addressing: list every account the user holds, optionally filtered to one service. */
  listAccounts(opts?: { toolkit?: string }): Promise<ConnectedAccount[]>;
  /** Revoke one account by its opaque id. Idempotent — revoking an unknown/revoked id resolves. */
  disconnect(accountId: ConnectedAccountId): Promise<void>;

  /**
   * Expose a connected account's tools to a session as MCP. Returns runtime-neutral connection
   * details (the exact `McpAppServerConnection` the runtime already injects), selected BY id — so
   * two Gmail accounts become two addressable tool servers.
   *
   * Returns `null` when the account cannot be exposed right now: `expired`/`revoked` status, a
   * provider that momentarily has no live session URL, or a transport this host cannot
   * independently reconnect. Callers MUST handle null (see §3) — it is a surfaced, per-account
   * warning, never a thrown error and never a silent drop.
   */
  toolServerForAccount(accountId: ConnectedAccountId): Promise<McpAppServerConnection | null>;
}
```

**Why every method here.** Discovery (`listToolkits`) drives the connect picker; `startConnect`/`pollConnect` are the connect flow (mirrors the `Transport` PKCE-loopback pair, reference-not-secret); `listAccounts`/`disconnect` are multi-account management; `toolServerForAccount` is the single unification point — every provider ultimately exposes tools as MCP (Composio via Rube, Nango via a DorkOS wrapper over Auth+Proxy, raw-MCP trivially), so its output plugs straight into `setMcpServerFactory`. Capability flags carry genuinely-boolean differences (`supportsMultiAccount`, `exposesOverMcp`) so there is no forked code.

### 2. Multi-account addressing + the connected-account registry

The port speaks one `ConnectedAccountId`. A backend maps it to its own handle (`ca_…` / `connectionId`). To route `toolServerForAccount`/`disconnect` to the owning backend without leaking the vendor into session code, a **connected-account registry** binds each id to its provider.

- **New table** `connected_accounts` (`@dorkos/db`): `{ accountId (pk), provider, toolkit, label, custody, status, createdAt }`. Derived cache (ADR-0043 pattern); vaults own the tokens. Written on `pollConnect` success (first-write-wins, mirroring `runtimeRegistry`'s per-session binding, ADR-0255), cleared on `disconnect`.
- **`ConnectorRegistry`** (`apps/server/src/services/connectors/registry.ts`): `register(provider)`, `listProviders()`, `resolveProvider(type)`, and the id→provider routing (`providerForAccount(accountId)` via the table). `listAccounts()` **aggregates across providers with per-provider degradation** (`warnings[]`), exactly as session listing aggregates across runtimes (ADR-0310) — one unreachable provider degrades to a warning, never a hard failure.

**No provider leakage (G2), concretely.** Session `abc` attaches `gmail-personal` and `gmail-work`. The connector service resolves each id → provider → `toolServerForAccount` → two `McpAppServerConnection`s, injected via `setMcpServerFactory` as MCP servers named by toolkit + label (e.g. `gmail-personal`, `gmail-work`). The agent's tool namespace and code paths contain **no** `composio`/`nango` string. The provider is visible only in the accounts **settings** surface (for honest custody disclosure), never in the session tool surface.

### 3. Session tool exposure (the MCP seam, null branch, consent)

- **Path (reused, nothing new):** the connector service assembles the `McpAppServerConnection[]` for the accounts a session is authorized to use and injects them through `AgentRuntime.setMcpServerFactory` / `getMcpServerConfig`. **Shape adaptation:** `setMcpServerFactory` takes a factory returning a `Record<string, unknown>` keyed by server name (`agent-runtime.ts:721`), so the connector service folds the per-account array into that record — each `McpAppServerConnection` becomes one named entry (`gmail-personal`, `gmail-work`). `RuntimeCapabilities.supportsMcp` is the gate: a runtime without the seam (`supportsMcp: false`, or no `setMcpServerFactory`) simply receives no connector tool servers, surfaced as a session-level notice rather than an error.
- **The null branch (LOCKED, spike-review correction).** `toolServerForAccount` returns `McpAppServerConnection | null`. When null, that account is **skipped and surfaced** as a per-account warning in the session's connector status (`{ accountId, label, reason: 'expired' | 'revoked' | 'unavailable' }`) — mirroring the aggregation-degradation pattern. It is never a thrown error and never a silent drop. The accounts settings UI shows the same status so the user can reconnect.
- **Consent gate (RESOLVED per-account→session).** A session gets a tool server only for accounts explicitly attached to it, modeled on relay's `BindingSubsystem` ("this connected account is exposed to this session"). Attaching is the consent point; custody is disclosed at connect and re-shown at attach.

### 4. Custody + the plain-language disclosure

Custody is where "be honest by design" bites hardest — a connector moves the user's real credentials somewhere. The disclosure states, in plain language, **where the tokens live, before the user connects**, and per account in the list. Copy follows the `writing-for-humans` bar (readable by a smart 9th grader who doesn't code):

**Managed (Composio) — tokens leave the machine:**

> "Connecting Gmail takes you to Google to sign in. Composio stores your connected accounts' login access in its own secure vault, not on your computer. Your agents can then act for you; your password is never shared, and you can disconnect anytime."

The second sentence is **verbatim from the accepted D4 ADR** (`decisions/260718-045630-connector-provider-custody-composio-nango-raw-mcp.md` §Custody disclosure), which mandates that product copy reuse it exactly. This block is the single source of truth task 2.1 locks — any future edit must keep the ADR sentence intact.

**Self-host (Nango) — tokens stay in your infrastructure:**

> "You're connecting through your own Nango server. The keys to this connection are stored in your database, on infrastructure you control. Nothing about this connection leaves your systems."

**External (raw MCP) — the server holds its own:**

> "This tool connects straight to {server}. DorkOS doesn't store or see its keys — that server manages its own sign-in."

**Design consequences:**

- Custody is **per account, not global** — a user may hold a managed Gmail and a self-host Slack at once — so `ConnectedAccount.custody` echoes the provider stance per row and every account row renders its own disclosure line.
- **Enforced, not just disclosed (spike §1.3):** the Nango self-host setup guide **mandates `NANGO_ENCRYPTION_KEY`** (256-bit base64); without it Nango stores tokens unencrypted and the "your infra, your keys" promise is hollow. The setup guide gates on the key being set. DorkOS's own `CredentialStore` gives the vendor-key path AES-256-GCM for free; the Nango footgun is on the Nango side.
- The custody primitive ships **with the port** (Implementation Phase 2), so no provider can be added without a truthful disclosure — the demo-claim gate made structural.

### 5. Routing intelligence (`recommendConnector` + Relay precedence)

The crux for W4: "Connect to Slack" must route to the purpose-built **Relay Slack adapter** (bidirectional messaging + `BindingSubsystem` consent), not the generic gateway; "Connect to my Gmail" (no purpose-built adapter) routes to the gateway.

```typescript
export const ConnectorRecommendationKindSchema = z.enum([
  'relay-adapter', // a purpose-built relay adapter exists for this service (richest)
  'gateway', // a ConnectorProvider gateway backend (Composio managed / Nango self-host)
  'raw-mcp', // a known remote MCP server for this service
]);

export const ConnectorRecommendationSchema = z.object({
  kind: ConnectorRecommendationKindSchema,
  target: z.string(), // service slug, e.g. 'slack' | 'gmail'
  provider: z.string().optional(), // relay adapter type, or 'composio' | 'nango' for gateway
  rank: z.number().int().nonnegative(), // 0 = best; ascending
  reason: z.string(), // human-readable "why this one"
  custody: ConnectorCustodySchema.optional(), // present for gateway/raw-mcp so the picker can disclose
});
export type ConnectorRecommendation = z.infer<typeof ConnectorRecommendationSchema>;
```

**`recommendConnector(serviceSlug): ConnectorRecommendation[]`** (sorted ascending by `rank`), built in `apps/server/src/services/connectors/routing.ts`:

1. **rank 0 — Relay adapter**, if the relay `AdapterManager.getManifest(serviceSlug)` (`adapter-manager.ts:905-907`) returns a manifest (e.g. `slack`); `getCatalog()` (`:882-903`) lists the full set for discovery. Reason: "Slack has a purpose-built two-way adapter in DorkOS — richer than the generic connector." This is a real seam: the relay adapter catalog, read through these **public accessors** (never the private `manifests` field), is the authority for "is there a purpose-built adapter for this service?"
2. **rank 1 — gateway**, if a `ConnectorProvider` gateway backend is registered and lists `serviceSlug` in `listToolkits()`. Prefers the managed default (Composio) unless the operator configured a self-host default (Nango). Carries `custody` for the picker.
3. **rank 2 — raw-mcp**, if a known remote MCP server exists for the service.

**"Connect to Slack" → top recommendation is `{ kind: 'relay-adapter', target: 'slack', rank: 0 }`, ranked above any `gateway` entry.** **"Connect to my Gmail" → top recommendation is `{ kind: 'gateway', target: 'gmail', provider: 'composio', rank: 0 or 1 }`** (no relay adapter for Gmail, so gateway is first). This is the surface the W4 routing-eval asserts against (§Testing Strategy).

### 6. Distribution (marketplace `adapter` package)

Connectors ship as the existing marketplace `adapter` type with `adapterType: 'connector'` (`manifest-schema.ts:162`, the free-form discriminator) — no `PackageTypeSchema` migration (RESOLVED above). Install places the provider adapter via the git-free staged transaction (`marketplace-installer.ts`, ADR-0304); connecting an account is a runtime step (`startConnect`), not an install step, so install behavior does not diverge from other adapters. Dependencies can be declared `adapter:connector-composio@^1.0.0` via the existing `DependencyDeclarationSchema`.

### Code structure & file organization

| Path                                                        | Change            | Notes                                                                                              |
| ----------------------------------------------------------- | ----------------- | -------------------------------------------------------------------------------------------------- |
| `packages/shared/src/connector-provider.ts`                 | **new**           | Port + Zod schemas; add a `@dorkos/shared/connector-provider` subpath to `package.json` `exports`. |
| `packages/shared/src/index.ts` (or barrel)                  | edit              | Re-export the new module.                                                                          |
| `packages/test-utils/src/connector-conformance.ts`          | **new**           | `connectorConformance(makeProvider)` suite + `FakeConnectorProvider`.                              |
| `packages/db/src/schema/connected-accounts.ts`              | **new**           | `connected_accounts` Drizzle table + migration.                                                    |
| `apps/server/src/services/connectors/registry.ts`           | **new**           | `ConnectorRegistry` + id→provider routing + aggregation/degradation.                               |
| `apps/server/src/services/connectors/routing.ts`            | **new**           | `recommendConnector`; reads relay `AdapterManager.getManifest`/`getCatalog`.                       |
| `apps/server/src/services/connectors/custody-disclosure.ts` | **new**           | Disclosure copy per custody class (§4).                                                            |
| `apps/server/src/services/connectors/providers/raw-mcp.ts`  | **new**           | Baseline adapter (`supportsMultiAccount:false`, `custody:'external'`).                             |
| `apps/server/src/services/connectors/providers/composio.ts` | **new (Phase 3)** | Managed adapter; Composio API key via `CredentialStore`; Rube MCP → `toolServerForAccount`.        |
| `apps/server/src/services/connectors/providers/nango.ts`    | **new (Phase 4)** | Self-host adapter; enforces `NANGO_ENCRYPTION_KEY`; wraps Auth+Proxy.                              |
| `apps/server/src/routes/connectors.ts`                      | **new**           | REST surface (see API changes).                                                                    |
| `docs/connectors/*.mdx`                                     | **new**           | Setup guides (Composio; Nango with mandatory encryption key).                                      |

### API changes

New REST routes under `/api/connectors` (thin; delegate to the registry/providers):

- `GET /api/connectors/toolkits` — aggregated `listToolkits()` across providers.
- `GET /api/connectors/recommend?service=<slug>` → `ConnectorRecommendation[]`.
- `POST /api/connectors/:provider/connect` (body `{ toolkit, label? }`) → `ConnectStart`.
- `GET /api/connectors/flows/:flowId` → `ConnectPoll`.
- `GET /api/connectors/accounts?toolkit=<slug>` → `ConnectedAccount[]` (aggregated, `provider` stripped for non-settings callers) + `warnings[]`.
- `DELETE /api/connectors/accounts/:accountId` → 204 (idempotent).
- `POST /api/sessions/:id/connectors/:accountId` / `DELETE …` — attach/detach an account to a session (the consent binding).

OpenAPI regenerated; all new schemas exported from `@dorkos/shared`.

### Data model changes

One new SQLite table, `connected_accounts` (derived cache; migration in `@dorkos/db`). No change to session storage (runtime-owned, ADR-0310). No config-schema change beyond registering configured providers (a `conf` migration if a `connectors` config block is added — follow the `adding-config-fields` skill).

## User Experience

- **Connect:** a user (or an agent, via the MCP tools these routes back) picks a service; the picker shows the routed recommendation first (Relay adapter for Slack; Composio for Gmail) with its custody line; the vendor consent screen opens; on return the account appears with its label.
- **Two accounts:** connecting a second Gmail prompts for a label ("work"); both appear in the accounts list, each with its own custody line and status.
- **In a session:** attached accounts appear as named tool servers; an expired one shows a "reconnect" affordance instead of silently missing.
- **Honesty:** every account row states where its keys live. Managed accounts say so plainly; self-host accounts say "your infrastructure."

## Testing Strategy

- **Conformance suite (`connectorConformance`)** — every provider (raw-MCP, Composio, Nango, and `FakeConnectorProvider`) passes: capability shape valid; `startConnect`→`pollConnect` reaches `connected` with a well-formed `ConnectedAccount`; `listAccounts` reflects connects/disconnects; multi-account providers return distinct ids for two connects of one toolkit; `toolServerForAccount` returns a valid `McpAppServerConnection` for `active` and **`null` for `expired`/`revoked`** (the null branch is a required conformance case); `disconnect` is idempotent.
- **Registry/routing units** — id→provider routing; aggregation degrades one failing provider to a `warning`; `recommendConnector('slack')[0].kind === 'relay-adapter'` (relay manifest present) ranked above any gateway; `recommendConnector('gmail')[0].kind === 'gateway'`.
- **Custody-disclosure units** — each custody class renders its exact copy; no account row can render without a disclosure line.
- **Session-exposure units** — attached `active` accounts inject two distinct named MCP servers with no provider string; a `null` `toolServerForAccount` surfaces a warning, not a throw; no provider identity appears in the injected server config.
- **The two W4 evals, expressible against this interface (G5):**
  - **"Connect to my Gmail"** (default-gateway eval; CI vs mock OAuth, real weekly): `recommendConnector('gmail')` tops with `kind:'gateway'`; drive `startConnect('gmail')`→`pollConnect` to an `active` account; connect a second → `listAccounts({toolkit:'gmail'})` returns two distinct ids, both yielding non-null `toolServerForAccount`. **Oracle refinement of eval 13** (`specs/eval-harness/02-specification.md:286` states "a credential ref is persisted via `credential-provider.ts`"): on the managed gateway path the persisted reference is the **vendor API-key ref** (the Composio key's `file:` reference), **never per-account token refs** — upstream OAuth tokens live in the vendor vault and by design never touch DorkOS's credential store (§Security Considerations). The W4 eval author should implement this refined oracle, not the stale per-account-ref reading.
  - **"Connect to Slack"** (routing eval): `recommendConnector('slack')[0]` is `{kind:'relay-adapter', target:'slack'}`, ranked above any `gateway` entry — proving the agent chooses the purpose-built adapter over the generic gateway.
- Server/client tests follow repo patterns (`FakeConnectorProvider` + scenarios; mock `Transport` for any client UI). Vitest, `__tests__/` alongside source.

## Performance Considerations

- `listAccounts` aggregation is N provider calls in parallel with per-provider timeout+degradation (never block on one slow vendor).
- `toolServerForAccount` may hit a vendor per attach — cache the resolved `McpAppServerConnection` per account for the session's lifetime; invalidate on status change. Never cache secrets, only reference-shaped connection details.
- The `connected_accounts` table is small and indexed by `accountId`; routing reads the in-memory relay `manifests` map (no I/O).

## Security Considerations

- **Reference-not-secret everywhere** (mirrors `storeRuntimeCredential`/`CredentialProvider`): connect flows return references and statuses; vendor keys (Composio API key, Nango secret key + base URL) go to `CredentialStore` as `file:` references before any config write (the relay `adapter-secrets.ts` DOR-280 funnel), resolved in-memory only. Upstream OAuth tokens never touch DorkOS's store on the managed path (the custody point).
- **`McpAppServerConnection` is server-only** — stdio `command`/`env` must never reach the browser client; the `/api/connectors/accounts` DTO strips `provider` and never carries connection details.
- **Custody disclosure is a security control, not just copy** — the managed-vault trade is only acceptable _because_ it is labeled before connect.
- **`NANGO_ENCRYPTION_KEY` enforced** or the self-host promise is false (§4).
- **No AGPL backend bundled** as a default (spike §5); any future AGPL option runs only as an arm's-length process with legal sign-off (Blaze Ventures, LLC).

## Documentation

- `docs/connectors/` setup guides: Composio (API key + custody disclosure), Nango (self-host, **mandatory `NANGO_ENCRYPTION_KEY`**), raw-MCP. Follow `writing-for-humans`.
- `contributing/adding-a-connector.md` — the authoring checklist (mirrors `adding-a-runtime.md`): implement the port, pass `connectorConformance`, declare capabilities honestly, ship as an `adapter` package.
- **Demo-claim gate:** connectors are unverified end-to-end until their evals are green; site/docs must not claim a provider "works" before then (AGENTS.md §Product state).
- Changelog fragment at implementation time (a new user-facing capability) — not at spec time.

## Implementation Phases

**Deliberately refines spike §6's sequencing** (not a straight copy): the registry/routing surface (Phase 3) and session exposure + consent (Phase 4) are pulled **ahead of** the Composio adapter, so the W4-testable routing surface and the consent binding exist against mocks before any vendor integration lands; distribution rides with the eval hooks (Phase 6) instead of standing alone. The spike's ordering principles — port + raw-MCP first, custody with the port, Nango last behind its re-check — are preserved. Each phase is independently shippable.

1. **Port + raw-MCP baseline + conformance** — land the Zod port, `FakeConnectorProvider`, `connectorConformance`, and the raw-MCP adapter (exercises the whole seam against existing machinery). Baseline, no vendor dependency.
2. **Custody-disclosure primitive** — ship with the port so no provider is addable without truthful disclosure.
3. **Registry + connected-account table + routing** — `ConnectorRegistry`, the `connected_accounts` table, aggregation/degradation, `recommendConnector` with Relay precedence, the `/api/connectors` routes.
4. **Session tool exposure + consent binding** — wire `toolServerForAccount` → `setMcpServerFactory`, the null branch, per-account→session attach.
5. **Composio adapter** (managed) — API key via `CredentialStore`; Rube MCP → `toolServerForAccount`; `ca_…`↔`ConnectedAccountId` mapping.
6. **Distribution + W4 eval hooks** — `adapterType:'connector'` packaging; wire the "Connect to my Gmail" + "Connect to Slack" evals.
7. **Nango adapter** (self-host) — **after** the build-time re-check vs `oomol-lab/open-connector`; enforce `NANGO_ENCRYPTION_KEY`; wrap Auth+Proxy (no Enterprise MCP dependency).

Phases 1–6 are the first implementation phase's scope (Composio + baseline); Phase 7 is the gated follow-on.

## Open Questions

- **OQ1 — Composio `user_id` scoping in a single-operator DorkOS.** Composio scopes accounts to a `user_id`. DorkOS is largely single-operator today; confirm whether one fixed `user_id` per DorkOS instance suffices, or whether multi-user DorkOS (post-launch) needs per-user scoping. Non-blocking for Phase 5.
- **OQ2 — Self-host provider re-confirm.** Re-run the Nango vs `oomol-lab/open-connector` maturity check when Phase 7 starts (spike §4.1). Watch signals: a second maintainer/vendor, a `>v1.3.0` release, a measurable adoption jump.
- **OQ3 — Composio pricing re-verify.** Pricing changes 2026-08-15 (spike §1.3); re-verify before any public claim or the partnership conversation. Business action item, not a technical blocker.
- **OQ4 — Recommendation for services with both a Relay adapter and a gateway toolkit** where the user explicitly wants the gateway (e.g. read-only Slack via Composio). The rank-0 Relay default should be overridable; confirm the override affordance in the picker.

## Related ADRs

**Accepted (already on main):**

- **ADR `260718-045630`** (`decisions/260718-045630-connector-provider-custody-composio-nango-raw-mcp.md`) — the D4 custody stance: provider picks (Composio/Nango/raw-MCP), the `ConnectorCustody` field, the canonical managed-custody disclosure sentence (reused verbatim in §Detailed Design 4), the `NANGO_ENCRYPTION_KEY` mandate, and the open-connector re-check clause. This spec implements that ADR; the custody-disclosure seed below is **partly satisfied by it** already.

Seed at implementation time (`/adr:from-spec`):

- **The `ConnectorProvider` port** — the third swappable seam (custody-aware capability flags; opaque `ConnectedAccountId`; MCP-seam reuse; nullable `toolServerForAccount`). Cross-links ADR-0255 (`runtimeRegistry` first-write-wins), ADR-0310 (aggregation/degradation), ADR-0043 (derived cache), `260708-141143` (MCP Apps / `McpAppServerConnection`).
- **Custody disclosure as a structural gate** — the stance and the canonical sentence are already recorded in accepted ADR `260718-045630`; what remains to seed is the **structural** half: the "no provider addable without a truthful, per-account disclosure" enforcement (the disclosure module as a hard dependency of provider registration) and its test proof.
- **Connectors distribute as `adapter` (not a new type)** — records the reuse decision and its rationale (RESOLVED above).

## References

**In-repo (verified this session):**

- `packages/shared/src/agent-runtime.ts:54` (`McpAppServerConnection`), `:747` (`getMcpServerConfig?(): McpAppServerConnection | null` — optional/nullable), `:266` (`RuntimeCapabilities.supportsMcp`), `:721` (`setMcpServerFactory`).
- `packages/shared/src/transport.ts` — `startOpenRouterOAuth`/`getOpenRouterOAuthStatus`, `storeRuntimeCredential` (reference-not-secret).
- `apps/server/src/services/core/credential-provider.ts` — `CredentialProvider`/`CredentialStore`/`EncryptedFileCredentialStore`/`initCredentialProvider`; `keychain:`/`env:`/`file:` scheme.
- `apps/server/src/services/relay/adapter-manager.ts` (`getManifest` `:905-907`, `getCatalog` `:882-903` — the public accessors routing reads; `addAdapter`/`removeAdapter`/`enable`/`disable`/`testConnection`), `adapter-secrets.ts` (`materializeAdapterSecrets`, DOR-280), `base-adapter.ts`; `packages/shared/src/relay-adapter-schemas.ts:275` (`multiInstance`).
- `packages/marketplace/src/package-types.ts:38` (`PackageTypeSchema`), `manifest-schema.ts:160-162` (`adapter`/`adapterType`); `apps/server/src/services/marketplace/marketplace-installer.ts`.
- Adjacent: `apps/server/src/services/runtimes/connect/credentials.ts`; `apps/server/src/services/core/auth/cloud-link.ts`.

**Research + plan + decisions:**

- `research/20260718_connector-gateway-spike.md` — the full evidence base (provider matrix, seams §3, interface sketch §2, custody §4, AGPL §5, recommendation + sequencing §6).
- `plans/shapes-program.md` — D4 (custody stance), W5 (this workstream), P4 (CRM-lite, first consumer), W4 (connector evals).
- `decisions/260718-045630-connector-provider-custody-composio-nango-raw-mcp.md` — the accepted D4 ADR (provider picks, canonical custody sentence, `NANGO_ENCRYPTION_KEY` mandate, re-check clause).
- `specs/eval-harness/02-specification.md:286` — eval 13/14 (`connector-gmail`/`connector-slack`), whose eval-13 oracle §Testing Strategy refines.

**External (open-connector re-check, accessed 2026-07-18):**

- `github.com/oomol-lab/open-connector` — Apache-2.0, `v1.3.0` (2026-07-17, unchanged), ~2,900 stars, single-vendor. Verdict: watch-only; re-confirm at Phase 7.
