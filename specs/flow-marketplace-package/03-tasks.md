# Tasks — Ship /flow as a portable DorkOS Marketplace plugin

> Decomposed from `specs/flow-marketplace-package/02-specification.md` (#264, DOR-133).
> Mode: full. Canonical machine form: `03-tasks.json`. 18 tasks across 7 phases.

## Dependency tree

```
Phase 1 (Scripts engine) ─────────────────────────── critical path
  1.1 move engine -> .agents/flow/engine/   [head]
   ├─ 1.2 esbuild oracle build -> scripts/*.mjs
   │    └─ 1.3 oracle CLI wrappers + contract tests
   │         ├─ 1.4 rewire skills to call scripts  (also needs 2.1)
   │         │    └─ 1.5 delete packages/flow + purge refs  (also needs 1.1)
   │         └─ 1.6 wire engine tests into runner
   └─ (1.6 also depends on 1.1)

Phase 2 (G8 decoupling) ── independent of P1/P3 (parallelWith 1.1, 3.1)
  2.1 strip tracker strings from 8 stage skills  [head]
   └─ 2.2 extend tracker-confinement guard for G8

Phase 3 (Adapter-builder) ── independent of P1/P2 (parallelWith 1.1, 2.1)
  3.1 author adapter contract (SPEC.md + WorkItem + 13 verbs)  [head]
   ├─ 3.2 validate-adapter.mjs + fake tracker fixture
   │    ├─ 3.3 building-adapters skill
   │    └─ 3.4 recast linear-adapter -> reference adapters
   └─ (3.3, 3.4 both depend on 3.2)

Phase 4 (/flow:init + config) ── needs Phase 3
  4.1 repo-local config shape          (needs 3.1)
  4.2 /flow:init command + skill        (needs 3.3, 4.1)
   └─ 4.3 orchestrator routes to init   (needs 4.2)

Phase 5 (Capability-model tick)
  5.1 thin flow-drain tick             (needs 1.4)

Phase 7 (Cross-cutting docs + ADRs)
  7.1 amend ADRs + docs pages          (independent; lands last)

Phase 6 (Assembly) ── BLOCKED on DOR-145 + DOR-138 (not built)
  6.1 manifest + plugin.json + package build + dogfood install
      (internal deps 1.5, 2.2, 3.4, 4.2; external DOR-145, DOR-138)
```

## Critical paths

- **Engine chain (longest):** `1.1 -> 1.2 -> 1.3 -> 1.4 -> 1.5`. The `1.4 -> 2.1`
  cross-edge means the G8 skill decouple (2.1) must land before the skill rewire (1.4),
  so they edit each stage skill once, not twice.
- **Adapter chain:** `3.1 -> 3.2 -> 3.3 -> 4.2 -> 4.3` (Phase 3 feeds Phase 4).
- **Three independent heads** can start at once: `1.1`, `2.1`, `3.1`.

## Execution order chosen for this autonomous run

Optimized for green, low-risk-first increments (each phase a green commit):

1. **Phase 2** (G8 decouple) — independent, prose-only, extends an existing guard. The true portability gate.
2. **Phase 3** (adapter-builder) — fully additive new files; nothing existing breaks.
3. **Phase 1** (engine -> scripts, delete package, rewire skills) — the invasive refactor; `1.4` rewire runs after `2.1`.
4. **Phase 4** (/flow:init + config) — depends on Phase 3.
5. **Phase 5** (thin the tick) — small interim.
6. **Phase 7** (docs + ADRs) — lands last.
7. **Phase 6** (assembly) — **blocked**; left as the tracked follow-up (DOR-145 + DOR-138).

## Tasks by phase

### Phase 1 — Scripts engine

- **1.1** Move `@dorkos/flow` source + 388-test vitest suite into `.agents/flow/engine/`. _(large)_
- **1.2** esbuild step compiling oracle entrypoints to dependency-free `.agents/flow/scripts/*.mjs` (bundles Zod into `validate-config.mjs`). _(large)_
- **1.3** Oracle CLI wrappers (`dispatch`, `involvement`, `gates`, `recovery`, `validate-config`) + CLI-contract tests. _(large)_
- **1.4** Rewire stage skills + orchestrator + `/flow auto` to call the scripts (after 2.1). _(large)_
- **1.5** Delete `packages/flow`; purge refs; re-home the tracker-confinement guard. _(medium)_
- **1.6** Confirm the 388 tests + new script tests run in the engine home and are wired into `pnpm test`. _(medium)_

### Phase 2 — G8 decoupling

- **2.1** Strip leaked tracker strings from the 8 generic stage skills (triaging 16, verifying 10, capturing 10, closing 9, specifying 8, decomposing 6, tending 5). _(large)_
- **2.2** Extend the tracker-confinement guard to assert each stage skill is tracker-clean. _(medium)_

### Phase 3 — Adapter-builder

- **3.1** Author the adapter contract `.agents/flow/adapters/SPEC.md` (WorkItem schema + exactly 13 verbs + conformance invariants). _(large)_
- **3.2** `validate-adapter.mjs` conformance harness + fake in-memory tracker fixture + vitest contract test. _(large)_
- **3.3** `building-adapters` skill (generate-and-verify loop). _(medium)_
- **3.4** Recast `linear-adapter` into `linear-mcp` + `linear-composio` reference adapters under `adapters/reference/`. _(medium)_

### Phase 4 — /flow:init + config

- **4.1** Repo-local config triad: committed `config.json` + gitignored `config.local.json` + env override. _(medium)_
- **4.2** `/flow:init` command + `initializing-flow` skill (first-run setup, adapter generation, secrets gitignore). _(large)_
- **4.3** Orchestrator routes to `/flow:init` on missing config. _(small)_

### Phase 5 — Capability-model tick

- **5.1** Thin `flow-drain` to delegate to the canonical single tick; `enabled:false`. _(small)_

### Phase 7 — Cross-cutting

- **7.1** Amend ADR-0281/0229, keep draft ADRs 0294/0295/0296 consistent, add `docs/guides/flow/` pages. _(medium)_

### Phase 6 — Assembly (BLOCKED)

- **6.1** `.dork/manifest.json` + `.claude-plugin/plugin.json` + `dorkos package build` + dogfood install. **Blocked on DOR-145 + DOR-138.** _(large)_
