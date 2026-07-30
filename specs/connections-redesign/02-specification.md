---
slug: connections-redesign
id: 260729-234751
created: 2026-07-29
status: specified
---

# Connections redesign — the catalog becomes the page

**Status:** Draft (frozen for DECOMPOSE)
**Author:** spec-redesign (connections-redesign program)
**Date:** 2026-07-29
**Basis:** design critique `connections-ux-critique.md` (P2, P3, P4, P6 + the import beat), source read 2026-07-29, `specs/connector-completion/02-specification.md` (implemented), PR #617 (`dd7647cb9`).
**Dependency (parallel):** `specs/direct-connect` owns real OAuth for direct connections, the `direct` custody class, and the preconfigured endpoint catalog. This spec reads custody from one server field, so it needs nothing from that spec to ship (see §Technical Dependencies, stated ordering).

## Overview

`/connections` leads with two empty panels and buries its only control beneath them. This spec inverts it: **one curated service catalog, populated on a fresh install, is the page.** Every tile carries a real brand mark where one exists, one plain sentence about what an agent will be able to do, a custody chip that is always true, and a capability facet. Connected accounts render as a compact list that appears only when it has content. Provider (engine) setup leaves the top level for a collapsed **Advanced** disclosure, and the copy inside it names Composio plainly, one beat before the vendor's consent screen does. The page gains a chat cross-link, the session readout stops being silent about connectors, DorkBot learns to volunteer the capability, one tap after a successful connect opens a session with the account attached and the composer prefilled, and accounts that already exist inside a person's Composio project can be brought in with custody disclosed.

## Background

Read `01-ideation.md`. In short: the page's default and permanent state for anyone without a working key is an empty box that blames the reader for not adding the key they just added; the first decision it asks for (Composio or Nango) is one no persona can make; Nango's card asserts infrastructure the reader does not have; the topbar reads "Dashboard"; the only control sits below the mobile fold; and the in-chat path — which needs zero navigation and is the real primary journey — has no discovery at all. PR #617 fixed the underlying honesty (failures propagate, `registered` means a live probe passed, errors are verbatim). Everything left is shape, copy, and discovery.

## Decisions

**D1 — Two sections, at most, and the second one is always populated.** Order: `Your accounts` (rendered **only** when at least one account exists) → `Services` (the catalog, always populated) → `Advanced` (collapsed). On a fresh install the page therefore opens directly on fourteen actionable tiles. Providers never appear at the top level again.

**D2 — The catalog is curated client data; live server data decorates it.** `layers/features/connections/config/service-catalog.ts` holds one entry per known service: `slug`, `displayName`, `capabilityLine` (one plain sentence), `facet`, `route` (`'engine' | 'relay'`), and an optional `mark`. Provider-discovered toolkits that are **not** in the catalog render in a secondary, collapsed `More services (N)` list — name plus `Connect`, no facet, no claims. Nothing is hidden and nothing is invented.

**This catalog is display metadata only.** It carries names, marks, plain sentences and facets for recognition; it carries **no endpoint, no vendor URL, and no auth configuration**, and connecting still routes entirely through the shipped `recommendConnector` / provider machinery. It is therefore outside the counsel gate that `specs/direct-connect` decision 6 puts on its **preconfigured endpoint catalog** (that gate covers shipping vendor MCP endpoint URLs as working defaults, flag-off until cleared). If counsel later restricts brand marks specifically, this catalog degrades to the fallback glyph with no functional change (OQ5).

**D3 — The custody chip is always true or names no vendor,** and it is exhaustive over `ConnectorCustody`. One source, one switch:

| Chip             | Renders iff                                                      | Accessible definition                                                      |
| ---------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `via Composio`   | `custody === 'managed'`                                          | Composio holds this sign-in in its own secure vault, not on your computer. |
| `Self-hosted`    | `custody === 'self-host'`                                        | Your own Nango server holds this sign-in.                                  |
| `Direct`         | `custody === 'external'`                                         | You connect straight to the service. No other company holds this sign-in.  |
| `Direct`         | `custody === 'direct'` (enum member arrives with direct-connect) | You sign in to the service, and the key stays on your machine.             |
| `DorkOS adapter` | catalog entry has `route: 'relay'` (e.g. Slack)                  | Slack runs through DorkOS's own Slack adapter.                             |
| `Needs setup`    | no live route lists the service at all                           | Nothing can connect this yet. Click Connect to see what it needs.          |

`external` and `direct` share the `Direct` chip because both are true "no middle party" custody, and each keeps its own exact sentence so neither overclaims. `Needs setup` names no vendor, so it cannot be wrong. Full custody sentences at the consent points remain the server's, unchanged.

**D4 — Truth for the chip comes from one server field, never from inference or a second list.** `ConnectorToolkitSchema` gains `custody: ConnectorCustody`, set during registry aggregation from the yielding provider's capabilities and deduped by the existing managed-over-self-host precedence. The client reads only that field: **there is no client-side direct-slug list**, so `Direct` renders if and only if the server said `external` or `direct`. `lib/custody-chip.ts` switches over `ConnectorCustody` with a `never`-typed fallthrough guard mirroring `assertUnreachableCustody` (`custody-disclosure.ts:114`), so widening the enum is a compile error here until the chip handles it. This spec owns the DTO change (~30 lines).

**D5 — One `Connect` verb, never disabled, never a dead end.** A tile whose service has no live route still has an enabled `Connect`; the dialog's new first step is the guided engine setup (D8). This is the critique's "engine setup appears inside the first long-tail connect".

**D6 — Capability facets adopt Claude's directory vocabulary,** curated per service from the vendor's documented tool scope at authoring time, and **omitted when unknown** — never guessed:

| Facet          | Definition shown on hover/focus                                    |
| -------------- | ------------------------------------------------------------------ |
| `Read-only`    | Your agent can look, and never change anything.                    |
| `Read & write` | Your agent can look and make changes.                              |
| `Interactive`  | Your agent can act where other people see it: send, post or reply. |

**D7 — A rejected engine key is a page-level notice, not an Advanced-only detail.** When any provider reports `configured && !registered`, a notice sits above the catalog with the vendor's verbatim error and a button that expands Advanced and focuses that provider's key field.

**D8 — Engine setup discloses Composio before the vendor does,** and walks the person to the right key. The pre-configuration lead line is client copy (conditional, honest); the post-configuration custody sentence stays the server's. No pricing numbers anywhere; one link out.

**D9 — Import owns its own thin server surface.** `ConnectorProvider` gains an **optional** `listImportableAccounts?()`, plus `GET /api/connectors/accounts/importable` and `POST /api/connectors/accounts/:accountId/adopt`. Optional keeps `connectorConformance` unchanged and leaves raw-MCP untouched. `specs/direct-connect` owns nothing here: a direct connection is always minted by DorkOS, so it has no pre-existing provider-side inventory.

**D10 — Try-it-now is one chip, one visible prompt, no hidden text.** The prompt is shown verbatim before it is sent, comes from a curated per-service map, and is selected by `recommendForRoles(config.profile.roles)`. When a service has no curated prompt, the affordance is absent.

**D11 — One animation, gated, and reduced motion keeps the feedback.** The newly connected account row does a single 160ms fade-and-rise. Under `prefers-reduced-motion` there is no motion and the row instead carries a `Just connected` chip until the next interaction. The animation is suppressed whenever a D7 notice is on screen — nothing celebrates during an incident.

## Goals

- **G1** — On a fresh install with no key, `/connections` shows a populated catalog of known services, each with a true custody chip, and every tile's `Connect` leads somewhere useful. Zero empty panels above the fold on desktop **and** at 390px.
- **G2** — The topbar reads "Connections" on `/connections` (and "Workspaces" on `/workspaces`, the same hole).
- **G3** — Every surface here has a specified and tested loading, empty, error, and provider-degraded state, including the `configured && !registered` state PR #617 made expressible.
- **G4** — A person reading engine setup learns, before clicking anything: that the sign-in page will say Composio, where the sign-in then lives, which key to copy, and which key will be rejected.
- **G5** — A person who never opens `/connections` can still discover connections: from their agent, from the session readout they opened on purpose, and from one dashboard card whose words do not collide with the Slack/Telegram notification card.
- **G6** — After a successful connect, one tap opens a session with that account attached and a role-aware prompt in the composer.
- **G7** — Accounts that already exist in a person's Composio project can be listed, brought in with custody disclosed, and honestly reported when their tools cannot be reached.
- **G8** — No pricing number, no unverified capability count, and no claim that an unverified surface works, anywhere in this spec's copy.

## Non-Goals

- **No OAuth work.** Real direct connections, the direct catalog, CIMD/DCR, and the `raw-mcp.ts` fabricated-success fix are `specs/direct-connect`.
- **No attachment durability, and therefore no "attach to new sessions by default"** (critique P5): attachments are process-scoped, so that promise stays unmade.
- **No tool counts** ("23 tools") and no per-toolkit fetch to compute one.
- **No hero header.** The existing plain header is correct; this is a control panel.
- **No new user-editable catalog config.** `connectors.rawMcpServers` stays boot-read-only and documented in Advanced.

## Technical Dependencies

All shipped: `layers/features/connections/*`, `layers/entities/connectors/*` (12 Transport methods, query keys, connect-flow store), `@dorkos/shared/connector-provider`, `@dorkos/shared/profile-recommendations` (`recommendForRoles`), `entities/config` (`useConfig` → `config.profile.roles`), `features/top-nav` (`PageHeader`), `features/feature-promos` (`PROMO_REGISTRY`, `usePromoContext`), `features/status` (`SessionInspector`), `services/connectors/{registry,routing,custody-disclosure,connector-capabilities}.ts`, `@dorkos/icons`, `apps/e2e/tests/connections/`.

**Stated cross-spec ordering (not an open question).** This spec ships against today's `ConnectorCustody` enum: `managed | self-host | external`. The `direct` member, and the provider that sets it, land with `specs/direct-connect` **D1.5**; the chip's `direct` branch and its sentence are written here now and become reachable then, guarded by the D4 `never` check so the enum cannot widen without this file being updated. Until that lands, **zero `Direct` chips from `direct` is the normal, tested state** (`external` still renders `Direct` today via the raw-MCP baseline). Neither spec blocks the other, in either order.

## Detailed Design

Read `.claude/skills/designing-frontend/SKILL.md` and `contributing/design-system.md` before building; all copy goes through `writing-for-humans` (no em dashes). Design tokens only — no hardcoded colors, no inline styles, no hand-sorted classes.

### 1. Page structure

```
Connections                                     ← PageHeader title (G2)
Link your accounts once, then attach them to sessions so your agents can act for you.
Or just ask your agent: "Connect my Gmail."  [Ask your agent]      ← §6

[!] Your Composio key isn't working. <verbatim error>   [Fix it]    ← D7, conditional

Your accounts                                    ← only when non-empty
  <AccountsList, as shipped: custody sentence + status + Disconnect>

Services
  [tile] [tile] [tile] [tile]                    ← 2 cols @sm, 3 @md, 4 @lg
  ...
  ▸ More services (137)                          ← provider-discovered, collapsed

▸ Advanced
    Connection engine     ← Composio + Nango cards (today's ProviderSetup, recopied)
    Accounts already in Composio (3)   ← §5, only when found
    Your own MCP servers  ← one paragraph pointing at connectors.rawMcpServers
```

Mobile (390px): single column, `Your accounts` collapses to the same rows, tiles are full-width, and `Advanced` stays collapsed — so the first interactive element is a tile's `Connect` **above** the fold. Verified in the browser at 390×844 as an acceptance criterion, not asserted in jsdom (jsdom reports every element as 0×0).

### 2. The tile

`ServiceTile` (rewritten, same file): mark or fallback glyph (`size-6`) · name (`text-sm font-medium`) · `capabilityLine` (`text-xs text-muted-foreground`, two-line clamp) · chip row (custody chip, then facet chip; `Badge` with an accessible name carrying the D6 definition) · action row.

| Tile state                    | Action                                   | Extra                                                     |
| ----------------------------- | ---------------------------------------- | --------------------------------------------------------- |
| No live route (`Needs setup`) | `Connect` → dialog opens on engine setup | —                                                         |
| Live route, no account        | `Connect` → dialog as shipped            | —                                                         |
| ≥1 account                    | `Connect another` (`variant="ghost"`)    | `Connected` chip + count; rows live in `Your accounts`    |
| `route: 'relay'` (Slack)      | `Connect` → dialog's relay branch        | Chip `DorkOS adapter`                                     |
| Account `expired` / `revoked` | `Reconnect` (`variant="secondary"`)      | Status reads from the account row, which keeps the detail |

### 3. States, every surface

| Surface                  | Loading                                                                                       | Empty                      | Error                                                                                                                                    | Degraded                                                         |
| ------------------------ | --------------------------------------------------------------------------------------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Catalog                  | Tiles render **immediately** (local data); only the chip row and the connected state skeleton | Impossible by construction | `role="alert"` above the grid: "DorkOS could not check which services are ready right now." + verbatim + `Try again`. Tiles stay usable. | Per-warning line under the grid, verbatim, as shipped            |
| `More services`          | Skeleton list inside the disclosure                                                           | Section not rendered       | Folded into the catalog's error                                                                                                          | Same warnings, not duplicated                                    |
| `Your accounts`          | Two skeleton rows                                                                             | Section not rendered       | `role="alert"`, verbatim, as shipped                                                                                                     | Verbatim per-provider line, as shipped                           |
| Engine card              | Nothing (status is one cheap read)                                                            | `Not set up` + key form    | `Key not working` badge + verbatim error (renamed from `Not running`)                                                                    | Self-host refusal (e.g. missing `NANGO_ENCRYPTION_KEY`) verbatim |
| Import panel             | Skeleton rows                                                                                 | Not rendered               | Verbatim; "We could not read your Composio account list."                                                                                | Per-provider warnings verbatim                                   |
| Session connectors group | Nothing                                                                                       | **Speaks** (§6.3)          | Verbatim                                                                                                                                 | Existing per-account null-branch warnings                        |

### 4. Advanced: engine setup copy (P3)

Composio card, in reading order:

1. **"Composio"** (title) · badge: `Not set up` / `Ready` / `Key not working`.
2. Lead (client copy): "Composio is the service DorkOS uses to hold sign-ins for apps it cannot reach directly."
3. **The consent preview, the point of this whole section:** "When you connect an app this way, the sign-in page will say Composio, not DorkOS. That is expected. Composio is the party holding the connection."
4. The server's custody sentence, verbatim (unchanged, ADR `260718-045630`).
5. **Guided key retrieval:** "Open your Composio dashboard and go to API keys." (link out) → "Copy an API key — any kind works, including the account key the composio CLI uses." → "Paste it below." _(Amended 2026-07-30, DOR-736: live verification showed `uak_`user-account keys DO work — they authenticate via`x-user-api-key`; the server routes by key kind, so the earlier "the API will refuse it" warning was our client's bug, not a key problem.)\_
6. Key form (unchanged), then: "Composio has its own free and paid plans. See their pricing." (link out, **no numbers** — D4/G8).

Nango card: the shipped disclosure sentence is present-tense about a server the reader may not have. Rule: **when `configured === false` the card shows a client-owned conditional lead; when `configured === true` it shows the server's sentence.** Unconfigured lead: "Nango is a connection service you run yourself. If you have one, DorkOS can use it, and your sign-ins stay in your own database." Plus one honest note: "Free self-hosted Nango gives you sign-in and a proxy, not Nango's own tool server. DorkOS builds that part itself, so your agents still get a tool."

`Your own MCP servers`: one paragraph naming `connectors.rawMcpServers` in `~/.dork/config.json` and stating plainly that edits apply the next time the server starts.

### 5. Import accounts that already exist (the founder beat)

DorkOS reads Composio scoped to `user_id: 'dorkos-operator'`, so accounts a person connected in Composio's own dashboard are invisible. After a key save that registers, and on every load where any provider reports importable accounts:

- **Where:** an `Accounts already in Composio (N)` panel inside Advanced, plus a one-line pointer under the D7 notice slot when N > 0 and nothing is connected yet.
- **Each row:** service name, the provider-side label, status, and one `Bring it in` button. One custody line above the list: "These sign-ins stay where they are, in Composio's vault. DorkOS just starts using them."
- **Adoption:** `POST /api/connectors/accounts/:accountId/adopt` → `registry.recordConnect(account)` → immediately probe `provider.toolServerForAccount(accountId)` → respond `{ account, toolsReachable, error? }`.
  - `toolsReachable: true` → the row moves into `Your accounts` (D11 animation applies).
  - `toolsReachable: false` → the row reads: "DorkOS brought this in, but could not reach its tools. \<verbatim\>. Connect it again through DorkOS instead." with a `Connect` button that starts a normal flow for that service.
- **Server:** optional port method `listImportableAccounts?(): Promise<ConnectedAccount[]>` (Composio: `GET /connected_accounts` **without** the `user_ids` filter; Nango: environment connections), and `GET /api/connectors/accounts/importable` → `{ accounts: PublicConnectedAccount[], warnings }` with anything already bound in `connected_accounts` filtered out. Aggregation degrades per provider like everything else (ADR-0310). `test-mode` implements the method so e2e can drive it.

### 6. Chat as the front door (P4)

1. **Fix the wrong pointer.** Two capability descriptions in `connector-capabilities.ts` send agents to "Settings → Connections", a screen that does not exist; the route is the top-level `/connections`. Fix every occurrence, then grep for others.
2. **Teach DorkBot to volunteer it.** Add one sentence to DorkOS's agent-facing self-description (`services/core/self-description/`): "You can connect the person's own accounts, like Gmail or Notion, so you can act for them. Use `connector_recommend`, then `connector_start_connect`, and show the sign-in link and the custody line exactly as returned." The `<user_profile>` block already carries roles, so a role-aware suggestion needs no new plumbing.
3. **The session readout stops being silent.** `SessionConnectorsGroup` returns `null` when nothing is connected. Its host, `SessionInspector`, documents the opposite contract: "everything about the session, always, because you opened it on purpose." So in that host the group renders, always: when nothing is connected, one line ("Nothing connected yet. Connect a service, or just ask your agent to do it.") plus a `Connect a service` ghost button to `/connections` (suppressed in embedded mode, matching the existing `Manage` rule). When accounts exist, the same button sits below the rows. No other surface gains connector chrome.
4. **The page points back at chat.** Header line: `Or just ask your agent: "Connect my Gmail."` with an `Ask your agent` button that opens a fresh session prefilled with that sentence (§7 primitives, no account to attach).
5. **Kill the verb collision.** In `PROMO_REGISTRY`, retitle the relay promo to **"Get notified in Slack or Telegram"** (it is about notifications), and add a connections promo: **"Let your agents use your accounts"** / "Connect Gmail, Notion or Linear" / `navigate` → `/connections`, `priority: 75`, `shouldShow: (ctx) => ctx.connectedAccountCount === 0`. `PromoContext` gains `connectedAccountCount: number` from `useConnectorAccounts` in `usePromoContext`, following the existing gated-query pattern.

### 7. Try-it-now (P6)

**Primitives, verified in source (2026-07-29):** `POST /api/sessions/:id/connectors/:accountId` resolves the account through `registry.accountBinding` and never checks that the session exists (`session-exposure.ts:198-222`), so a client-minted UUID attaches; `sessionRouteLoader` returns early when `session` is present, so `prompt` survives in the URL; `SessionPage` passes it to `ChatPanel`, which seeds the composer once, only into an empty session.

**Attach-before-session-exists is promoted from accident to contract.** Today nothing stops a future "validate the session id" hardening from silently breaking this flow. We do **not** close the hole (attaching early is the feature, and `_ensureSession` already treats the session map as create-on-write); we pin it: R4.2 adds a case to `apps/server/src/routes/__tests__/session-connectors.test.ts` asserting attach succeeds for a session id that has never been created, with a comment naming try-it-now as the dependent. Anyone adding session validation then has to read why.

**Wiring** (`layers/features/connections/lib/try-it-now.ts` + a button in the dialog's connected step and in an adopted row):

```
const sessionId = crypto.randomUUID();
await transport.attachSessionConnector(sessionId, account.id);   // 404 only on unknown account
navigate({ to: '/session', search: { session: sessionId, prompt } });
```

Failure of the attach call leaves the person exactly where they were, with `role="alert"` carrying the verbatim message and the `Done` button still available. Never navigate on a failed attach.

**Prompt selection** (`config/try-it-prompts.ts`): `TRY_IT_PROMPTS: Record<slug, { default: string; byRole?: Partial<Record<CanonRoleId, string>> }>`. `pickTryItPrompt(slug, roles)` = `recommendForRoles(roles)` → the recommendation matching `slug` → `byRole[rec.role] ?? default`; no entry for the slug means no button. Deterministic and pure, so it is unit-tested without a DOM. Seed entries: gmail, notion, linear, github, googlecalendar, googlesheets, hubspot, figma (the eight slugs `CONNECTOR_DISPLAY_NAMES` already knows).

**Copy:** `Try it now` (primary) with the exact prompt shown above it in a quiet block: `"Summarize the last 5 emails in my inbox."` Nothing is sent without a further keystroke: the composer is prefilled, not submitted.

### 8. Header and breadcrumb (G2)

`useHeaderSlot` in `AppShell.tsx` has no case for `/connections` or `/workspaces`, so both fall through to `DashboardHeader`. Add `ConnectionsHeader` and `WorkspacesHeader` (each `<PageHeader title="…" />`, matching `MarketplaceHeader`) and their cases, then add one test that walks every registered route path and asserts none of them resolves to the dashboard header except `/`.

### Code structure

| Path                                                                                                                              | Change                                                      |
| --------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `apps/client/src/layers/features/connections/config/service-catalog.ts`                                                           | **new** — curated catalog (D2)                              |
| `apps/client/src/layers/features/connections/config/try-it-prompts.ts`                                                            | **new** — curated prompts (D10)                             |
| `apps/client/src/layers/features/connections/lib/{custody-chip,try-it-now}.ts`                                                    | **new** — chip derivation, session wiring                   |
| `apps/client/src/layers/features/connections/ui/ServiceCatalog.tsx`                                                               | **new** — replaces `ServiceGrid`'s page role                |
| `apps/client/src/layers/features/connections/ui/{ServiceGrid,ProviderSetupCard,ProviderSetup}.tsx`                                | edit — tile rewrite, copy, badge rename                     |
| `apps/client/src/layers/features/connections/ui/{ConnectDialog,SessionConnectorsGroup,AccountsList}.tsx`                          | edit — engine-setup first step, empty state, animation      |
| `apps/client/src/layers/features/connections/ui/{EngineSetupPanel,ImportAccountsPanel,AdvancedDisclosure}.tsx`                    | **new**                                                     |
| `apps/client/src/layers/widgets/connections/ui/ConnectionsPage.tsx`                                                               | edit — new structure                                        |
| `apps/client/src/layers/features/top-nav/ui/{ConnectionsHeader,WorkspacesHeader}.tsx`, `AppShell.tsx`                             | **new**/edit — G2                                           |
| `apps/client/src/layers/features/feature-promos/model/{promo-registry,promo-types,use-promo-context}.ts`                          | edit — §6.5                                                 |
| `apps/client/src/layers/entities/connectors/model/use-importable-accounts.ts` + `index.ts`                                        | **new**/edit — import hooks                                 |
| `packages/shared/src/{connector-provider,transport}.ts`                                                                           | edit — toolkit `custody`, importable/adopt DTOs + 2 methods |
| `apps/server/src/services/connectors/{registry,providers/composio,providers/nango,providers/test-mode,connector-capabilities}.ts` | edit — D4, D9, §6.1                                         |
| `apps/server/src/routes/connectors.ts`                                                                                            | edit — importable + adopt routes                            |
| `apps/server/src/services/core/self-description/*`                                                                                | edit — §6.2                                                 |
| `packages/icons/src/adapter-logos.tsx`                                                                                            | edit — service marks (unblocking; fallback covers gaps)     |
| `apps/client/src/dev/showcases/ConnectionsShowcases.tsx`, `dev/sections/features-sections.ts`                                     | edit — playground parity                                    |
| `apps/e2e/tests/connections/connections.spec.ts`                                                                                  | edit — Advanced disclosure + new flows                      |
| `docs/connectors/*.mdx`, `changelog/unreleased/<id>-*.md`                                                                         | edit / **new** per PR                                       |

### API changes

- `ConnectorToolkitSchema` gains required `custody: ConnectorCustody` (server always sets it; the client's Zod parse is the guard).
- `GET /api/connectors/accounts/importable` → `{ accounts: PublicConnectedAccount[], warnings: ConnectorWarning[] }`.
- `POST /api/connectors/accounts/:accountId/adopt` → `{ account: PublicConnectedAccount, toolsReachable: boolean, error?: string }`; 404 on an id no provider offers.
- `Transport` gains `getImportableConnectorAccounts()` and `adoptConnectorAccount(accountId)`, implemented in `HttpTransport`; `DirectTransport` implements them honestly (read + adopt work in-process, since both are server-side services).
- OpenAPI regenerated. No other route changes.

## Data model changes

None. `connected_accounts` is unchanged; adoption is exactly the `recordConnect` write a normal connect already performs.

## User Experience

A person lands on a populated control panel and can act in one click. Custody is legible before any decision: a chip on every tile, the server's full sentence at every consent point, and Composio named out loud one beat before Google's screen names it. Failures are the vendor's own words, never a paraphrase and never a green badge. Discovery has three doors (the page, the agent, the session readout) and one dashboard card that no longer competes for the word "connect". The only celebration in the whole surface is one 160ms row entrance, and it stands down when anything is wrong.

## Testing Strategy

- **Pure units** (`pnpm vitest run <path>`): `pickTryItPrompt` (role hit, role miss falls back to default, unknown slug returns nothing, deterministic across role order); custody-chip derivation (each of the five states, including both-providers-configured resolving by precedence and no-route yielding `Needs setup` with no vendor string).
- **Client RTL + mock `Transport`** (`createMockTransport`, `TransportProvider`, per `.claude/rules/testing.md`): catalog renders tiles with **zero** live data resolved; a live managed toolkit turns the chip to `via Composio`; a `configured && !registered` provider renders the page-level notice with the verbatim error **and** the catalog stays interactive; `Your accounts` is absent when empty and present when not; the engine card shows the consent-preview sentence and the any-key-works line before any key is typed _(amended 2026-07-30, DOR-736 — the former `uak_` warning is retired)\_; the unconfigured Nango card shows the conditional lead and **not** the present-tense server sentence; import lists rows, adopts, and renders the not-reachable branch verbatim; try-it-now attaches then navigates, and on attach failure does neither; the session group renders its empty line inside the inspector.
- **Server units**: registry aggregation sets `custody` per toolkit and dedupes by precedence; `importable` filters already-bound ids and degrades per provider; `adopt` records the binding and reports probe failure without throwing; capability descriptions contain no "Settings →" string (a grep-style assertion that can fail).
- **Playwright** (`apps/e2e/tests/connections/connections.spec.ts`, read `.claude/skills/browser-testing/SKILL.md` + `apps/e2e/GOTCHAS.md` first): the shipped flow updated to open **Advanced** before touching the provider card (same assertions otherwise); **new coverage** for (a) a populated catalog with no key saved, (b) the rejected-key notice using the test provider's refusal, (c) try-it-now landing on `/session` with the prompt in the composer and the account attached, (d) import → adopt → row appears. Mobile 390px above-the-fold check is a browser assertion, not jsdom.
- **Per PR**: `pnpm verify`, a changelog fragment, and Dev Playground parity for every changed component (`maintaining-dev-playground`).

## Security Considerations

No new secret path: keys still enter only through the shipped credential routes and never come back. The import read returns provider-side account metadata plus the server-composed disclosure only — no tokens, no vendor handles beyond the opaque id already used everywhere. Adoption is a local binding write, not a credential grant, and it never widens what an agent can reach: exposing tools to a session still requires the approval-gated attach. The catalog is static client data, so no new outbound call is added on page load.

## Documentation

`docs/connectors/index.mdx` and `composio.mdx` gain the new steps (catalog first, engine setup inside Advanced, the project-key-not-CLI-key note, importing accounts already in Composio) with the alpha callout intact; `nango.mdx` drops the present-tense self-host assertion; `raw-mcp.mdx` keeps the `rawMcpServers` reference the Advanced paragraph points at. `writing-for-humans` governs all of it.

## Slices (see `03-tasks.json`)

**R1 — page inversion + states** (D1-D7, §1-3, §8): catalog config, tile rewrite, page structure, header fix, `custody` on the toolkit DTO, every state.
**R2 — copy, engine setup, import** (D8-D9, §4-5): Advanced disclosure, recopied engine cards, guided key retrieval, then **R2.0's one-curl probe first**, and importable + adopt (client and server) only if the probe says yes, then docs.
**R3 — chat front door** (§6): capability-description fix, self-description sentence, session readout, page cross-link, promo registry.
**R4 — try-it-now** (D10-D11, §7): prompt map, selection, wiring, animation, reduced-motion marker.
R1 is prerequisite for R2 and R4 (both hang off the new structure). R3 is independent of all three. E2E updates land with the slice that moves the pixels they assert.

## Open Questions (with recommendations)

- **OQ1 — Composio's API-keys deep link and exact key naming.** _Recommendation:_ verify the URL and the dashboard's own label live at EXECUTE; if the deep link 404s, link the dashboard root and name the page in the sentence. _(Amended 2026-07-30, DOR-736: the `uak_`warning is retired — the founder's observed failure was our client sending the wrong auth header for user-account keys, which now route via`x-user-api-key`; any key kind works.)\_
- **OQ2 — does an unfiltered `GET /connected_accounts` work on a project key?** The import beat's only load-bearing assumption, and it is **empirically answerable at EXECUTE start**: the founder is creating a project key for the #617 retest. _Resolution path, not a judgement call:_ **task R2.0 is one curl** against `GET /api/v3.1/connected_accounts` with a real project key, run before any import code is written. If it returns the project's accounts, R2.2/R2.3 build as specced. If it refuses (403/scope), R2.2 and R2.3 **shrink to the connect-again-through-DorkOS path alone**: no importable read, no adopt route, no import panel, and the Advanced section instead carries one honest line ("Accounts you connected in Composio's own dashboard are not visible here. Connect them again from the catalog, which takes one click since you are already signed in."). Either way nothing invents a scope.
- **OQ3 — will an adopted account's tools resolve when it lives under a different `user_id`?** _Recommendation:_ do not guess. The probe-and-tell design (§5) makes either outcome honest, and the fallback is one click.
- **OQ4 — how many services in the v1 catalog?** _Recommendation:_ start at the twelve to fourteen the `CONNECTOR_DISPLAY_NAMES` map and the relay adapters already name, so every entry has a plain sentence somebody can defend. Growth is a data edit.
- **OQ5 — brand marks and trademark.** _Recommendation:_ ship the fallback glyph everywhere first (nothing depends on a mark), and land marks per service as the founder clears them.

Formerly OQ6 (whether `Direct` appears in this release) is no longer open: it is the stated cross-spec ordering under §Technical Dependencies.

## References

Design critique `connections-ux-critique.md` (2026-07-29) and its screenshots; `specs/connector-completion/02-specification.md`; `specs/connector-gateway/02-specification.md`; ADR `260718-045630` (custody stance); ADR-0310 (per-provider degradation); PR #617 (`dd7647cb9`). Source verified 2026-07-29: `apps/client/src/layers/features/connections/**`, `layers/entities/connectors/**`, `layers/widgets/connections/ui/ConnectionsPage.tsx`, `layers/features/status/ui/SessionInspector.tsx`, `layers/features/feature-promos/model/*`, `AppShell.tsx:156-210`, `router.tsx:57-215`, `features/chat/ui/ChatPanel.tsx:236-247`, `apps/server/src/services/connectors/{registry,routing,session-exposure,connector-capabilities}.ts`, `providers/{composio,composio-client}.ts`, `routes/session-connectors.ts`, `packages/shared/src/{connector-provider,profile-recommendations}.ts`, `packages/icons/src/adapter-logos.tsx`, `apps/e2e/tests/connections/connections.spec.ts`.
