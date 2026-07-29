---
slug: connector-completion
id: 260729-084214
created: 2026-07-29
status: specified
linearIssue: DOR-415
---

# Connector completion — the user-facing half of the connector gateway

**Status:** Draft (frozen for DECOMPOSE)
**Author:** spec-connector (connector-completion program)
**Date:** 2026-07-29
**Tracker:** DOR-415 (Nango Proxy→MCP + nits) under the DOR-371 umbrella.
**Basis:** `specs/connector-gateway/02-specification.md` (shipped), ADR `260718-045630`, source read 2026-07-29. Ideation: `specs/connector-completion/01-ideation.md`.

## Overview

The connector gateway backend is complete and conformance-tested, but nothing can reach it: no code path writes the vendor keys its providers gate on, providers are built once at boot, agents have no connector tools, and there is no UI. This spec completes the feature: a **credential write path with live provider (re)registration**, **raw-MCP registration**, **agent-facing MCP tools**, the **Nango Proxy→MCP wrapper** (DOR-415), a **`/connections` client surface** with session attach/detach, **marketplace + site discovery**, **truthful docs**, and **e2e proof against a fake provider**. Everything reuses the shipped services — new code is thin wiring, one new MCP wrapper, and UI.

## Background / Problem Statement

See `01-ideation.md` §Verified gaps for the nine source-verified gaps. In short: `maybeCreateComposioProvider` waits forever for `file:composio-api-key` (nothing writes it); `index.ts:1051-1090` constructs providers exactly once; `RawMcpConnectorProvider` is registered nowhere; the DorkOS MCP surface has zero connector tools; Nango declares `exposesOverMcp: false`; the client has no connector pixel; marketplace/site discovery is absent or false; `docs/connectors/*.mdx` describe steps that do not exist.

## Decisions (resolved in SPECIFY — recommendations marked where still open-ish)

1. **`ConnectorProviderBootstrapper` owns provider lifecycle.** New `services/connectors/bootstrap.ts`: `registerBootProviders()` (called from `index.ts`), `reload(provider: 'composio' | 'nango')` (called by credential routes after a key write/delete). Registry gains `unregister(type)`. Reload = unregister-if-present → `maybeCreate*` → register-if-non-null. No restart ever required. Boot semantics (silent-null when unconfigured, loud `NangoEncryptionKeyError` refusal) are preserved because reload calls the same factories.
2. **Credential routes live under `/api/connectors/providers`** (not `/api/runtimes`): `GET /api/connectors/providers` (status list), `PUT /api/connectors/providers/:provider/credential` (body `{ secret }`), `DELETE /api/connectors/providers/:provider/credential`. Writing mirrors `storeRuntimeCredential` (`services/runtimes/connect/credentials.ts`): `credentialStore.put(COMPOSIO_CREDENTIAL_NAME, secret)` → reference only, never logged, then `bootstrapper.reload()`. `:provider ∈ {composio, nango}`.
3. **Agent tools are a capability domain**, `services/connectors/connector-capabilities.ts`, mirroring `services/marketplace-mcp/marketplace-capabilities.ts` — one definition projected onto both the in-session tool server and the external `/mcp` server by the capability registry. Attach is a consent point, so `connector.attach_account` is a **mutation with approval semantics** (no `readOnlyCarveOut`); reads carry `readOnlyCarveOut: true`.
4. **In-chat connect v1 is markdown.** `connector.start_connect` returns the auth URL + the custody sentence (from `custodyDisclosure`) in its tool result; the chat renders it as normal markdown. A custom connect card is an **explicit deferred enhancement** (see Non-Goals).
5. **Nango Proxy→MCP wrapper** (DOR-415): a DorkOS-hosted Streamable-HTTP MCP endpoint wrapping Nango's credentialed HTTP proxy; `NangoConnectorProvider` flips `exposesOverMcp: true` and `toolServerForAccount` returns `{ transport: 'http', url, headers }` pointing at it. Details §Detailed Design 4.
6. **Raw-MCP servers come from user config**: new `connectors.rawMcpServers` block in `UserConfigSchema` (semver-keyed migration per `adding-config-fields`). The provider registers at boot with whatever is configured — including the empty list, so the seam is live before anyone configures a server.
7. **Marketplace discovery plumbs `adapterType` through the browse DTO** so the client can badge/filter connectors specifically (`CONNECTOR_ADAPTER_TYPE` already exists in `packages/marketplace/src/manifest-schema.ts:199`).
8. **Client surface is a top-level `/connections` route** (control-panel surface, like `/workspaces`), not a settings sub-pane: connecting services is a first-class operator activity, and the session attach affordance deep-links to it.
9. **DOR-415 nits, all three:** `normalizeStatus` defaults unknown statuses to `ERROR` (unknown-terminal must not read as in-flight; `PENDING` becomes an explicit case); `end_user.id` gets a unique id (`crypto.randomUUID()`), label stays `display_name` only; `NANGO_BASE_URL` gains a `.url()` refinement so a malformed address fails at boot.

## Goals

- **G1** — Pasting a Composio key in the UI (or via `PUT …/credential`) registers the Composio provider live; deleting the key unregisters it. Same seam for the Nango secret key. No restart.
- **G2** — `RawMcpConnectorProvider` registered at boot from `connectors.rawMcpServers` config.
- **G3** — An agent can list toolkits, get a routed recommendation, start/poll a connect flow (auth URL + custody sentence in the result), list accounts, and attach/detach an account to its session — via DorkOS MCP tools on both the in-session and external surfaces.
- **G4** — Nango accounts expose tools: `exposesOverMcp: true`, conformance suite runs the true branch, DOR-415's three nits fixed.
- **G5** — A `/connections` route: provider setup, service-first grid ("Connect" on Gmail/Slack/…, never "Composio" first), OAuth flow, accounts list with per-account custody line + disconnect, visible multi-account; session view attach/detach.
- **G6** — Marketplace UI badges/filters `adapterType: 'connector'`; site features catalog gains an alpha-labeled Connections entry; the false Marketplace bullet is made true.
- **G7** — `docs/connectors/*.mdx` describe only what ships.
- **G8** — Playwright proves save key → toolkits listed → connect → account appears → attach → session shows connector tools, against a test-mode connector provider.

## Non-Goals

- **No custom in-chat connect card** — v1 is markdown in the tool result. The card (rich OAuth affordance in the transcript) is a named deferred enhancement.
- **No real-provider CI**; Composio/Nango stay mock-verified in CI (gateway spec D5). Copy stays alpha-labeled per the demo-claim gate (`meta/positioning-202607/09-gtm-plan.md` §2.0).
- **No multi-user Composio `user_id` scoping** (gateway OQ1 stands).
- **No per-API tool catalogs over the Nango proxy** — v1 is one honest generic request tool per account (see OQ2).
- **No new connect-flow persistence** — in-flight flows remain process-scoped (`routes/connectors.ts` map), as the gateway spec accepted.

## Technical Dependencies

All internal, all shipped: `services/connectors/*` (registry, routing, custody-disclosure, session-exposure, providers), `services/core/credential-provider.ts`, `services/core/capabilities/*` + `services/core/mcp-server.ts`, `services/runtimes/claude-code/mcp-tools/index.ts` (`createDorkOsToolServer`), `@dorkos/shared/connector-provider`, `@dorkos/test-utils` (`FakeConnectorProvider`, `connectorConformance`), `packages/marketplace` (`CONNECTOR_ADAPTER_TYPE`), client FSD layers + TanStack Query/Router, `apps/e2e` (test-mode server, `DORKOS_TEST_RUNTIME`).

## Detailed Design

### 1. Credential write path + live provider lifecycle (gaps 1–2)

**`ConnectorProviderBootstrapper`** — new `apps/server/src/services/connectors/bootstrap.ts`:

```typescript
/** Owns connector-provider construction, registration, and live reload. */
export class ConnectorProviderBootstrapper {
  constructor(opts: {
    registry: ConnectorRegistry;
    credentials: CredentialProvider;
    /** Env-derived Nango settings (base URL, encryption key) re-read per reload. */
    nangoEnv: () => { baseUrl?: string; encryptionKey?: string };
    /** Raw-MCP descriptors from user config. */
    rawMcpServers: () => RawMcpServerDescriptor[];
  });
  /** Boot: raw-MCP always; Composio/Nango when configured (same semantics as today's index.ts block, moved here). */
  registerBootProviders(): Promise<void>;
  /** Re-run one provider's maybeCreate* and swap the registration atomically. Returns the new status. */
  reload(provider: 'composio' | 'nango'): Promise<ConnectorProviderStatus>;
}
```

- `ConnectorRegistry` gains `unregister(type: string): void` (removes the provider; account bindings in `connected_accounts` survive — `providerForAccount` already tolerates a missing provider and the routes degrade with warnings).
- `index.ts:1051-1090`'s inline block is **replaced** by `bootstrapper.registerBootProviders()` (no tolerated legacy path). The `NangoEncryptionKeyError` log-and-skip behavior moves into the bootstrapper.
- **Raw-MCP at boot:** `new RawMcpConnectorProvider({ servers: rawMcpServers() })`, always registered (empty list is valid). Config: `connectors.rawMcpServers: Array<{ slug, displayName, url, transport: 'http' | 'sse' }>` added to `UserConfigSchema` with default `[]`, semver-keyed `conf` migration per the `adding-config-fields` skill. Config edits take effect on next boot (v1; see OQ3).

**Provider credential routes** — new `apps/server/src/routes/connector-providers.ts`, mounted under `/api/connectors/providers` **before** the existing connectors router in `index.ts`:

- `GET /api/connectors/providers` → `{ providers: ConnectorProviderStatus[] }` where `ConnectorProviderStatus = { type, configured, registered, custody, disclosure, error? }` (new Zod schema in `@dorkos/shared/connector-provider`). `error` carries e.g. the Nango encryption-key refusal message so the UI can show _why_ a configured provider is not registered. Never carries a secret or reference value.
- `PUT /api/connectors/providers/:provider/credential`, body `{ secret: string }` (Zod, non-empty; Express 5: default `req.body ?? {}`). Writes `credentialStore.put(COMPOSIO_CREDENTIAL_NAME | NANGO_CREDENTIAL_NAME, secret)`, then `bootstrapper.reload(provider)`, returns the new status. 400 unknown provider / empty secret.
- `DELETE /api/connectors/providers/:provider/credential` → `credentialStore.delete(name)` (verify exact `CredentialStore` deletion API at EXECUTE; add one if absent), `reload`, 200 with status. Idempotent.

Secrets follow the DOR-280 funnel exactly: encrypted at rest via `EncryptedFileCredentialStore`, reference-only beyond the store, never logged.

### 2. Agent-facing MCP tools (gap 4)

New capability domain `apps/server/src/services/connectors/connector-capabilities.ts`, composed into the boot registry (`services/core/self-description/dorkos-registry.ts`) exactly as the marketplace domain is; a `ConnectorCapabilityDeps` bundle (`registry`, `sessionConnectorService`, `relay` catalog, `bootstrapper`) joins `CapabilityDeps` via module augmentation. Tools (thin wrappers over shipped services):

| Capability                 | Wraps                                             | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| -------------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `connector.list_toolkits`  | `registry.listToolkits()`                         | read-only                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `connector.recommend`      | `recommendConnector(service, …)`                  | read-only; input `{ service }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `connector.start_connect`  | routing + `provider.startConnect`                 | input `{ service, label?, provider? }`; when `provider` omitted, picks the top `gateway`/`raw-mcp` recommendation. **Result text = markdown**: the auth URL + the custody disclosure (`custodyDisclosure(...)`) + "tell me when you've signed in, then I'll check." Registers the flow→provider binding via the same mechanism the REST route uses (share the flow-binding map by extracting it into a small `services/connectors/flow-bindings.ts` used by both route and capability — do not duplicate state). |
| `connector.poll_connect`   | `provider.pollConnect` + `registry.recordConnect` | input `{ flowId }`; on `connected` returns the account (public shape, `provider` stripped)                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `connector.list_accounts`  | `registry.listAccounts`                           | read-only; strips `provider`; includes per-account disclosure line                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `connector.attach_account` | `sessionConnectorService.attach`                  | input `{ accountId, sessionId? }`; in-session invocations default to the invoking session id; external `/mcp` callers must pass `sessionId`. **Approval-gated mutation** — attaching is the consent binding, so it goes through the tier gate like `marketplace.uninstall` does. Result echoes the custody disclosure + exposure state (null-branch warning surfaced, never thrown).                                                                                                                             |
| `connector.detach_account` | `sessionConnectorService.detach`                  | input `{ accountId, sessionId? }`; idempotent                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

The in-session projection makes "connect my Gmail" work: recommend → start_connect (markdown URL + custody sentence) → poll → attach (human approves) → tools appear on the next turn via the existing `setMcpServerFactory` closure (`index.ts:1109-1128`), which already injects `sessionConnectorService.mcpServersForSession(...)`.

### 3. Sequenced with §2 — REST stays canonical

The capabilities never bypass the routes' invariants (public account shape, flow binding, `recordConnect`); shared logic that both need (flow bindings, public-account mapping) is extracted to `services/connectors/` helpers rather than duplicated.

### 4. Nango Proxy→MCP wrapper + nits (gap 5, DOR-415)

**Wrapper.** New `apps/server/src/services/connectors/providers/nango-proxy-mcp.ts` + route mount `POST/GET /api/connectors/nango/mcp/:accountId` (Streamable HTTP, stateless per request — same shape as the `/mcp` mount in `index.ts`):

- Builds a fresh `McpServer` per request exposing **one generic tool per account**: `proxy_request` — input `{ method, path, query?, body?, headers? }` — forwarded to Nango's credentialed proxy (`{NANGO_BASE_URL}/proxy/{path}` with `Provider-Config-Key: <integration>` + `Connection-Id: <connectionId>` headers, secret key as bearer). Tool description names the service + label honestly ("Send an authenticated HTTP request to gmail (work) through your self-hosted Nango"). Responses are truncated/size-capped; secrets never echoed.
- **Auth:** a per-account opaque bearer token minted in memory by the wrapper when `toolServerForAccount` is called; the returned `McpAppServerConnection` is `{ transport: 'http', url: 'http://127.0.0.1:{DORKOS_PORT}/api/connectors/nango/mcp/{accountId}', headers: { authorization: 'Bearer <token>' } }`. Tokens are process-scoped (same liveness as connect flows) and never persisted. The endpoint 401s without a matching token, so browser/other callers cannot ride it.
- `NangoConnectorProvider` flips `exposesOverMcp: true`; `toolServerForAccount` resolves the account (must be `active`, else `null` — the documented null branch) and returns the wrapper connection. The conformance run in `providers/__tests__/nango.test.ts` moves to the `exposesOverMcp: true` branch.
- The Nango proxy endpoint shapes are marked `ASSUMPTION (live-unverified)` like the rest of `nango-client.ts`; docs stay alpha-labeled.

**Nits (all in this slice):**

- `nango-client.ts` `normalizeStatus`: `PENDING` becomes an explicit case; the `default` branch returns `ERROR` (an unknown status must not read as still-in-flight — a poller would spin forever on an unrecognized terminal state).
- `nango-client.ts` `initiateConnection`: `end_user: { id: crypto.randomUUID(), display_name: label }` — duplicate labels no longer collide on `end_user.id`. Label resolution in `toDomainConnection` keeps preferring `display_name`.
- `apps/server/src/env.ts:243`: `NANGO_BASE_URL: z.string().url().optional()` — malformed address fails at boot with a Zod message.

### 5. Client `/connections` surface (gap 6)

Read `.claude/skills/designing-frontend/SKILL.md` (Calm Tech) and `contributing/design-system.md` before building. FSD placement (barrel imports only, `shared ← entities ← features ← widgets`):

- **`layers/entities/connectors/`** — TanStack Query hooks + types: `useConnectorProviders`, `useToolkits`, `useAccounts`, `useRecommendation(service)`, `useConnectFlow` (mutation + poll), `useSessionConnectors(sessionId)`, mutations for attach/detach/disconnect/credential-save. All server I/O goes through **new `Transport` methods** (`packages/shared/src/transport.ts`): `getConnectorProviders`, `putConnectorCredential`, `deleteConnectorCredential`, `getConnectorToolkits`, `getConnectorRecommendation`, `startConnectorFlow`, `pollConnectorFlow`, `getConnectorAccounts`, `disconnectConnectorAccount`, `getSessionConnectors`, `attachSessionConnector`, `detachSessionConnector` — implemented in `HttpTransport`; `DirectTransport` (Obsidian) implements honestly against the same services or returns empty-with-notice where the surface is unavailable (decide at EXECUTE; interface compliance is required either way).
- **`layers/features/connections/`** — the working parts:
  - **Provider setup**: card per provider from `GET /providers` — Composio key entry (password input → `PUT credential`), status (configured/registered/error — the Nango encryption-key refusal renders here verbatim), custody stance line. Key delete with confirm.
  - **Service grid**: toolkits aggregated across providers, **service-first** — the user sees Gmail/Slack/Linear/Notion tiles with one verb, "Connect". Provider choice is invisible: the tile's connect uses `recommendConnector` routing (a relay-adapter recommendation deep-links to the relay surface instead). Empty state when no provider is configured points at provider setup.
  - **Connect flow**: click Connect → optional label field (pre-filled `personal` when a first account of that toolkit exists — multi-account made visible) → custody disclosure shown **before** opening the auth URL (new tab) → poll `flows/:flowId` with TanStack Query polling until `connected`/`failed` → account appears.
  - **Accounts list**: each row = service icon, label ("Gmail (work)"), status, **its own plain-language custody sentence** (from the API — the client never composes disclosure copy), disconnect with confirm.
- **`/connections` route** in `apps/client/src/router.tsx` (code-based, sibling of `/workspaces`), page composes the feature; add to the app nav.
- **Session attach affordance**: in the session view, a compact "Connectors" popover/section (near the session's tool/status surface — exact placement per Calm Tech: quiet until relevant): lists attached accounts with status + null-branch warnings (`GET /api/sessions/:id/connectors`), attach from connected accounts, detach, link to `/connections`. Attach re-shows the custody disclosure (the API result carries it).
- Follow `styling-with-tailwind-shadcn` (new-york, neutral); evaluate Dev Playground candidacy for the grid/row components per `maintaining-dev-playground`.

### 6. Discovery (gap 7)

- **Marketplace client**: plumb `adapterType` from the package manifest through the browse/search DTO (`packages/marketplace` scanner/entry types → `packages/shared` marketplace schemas → server marketplace service → client; verify the exact hop points at EXECUTE — today the client sees only `type: 'adapter'`). `PackageTypeBadge` renders `CONNECTOR` (distinct color) when `adapterType === CONNECTOR_ADAPTER_TYPE`; `MarketplaceSidebar` gains a "Connectors" filter entry that filters adapters by `adapterType`.
- **Site features catalog** (`apps/site/src/layers/features/marketing/lib/features.ts`): new entry `slug: 'connections'`, `category: 'integration'`, **`status: 'alpha'`** (demo-claim gate — built, not user-verified), describing the user outcome ("Connect Gmail or Slack once, then let your agents act for you — you always see where your sign-in lives"), no "works" claims.
- **Fix the false bullet** (`features.ts:666`): "Browse agents, plugins, skills, and connectors" becomes true only when the badge/filter task above ships in the same release; otherwise the task drops "connectors" from the bullet. Ship order inside Slice C makes it true — the task's acceptance criteria require whichever is accurate at merge time.

### 7. Docs truthing (gap 8)

Rewrite `docs/connectors/index.mdx`, `composio.mdx`, `nango.mdx`, `raw-mcp.mdx` per `writing-for-humans` to match what ships: the `/connections` screen steps (paste key → Connect on a service → sign in → account with custody line → attach to a session) and the in-chat path ("ask your agent to connect a service; it replies with a sign-in link"). Keep the ADR's canonical custody sentence verbatim. Keep the alpha `Callout`. Nango doc gains the proxy-tool explanation ("your agent gets one tool that can call the service's API through your Nango") + the unchanged `NANGO_ENCRYPTION_KEY` mandate. Raw-MCP doc documents the `connectors.rawMcpServers` config block.

### 8. E2E (gap 9)

- **Test-mode connector provider**: `apps/server/src/services/connectors/providers/test-mode.ts` — an in-server provider (dynamic-imported and registered only when `env.DORKOS_TEST_RUNTIME` is set, exactly like `TestModeRuntime` at `index.ts:537`) with scripted toolkits (gmail, slack), instant-success connect flows (auth URL points at a local no-op page), multi-account, and a `toolServerForAccount` that returns a real (stub) HTTP MCP connection so attached tools are visible to the test-mode runtime surface. It must pass `connectorConformance`. It also honors the credential gate: registered only after a key is saved for provider type `test-connector` **(decision: gate on the same credential route with provider `test-connector` in test mode so the e2e can exercise the save-key step end to end)**.
- **Playwright** (`apps/e2e/tests/connections/`): read `.claude/skills/browser-testing/SKILL.md` + `apps/e2e/GOTCHAS.md` first. Flow spec: open `/connections` → provider shows unconfigured → save key → toolkits grid appears → Connect Gmail (label "work") → custody sentence visible before auth → flow completes → "Gmail (work)" row with custody line → attach to a session → session connector surface lists it → second connect ("personal") shows both. Plus a marketplace spec asserting the connector badge/filter (Slice C).

### Code structure & file organization

| Path                                                                                                      | Change                                                              |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `apps/server/src/services/connectors/bootstrap.ts` (+ tests)                                              | **new** — bootstrapper                                              |
| `apps/server/src/services/connectors/registry.ts`                                                         | edit — `unregister`                                                 |
| `apps/server/src/routes/connector-providers.ts` (+ tests)                                                 | **new** — credential/status routes                                  |
| `apps/server/src/services/connectors/connector-capabilities.ts` (+ tests)                                 | **new** — agent tools                                               |
| `apps/server/src/services/connectors/flow-bindings.ts`                                                    | **new** — shared flow→provider map                                  |
| `apps/server/src/services/connectors/providers/nango-proxy-mcp.ts` (+ tests)                              | **new** — DOR-415 wrapper                                           |
| `apps/server/src/services/connectors/providers/{nango,nango-client}.ts`, `apps/server/src/env.ts`         | edit — `exposesOverMcp`, nits                                       |
| `apps/server/src/services/connectors/providers/test-mode.ts`                                              | **new** — e2e provider                                              |
| `apps/server/src/index.ts`                                                                                | edit — bootstrapper call, mounts, capability composition            |
| `packages/shared/src/{connector-provider,transport,config-schema}.ts`                                     | edit — status schema, Transport methods, `connectors.rawMcpServers` |
| `apps/client/src/layers/entities/connectors/`, `layers/features/connections/`, `router.tsx`, session view | **new/edit** — UI                                                   |
| `apps/client/.../Marketplace{Sidebar,…}.tsx`, `PackageTypeBadge.tsx`, marketplace DTO hops                | edit — discovery                                                    |
| `apps/site/.../features.ts`                                                                               | edit — catalog entry + bullet                                       |
| `docs/connectors/*.mdx`                                                                                   | rewrite                                                             |
| `apps/e2e/tests/connections/`                                                                             | **new**                                                             |
| `changelog/unreleased/<id>-*.md`                                                                          | one fragment per PR                                                 |

### API changes

New: `GET /api/connectors/providers`, `PUT|DELETE /api/connectors/providers/:provider/credential`, `POST|GET /api/connectors/nango/mcp/:accountId` (MCP, bearer-gated). New capabilities (7, table above) on both MCP surfaces. OpenAPI regenerated; new Zod schemas exported from `@dorkos/shared`. Existing 9 REST routes unchanged.

## Data model changes

`connectors.rawMcpServers` in user config (Zod default `[]`, `conf` semver migration). No DB schema change (`connected_accounts` unchanged).

## User Experience

Provider setup is the only place a vendor name leads; everywhere else the user sees **services**. Custody is disclosed before every connect, on every account row, and again at attach — copy always from the server's `custody-disclosure` module. Errors are honest and actionable (the Nango encryption-key refusal renders verbatim). In chat, connect is plain markdown from the tool result. Everything works on mobile/tablet/desktop.

## Testing Strategy

- **Units** (all `pnpm vitest run <path>`): bootstrapper (boot registration incl. raw-MCP; reload registers on key-save, unregisters on delete, preserves Nango refusal semantics); credential routes with a fake store + registry (secret never in any response/log; Express-5 empty-body 400s); capability handlers against `FakeConnectorProvider` + a fake `SessionConnectorService` (start_connect result contains auth URL + exact disclosure copy; attach defaults to invoking session in-session, requires `sessionId` externally; approval semantics asserted); nango-proxy-mcp (proxy call shape, bearer 401, size cap, no secret echo); nango nits (unknown status → `ERROR`; distinct `end_user.id` for duplicate labels; malformed `NANGO_BASE_URL` fails env parse); Nango conformance on the `exposesOverMcp: true` branch; test-mode provider passes `connectorConformance`.
- **Client**: RTL + mock `Transport` for entities hooks and the connect-flow state machine (disclosure-before-URL ordering asserted); badge/filter tests for marketplace.
- **E2E**: the Playwright flow of §8, in CI's test-mode server.
- **Full loop**: `pnpm verify` per PR; changelog fragment per PR.

## Security Considerations

Reference-not-secret is unchanged and now has a write path: secrets enter only via the credential routes, land only in `EncryptedFileCredentialStore`, and are never returned, logged, or shipped to the client (status DTO carries booleans + disclosure text only). The Nango proxy endpoint is bearer-gated per account with process-scoped tokens; `McpAppServerConnection` details still never reach the browser. Agent attach is approval-gated — an agent cannot silently grant itself a user's account. Custody disclosure copy remains server-owned so no surface can drift from the ADR sentence.

## Documentation

§7 above; plus `contributing/` touch-ups if the bootstrapper changes the adding-a-connector checklist (verify `contributing/adding-a-connector.md` exists/needs edit at EXECUTE). Demo-claim gate: all user-facing copy stays alpha-labeled until the e2e-verified claim ladder allows more.

## Implementation slices (see 03-tasks.json)

**A — server truth** (gaps 1–5, 8): bootstrapper + registry.unregister; credential routes; raw-MCP config + boot registration; capabilities; Nango wrapper + nits; docs rewrite (docs task lands last in A, after B's UI copy is stable — acceptance ties it to shipped behavior).
**B — client surfaces** (gap 6): Transport methods; entities; `/connections` feature + route; session attach.
**C — discovery** (gap 7): adapterType plumb + badge/filter; site catalog + bullet fix.
**E — e2e** (gap 9): test-mode provider; Playwright flows.
A is prerequisite for B/E; C is independent of B; E depends on A + B.

## Open Questions (with recommendations)

- **OQ1 — `DELETE` credential API surface.** `CredentialStore` deletion method name/behavior unverified. _Recommendation:_ add `delete(name)` to the store if absent; treat missing-key delete as idempotent success.
- **OQ2 — richer Nango tool surface.** One generic `proxy_request` tool is honest but low-level. _Recommendation:_ ship generic v1; revisit per-service tool catalogs after live verification (deferred, like the chat card).
- **OQ3 — raw-MCP config live-reload.** v1 reads `connectors.rawMcpServers` at boot only. _Recommendation:_ accept boot-only for v1 (config edits are rare, file-driven); note a follow-up if the UI later edits this block.
- **OQ4 — DirectTransport (Obsidian) coverage.** Full parity vs. honest empty-state. _Recommendation:_ implement read surfaces; return a clear "open the web cockpit to manage connections" notice for credential writes if wiring cost is high — never a silent failure. Decide at EXECUTE; Obsidian is a staged, unverified surface either way.
- **OQ5 — external-MCP attach ergonomics.** Requiring `sessionId` externally is safe but clunky. _Recommendation:_ keep it; external callers are automation, not chat.

## References

`specs/connector-gateway/02-specification.md`; ADR `260718-045630`; source (verified 2026-07-29): `apps/server/src/index.ts:1051-1128`, `services/connectors/{index,registry,routing,custody-disclosure,session-exposure}.ts`, `providers/{composio,composio-client,nango,nango-client,raw-mcp}.ts`, `routes/{connectors,session-connectors,runtimes}.ts`, `services/runtimes/connect/credentials.ts`, `services/core/{credential-provider,mcp-server}.ts`, `services/marketplace-mcp/marketplace-capabilities.ts`, `packages/marketplace/src/manifest-schema.ts:186-211`, `apps/client/src/router.tsx`, `apps/client/.../Marketplace{Sidebar,PackageTypeBadge}.tsx`, `apps/site/.../features.ts:655-680`, `docs/connectors/*.mdx`, `apps/e2e/`.
