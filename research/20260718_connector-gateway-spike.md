---
title: 'ConnectorProvider Gateway Spike — Provider Landscape + Repo Seams (DOR-365, W5/D4)'
date: 2026-07-18
type: research
status: active
tags:
  [
    connectors,
    connector-gateway,
    composio,
    nango,
    mcp,
    oauth,
    multi-account,
    byoa,
    shapes,
    credential-provider,
    relay-adapters,
    marketplace,
    custody,
    agpl,
  ]
---

# ConnectorProvider Gateway Spike — Provider Landscape + Repo Seams

**Scope**: DOR-365, the W5 research spike behind decision **D4** in `plans/shapes-program.md` ("Connector custody stance"). D4's _direction_ is already decided (founder, 2026-07-17): build a `ConnectorProvider` abstraction — a batteries-included **managed** provider, a **self-hostable** provider for the privacy cohort, and **raw MCP** as the baseline. This spike does the evidence work D4 deferred: (1) verify the provider landscape, licenses, and custody models against primary sources; (2) sketch the `ConnectorProvider` interface against the repo's proven seam pattern; (3) name the concrete in-repo integration seams; (4) settle the custody disclosure; (5) run the AGPL exposure check; (6) make a decisive provider recommendation and sequence the W5 spec.

This spike **supersedes and deepens** `research/20260717_shapes-byoa-positioning.md` §8.3 (the connector-gateway reconnaissance). Where a claim below differs from §8.3, this doc is authoritative — three parallel web-research passes (Composio, Nango + alternatives, MCP spec) verified the load-bearing facts against docs, GitHub `LICENSE` files, npm metadata, and funding announcements (accessed 2026-07-17).

**One-line answer**: **Composio** as the flagship managed provider, **Nango** as the first self-hostable provider (with an explicit re-check against the day-old Apache-2.0 `oomol-lab/open-connector` at spec kickoff), **raw MCP (OAuth 2.1 remote servers)** as the zero-dependency baseline — behind one `ConnectorProvider` port that mirrors `AgentRuntime`/`Transport`, reusing the existing `CredentialProvider` custody model and the relay `AdapterManager` lifecycle shape, distributed as a marketplace `adapter`-type package.

---

## 1. Findings first

### 1.1 The gap is real — MCP genuinely lacks a multi-account model

The load-bearing premise for building a gateway at all is that **raw MCP cannot cleanly address multiple end-user accounts for the same service** (two Gmail inboxes, a personal + a work Slack). **Confirmed by primary sources** — this is a real protocol gap, and the ecosystem's own workarounds prove it:

- **The MCP authorization spec is single-account-per-connection by construction.** The current draft (OAuth 2.1; server = OAuth 2.1 resource server; authorization server is a distinct entity "beyond the scope of this specification") requires clients to send an RFC 8707 `resource` parameter — but that scopes a token to **the MCP server**, not to a **user account on an upstream service**. There is no account-selection, `login_hint`-equivalent, or multi-credential-binding primitive anywhere in the spec text. (Aside: Dynamic Client Registration / RFC 7591 is now **deprecated** in the draft, superseded by OAuth Client ID Metadata Documents — orthogonal to multi-account, but shows the auth spec is actively churning.)
- **GitHub discussion #234** ("Multi-user Authorization," opened Mar 26 2025) proposed exactly a per-call token/account mechanism — and was **closed by its own author on May 6 2025**, redirected to a separate user-interaction/authorization spec rather than adopted. Related threads confirm the gap persists: **#193** ("Multi-Tenant Client Support") is **still open and stalled**; **#483** ("Fine-Grained Resource Control") is **open** but addresses per-user scoping, not one user's many accounts; **SEP-1299** ("Server-Side Authorization Management," Aug 2025) proposed server-side management of "multiple access tokens for different backend resources" but **never progressed to draft**. No merged SEP adds a multi-account addressing primitive.
- **The 2026-07-28 core-spec release does not close the gap.** Its six "authorization hardening" SEPs (2468, 837, 2352, 2207, 2350, 2351) are all OAuth/OIDC alignment (issuer validation, DCR metadata, refresh-token guidance, scope step-up) — **none address multi-account/multi-tenant**. The one shipped auth extension, **Enterprise-Managed Authorization** (EMA, Stable 2026-06-18; adopted by Anthropic, Microsoft/VS Code, Okta, Figma, Linear, Asana), goes the _opposite_ direction: it **removes interactive account selection** to stop personal/corporate account mixing.
- **Real-world proof it's unaddressed**: on the Atlassian community forum, a user asking to connect two Atlassian accounts through one MCP connection was told it can't be done ("it keeps the same OAuth") and the accepted workaround was **adding a second, separate MCP connector entry** — i.e., N accounts require N connections, not one connection addressing many. Google Workspace MCP added a per-server `login_hint` workaround for the same reason. **This is exactly the value a gateway adds**: a first-class `connectedAccountId` addressing layer over many upstreams.

So the gateway fills a genuine protocol gap, and "raw MCP as baseline" means: single-account remote MCP servers work today; multi-account is the gateway's job.

- **MCP Apps (SEP-1865)** is a **separate track** and the mechanism for _official Shapes_, not connector auth — and the plan's timeline framing was wrong: **SEP-1865 has been Final/Stable since ~2026-01-26**, not "going final ~2026-07-28." What lands 2026-07-28 is the core-spec version that formalizes the **Extensions framework (SEP-2133)** — under which MCP Apps + a new Tasks extension are the "first two official extensions" — plus a major **stateless-protocol rewrite** (removes the `initialize` handshake and `Mcp-Session-Id`). DorkOS already hosts MCP Apps (`getMcpServerConfig` / `fetchMcpAppResource`, ADR `260708-141143`). None of this gates D4; multi-account auth is not part of MCP Apps.

### 1.2 Provider landscape matrix

Legend: **Custody** = where end-user OAuth tokens live at rest. **Multi-acct** = first-class support for N accounts of the same service per user. **Self-host** = can you run the whole thing yourself, and is that path open or gated. All licenses below were checked against the actual repo `LICENSE`/npm metadata this pass.

| Provider                                 | What it is                             | License (verified)                                     | Self-host                                        | Multi-account model                                                                                          | Token custody                                                           | MCP                                           |
| ---------------------------------------- | -------------------------------------- | ------------------------------------------------------ | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- | --------------------------------------------- |
| **Composio**                             | Managed tool-auth + 1,047 toolkits     | Closed backend; `ComposioHQ/composio` SDK/CLI is MIT   | **Enterprise-gated only** (VPC/on-prem)          | **First-class**: `connected_account_id` (`ca_…`) + `alias`, session `multi_account.max_accounts_per_toolkit` | **Composio managed cloud vault** (keyed to `user_id`)                   | **Yes** — Rube (`rube.app/mcp`) + Tool Router |
| **Nango**                                | Unified OAuth/integrations infra       | **Elastic License 2.0 (whole monorepo, incl. SDKs)**   | **Free = Auth+Proxy only**; rest Enterprise-paid | `connectionId` (UUID) + tags (`end_user_id`, `organization_id`)                                              | **Your Postgres** — _unencrypted_ unless you set `NANGO_ENCRYPTION_KEY` | Enterprise-gated on self-host                 |
| **Arcade.dev**                           | Authenticated agent tool-calling layer | `arcade-mcp` framework **MIT**; **Engine proprietary** | Engine: **Enterprise only** (Helm/Azure)         | `Arcade-User-Id` header, per-(user, provider)                                                                | Vaulted server-side by the proprietary Engine                           | Yes (MCP-native)                              |
| **Klavis AI (Strata)**                   | Self-hostable MCP aggregator           | **Apache-2.0** (verified; _not_ MIT)                   | **Yes, full** (Docker/pipx) or cloud             | `user_id`-scoped; per-toolkit multi-account UNVERIFIED                                                       | OAuth managed server-side; vaulting mechanics undocumented              | Yes — its whole point                         |
| **Pipedream Connect**                    | Managed embedded connector             | Core Pipedream OSS; **Connect not self-hostable**      | **No** (cloud-only; VPC for enterprise)          | Native — meters "external users"                                                                             | Managed only                                                            | Via MCP endpoints                             |
| **Paragon / ActionKit**                  | Embedded iPaaS for SaaS                | MCP wrapper MIT; **platform closed**                   | **No** (managed only)                            | Native — meters "Connected Users"                                                                            | Managed only                                                            | ActionKit MCP wrapper                         |
| **oomol-lab/open-connector**             | Self-host "Composio alternative"       | **Apache-2.0** (verified)                              | **Yes** (Docker/Fly/Cloudflare/local)            | Per-provider, "entity"-based                                                                                 | Encrypted vault (claimed; not audited)                                  | Yes — MCP gateway + OAuth vault               |
| **openconnector.dev ("Open Connector")** | Marketed AGPL "open-source Composio"   | **AGPL-3.0 claimed — no published code to verify**     | UNVERIFIED (pre-launch/vaporware)                | UNVERIFIED                                                                                                   | UNVERIFIED                                                              | UNVERIFIED                                    |
| **Raw MCP (baseline)**                   | OAuth 2.1 remote MCP servers           | Spec (open)                                            | N/A (you point at servers)                       | **None** (one credential context per connection)                                                             | Wherever the server keeps it                                            | Native                                        |

**Two projects share the "Open Connector" name — do not conflate** (a genuine trap for the AGPL check in §5): `openconnector.dev` (org `openconnector-dev`) declares AGPL-3.0 but ships **no code** ("coming soon," 1 star) — effectively vaporware. `oomol-lab/open-connector` (backed by OOMOL) uses near-identical "self-hostable Composio alternative / MCP gateway + OAuth vault" copy but is a **different, materially mature** project: **Apache-2.0**, ~2,900 stars, `v1.3.0` released **2026-07-17**. Also evaluated and dropped: **MetaMCP** (MIT, aggregation not vaulting — subsumed by Klavis), **Docker MCP Gateway** (weak multi-account).

### 1.3 Vendor specifics that matter for D4

**Composio (flagship managed candidate)** — all verified against docs/pricing/funding this pass:

- **Multi-account is its headline strength.** The v3 SDK scopes to `user_id` (the legacy `entity_id` renamed); each connected account is a `connected_account_id` (nanoid `ca_…`). Two accounts of one service are distinguished by a human-readable `alias` set at connect time, with a session-level `multi_account = { enable, max_accounts_per_toolkit, require_explicit_selection }`; at tool-call time you address a specific account by the `account` param (id or alias). **This is precisely the primitive raw MCP lacks (§1.1) — it is why Composio is the managed default.**
- **Custody: managed cloud vault by default.** Docs: "Composio stores and refreshes those credentials against that userID," and "Credentials never pass through your app or the model." DorkOS would hold a Composio API key + `ca_…` references, never the upstream tokens. SOC 2 Type II + ISO 27001. Self-hosting the actual backend/vault is **Enterprise-gated** (VPC/on-prem, custom quote); the public MIT repo is SDK/CLI only. So "self-host Composio" is not a realistic privacy-cohort answer — that is Nango's job.
- **MCP: yes.** **Rube** is the hosted MCP server (single endpoint `https://rube.app/mcp`, paste into any MCP client); **Tool Router** is the underlying infra issuing pre-signed per-user MCP session URLs with dynamic tool selection. An **Enterprise MCP Gateway** gives per-team scoped endpoints (`/mcp/t/{team}`) with SSO/SCIM. A Composio-backed connector exposes tools to sessions as MCP, aligning with DorkOS's existing MCP host.
- **Pricing** (metered on **tool calls**, not accounts/MAU): Free $0 / 20K calls; "Ridiculously Cheap" $29 / 200K (overage $0.299/1K); "Serious Business" $229 / 2M (overage $0.249/1K); Enterprise custom. **Pricing changes 2026-08-15** — new numbers unpublished (re-verify before any public claim).
- **Funding**: **Series A $25M led by Lightspeed** (announced 2025-07-22; ~$29M total incl. $4M seed; angels incl. Guillermo Rauch, Dharmesh Shah). No confirmed 2026 round found.
- **Partner/affiliate program CONFIRMED to exist** (correcting §8.3's "UNVERIFIED"): run via Dub Partners at `partners.dub.co/composio-dev/register`. Commission/cookie/payout terms are gated behind sign-in (UNVERIFIED). The partnership conversation is a business action item, not a technical dependency.

**Nango (first self-hostable candidate)** — the load-bearing license is now verified, with two important caveats §8.3 missed:

- **License, verified from the repo `LICENSE` file: Elastic License 2.0 (ELv2), single license across the whole monorepo including the client SDKs/CLI.** The widely-repeated "MIT SDKs" claim is **marketing, and it does not hold up** — npm metadata for `nango` and `@nangohq/frontend` reads `"SEE LICENSE IN LICENSE FILE IN GIT REPOSITORY"`, pointing at the root ELv2. ELv2 is **source-available, not OSI-open-source and not copyleft**: it permits self-host, modification, and internal/commercial use, forbidding only (a) providing it to third parties **as a hosted/managed service**, (b) circumventing license keys, (c) removing notices. No Change-Date auto-conversion. **For DorkOS this is benign** — DorkOS runs/points at self-hosted Nango as the user's own connector backend; it does not resell Nango-as-a-service.
- **Self-host is more gated than §8.3 implied — state it honestly.** Free self-host (docker-compose) covers **Auth + Proxy only**. **Functions, syncs, webhooks, AND Nango's own MCP server require the paid Enterprise Self-Hosted tier** (Helm on your cloud) or Nango Cloud. This is fine for D4's purpose — the **custody core** (OAuth connect + token storage in _your_ Postgres + authenticated Proxy calls) is exactly the free Auth+Proxy tier — but it means **DorkOS wraps Nango's Auth+Proxy into its own MCP tools via the ConnectorProvider adapter; it must NOT rely on Nango's Enterprise-gated MCP server.**
- **Custody caveat**: tokens live in your Postgres but are **stored unencrypted unless you set `NANGO_ENCRYPTION_KEY`** (256-bit, base64), and key rotation is unsupported. The DorkOS self-host guide must make setting this key mandatory, or the "tokens safe in your infra" promise is false.
- **Multi-account**: connections are keyed by a random-UUID `connectionId`; there is **no first-class `end_user` object** — instead arbitrary **tags** (`end_user_id`, `organization_id`, `workspace_id`) filter the connection list. Multi-tenant ships in the free Auth tier. 800+ APIs, 5,000+ templates. Cloud pricing: Free $0 (10 connections) / Starter $50 / Growth $500 / Enterprise custom.

**Raw MCP (baseline)**

- Must support: (a) connecting to **remote MCP servers** over OAuth 2.1 (DorkOS's runtimes already speak MCP and the server already opens short-lived MCP clients for `ui://` reads); (b) **single account per server connection**; (c) surfacing the server's tools to a session. Multi-account is explicitly **out of scope** for the baseline — that is the gateway's differentiator, and conflating them blurs why the gateway exists. Near-free to support because the plumbing exists.

---

## 2. The `ConnectorProvider` interface (design sketch — not shipped code)

DorkOS already abstracts swappable backends with two proven seams; `ConnectorProvider` is the third, cut to the same pattern:

- **`AgentRuntime`** (`packages/shared/src/agent-runtime.ts`) — one interface, N backends (claude-code/codex/opencode/test-mode), resolved per-session via a registry, each backend passing a shared conformance suite, capability flags declaring what a backend supports (`RuntimeCapabilities`).
- **`Transport`** (`packages/shared/src/transport.ts`) — one port, two adapters (HTTP/Direct), the client depends only on the port. It **already** carries an OAuth-PKCE loopback flow (`startOpenRouterOAuth` → `getOpenRouterOAuthStatus`) and reference-based credential storage (`storeRuntimeCredential` returns a _reference_, never the secret) — the exact shapes a connector connect-flow needs.

Principles that fall out of studying those two:

1. **Provider-neutral core, capability-flagged differences.** Genuinely-boolean differences are flags (mirrors `RuntimeCapabilities`), not forked code — `supportsMultiAccount`, `custody`.
2. **Address accounts by opaque id.** Composio's `connected_account_id` and Nango's `connectionId` both reduce to "an opaque, provider-scoped handle for one account of one service." The port speaks `ConnectedAccountId`; each adapter maps it.
3. **Never hand the client a secret.** Consistent with `CredentialProvider` and `storeRuntimeCredential`: connect flows return _references_ and _statuses_; tokens stay server-side (or vendor-side).
4. **Custody is a first-class, disclosable field** — the port must _surface_ where tokens live so the UI can tell the truth (§4). A DorkOS-specific addition the runtime/transport seams don't need.

```typescript
/** Where a provider keeps end-user OAuth tokens at rest — drives the custody disclosure UI (§4). */
type ConnectorCustody =
  | 'managed' // vendor cloud vault (Composio) — tokens leave the machine
  | 'self-host' // operator's own store (self-hosted Nango, in your Postgres) — tokens stay in your infra
  | 'external'; // no token custody by the gateway (raw MCP — the server holds its own)

/** Opaque, provider-scoped handle for ONE account of one service. The multi-account primitive raw MCP lacks. */
type ConnectedAccountId = string & { readonly __brand: 'ConnectedAccountId' };

/** Static capability + custody descriptor for one connector backend (mirrors RuntimeCapabilities). */
interface ConnectorCapabilities {
  readonly type: string; // 'composio' | 'nango' | 'mcp'
  /** Can one user hold N accounts of the same service? Raw-MCP: false. */
  supportsMultiAccount: boolean;
  /** Custody stance — the honest disclosure the UI renders. */
  custody: ConnectorCustody;
  /** Can the backend expose connected tools to a session over MCP? */
  exposesOverMcp: boolean;
  /** Runtime-specific metadata that doesn't merit a first-class field (cf. RuntimeCapabilities.features). */
  features: Record<string, unknown>;
}

/** A service the provider can connect to (Gmail, Slack, Linear, …). */
interface ConnectorToolkit {
  slug: string; // 'gmail'
  displayName: string;
  authKind: 'oauth2' | 'api-key' | 'none';
  maxAccountsPerUser?: number; // Composio's max_accounts_per_toolkit; undefined = unbounded/one
}

/** One connected account, provider-neutral. */
interface ConnectedAccount {
  id: ConnectedAccountId;
  toolkit: string; // 'gmail'
  label: string; // 'dorian@personal' — user-facing disambiguator (Composio alias / Nango tag)
  status: 'active' | 'expired' | 'revoked' | 'pending';
  custody: ConnectorCustody; // echoes provider custody so each row can disclose per-account
}

/** Begin a connect flow — mirrors startOpenRouterOAuth's loopback-PKCE shape. */
interface ConnectStart {
  /** URL to open (vendor consent screen or loopback authorize). */
  authorizeUrl: string;
  /** Opaque flow id to poll; the code_verifier / secrets stay server-side. */
  flowId: string;
}

/**
 * Universal connector backend contract — the third swappable seam beside AgentRuntime and
 * Transport. Composio (managed), Nango (self-host), and a raw-MCP adapter (baseline) each
 * implement it; a shared conformance suite gates every one, exactly as runtimeConformance
 * gates runtimes.
 */
interface ConnectorProvider {
  readonly type: string;
  getCapabilities(): ConnectorCapabilities;

  /** Discovery: which services can be connected. */
  listToolkits(): Promise<ConnectorToolkit[]>;

  /** Begin connecting `toolkit`; returns a URL + pollable flow id (secrets stay server-side). */
  startConnect(toolkit: string, opts?: { label?: string }): Promise<ConnectStart>;
  /** Poll a connect flow to completion; resolves to the new account handle. */
  pollConnect(
    flowId: string
  ): Promise<{ status: 'pending' | 'connected' | 'failed'; account?: ConnectedAccount }>;

  /** Multi-account addressing: list every account the user holds, optionally filtered to one service. */
  listAccounts(opts?: { toolkit?: string }): Promise<ConnectedAccount[]>;
  /** Revoke one account by its opaque id. */
  disconnect(accountId: ConnectedAccountId): Promise<void>;

  /**
   * Expose a connected account's tools to a session — the payload the session's runtime injects
   * as MCP. Returns runtime-neutral MCP connection details (mirrors AgentRuntime.getMcpServerConfig
   * / McpAppServerConnection): the account is selected by id, so two Gmail accounts become two
   * addressable tool servers.
   */
  toolServerForAccount(accountId: ConnectedAccountId): Promise<McpAppServerConnection>;
}
```

Notes on the sketch:

- `toolServerForAccount` returning `McpAppServerConnection` (a type that already exists in `agent-runtime.ts`) is the key unification: **every provider ultimately exposes connected tools to a session as MCP** — Composio via Rube, Nango via a DorkOS-built wrapper over its Auth+Proxy (its own MCP server is Enterprise-gated, §1.3), raw-MCP trivially. The runtime already injects MCP tool servers (`setMcpServerFactory`, `supportsMcp`), so the gateway's output plugs straight into the existing seam; no new session-side machinery.
- **Consent surface**: connect flows follow the same reference-not-secret discipline as `storeRuntimeCredential`. Per-account exposure to a session is the consent point — a session gets a tool server only for accounts the user has attached, and the `custody` field lets the approval UI disclose where tokens live _before_ the user connects.
- A raw-MCP adapter implements `ConnectorProvider` with `supportsMultiAccount: false`, `custody: 'external'`, `startConnect` driving the OAuth 2.1 remote-server flow, and `listAccounts` returning at most one account per configured server.

---

## 3. Integration seams in this repo (read the code — files/exports named)

A connector gateway is **net-new**, but it does not start from zero: it extends three shipped patterns and reuses one existing type.

### 3.1 Credential custody — reuse `CredentialProvider` wholesale

`apps/server/src/services/core/credential-provider.ts`:

- Exports the `CredentialProvider` port (`resolve(ref) → CredentialResolution`), the `CredentialStore` write port (`put`/`get`/`delete`), `EncryptedFileCredentialStore` (AES-256-GCM at rest via `ExtensionSecretStore`, scoped to store id `runtime-credentials` under `{dorkHome}`), `MacOsKeychainAccessor`, `DefaultCredentialProvider`, and the module singletons `credentialProvider` / `credentialStore` set by `initCredentialProvider(dorkHome)`.
- Reference scheme `keychain:<id>` / `env:<VAR>` / `file:<name>` (parsed by `parseCredentialReference` in `@dorkos/shared/config-schema`). Secrets are never persisted plaintext, never logged, never echoed by any endpoint; resolution is throw-free and failure-typed.
- **For the self-host / API-key path** (Nango base URL + secret key, Composio API key): store the vendor key via `credentialStore.put(...)`, persist only its `file:` reference (the exact pattern `connect/credentials.ts` uses for `providers.anthropic`). For the **managed vault path**, the only DorkOS-held secret is the Composio API key + the `ca_…` references — upstream tokens never touch this store, which is the whole custody point. (Note: DorkOS's own store gives you AES-256-GCM for free; Nango's `NANGO_ENCRYPTION_KEY` footgun from §1.3 is on the Nango side, so the self-host guide must set it.)

### 3.2 Per-service adapter lifecycle — mirror `AdapterManager`

`apps/server/src/services/relay/adapter-manager.ts` + `packages/relay/src/base-adapter.ts` + `apps/server/src/services/relay/adapter-secrets.ts`:

- The relay subsystem is the closest existing shape to "many per-service backends with secrets and a lifecycle." `AdapterManager` owns a `manifests` map, per-instance `configs`, a serialized start/stop queue, `enable`/`disable`/`addAdapter`/`removeAdapter`/`testConnection`, and secret materialization.
- **Multi-account precedent lives here**: `AdapterManifest.multiInstance` (`packages/shared/src/relay-adapter-schemas.ts:275`) already lets N instances of one adapter type coexist — the structural analogue of N connected accounts per toolkit. `addAdapter` enforces the single-instance rule when `multiInstance` is false.
- **Secret handling to copy**: `adapter-secrets.ts` (`materializeAdapterSecrets` / `resolveAdapterSecrets` / `secretFieldKeys`) drives "which fields are secret" off the manifest's `password` config fields, moves pasted secrets into the encrypted `CredentialStore` as `file:` references before writing config, and resolves them back **in memory only** at construction (DOR-280). Route vendor keys through the identical funnel.
- **Config-field UI**: `ConfigField` / `AdapterManifest` (`relay-adapter-schemas.ts`) already model typed, `password`-masked, `showWhen`-conditional setup forms with `setupSteps` and a `setupGuide` — reusable for a connector's connect form.
- **Consent gate**: relay's binding subsystem (`BindingSubsystem`) is the existing "this external channel may talk to this agent" gate. The connector analogue is "this connected account is exposed to this session/agent."

### 3.3 Distribution — the marketplace `adapter` package type

`packages/marketplace/src/manifest-schema.ts` + `packages/marketplace/src/package-types.ts`:

- `PackageTypeSchema = z.enum(['agent', 'plugin', 'skill-pack', 'adapter'])` — a **closed** enum. `adapter` packages carry `adapterType` (`AdapterManifestSchema`, `manifest-schema.ts:159`) and install transactionally via `apps/server/src/services/marketplace/marketplace-installer.ts` (git-free staged transaction, ADR-0304). Dependencies can be declared `adapter:slack@^1.0.0` (`DependencyDeclarationSchema`).
- **Decision for the W5 spec**: ship a connector as the existing `adapter` type, or add a `connector` enum member? Leaning **reuse `adapter`** (a connector _is_ a service adapter; avoids a schema migration and the ADR-0236 sidecar dance) unless connectors need install-flow behavior adapters don't. The program plan already contemplates a fifth type `shape`; adding `connector` too would be two enum changes — prefer folding connectors into `adapter`.

### 3.4 Session tool exposure — reuse the MCP seam (no new machinery)

- `AgentRuntime.getMcpServerConfig(cwd, serverName) → McpAppServerConnection` and `setMcpServerFactory` (`agent-runtime.ts`), plus `RuntimeCapabilities.supportsMcp`, are how tool servers already reach a session. `ConnectorProvider.toolServerForAccount` returns exactly `McpAppServerConnection`, so a connected account becomes a session tool server through the path that already exists — the single biggest reason the gateway is _additive_, not invasive.

### 3.5 Adjacent-but-distinct (do not conflate)

- **Runtime Connect** (`apps/server/src/services/runtimes/connect/credentials.ts`) authenticates the _agent model provider_ (Anthropic/Codex/OpenCode keys), not third-party service accounts. Same custody plumbing, different purpose.
- **Cloud-link "Accounts"** (`apps/server/src/services/core/auth/cloud-link.ts`, `packages/shared/src/cloud-schemas.ts`) is an RFC 8628 device flow linking a DorkOS _instance_ to a dorkos.ai _account_ — identity, not connectors. Adjacent, not overlapping.

---

## 4. Custody stance and the plain-language disclosure

The house rule is "be honest by design; describe what happens for the user." Custody is where that rule bites hardest — a connector moves the user's real credentials somewhere. The disclosure must state, in plain language, **where the tokens live** — before the user connects, not buried in docs.

**Managed provider (Composio) — tokens leave the machine.** Disclosure copy, roughly:

> "Connecting Gmail sends you to Google to sign in. Composio (our connector service) holds the resulting access securely in its vault so your agents can act on your behalf. Your password is never shared; the connection can be revoked anytime. Tokens are stored by Composio, not on this computer."

The honest core: **a managed vault means the tokens are in the vendor's cloud, not local-first.** For Kai/Ikechi (already running cloud models) this is an acceptable, clearly-labeled trade. It must be _labeled_, because DorkOS's whole trust position is local-first-by-default. (Composio's own docs back the safe half of the claim: "Credentials never pass through your app or the model" — the tokens are with Composio, not with DorkOS or the LLM.)

**Self-host path (Nango) — tokens stay in your infrastructure.** Disclosure copy, roughly:

> "You're connecting through your own self-hosted Nango. The access tokens are stored in your database, on infrastructure you control. Nothing about this connection leaves your systems."

This is the privacy-cohort answer (Priya/Lil). The self-host path **changes the disclosure from "vendor holds it" to "you hold it,"** and DorkOS's role from "we chose a custodian for you" to "you are the custodian." **Caveat that must be enforced, not just disclosed** (§1.3): self-hosted Nango stores tokens _unencrypted_ unless `NANGO_ENCRYPTION_KEY` is set — so the DorkOS self-host guide must make setting it mandatory, or the promise is hollow.

**Raw MCP baseline — the server holds its own.** `custody: 'external'`: DorkOS brokers nothing; the remote MCP server manages its own auth. Disclosure: "This tool connects directly to <server>; DorkOS doesn't store its credentials."

Design consequence: **custody must be visible at connect time and per-account in the accounts list** — not a global setting, because a user may have a managed Gmail and a self-host Slack simultaneously. That is why `ConnectedAccount.custody` echoes the provider's stance per row.

---

## 5. AGPL exposure check

The AGPL question turns out to be **largely moot in practice** — but the guardrail still matters, so record both.

- **No adoptable AGPL candidate actually exists.** The only AGPL-declared option, `openconnector.dev` ("open-source Composio," AGPL-3.0), **ships no published code** — its GitHub org has one empty "coming soon" repo. It is not adoptable regardless of license. The mature namesake that _does_ exist, `oomol-lab/open-connector`, is **Apache-2.0** (permissive, verified), not AGPL. So the "AGPL open-source Composio" of §8.3 was a marketing site, not a codebase — a trap worth flagging so nobody adopts a phantom.
- **The guardrail still stands** for anything AGPL that appears later: **AGPL-3.0 §13's network clause** is the sharp edge. If DorkOS _modifies_ AGPL software and lets users interact with it **over a network** (which a self-hostable HTTP server does by definition), it must offer those users the modified source — obligations that could attach to the modified backend and plausibly reach tightly-linked server code. **Do not bundle or fork an AGPL connector backend as a default** without legal sign-off (Blaze Ventures, LLC is the entity for counsel). The only safe AGPL use is running it **unmodified as a separate arm's-length process** the user opts into.
- **This is why Nango (ELv2) beats a hypothetical AGPL pick** for the self-host slot: source-available, self-hostable, non-copyleft, and its one real restriction (don't resell it as a managed service) is one DorkOS won't trip. Permissive alternatives (Klavis **Apache-2.0**, oomol-lab/open-connector **Apache-2.0**, MetaMCP **MIT**) carry no copyleft risk at all. Composio's managed backend is closed (you consume an API — no license transfer). **Net: AGPL exposure is currently hypothetical; keep the guardrail, adopt no AGPL default.**

---

## 6. Recommendation (decisive — the founder delegated this to evidence)

**Flagship managed provider: Composio.** Strongest multi-account primitive (`connected_account_id` + `alias` + `max_accounts_per_toolkit`), widest coverage (1,047 toolkits), and a hosted MCP gateway (Rube) that plugs into DorkOS's existing MCP host. Its managed vault is the acceptable-with-disclosure default for the convenience cohort. Business action items (non-blocking): open the partnership/affiliate conversation (confirmed to exist via Dub Partners) and re-verify pricing after the 2026-08-15 change.

**First self-hostable provider: Nango — with one explicit re-check at spec kickoff.** ELv2 (verified whole-monorepo; source-available, non-copyleft), free self-host Auth+Proxy puts tokens in the operator's own Postgres, first-class multi-connection via tags, 800+ integrations, and it is the most mature option by a wide margin. Two honesty caveats baked into the plan: (a) DorkOS wraps Nango's **Auth+Proxy** into its own MCP tools — it must **not** depend on Nango's Enterprise-gated MCP server; (b) the self-host guide must **mandate `NANGO_ENCRYPTION_KEY`** or the custody promise is false. **Re-check at W5 spec kickoff**: `oomol-lab/open-connector` (Apache-2.0, purpose-built as a self-hostable MCP-gateway-with-vault — architecturally the exact shape we want, and more permissively licensed than ELv2) shipped `v1.3.0` on 2026-07-17. It is one day old at this spike and single-vendor, so Nango wins **now** on maturity; but it is the strongest reason to re-confirm the self-host pick when the spec starts rather than treat Nango as locked.

**Raw-MCP baseline must support:** connecting to remote MCP servers over OAuth 2.1, one account per server connection, and surfacing the server's tools to a session via the existing runtime MCP injection seam. Explicitly **no** multi-account — that is the gateway's differentiator. Near-free because the plumbing exists (`getMcpServerConfig`, `supportsMcp`, the short-lived MCP client for `ui://` reads).

**Reject both "Open Connector" projects as defaults**: `openconnector.dev` is vaporware; `oomol-lab/open-connector` is a re-check candidate, not a day-one bet. **Reject any AGPL backend as a bundled default** (§5).

### Sequencing for the W5 spec

1. **Define the `ConnectorProvider` port + conformance suite** (`packages/shared` + a `@dorkos/test-utils` harness, exactly as `runtimeConformance` gates runtimes). Land the port and the **raw-MCP adapter first** — it's the baseline and exercises the whole seam against machinery that already exists.
2. **Custody-disclosure UI primitive** (`ConnectorCustody` → per-account and connect-time disclosure copy). Ship it with the port so no provider can be added without a truthful disclosure — the demo-claim gate, made structural.
3. **Composio adapter** (managed, `custody: 'managed'`): store only the Composio API key (via `CredentialStore`) + `ca_…` references; wire tool exposure through Rube MCP → `toolServerForAccount`.
4. **Nango adapter** (self-host, `custody: 'self-host'`), after the spec-kickoff re-check vs oomol: store base URL + secret key as `file:` references; enforce `NANGO_ENCRYPTION_KEY`; wrap Auth+Proxy into MCP tools (do not require Nango's Enterprise MCP server).
5. **Distribution**: ship connectors as marketplace `adapter`-type packages (reuse the enum member; add a `connector` type only if install behavior genuinely diverges). Feeds W4's connector evals ("Connect to my Gmail" default-gateway eval; "Connect to Slack" routing eval that must pick the Relay Slack adapter over the gateway).
6. **Consent/binding**: model per-account→session exposure on the relay binding subsystem's gate.

Dependencies satisfied: this spike closes D4's evidence gap and answers the parked open question (`plans/shapes-program.md` OQ1 / DOR-369, first self-hostable provider) — **Nango**, on license + custody + maturity evidence, with `oomol-lab/open-connector` named as the explicit re-evaluation candidate.

---

## 7. Honest confidence notes

- **High confidence** (verified this pass or read from source):
  - The MCP multi-account gap (§1.1) — verified against discussions #234/#193/#483, SEP-1299, the six 2026-07-28 hardening SEPs, EMA, and real-world Atlassian/Google-Workspace workarounds.
  - **SEP-1865 has been Final since ~2026-01-26** (the plan's "~2026-07-28 final" was a date conflation with the Extensions-framework core release).
  - Composio's multi-account model, custody, pricing tiers, $25M Lightspeed Series A, 1,047 toolkits, and **the affiliate program's existence** (Dub Partners) — all primary-sourced.
  - **Nango's ELv2 license across the whole monorepo** (repo `LICENSE` + npm metadata; the "MIT SDKs" claim is disproven), its **Auth+Proxy-only free self-host gate**, and the **`NANGO_ENCRYPTION_KEY` unencrypted-by-default** custody caveat.
  - Klavis is **Apache-2.0** (not MIT); Arcade's Engine is **proprietary** (framework MIT); the "Open Connector" name collision (AGPL vaporware vs Apache-2.0 `oomol-lab`).
  - The three in-repo seams and exact files/exports (§3) — read directly from source this session; `McpAppServerConnection` reuse; `CredentialProvider` custody reuse.
- **Medium confidence** (verify before a hard public/contract claim, not before deciding): Composio's **post-2026-08-15 pricing** (unpublished); Composio Tool Router GA date; Nango Cloud "per-tenant isolation" (vendor claim); Klavis per-toolkit multi-account + vaulting mechanics (undocumented); Pipedream Connect exact pricing. **None change the recommendation** — the picks rest on custody model + license class + multi-account primitive, which are verified and stable.
- **Lower confidence / explicitly deferred**: `oomol-lab/open-connector` maturity (1 day old at spike time — its "encrypted vault" is a claim, not audited); Arcade/Paragon assessed at "credible alternative" depth only (not the recommendation). MetaMCP MIT is carried from prior research, not re-verified this pass.
- **Not a code commitment**: the §2 interface is a design sketch to anchor the W5 spec. `connected_account_id`↔`connectionId` normalization, error taxonomy, and the conformance suite are spec-stage work.

---

## 8. Source pointers

**In-repo (read this session):**

- `packages/shared/src/agent-runtime.ts` — `AgentRuntime`, `RuntimeCapabilities`, `McpAppServerConnection`, `getMcpServerConfig`, `setMcpServerFactory`.
- `packages/shared/src/transport.ts` — `Transport`; OAuth-PKCE loopback (`startOpenRouterOAuth`/`getOpenRouterOAuthStatus`) and reference-based `storeRuntimeCredential`.
- `apps/server/src/services/core/credential-provider.ts` — `CredentialProvider`, `CredentialStore`, `EncryptedFileCredentialStore`, `initCredentialProvider`, the `keychain:`/`env:`/`file:` scheme.
- `apps/server/src/services/relay/adapter-manager.ts`, `packages/relay/src/base-adapter.ts`, `apps/server/src/services/relay/adapter-secrets.ts` — per-service adapter lifecycle, `multiInstance` precedent, secret materialization (DOR-280).
- `packages/shared/src/relay-adapter-schemas.ts` — `AdapterManifest`, `ConfigField`, `multiInstance` (`:275`).
- `packages/marketplace/src/manifest-schema.ts`, `packages/marketplace/src/package-types.ts` — the `adapter` package type + closed `PackageTypeSchema` enum; `apps/server/src/services/marketplace/marketplace-installer.ts`.
- `apps/server/src/services/runtimes/connect/credentials.ts` — model-provider credential path (adjacent).
- `apps/server/src/services/core/auth/cloud-link.ts`, `packages/shared/src/cloud-schemas.ts` — dorkos.ai account link (adjacent, device flow).
- Prior research: `research/20260717_shapes-byoa-positioning.md` §8.3 (this doc supersedes it); `plans/shapes-program.md` D4/W5, OQ1 (DOR-369).

**External — Composio** (accessed 2026-07-17):

- Multi-account: `docs.composio.dev/docs/managing-multiple-connected-accounts`, `.../auth-configuration/connected-accounts`, `.../migration-guide/new-sdk`.
- Custody/auth: `docs.composio.dev/docs/authentication`; enterprise self-host `composio.dev/enterprise`.
- MCP: `composio.dev/mcp-gateway`, `composio.dev/blog/introducing-tool-router-(beta)`, Rube `https://rube.app/mcp` (via `pulsemcp.com/servers/composiohq-rube`, `npmjs.com/package/@composio/rube-mcp`).
- Pricing: `composio.dev/pricing` (changes 2026-08-15). Toolkits: `composio.dev/toolkits` (1,047).
- Funding: `prnewswire.com` ($29M / $25M Series A, Lightspeed, 2025-07-22); `finsmes.com`. Repo: `github.com/ComposioHQ/composio` (MIT SDK; self-host issue #291, discussion #1037). Affiliate: `partners.dub.co/composio-dev/register`.

**External — Nango + alternatives** (accessed 2026-07-17):

- Nango license: **`github.com/NangoHQ/nango/blob/master/LICENSE`** (Elastic License 2.0); npm `registry.npmjs.org/nango/latest` + `@nangohq/frontend` (`SEE LICENSE IN LICENSE FILE`).
- Nango self-host gate: `nango.dev/docs/guides/platform/self-hosting`, issue `github.com/NangoHQ/nango/issues/5536`; tags: `.../auth/connection-tags-configuration-metadata`; pricing `nango.dev/pricing`.
- Arcade: `arcade.dev`, `docs.arcade.dev/home/hosting-overview`, `github.com/arcadeai/arcade-mcp` (MIT); Series A `$60M` `businesswire.com` (2026-06-15), seed `$12M` `thesaasnews.com`.
- Klavis: `github.com/Klavis-AI/klavis` (**Apache-2.0**), `klavis.ai/docs/concepts/strata`.
- Paragon: `useparagon.com/actionkit`, pricing `merge.dev/blog/paragon-pricing`. Pipedream: `pipedream.com/connect`, self-host issue #954, pricing community thread.
- Open Connector: `openconnector.dev` + `github.com/openconnector-dev` (AGPL-3.0 claimed, no code); `github.com/oomol-lab/open-connector` (**Apache-2.0**, v1.3.0 2026-07-17), `oomol.com/en/docs/openconnector-self-hosting`.

**External — MCP spec** (accessed 2026-07-17):

- Authorization: `modelcontextprotocol.io/specification/draft/basic/authorization` (OAuth 2.1, RFC 8707 resource indicators, RFC 9728, DCR deprecated → Client ID Metadata Documents).
- Multi-account gap: discussions `github.com/modelcontextprotocol/modelcontextprotocol/discussions/234` (closed), `/193` (open), `/483` (open); issue `/1299` (SEP-1299, stalled). Real-world: Atlassian community "N accounts = N connections"; `github.com/taylorwilsdon/google_workspace_mcp/issues/693` (`login_hint`).
- 2026-07-28 release + Extensions framework (SEP-2133), stateless rewrite: `blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate`. EMA: `blog.modelcontextprotocol.io/posts/enterprise-managed-auth`. MCP Apps (SEP-1865, Final ~2026-01-26): `github.com/modelcontextprotocol/modelcontextprotocol/pull/1865`, `github.com/modelcontextprotocol/ext-apps`.
