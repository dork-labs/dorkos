---
slug: agent-budget-enforcement
id: 260717-153826
created: 2026-07-17
status: specified
linearIssue: DOR-265
---

# Remove the advisory per-agent budget (`AgentManifest.budget`)

**Status:** Draft (frozen for DECOMPOSE)
**Author:** Boole (SPECIFY stage, /flow drain)
**Date:** 2026-07-17
**Tracker:** DOR-265 · type task→design · size 5 · Medium · split out of DOR-260

## Overview

`AgentManifest.budget` ships two fields — `maxHopsPerMessage: 5` and
`maxCallsPerHour: 100` — that are persisted, surfaced in the API, and **editable
in the UI**, yet enforce nothing. DOR-260 made the per-**message** envelope
budget (`RelayBudget`) genuinely enforced; the per-**agent** budget stayed
advisory. Its own schema TSDoc admits it ("not currently enforced at runtime…
Treat them as advisory metadata"). An editable "safety limit" that throttles
nothing is exactly what the AGENTS.md quality bar forbids — "Be honest by
design: no dark patterns"; "no dead code, no tolerated legacy patterns — when
something is superseded, remove it."

The ideation (`01-ideation.md`) verified every DOR-265 claim against the code and
resolved the enforce-vs-remove fork to **REMOVE**. This spec freezes the
complete, purely-subtractive removal: delete `AgentBudgetSchema` and both fields,
drop the `budgetJson` DB column via a Drizzle migration, strip the ~8 seed sites,
remove every UI surface (including the editable ToolsTab inputs), delete the docs
rows, regenerate OpenAPI, and clear the stale `dist` residue — leaving a
documented path to reintroduce a per-agent cap **with** real enforcement later.

The removal is subtractive but wide: it fans across schema → DB migration →
registry/reconciler → 8 seed sites → 4 client UI surfaces + 3 dev showcases →
docs → OpenAPI, plus a ~36-file test-fixture sweep. This spec enumerates every
site with `file:line` so nothing is half-removed — a single lingering seed
default or stale UI input would reintroduce the dishonesty the change exists to
end.

The single most important safety property: **the type deletion is the keystone.**
Once `AgentBudget`/`AgentManifest.budget` leave `@dorkos/shared`, every typed
`AgentManifest` literal that still carries `budget` becomes a **compile error**,
so the fixture sweep is compiler-guided, not grep-guided. Only loosely-typed
mocks (the dev showcases' local node types) escape the typechecker and must be
found by the `file:line` list below.

## Background / Problem Statement

Verified against the codebase (2026-07-17):

- **The advisory contract.** `AgentBudgetSchema`
  (`packages/shared/src/mesh-schemas.ts:85-92`) defines `maxHopsPerMessage`
  (default 5) and `maxCallsPerHour` (default 100), carrying an explicit "not
  currently enforced at runtime" NOTE (`:69-84`). It is used as
  `AgentManifestSchema.budget` (`:163`, defaulted) and picked into
  `UpdateAgentRequestSchema` (`:342`), making it editable via
  `PATCH /api/mesh/agents/:id`. The `AgentBudget` type is re-exported from the
  shared barrel (`packages/shared/src/types.ts:170`).

- **Nothing enforces it.** The enforced runaway protection is the per-**message**
  envelope budget: `RelayPublishPipeline.deliverAndFinalize()` runs one
  authoritative `enforceBudget(envelope, subject)` gate before any delivery
  (`packages/relay/src/relay-publish.ts:297-314`, DOR-260). That envelope budget
  (`RelayBudget`: `maxHops` / `callBudgetRemaining` / TTL / cycle detection) is a
  **different object** from `AgentBudget`; its `maxHops` comes from relay config
  (`opts`), never from an agent's manifest. No component reads
  `AgentBudget.maxCallsPerHour` or `maxHopsPerMessage` for any gating decision.

- **The former enforcer was already deleted.** `BudgetMapper` + its
  `rate_limit_buckets` table were removed as dead code; no
  `packages/mesh/src/budget-mapper.ts` exists and no `rate_limit_buckets` appears
  in `packages/db/src`. Only a **stale build artifact** survives —
  `packages/mesh/dist/budget-mapper.{d.ts,js,js.map,d.ts.map}` and
  `dist/__tests__/budget-mapper.test.*` — and `dist/` is **git-ignored**
  (confirmed via `git check-ignore`), so this is uncommitted local build residue,
  not tracked source.

- **The persistence path.** The `agents` table (a derived cache, ADR-0043; disk
  `.dork/agent.json` is the source of truth) has a `budget_json` column
  (`packages/db/src/schema/mesh.ts:23-25`), added by migration `0003` (`ALTER
TABLE agents ADD budget_json …`). `AgentRegistry` writes it on insert/update
  (`packages/mesh/src/agent-registry.ts:110,132,222`) and reads it back in
  `rowToEntry` (`:434`, `budget: JSON.parse(row.budgetJson)`). The reconciler
  syncs and diffs it (`packages/mesh/src/reconciler.ts:130,206`).

- **The legacy-tolerance mechanism already exists — for free.** `readManifest`
  (`packages/shared/src/manifest.ts:59`) parses disk manifests with
  `AgentManifestSchema.safeParse(parsed)` and returns `result.data`. Zod objects
  **strip unknown keys by default** (no `.passthrough()`/`.strict()` here). So
  once `budget` leaves the schema, an old `agent.json` that still contains a
  top-level `"budget": {…}` key **parses successfully with the key silently
  stripped** — no validation failure, no special-case code. The stripped
  in-memory manifest is what the file-first write-through then persists, so the
  stale key is removed from disk on the **next write** of that agent. (Pinned in
  detail under "Backward compatibility.")

## Operator Decisions (LOCKED)

Both ideation Open Questions were resolved by the operator via the /flow drain
directive; not reopened here.

1. **Enforce vs. remove `maxCallsPerHour`:** **REMOVE.** No cheap enforcement
   path (needs a resurrected turn-count store); not launch-critical; the
   per-message envelope budget already enforces runaway protection; an editable
   knob that gates nothing violates honest-by-design + no-dead-code.
2. **Open Q A — `maxHopsPerMessage`: remove-both vs. cheaply-wire.**
   **REMOVE BOTH.** Symmetric, minimal, complete. The per-agent hop cap is
   redundant with the enforced relay-config hop default, and nothing relies on
   it. We do not wire `maxHopsPerMessage` into the envelope `maxHops` (that keeps
   a `budget` concept alive and needs the target manifest at publish time — a
   smaller version of the enforcement plumbing this issue declines to build).
3. **Open Q B — DB column: drop now vs. retain-and-ignore.** **DROP NOW.**
   No-dead-code applies to the schema too; a live-but-ignored column is its own
   small lie. A Drizzle migration on the `agents` table (derived cache) is the
   one non-trivial step, but the reintroduction path re-adds it cleanly if a
   future enforced cap needs a store.
4. **Reject the "keep it as documented advisory metadata" hybrid.** A field that
   enforces nothing but stays "documented" is dishonest _and_ undead — worse than
   either clean pole.
5. **The enforced budgets are untouched.** The `RelayBudget` envelope gate
   (DOR-260) and the per-sender rate limiter (`checkRateLimit` /
   `countSenderInWindow`) are separate, working systems; removal must not perturb
   them.

## Goals

- Delete `AgentBudgetSchema` (both fields + the advisory NOTE) and the
  `AgentBudget` type; remove `budget` from `AgentManifestSchema` and
  `UpdateAgentRequestSchema`; drop the shared-barrel re-export.
- Drop the `agents.budget_json` column via a generated Drizzle migration; remove
  every read/write of it in the registry and reconciler.
- Remove all ~8 manifest-seed sites that hardcode `{ maxHopsPerMessage: 5,
maxCallsPerHour: 100 }`.
- Remove every client surface that displays or edits budget — the editable
  ToolsTab "Limits" section, the AgentRow line, and the topology displays — plus
  the three dev showcases, leaving an honest absence (no placeholder, no orphaned
  divider) where each element was.
- Delete the three docs references and regenerate `docs/api/openapi.json` so the
  `AgentBudget` schema and its `$ref`s disappear.
- Clear the stale `dist/budget-mapper.*` residue via a clean rebuild.
- Old `agent.json` files carrying a `budget` key load fine (key stripped on read,
  removed from disk on next write) — verified by a round-trip test.
- Update the ~36 test files whose fixtures carry `budget`; delete or rewrite the
  handful that **assert** on budget round-tripping.
- Record the reintroduction path (a draft ADR + the enforcement design the
  ideation already analyzed) so a future enforced per-agent cap is a deliberate,
  scoped build with the correct in-adapter turn-start signal.

## Non-Goals

- **Any enforcement.** The ideation's Option 1 (turn-start-row store,
  `buildContext` manifest plumbing, in-adapter rejection) is explicitly **not**
  built. This is a pure removal.
- **The per-message envelope budget (`RelayBudget`).** Enforced and correct
  (DOR-260); untouched. Its `maxHops` / `callBudgetRemaining` config knobs stay.
- **The per-sender relay rate limiter** (`checkRateLimit` +
  `SqliteIndex.countSenderInWindow`, `relay-publish.ts:201-220`) — a distinct,
  working sliding-window throttle; untouched.
- **The MCP relay tools' `budget` field** (`services/core/external-mcp/relay-tools.ts:65-77,161-191`)
  — that is the **envelope** `RelayBudget` ("Remaining call budget"), not
  `AgentBudget`. No MCP tool exposes `AgentBudget` (verified: the mesh
  register/update tools do not accept a budget field), so no MCP surface changes.
- **The `AdapterContext.agent.manifest?` field** (`packages/relay/src/types.ts:595`)
  — a generic `Record<string, unknown>` that is typed but never populated by any
  producer (`buildContext` sets only `directory` + `runtime`,
  `adapter-manager.ts:553-558`). It is **not** budget-typed and no code reads
  budget from it, so removing budget touches it not at all. It is pre-existing
  dead scaffolding worth a separate cleanup; kept out of scope here to keep this
  change strictly budget-subtractive.
- **Building codex/opencode relay adapters.** Only the claude-code relay adapter
  exists today; multi-adapter enforcement is speculative and unbuilt. Out of
  scope.

## Technical Dependencies

- No new external dependencies. Purely subtractive.
- `drizzle-kit` (`^0.31.10`) generates the column-drop migration:
  `pnpm --filter @dorkos/db db:generate` (writes the next `00NN_*.sql`, a new
  `meta/00NN_snapshot.json`, and a `_journal.json` entry). SQLite 3.35+ `ALTER
TABLE … DROP COLUMN` is supported.
- OpenAPI regenerates from the Zod schemas via `pnpm docs:export-api` (runs
  `tsx scripts/export-openapi.ts` → `docs/api/openapi.json`). Never hand-edit.

## Detailed Design

### The complete removal inventory (verified `file:line`)

Every site below was confirmed by direct read on 2026-07-17. Counts summarized in
"Blast radius" at the end of this section.

#### 1. Schema — `@dorkos/shared` (the contract source; the keystone)

- `packages/shared/src/mesh-schemas.ts:69-84` — the `AgentBudgetSchema` TSDoc
  block (the "not enforced" NOTE) — **delete**.
- `packages/shared/src/mesh-schemas.ts:85-92` — `AgentBudgetSchema` +
  `export type AgentBudget` — **delete**.
- `packages/shared/src/mesh-schemas.ts:163` — `budget:
AgentBudgetSchema.default(...)` inside `AgentManifestSchema` — **delete the
  line**.
- `packages/shared/src/mesh-schemas.ts:342` — `budget: true` inside
  `UpdateAgentRequestSchema.pick({...})` — **delete the line**.
- `packages/shared/src/types.ts:170` — `AgentBudget` in the barrel re-export list
  — **delete**.

Deleting these first makes every downstream typed `AgentManifest` literal a
compile error (the guided sweep). `AgentBehaviorSchema` (`:60-67`) stays — it is a
live, unrelated field and is the model the surviving code follows.

#### 2. Persistence — `@dorkos/db` + `@dorkos/mesh`

- `packages/db/src/schema/mesh.ts:23-25` — the `budgetJson` column definition —
  **delete**.
- **New migration** (generated, not hand-written): run
  `pnpm --filter @dorkos/db db:generate` after editing the schema → produces
  `packages/db/drizzle/00NN_<name>.sql` containing `ALTER TABLE \`agents\` DROP
  COLUMN \`budget_json\`;`, plus `packages/db/drizzle/meta/00NN_snapshot.json`and a new`\_journal.json`entry. (Next index is`0028`; drizzle assigns the
  slug.) Verify the generated SQL is exactly the column drop (nothing else
  drifted) before committing.
- `packages/db/src/__tests__/migrations.test.ts:147-165` — the "agents table has
  budget_json column with default hop and rate limits" test — **replace** with a
  test asserting the column is **absent** after `runMigrations` (a
  `PRAGMA table_info(agents)` check that `budget_json` is gone), so the migration
  is proven, not silently dropped.
- `packages/mesh/src/agent-registry.ts:110` — `budgetJson:
JSON.stringify(agent.budget)` in the insert values — **delete**.
- `packages/mesh/src/agent-registry.ts:132` — `budgetJson: …` in the
  `onConflictDoUpdate` set — **delete**.
- `packages/mesh/src/agent-registry.ts:222` — `budgetJson: …` in `update()` —
  **delete**.
- `packages/mesh/src/agent-registry.ts:434` — `budget: JSON.parse(row.budgetJson)`
  in `rowToEntry` — **delete**. (`AgentRegistryEntry extends AgentManifest`,
  `:19`, so its `budget` member vanishes automatically with the shared type.)
- `packages/mesh/src/reconciler.ts:130` — `budget: manifest.budget` in the sync
  payload — **delete**.
- `packages/mesh/src/reconciler.ts:206` — `JSON.stringify(manifest.budget) !==
JSON.stringify(entry.budget) ||` in the field-diff — **delete the clause**
  (keep the surrounding `behavior`/`persona` comparisons).

#### 3. Manifest-seed sites (write the default; read it nowhere for gating)

Eight sites hardcode `budget: { maxHopsPerMessage: 5, maxCallsPerHour: 100 }`:

- `apps/server/src/routes/agents.ts:135` — **delete the line**.
- `apps/server/src/routes/test-control.ts:81` — **delete**.
- `apps/server/src/services/mesh/ensure-dorkbot.ts:68` — **delete** (DorkBot
  system-agent manifest).
- `apps/server/src/services/core/agent-creator.ts:264` — **delete**.
- `packages/mesh/src/mesh-discovery.ts:104` — `register()` manifest builder —
  **delete**.
- `packages/mesh/src/mesh-discovery.ts:148` — `registerByPath()` manifest builder
  — **delete**.
- `apps/client/src/layers/shared/lib/direct/mesh-methods.ts:49` — DirectTransport
  (Obsidian, in-process) manifest builder — **delete** (typed `AgentManifest`, so
  compiler-guided).
- `packages/test-utils/src/mock-factories.ts:114` — the shared mock-manifest
  factory — **delete** (its removal propagates the fixture change to every test
  that consumes the factory rather than inlining its own).

#### 4. Client UI surfaces (display / edit) — honest absence, no placeholder

- **`apps/client/src/layers/features/agent-settings/ui/ToolsTab.tsx` — the
  editable knob (the sharpest violation).** Remove the whole "Limits" block:
  - `:210` — the docstring clause "and collapsible safety limits (budget)".
  - `:213` — `const [limitsOpen, setLimitsOpen] = useState(false);`.
  - `:283-284` — `const hops`/`const calls` reads.
  - `:351-401` — the `CollapsibleFieldCard` "Limits" (badge `{hops} hops · {calls}
calls/hr` + two `SettingRow`s with `<Input type="number">` for
    `maxHopsPerMessage` / `maxCallsPerHour`, each calling `onUpdate({ budget: … })`).
  - **Unused imports to drop after removal:** `CollapsibleFieldCard` (only use)
    and `Input` (only use). `useState` becomes unused → drop from the
    `react` import. **Keep** `SettingRow` (still used at `:132,:152` by
    `ToolGroupRow`). The tab then ends after MCP Servers — no empty state; there
    is nothing to say about a limit that does not exist.
- **`apps/client/src/layers/features/agents-list/ui/AgentRow.tsx:213-219`** — the
  `{/* Budget */}` block ("Budget: max {maxHopsPerMessage} hops · {maxCallsPerHour}
  calls/hr"). **Delete the block** (guard + div); the sibling response-mode and
  namespace rows are untouched. _(This surface is not named in the ideation's
  §3 UI list — found during the SPECIFY sweep; it is a real fourth display
  surface.)_
- **Topology (`features/mesh`) — three coupled files:**
  - `apps/client/src/layers/features/mesh/lib/build-topology-elements.ts:167-172`
    — the `budget: agent.budget ? {…} : undefined` node-data mapping —
    **delete**.
  - `apps/client/src/layers/features/mesh/ui/AgentNode.tsx:28` — the local
    `budget?: {…}` field on the node data type — **delete**; `:202` — the
    `{d.budget.maxCallsPerHour} calls/hr · {d.budget.maxHopsPerMessage} max hops`
    render — **delete**.
  - `apps/client/src/layers/features/mesh/ui/TopologyPanel.tsx:54-55` — the two
    `<span>{…} calls/hr</span>` / `max hops` displays — **delete**.

#### 5. Dev showcases (loosely typed — escape the compiler; grep-found)

- `apps/client/src/dev/showcases/topology-agent-node.tsx:20` (local type field),
  `:137` (display), `:168` (mock data) — **delete**.
- `apps/client/src/dev/showcases/settings-mock-data.ts:115,152` — **delete**.
- `apps/client/src/dev/showcases/FilterBarShowcase.tsx:23,47,71,95,119,143` —
  **delete** (six mock agents). See the `maintaining-dev-playground` skill.

#### 6. Docs + OpenAPI

- `docs/concepts/mesh.mdx:125` — the **budget** row ("Max hops per message… max
  API calls per hour… Advisory only, not enforced at runtime today.") — **delete
  the table row**.
- `docs/guides/agents.mdx:63` — the `"budget": { … }` line in the example
  manifest — **delete**.
- `docs/guides/agent-discovery.mdx:164` — the `"budget": { … }` example line —
  **delete**; `:194-198` — the field-table `budget:` entry — **delete**.
- `docs/api/openapi.json` — **regenerate** via `pnpm docs:export-api`. The
  `AgentBudget` schema definition (`:4048`) and its `$ref`s inside `AgentManifest`
  / `UpdateAgentRequest` (`:3969,:4187,:4281`) disappear automatically. Confirm
  `openapi-fresh` is green (see the MEMORY note: a red on an untouched-schema PR
  means another PR landed a schema-stale main — reproduce by merging `origin/main`
  first, then regenerating).

#### 7. Stale build residue

- `packages/mesh/dist/budget-mapper.{d.ts,js,js.map,d.ts.map}` and
  `dist/__tests__/budget-mapper.test.*` — **git-ignored build output** (no source
  file backs them). A clean rebuild clears them: remove `packages/mesh/dist` then
  `pnpm --filter @dorkos/mesh build` (or a full `pnpm build`). No committed change
  — this step just prevents the stale `.d.ts` from lingering in a working tree and
  confusing `knip`/future readers.

#### 8. Test-fixture sweep (~36 files)

Removing the `budget` field from `AgentManifest` makes every **typed** fixture a
compile error; the sweep is compiler-guided plus the `file:line` list below for
loosely-typed mocks. Two categories:

- **Assert on budget (rewrite/remove the assertion):**
  - `packages/mesh/src/__tests__/agent-registry.test.ts:30,186,190,236,262` —
    round-trip asserts (`expect(entry?.budget.maxCallsPerHour).toBe(10)`, custom
    budgets persisted) — **remove these assertions and their budget inputs**.
  - `packages/mesh/src/__tests__/relay-integration.test.ts:322,329,337` —
    `expect(manifest.budget).toEqual(...)` / `expect(agent!.budget).toEqual(...)`
    — **remove**.
  - `apps/client/src/layers/features/agent-settings/__tests__/ToolsTab.test.tsx`
    — any test exercising the Limits inputs — **remove** (the inputs are gone).
  - `apps/client/src/layers/features/mesh/lib/__tests__/build-topology-elements.test.ts:21`
    and `apps/client/src/layers/features/agents-list/__tests__/AgentRow.test.tsx:132`
    — drop budget from fixtures and any budget-display assertion.
  - `packages/db/src/__tests__/migrations.test.ts:147-165` — replaced per §2.
- **Merely include budget in a fixture (drop the field):** the remaining ~28
  files — server (`a2a-routes`, `agents`, `agents-conventions`, `context-builder`,
  `context-builder-conventions`, `mcp-resources`, `mcp-structured-output`,
  `ensure-dorkbot`), client (`agent-hooks`, `BindingDialog`,
  `tab-migration-parity`, `IdentityTab`, `PersonalityTab`, `ChannelsTab`,
  `AgentsList`, `agent-filter-schema`, `OfflineAgentDetailSheet`, `ConversationRow`,
  `TaskRow`, `AgentsPage`), and packages (`a2a-gateway` ×3, mesh `manifest`,
  `mesh-core`, `reconciler`, `relay-bridge`, `topology`,
  `discovery/unified-scanner`, shared `manifest`) — **delete the `budget:` line**
  from each fixture. Most inherit from `mock-factories.ts`; those that inline it
  are listed here.
- **Add one legacy-tolerance test** (see Testing Strategy): a `readManifest`
  round-trip proving an old on-disk `budget` key is stripped, in
  `packages/shared/src/__tests__/manifest.test.ts`.

### Backward compatibility (legacy `agent.json` with a `budget` key) — pinned

The source of truth is disk `.dork/agent.json` (ADR-0043); users have live files
carrying `"budget": { "maxHopsPerMessage": 5, "maxCallsPerHour": 100 }`. Exact
behavior after removal:

1. **Read.** `readManifest` (`packages/shared/src/manifest.ts:59`) does
   `AgentManifestSchema.safeParse(parsed)` and returns `result.data`. Zod object
   schemas **strip unknown keys by default** (this schema uses neither
   `.passthrough()` nor `.strict()`). The unknown `budget` key is therefore
   **dropped silently** — `safeParse` **succeeds**, no warning, and the returned
   `AgentManifest` has no `budget`. (Present-but-invalid manifests
   `safeParse`-to-`null`; a stray extra key is _not_ invalid, so this path is
   never hit.)
2. **Persist.** `writeManifest` (`:85`) validates then serializes the **passed
   object** (`JSON.stringify(manifest, …)`). Because every producer of an
   in-memory manifest (the seed sites in §3) is stripped of `budget`, and because
   the file-first write-through / reconciler round-trips manifests through
   `readManifest` (which already stripped the key), the stale `budget` key is
   **removed from disk on the next write** of that agent (rename, re-register,
   convention edit, or any reconciler-detected diff). No migration of on-disk
   files is needed; the key decays away.
3. **DB.** The `budget_json` column is dropped by the migration (§2); existing
   rows lose the column outright. `rowToEntry` no longer reads it. There is no
   read path that can fail on the missing column post-migration.

Net: **old files load fine, the `budget` key is ignored on read and stripped on
next write** — the honest, zero-touch backward-compat story. This is proven by a
round-trip test, not assumed.

### API / OpenAPI deltas

- **`AgentManifest`** (DTO / `GET /api/mesh/agents`, `POST /api/mesh/agents`,
  resolve, inspect, topology) loses its `budget` property. Clients that read it
  already guard (`agent.budget && …`), so absence renders nothing — but those
  guards are deleted alongside per §4.
- **`UpdateAgentRequest`** (`PATCH /api/mesh/agents/:id`) loses `budget` from its
  accepted shape. The only producer was the deleted ToolsTab input; no other
  caller sends it. An old client that still PATCHed `budget` would have that key
  **stripped** by the same Zod default-strip on the request body — a graceful,
  non-breaking degrade.
- **`AgentBudget`** schema and all `$ref`s vanish from `docs/api/openapi.json` on
  regen. No route is added or removed; no status codes change.

### Blast radius (counts)

| Area                         | Sites                                                                     |
| ---------------------------- | ------------------------------------------------------------------------- |
| Shared schema + barrel       | 5 edits (1 schema+type delete, 1 TSDoc, 2 usage lines, 1 barrel)          |
| DB schema + migration + test | column delete + 1 generated migration + 1 migration test rewrite          |
| Registry + reconciler        | 6 lines (registry ×4, reconciler ×2)                                      |
| Manifest-seed sites          | 8 (5 server/pkg + 1 client DirectTransport + 1 mock factory + …)          |
| Client UI surfaces           | 4 (ToolsTab editors, AgentRow, AgentNode+TopologyPanel, topology-builder) |
| Dev showcases                | 3 files                                                                   |
| Docs                         | 3 MDX refs + OpenAPI regen                                                |
| Stale dist residue           | clean rebuild (git-ignored, uncommitted)                                  |
| Test fixtures                | ~36 files (~6 assert-and-rewrite, ~28 field-drop, +1 new test)            |

## User Experience

- **Agent settings → Tools tab (Kai/Ikechi):** the collapsible "Limits" section
  with its two number inputs is **gone**. The tab shows tool-group overrides and
  MCP servers only. Nothing replaces the section — an honest absence, because a
  limit that enforced nothing had no business claiming to. No dangling divider or
  empty card.
- **Agents list row:** the "Budget: max 5 hops · 100 calls/hr" line disappears;
  the row keeps its response-mode and namespace details.
- **Topology view (agent node + panel):** the "100 calls/hr · 5 max hops" line
  disappears from both the node card and the side panel.
- **No functional change for anyone:** because the fields gated nothing, removing
  them changes only what is _displayed and editable_, never what the system
  _does_. Runaway protection — the per-message envelope budget — is unchanged.
- **Honesty win:** the product stops presenting an editable safety control that
  did nothing. This is the AGENTS.md "every element justifies its existence" bar,
  applied.

## Testing Strategy

- **Shared — legacy tolerance (new, `packages/shared/src/__tests__/manifest.test.ts`):**
  write an `agent.json` containing a top-level `"budget": { "maxHopsPerMessage":
5, "maxCallsPerHour": 100 }` plus valid required fields; assert `readManifest`
  **succeeds** (non-null), the returned manifest has **no** `budget` property, and
  **no warning** was logged (distinguish strip from the invalid-manifest path).
  Then `writeManifest` the returned manifest and re-read the file bytes to assert
  `budget` is **absent on disk** (strip-on-read → removed-on-write). _Purpose:
  proves the zero-touch backward-compat contract._
- **DB — migration (`packages/db/src/__tests__/migrations.test.ts`):** replace the
  old "has budget*json column" test with one that runs `runMigrations` on a fresh
  `:memory:` DB and asserts `PRAGMA table_info(agents)` contains **no**
  `budget_json` column, and that an INSERT omitting budget succeeds. \_Purpose:
  proves the column drop actually ran.*
- **Mesh — registry round-trip (`agent-registry.test.ts`):** update the existing
  round-trip tests so a manifest with no `budget` persists and reads back with no
  `budget`; remove the custom-budget assertions. _Purpose: no stale budget
  read/write survives._
- **Mesh — reconciler (`reconciler.test.ts`):** the field-diff no longer
  references budget; a manifest that differs only in a (now-absent) budget is not
  treated as changed. Keep the behavior/persona diff coverage. _Purpose: the diff
  clause removal doesn't regress sync detection._
- **Mesh — relay integration (`relay-integration.test.ts`):** drop the
  `manifest.budget` / `agent.budget` assertions; the registration/round-trip
  still passes. _Purpose: registration path is budget-free end-to-end._
- **Client — ToolsTab (`ToolsTab.test.tsx`):** remove tests for the Limits inputs;
  add/keep a test asserting the tab renders tool groups + MCP servers and the
  "Limits" control is **not** present. _Purpose: the editable dishonest control is
  gone from the DOM._
- **Client — AgentRow / topology (`AgentRow.test.tsx`,
  `build-topology-elements.test.ts`):** assert the budget line/data is **absent**;
  the surrounding row/node still renders. _Purpose: display surfaces are clean._
- **Fixture sweep:** the ~28 include-only fixtures drop the field; the suite
  compiles (the type deletion enforces this) and passes.
- **Full-suite gate:** `pnpm test -- --run` green; `pnpm --filter @dorkos/shared
build` first (stale dist causes false-red type errors), then affected
  typecheck/lint via `pnpm verify`.

Each test carries a purpose comment; no always-pass tests.

## Performance Considerations

None. The change removes a persisted column, two small fields, and several render
branches. Marginally less to serialize, store, and diff. No hot path affected.

## Security Considerations

None. `AgentBudget` was non-sensitive advisory metadata gating nothing; removing
it removes no protection (the enforced protection — the per-message envelope
budget — is untouched). No new route, auth surface, or external fetch. Dropping a
column on the derived `agents` cache is safe; the disk manifest source of truth
tolerates the stale key gracefully (above).

## Documentation

- Delete the three docs references (§6) and regenerate OpenAPI.
- **Changelog fragment** (user-visible: an editable control disappears). Add
  `changelog/unreleased/<id>-<slug>.md` (timestamp-id via `.claude/scripts/id.ts`
  - slug), a small **Changed/Removed** entry in `writing-for-humans` voice, e.g.:
    _"Removed the per-agent message and hourly-call limits from agent settings —
    they were shown as editable controls but never actually limited anything.
    Runaway protection still comes from the per-message budget, which is enforced."_
    Never edit `CHANGELOG.md` directly (ADR 260707-231641).
- Inline TSDoc: no new exports; the removed `AgentBudgetSchema` NOTE goes with it.
- Draft ADR — see Related ADRs.

## Implementation Phases

Order matters only in that the **schema deletion lands first** so the compiler
guides the rest. Otherwise the phases are independent and parallelizable in a
worktree (DECOMPOSE will shape ~5-6 tasks).

- **Phase 1 — schema keystone:** delete `AgentBudgetSchema` + type + the two
  usages + the barrel re-export (§1). Everything typed now red-flags.
- **Phase 2 — persistence:** drop the column, generate + verify the migration,
  rewrite the migration test, strip registry (×4) + reconciler (×2) (§2).
- **Phase 3 — seed sites:** the 8 hardcoded defaults (§3).
- **Phase 4 — client UI + showcases:** ToolsTab (with unused-import cleanup),
  AgentRow, topology ×3, dev showcases ×3; honest absence, no placeholder (§4-5).
- **Phase 5 — docs, OpenAPI, changelog, ADR:** MDX ×3, `pnpm docs:export-api`,
  changelog fragment, draft ADR (§6, Documentation, Related ADRs).
- **Phase 6 — test sweep + green:** fixture drops, assertion rewrites, the new
  legacy-tolerance test, clean rebuild to clear dist residue, full verify.

## Reintroduction path (if a per-agent cap is ever wanted)

This removal keeps the door open without carrying dead metadata. When Mesh
becomes launch-critical and codex/opencode relay adapters actually exist, a
per-agent turn cap should be rebuilt **with enforcement**, not resurrected as
advisory metadata. The ideation already did the cost analysis (§5.3-5.4) and
pinned the one non-obvious constraint: the "this is a paid turn" signal lives
**inside the claude-code adapter, after the `STREAM_EVENT_TYPES` skip**
(`agent-handler.ts:179-204`), right before `agentManager.sendMessage` — so a
future cap must count turns there, **not** naïvely count `relay.agent.*`
publishes at the relay gate (which would burn the cap on reply/stream traffic).
Rebuilding then means: a new per-target-agent turn-count store (a Drizzle table +
migration — re-adding what this spec drops), plumbing the target manifest onto
`AdapterContext` via `buildContext` (+ a `meshCore.getAgent`), a sliding-window
gate, and an in-adapter rejection path that settles the reply-waiter (it cannot
reuse the pre-delivery `rejectAtGate`). All of that is a deliberate, scoped build
— captured here and in the draft ADR so the lesson is not relearned.

## Open Questions

Both ideation Open Questions were resolved by the operator via the /flow drain
directive; recorded here for the audit trail.

- ~~**A. `maxHopsPerMessage`: remove-both vs. cheaply-wire into the enforced
  envelope `maxHops`.**~~ **(RESOLVED — remove both.)** Answer: remove
  `maxHopsPerMessage` alongside `maxCallsPerHour`. Rationale: the per-agent hop
  cap is redundant with the enforced relay-config hop default and nothing relies
  on it; wiring it would keep a `budget` concept alive and require the target
  manifest at publish time (a slice of the enforcement plumbing this issue
  declines). A clean, complete, symmetric removal beats a half-kept concept.
- ~~**B. DB column: drop now vs. retain-and-ignore.**~~ **(RESOLVED — drop now.)**
  Answer: drop `budget_json` in this change via a generated Drizzle migration.
  Rationale: no-dead-code applies to the schema too; a live-but-ignored column is
  its own small lie. The reintroduction path re-adds a (better-designed) store if
  an enforced cap is ever built.

No floor-level blockers remain — direction is fully pinned.

## Related ADRs

- **DOR-260** — made the per-**message** envelope budget (`RelayBudget`)
  authoritative and enforced at `deliverAndFinalize()`. This spec's whole premise:
  that enforced budget is the real runaway protection, so the advisory per-agent
  budget is redundant dead metadata.
- **ADR-0043** — file-first agent storage (`.dork/agent.json` source of truth +
  derived `agents` cache). The reason dropping the `budget_json` column is safe
  and the reason strip-on-read + write-through cleanly retires the on-disk key.
- **Proposed ADR (extract at DECOMPOSE/EXECUTE via `/adr:from-spec`):** _"Remove
  the advisory per-agent budget; enforced runaway protection is the per-message
  envelope budget."_ Records the honesty decision (an editable control that gates
  nothing violates the quality bar), the verified single-adapter reality
  (only claude-code has a relay agent-turn adapter today), the backward-tolerance
  mechanism (Zod default-strip + write-through), and the correct in-adapter
  turn-start signal for any future enforcement. _(Per the drain directive, this
  spec does not create the ADR file — it is seeded here for extraction.)_

## References

- DOR-265 (issue) — the work item; split out of DOR-260.
- `specs/agent-budget-enforcement/01-ideation.md` — full verification of every
  DOR-265 claim, the enforce-vs-remove analysis, and the field asymmetry.
- Schema: `packages/shared/src/mesh-schemas.ts:69-92` (`AgentBudgetSchema`),
  `:163` (manifest use), `:342` (`UpdateAgentRequest` pick);
  `packages/shared/src/types.ts:170` (barrel); `packages/shared/src/manifest.ts:59,85`
  (read/write + strip semantics).
- Persistence: `packages/db/src/schema/mesh.ts:23-25`,
  `packages/db/drizzle/0003_lying_timeslip.sql:3` (column origin),
  `packages/db/src/__tests__/migrations.test.ts:147-165`;
  `packages/mesh/src/agent-registry.ts:19,110,132,222,434`,
  `packages/mesh/src/reconciler.ts:130,206`.
- Seed sites: `apps/server/src/routes/agents.ts:135`,
  `apps/server/src/routes/test-control.ts:81`,
  `apps/server/src/services/mesh/ensure-dorkbot.ts:68`,
  `apps/server/src/services/core/agent-creator.ts:264`,
  `packages/mesh/src/mesh-discovery.ts:104,148`,
  `apps/client/src/layers/shared/lib/direct/mesh-methods.ts:49`,
  `packages/test-utils/src/mock-factories.ts:114`.
- Client UI: `apps/client/src/layers/features/agent-settings/ui/ToolsTab.tsx:210,213,283-284,351-401`,
  `apps/client/src/layers/features/agents-list/ui/AgentRow.tsx:213-219`,
  `apps/client/src/layers/features/mesh/lib/build-topology-elements.ts:167-172`,
  `apps/client/src/layers/features/mesh/ui/AgentNode.tsx:28,202`,
  `apps/client/src/layers/features/mesh/ui/TopologyPanel.tsx:54-55`.
- Showcases: `apps/client/src/dev/showcases/topology-agent-node.tsx:20,137,168`,
  `.../settings-mock-data.ts:115,152`, `.../FilterBarShowcase.tsx:23,47,71,95,119,143`.
- Docs: `docs/concepts/mesh.mdx:125`, `docs/guides/agents.mdx:63`,
  `docs/guides/agent-discovery.mdx:164,194-198`, `docs/api/openapi.json`
  (regen via `pnpm docs:export-api`).
- Out-of-scope confirmations: `packages/relay/src/relay-publish.ts:297-314`
  (enforced envelope gate), `:201-220` (per-sender limiter);
  `packages/relay/src/types.ts:595` +
  `apps/server/src/services/relay/adapter-manager.ts:553-558`
  (`AdapterContext.agent.manifest` never populated);
  `apps/server/src/services/core/external-mcp/relay-tools.ts:65-77,161-191`
  (MCP `budget` is the envelope `RelayBudget`, not `AgentBudget`);
  `packages/relay/src/adapters/claude-code/agent-handler.ts:179-204`
  (the correct in-adapter turn-start signal for any future enforcement).
  </content>
  </invoke>
