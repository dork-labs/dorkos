# Tasks — Remove the advisory per-agent budget (`AgentManifest.budget`)

**Spec:** `specs/agent-budget-enforcement/02-specification.md` · **Slug:**
`agent-budget-enforcement` · **Tracker:** DOR-265 (task→design, size 5) ·
**Mode:** full · **Generated:** 2026-07-17

6 tasks across 6 phases. The removal is purely subtractive but wide, so the
decomposition follows the spec's own Implementation Phases almost 1:1, with one
consolidation: **task 1.1 bundles the spec's Phase 1 (schema), the
non-DB code half of Phase 2 (registry/reconciler), and all of Phase 3 (the 8
seed sites)** into a single atomic, compiler-guided sweep — the schema deletion
and every typed production site it turns red land together, because splitting
them would leave an intermediate commit that cannot compile. Everything else
(the DB column migration, client UI removal, docs/OpenAPI, changelog+ADR, and
the long-tail test-fixture sweep) depends on that keystone landing first.

## Dependency graph

```
1.1 (keystone: schema + barrel + registry/reconciler + 8 seed sites, self-tested)
 ├─→ 2.1 (DB: drop budget_json column + migration test)
 ├─→ 3.1 (client UI: ToolsTab/AgentRow/topology×3 + 3 showcases + tests)
 │     └─→ 5.1 (changelog + draft ADR — prose matches the shipped UI removal)
 └─→ 4.1 (docs ×3 + OpenAPI regen)

{2.1, 3.1, 4.1} all ∥ each other (different packages/files, all gated only by 1.1)

6.1 (test-fixture sweep ~28 files + legacy-tolerance test + clean rebuild + full verify)
 ← depends on 1.1, 2.1, 3.1, 4.1 (the final everything-green gate)
 ∥ 5.1 (changelog/ADR prose shares no files with the fixture sweep)
```

Compact form: `1.1 → {2.1 ∥ 3.1 ∥ 4.1}; 3.1 → 5.1; {1.1,2.1,3.1,4.1} → 6.1; 5.1 ∥ 6.1`.

**Critical path (4 deep):** `1.1 → 3.1 → 5.1` is the longest prose-dependent
chain; `1.1 → {2.1|3.1|4.1} → 6.1` is the longest code-dependent chain into the
final verify gate.

**Mutually independent (parallelizable) once 1.1 lands:**

- **2.1 (DB migration) ∥ 3.1 (client UI) ∥ 4.1 (docs/OpenAPI)** — three different
  packages (`@dorkos/db`, `@dorkos/client`, docs), zero file overlap.
- **5.1 (changelog/ADR) ∥ 2.1, 4.1, 6.1** — prose work shares no files with the
  DB migration, docs/OpenAPI regen, or the fixture sweep; it only waits on 3.1
  because the changelog copy describes the shipped UI removal.

**Nothing is promoted to a sub-issue** — no task reaches `xl` (threshold `xl`),
so every task stays a checklist line mirrored into DOR-265.

---

## Phase 1 — Schema keystone + compiler-guided sweep

### Task 1.1: Delete `AgentBudgetSchema` + barrel re-export + every compiler-guided production site (registry, reconciler, 8 seed sites)

The keystone. Deletes `AgentBudgetSchema`/`AgentBudget` and the "not enforced"
TSDoc NOTE (`mesh-schemas.ts:69-92`), the two usage lines inside
`AgentManifestSchema` (`:163`) and `UpdateAgentRequestSchema` (`:342`), and the
barrel re-export (`types.ts:170`) — leaving `AgentBehaviorSchema` untouched.
Then follows the compiler downstream: registry (`agent-registry.ts:110,132,222,434`)
and reconciler (`reconciler.ts:130,206`) code refs (NOT the DB column itself —
that's task 2.1), and all 8 hardcoded seed sites (`agents.ts:135`,
`test-control.ts:81`, `ensure-dorkbot.ts:68`, `agent-creator.ts:264`,
`mesh-discovery.ts:104,148`, `mesh-methods.ts:49` DirectTransport,
`mock-factories.ts:114`). Self-verifying: also fixes the three mesh tests that
directly assert on this code (`agent-registry.test.ts`, `relay-integration.test.ts`,
`reconciler.test.ts`).

- size: lg · priority: high · deps: none · ∥ none (the keystone; everything else
  waits on it) · cites spec §Detailed Design 1–3, §8, §Testing Strategy (Mesh)

---

## Phase 2 — Persistence: drop the `budget_json` column

### Task 2.1: Drop `agents.budget_json` — generated Drizzle migration + rewritten migration test

Edits `packages/db/src/schema/mesh.ts:23-25` to delete the column definition,
runs `pnpm --filter @dorkos/db db:generate` to produce the migration (next index
`0028`; verify the generated SQL is exactly the `DROP COLUMN` statement), and
replaces the stale "has budget_json column" test in `migrations.test.ts:147-165`
with one that proves the column is **absent** via `PRAGMA table_info(agents)`
post-migration.

- size: sm · priority: high · deps: 1.1 · ∥ 3.1, 4.1, 5.1 · cites spec
  §Detailed Design 2, §Technical Dependencies, §Testing Strategy (DB)

---

## Phase 3 — Client UI removal

### Task 3.1: Remove all client UI budget surfaces + 3 dev showcases + tests

Removes the editable "Limits" section from `ToolsTab.tsx` (`:210,213,283-284,351-401`
plus the unused-import cleanup), the `{/* Budget */}` block from `AgentRow.tsx`
(`:213-219`), and the three topology displays (`build-topology-elements.ts:167-172`,
`AgentNode.tsx:28,202`, `TopologyPanel.tsx:54-55`) — an honest absence, no
placeholder. Also cleans the three loosely-typed dev showcases
(`topology-agent-node.tsx`, `settings-mock-data.ts`, `FilterBarShowcase.tsx`)
that escape the compiler. Updates `ToolsTab.test.tsx`, `AgentRow.test.tsx`, and
`build-topology-elements.test.ts` to assert absence.

- size: lg · priority: high · deps: 1.1 · ∥ 2.1, 4.1 · cites spec §Detailed
  Design 4–5, §User Experience, §8, Implementation Phases 4

---

## Phase 4 — Docs + OpenAPI

### Task 4.1: Delete 3 docs references and regenerate OpenAPI

Deletes the budget row/lines from `docs/concepts/mesh.mdx:125`,
`docs/guides/agents.mdx:63`, and `docs/guides/agent-discovery.mdx:164,194-198`,
then regenerates `docs/api/openapi.json` via `pnpm docs:export-api` (never
hand-edited) so the `AgentBudget` schema and its `$ref`s disappear once 1.1's
shared-package build lands. Confirms `openapi-fresh` stays green.

- size: sm · priority: medium · deps: 1.1 · ∥ 2.1, 3.1, 5.1 · cites spec
  §Detailed Design 6, §Technical Dependencies, §API/OpenAPI deltas

---

## Phase 5 — Changelog + draft ADR

### Task 5.1: Changelog fragment (Changed) + draft ADR

Writes `changelog/unreleased/<id>-agent-budget-enforcement.md` (a small honest
Changed entry: an editable control disappears; runaway protection stays the
enforced per-message budget) and drafts the proposed ADR (preferably via
`/adr:from-spec`) recording the honesty decision, the verified single-adapter
reality, the backward-tolerance mechanism, and the correct in-adapter
turn-start signal for any future enforcement — cross-linked to DOR-260 and
ADR-0043.

- size: sm · priority: medium · deps: 3.1 (prose matches the shipped UI removal)
  · ∥ 2.1, 4.1, 6.1 · cites spec §Documentation, §Related ADRs, §Reintroduction path

---

## Phase 6 — Test sweep + full verify

### Task 6.1: Test-fixture sweep (~28 files) + legacy-tolerance round-trip test + clean rebuild + full verify gate

Sweeps the remaining ~28 fixture-only test files (server, client, and packages
— the compiler's authoritative red-file list after `pnpm --filter @dorkos/shared
build && pnpm verify`), adds the new legacy-tolerance round-trip test in
`packages/shared/src/__tests__/manifest.test.ts` (proves strip-on-read +
removed-on-next-write for a stale on-disk `budget` key), clears the stale
`packages/mesh/dist/budget-mapper.*` residue via a clean rebuild, and runs the
full-suite green gate (`pnpm verify` then `pnpm test -- --run`).

- size: lg · priority: high · deps: 1.1, 2.1, 3.1, 4.1 (the final
  everything-green gate) · ∥ 5.1 · cites spec §Detailed Design 7–8,
  §Backward compatibility, §Testing Strategy, Implementation Phases 6

---

## Next stage

`/flow:execute specs/agent-budget-enforcement/02-specification.md`
