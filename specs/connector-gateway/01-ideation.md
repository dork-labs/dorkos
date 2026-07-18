---
slug: connector-gateway
id: 260718-050609
created: 2026-07-18
status: ideation
linearIssue: DOR-371
---

# ConnectorProvider gateway — one port for many connector backends (W5/D4)

**Slug:** connector-gateway
**Author:** spec-connector-gateway (IDEATE stage, Shapes program W5)
**Date:** 2026-07-18
**Tracker:** DOR-371 · Shapes program workstream W5 · depends on D4 (connector custody stance)
**Research basis:** `research/20260718_connector-gateway-spike.md` (MERGED, REVIEW-verified) — provider matrix, seams, `ConnectorProvider` sketch, §6 recommendation + sequencing.

---

## 1) Intent & Assumptions

### Intent

Let a DorkOS agent connect to a real third-party service (Gmail, Slack, Linear, Notion, …) and act on the user's behalf — including **two accounts of the same service** (personal + work Gmail) — through **one provider-neutral port**, so session code never learns which connector vendor is behind a connection. This is the coordination-layer piece that turns "your agent can only talk to what it can already reach" into "your agent can act across your whole SaaS stack." It is the technical spine under the Shapes program's business-shape ladder (CRM-lite, content pipeline) and the direct input to the W4 connector evals.

The spike already did the evidence work D4 deferred and made the provider picks. **This spec turns that spike into an implementable design**: the `ConnectorProvider` port (Zod-first), the multi-account addressing model, the session tool-exposure path, the custody disclosure surface, the routing surface that sends "Connect to Slack" to the purpose-built Relay adapter instead of the generic gateway, and the marketplace distribution shape.

### Assumptions (marked; challenge in SPECIFY)

- **A1 — The spike's provider picks stand.** Composio = flagship managed provider; Nango = first self-hostable (with the spec-kickoff re-check, done below in §4); raw MCP = single-account baseline. These are founder-delegated-to-evidence and settled in the spike §6. _Not relitigated here._
- **A2 — The MCP seam is the tool-exposure path.** `AgentRuntime.getMcpServerConfig` / `McpAppServerConnection` / `setMcpServerFactory` already carry runtime-neutral MCP tool servers into a session (ADR `260708-141143`). The gateway's job is to _produce_ those connection objects per connected account; it adds no new session-side machinery. **Correction honored from spike review:** `getMcpServerConfig?` is _optional_ and returns `McpAppServerConnection | null` — so the gateway's analogue `toolServerForAccount` must also be nullable, and the null branch (expired/revoked/un-exposable account) must be designed explicitly, not assumed away.
- **A3 — Custody must be disclosed before connect, per account.** DorkOS is local-first-by-default; a managed vault (Composio) moves real credentials off the machine. The house rule ("be honest by design; describe what happens for the user") makes the custody label a first-class, load-bearing field, not a footnote.
- **A4 — Connectors distribute as the existing marketplace `adapter` type**, not a new `connector` enum member — unless install-flow behavior genuinely diverges (open question for SPECIFY). Avoids a schema migration and a second enum change alongside the planned `shape` type.
- **A5 — This is a design + first-implementation-phase spec, not a full vendor integration in one pass.** Composio/Nango adapters touch live vendor APIs and need real credentials; CI exercises them against **mock providers**, with real-provider runs on the weekly deep cadence (D5). The port + raw-MCP baseline + registry + routing + custody land against machinery that already exists; the managed/self-host adapters follow.

## 2) Pre-reading Log

| Source                                                                                                   | What it settled                                                                                                                                                                                                                                                                                   |
| -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `research/20260718_connector-gateway-spike.md` §1                                                        | The gap is real: MCP has **no** multi-account addressing primitive (discussions #234 closed, #193/#483 open, SEP-1299 stalled; EMA removes account selection). A gateway's whole value-add is a first-class `connectedAccountId` layer.                                                           |
| spike §1.2–1.3                                                                                           | Provider matrix + vendor specifics. Composio: `connected_account_id` (`ca_…`) + `alias` + `max_accounts_per_toolkit`, managed vault, Rube MCP. Nango: ELv2 whole-monorepo, free self-host = **Auth+Proxy only**, tokens **unencrypted unless `NANGO_ENCRYPTION_KEY`** set, `connectionId` + tags. |
| spike §2                                                                                                 | The `ConnectorProvider` interface sketch — the anchor for §Detailed Design.                                                                                                                                                                                                                       |
| spike §3                                                                                                 | The three verified in-repo seams + the one reused type.                                                                                                                                                                                                                                           |
| spike §4                                                                                                 | Custody stance + draft disclosure copy for all three custody classes.                                                                                                                                                                                                                             |
| spike §5                                                                                                 | AGPL check: no adoptable AGPL candidate exists; keep the guardrail, adopt no AGPL default.                                                                                                                                                                                                        |
| spike §6                                                                                                 | Decisive recommendation + the 6-step W5 sequencing.                                                                                                                                                                                                                                               |
| `plans/shapes-program.md` D4/W5, P4                                                                      | D4 direction; W5 scope; CRM-lite (P4) is the first shape that _needs_ this.                                                                                                                                                                                                                       |
| `packages/shared/src/agent-runtime.ts:54,747`                                                            | `McpAppServerConnection` (server-only stdio/http/sse union); `getMcpServerConfig?()` is optional and returns `McpAppServerConnection` or `null`.                                                                                                                                                  |
| `apps/server/src/services/core/credential-provider.ts`                                                   | `CredentialProvider`/`CredentialStore`/`EncryptedFileCredentialStore` (AES-256-GCM), `keychain:`/`env:`/`file:` scheme, `initCredentialProvider`.                                                                                                                                                 |
| `apps/server/src/services/relay/adapter-manager.ts` + `packages/shared/src/relay-adapter-schemas.ts:275` | `AdapterManager` lifecycle (`addAdapter`/`removeAdapter`/`enable`/`disable`/`testConnection`); `AdapterManifest.multiInstance` — the N-instances-of-one-type precedent, the structural analogue of N accounts per toolkit.                                                                        |
| `packages/marketplace/src/package-types.ts:38`                                                           | `PackageTypeSchema = z.enum(['agent','plugin','skill-pack','adapter'])` — closed enum; `adapter` packages carry `adapterType` (`manifest-schema.ts:160`).                                                                                                                                         |

## 3) Codebase Map

**The port lives in `@dorkos/shared`** beside its two proven siblings:

- `packages/shared/src/agent-runtime.ts` — `AgentRuntime` (one interface, N backends, per-session registry, conformance suite, `RuntimeCapabilities` flags) + the reused `McpAppServerConnection` type. This is the template `ConnectorProvider` copies.
- `packages/shared/src/transport.ts` — `Transport` (one port, two adapters). Already carries an **OAuth-PKCE loopback flow** (`startOpenRouterOAuth` → `getOpenRouterOAuthStatus`) and **reference-based credential storage** (`storeRuntimeCredential` returns a _reference_, never a secret) — the exact shapes a connect-flow needs.

**Server wiring** mirrors two shipped subsystems:

- `apps/server/src/services/core/credential-provider.ts` — reuse wholesale for vendor keys (Composio API key, Nango base URL + secret key) as `file:` references; the managed-vault path stores only the Composio API key + `ca_…` refs (upstream tokens never touch this store — the custody point).
- `apps/server/src/services/relay/` — `adapter-manager.ts` (lifecycle), `adapter-secrets.ts` (`materializeAdapterSecrets`/`resolveAdapterSecrets`, DOR-280 — secrets to `CredentialStore` before config write, resolved in-memory only), `base-adapter.ts`. `relay-adapter-schemas.ts` `ConfigField`/`AdapterManifest`/`multiInstance`/`setupSteps`/`setupGuide` model the connect-form UI. `BindingSubsystem` is the existing "this external channel may talk to this agent" consent gate — the connector analogue is "this connected account is exposed to this session/agent."

**Session tool exposure** reuses, adds nothing:

- `AgentRuntime.getMcpServerConfig` / `setMcpServerFactory` / `RuntimeCapabilities.supportsMcp` — a connected account becomes a session tool server through the path that already exists.

**Distribution:**

- `packages/marketplace/src/{package-types.ts,manifest-schema.ts}` — the `adapter` type; `apps/server/src/services/marketplace/marketplace-installer.ts` (git-free staged transaction, ADR-0304).

**Adjacent-but-distinct (do not conflate — spike §3.5):** Runtime Connect (`services/runtimes/connect/credentials.ts`, model-provider auth) and Cloud-link Accounts (`services/core/auth/cloud-link.ts`, dorkos.ai instance link) share the custody plumbing but not the purpose.

## 4) Research

Not a re-research pass — the spike is the evidence base. Two items are IDEATE-owned:

### 4.1 `oomol-lab/open-connector` re-check (the mandated spec-kickoff re-evaluation)

The spike named `oomol-lab/open-connector` (Apache-2.0, self-hostable MCP-gateway-with-vault — architecturally the exact shape we want, more permissive than Nango's ELv2) as an explicit re-check candidate, because at spike time it was **one day old** (`v1.3.0`, 2026-07-17) and single-vendor.

**Re-check outcome (2026-07-18, web-verified this session):**

- Still `v1.3.0` (2026-07-17) — **the same release**; no new version cut since the spike.
- **~2,900 stars** — unchanged from the spike's figure; no measurable adoption jump.
- Apache-2.0, TypeScript (99.8%), ~271 commits, 7 releases, **primarily single-vendor (OOMOL)** governance.
- Positioning now explicit: "Open-source auth gateway connecting 1000+ SaaS providers to AI agents through SDK, CLI, MCP, HTTP, and OpenAPI" — an encrypted vault + tamper-evident audit trail, deployable local / Fly.io / Cloudflare / GHCR image.

**Verdict: stays on watch; Nango wins now — exactly as the spike predicted.** No maturity change in the ~24h since the spike; still a single day-old release and single-vendor, so it is not a day-one bet against Nango's 800+ integrations and multi-year track record. It is architecturally attractive (native MCP-gateway-with-vault, permissive license) and remains the **strongest reason to re-confirm the self-host pick at the point the Nango adapter is actually built** (Implementation Phase 4), not to treat Nango as locked. Recorded as a spec Open Question, not a decision to switch.

### 4.2 Provider-neutrality is the load-bearing design constraint

Composio's `connected_account_id` and Nango's `connectionId` both reduce to "an opaque, provider-scoped handle for one account of one service" (spike §2, principle 2). The port speaks one `ConnectedAccountId`; each adapter maps it. This is what makes "two Gmail accounts addressable without provider leakage into session code" (the W5 acceptance criterion) achievable: the session sees two MCP tool servers named by toolkit + label, never the vendor.

## 5) Decisions (carried into SPECIFY as LOCKED)

1. **Build the third swappable seam.** `ConnectorProvider` mirrors `AgentRuntime`/`Transport`: one port, N backends, a `ConnectorRegistry`, a shared conformance suite, capability flags. (spike §2)
2. **Provider picks (from D4 + spike §6, not relitigated):** Composio (managed) flagship; Nango (self-host) first, after the §4.1 re-check at adapter-build time; raw-MCP (external) baseline.
3. **Address accounts by opaque, provider-scoped id.** `ConnectedAccountId`; a server-side connected-account registry binds each id → owning provider (first-write-wins, mirroring `runtimeRegistry`). Session tool surface carries **no** provider identity.
4. **Tool exposure reuses the MCP seam** — `toolServerForAccount(id): McpAppServerConnection | null`, with the null branch (account can't be exposed) surfaced as a per-account warning, never a silent drop.
5. **Custody is a first-class field with mandatory pre-connect disclosure**, per account. Three classes: `managed` / `self-host` / `external`. Draft copy in the spec §Detailed Design 4.
6. **Routing precedence: purpose-built Relay adapter > gateway > raw-MCP.** "Connect to Slack" routes to the Relay Slack adapter; "Connect to my Gmail" routes to the gateway (Composio default). A `recommendConnector(serviceSlug)` surface makes this testable by W4.
7. **Distribute as the marketplace `adapter` type** (reuse the enum), unless install behavior genuinely diverges (Open Question).
8. **Enforce `NANGO_ENCRYPTION_KEY`** in the Nango self-host path and never depend on Nango's Enterprise-gated MCP server (wrap its free Auth+Proxy into DorkOS MCP tools).

## 6) Open Questions (for SPECIFY)

- **OQ1 — `adapter` vs a new `connector` package type.** Lean reuse `adapter`. Does a connector need install-flow behavior an adapter lacks (e.g. a post-install "connect an account" step vs. adapters' "configure fields")? Decide against `marketplace-installer.ts`.
- **OQ2 — Where does the connected-account registry persist?** SQLite table (like the agents cache) vs a `~/.dork/` JSON file (like agent.json file-first). Leaning a small SQLite table keyed by `accountId`, since it's derived/queryable and never hand-edited.
- **OQ3 — Does the gateway own OAuth flows, or delegate entirely to the vendor?** Composio/Nango host their own consent screens (delegate). Raw-MCP uses the OAuth 2.1 loopback (`startOpenRouterOAuth` shape). Confirm the port's `startConnect`/`pollConnect` covers both without a leaky abstraction.
- **OQ4 — Self-host provider re-confirm at build time:** Nango vs `oomol-lab/open-connector` (§4.1). Re-run the maturity check when Phase 4 starts.
- **OQ5 — Consent granularity:** per-account→session (relay `BindingSubsystem` model) vs per-account→agent. Which is the first-class binding?

## 7) Recommended Direction & Next Step

Proceed to SPECIFY. Define the Zod-first `ConnectorProvider` port + conformance suite in `@dorkos/shared`/`@dorkos/test-utils`, land it with the **raw-MCP adapter** (baseline, exercises the whole seam against existing machinery) and the **custody-disclosure primitive** (so no provider can be added without a truthful disclosure — the demo-claim gate made structural), then the **registry + routing surface**, then the **Composio adapter**. Nango follows after the §4.1 re-check. Ship connectors as marketplace `adapter` packages. The design must make the two W4 evals — "Connect to my Gmail" (default gateway) and "Connect to Slack" (routes to the Relay adapter) — directly expressible against the interface.
