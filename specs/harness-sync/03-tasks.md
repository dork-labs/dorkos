# Harness Sync — Task Breakdown (DECOMPOSE)

**Spec:** `specs/harness-sync/02-specification.md` · **Slug:** harness-sync · **Mode:** full · **Generated:** 2026-06-29

Filesystem (`03-tasks.json`) is canonical; the tracker holds pointers + state. Each task maps to its
existing roadmap issue (B4–B11) or the two net-new issues created during decompose (DOR-173 Q1,
DOR-174 Q2). Most issues pre-existed (the roadmap filed them); decompose reconciles them to the spec
phases, sets dependencies, and readies the dependency-free Phase-1 starters.

## Phase 1 — Core engine (the active phase)

| Task | Title                                                                                    | Issue                        | Size | Depends on    |
| ---- | ---------------------------------------------------------------------------------------- | ---------------------------- | ---- | ------------- |
| 1.1  | Vendor rulesync maps + Gemini maps + re-vendor checklist                                 | DOR-139                      | M    | — **(ready)** |
| 1.2  | Slimmed HarnessManifest Zod schema + migrate the manifest                                | DOR-140                      | M    | — **(ready)** |
| 1.3  | `@dorkos/harness` core engine (scanner · projector · apply · Codex hook gen · drop list) | DOR-138                      | XL   | 1.1, 1.2      |
| 1.4  | `dorkos harness sync --check/--fix` CLI                                                  | DOR-141                      | M    | 1.3           |
| 1.5  | Fix the two stale design docs                                                            | _(checklist; under DOR-138)_ | S    | 1.3           |

**Critical path:** 1.1 ∥ 1.2 → 1.3 → 1.4. The two starters (1.1, 1.2) run in parallel with no
unmet dependencies; everything else gates on the engine (1.3).

## Phase 2 — Scaffolding, installed-plugin projection & UI

| Task | Title                                                             | Issue       | Size | Depends on |
| ---- | ----------------------------------------------------------------- | ----------- | ---- | ---------- |
| 2.1  | Instruction scaffolding helper + wire into `createAgentWorkspace` | DOR-142     | M    | 1.3        |
| 2.2  | Multi-source projection: marketplace-installed plugins (Q1)       | **DOR-173** | L    | 1.3        |
| 2.3  | Harnesses UI surface + `/api/harness/*`                           | DOR-144     | L    | 1.3, 1.4   |
| 2.4  | Integrate projection into agent creation (From Template)          | DOR-153     | M    | 2.1        |

2.1, 2.2, 2.3 are parallelizable once the engine (1.3) lands.

## Phase 3 — Breadth & adopt

| Task | Title                                                     | Issue       | Size | Depends on |
| ---- | --------------------------------------------------------- | ----------- | ---- | ---------- |
| 3.1  | Per-agent generators: Cursor → Gemini → Copilot           | DOR-143     | L    | 1.3, 1.1   |
| 3.2  | `dorkos harness adopt` — promote agent-native assets (Q2) | **DOR-174** | L    | 1.3        |

Fast-follows (noted in 3.2): hook-adopt, command-adopt (= rewrite as skill), MCP-server projection.

## Testing strategy (per-task acceptance lives in `03-tasks.json` → `verification`)

Harness Sync is **mostly pure filesystem logic, so the bulk is unit + integration, not browser** —
only the Harnesses UI is browser-tested. Four tiers + a live smoke:

| Tier                            | What it covers                                                                                                                                                                                               | Tooling                                                 | Browser? |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------- | -------- |
| **Unit**                        | maps round-trip, schema accept/reject, scanner derivation, projector plan, hook mapping, drop-list, idempotency, collision/provenance, conflict-stop                                                         | Vitest + in-memory/temp fs                              | no       |
| **Integration** (real-scenario) | run the projection against a fixture repo, assert the **actual files** (symlinks resolve, valid `.codex/hooks.json`, scaffolded instructions); CLI `--check`/`--fix`; install→sweep; server `/api/harness/*` | Vitest temp-dir + supertest                             | no       |
| **Component + Browser**         | the Harnesses page: status chips, drift banner, Re-sync, drop-list, states                                                                                                                                   | Vitest jsdom + Playwright (`apps/e2e`) + Dev Playground | **yes**  |
| **Live cross-harness**          | does Codex/Cursor actually load the projected skill / fire the hook                                                                                                                                          | scripted/manual smoke at VERIFY (not CI)                | n/a      |

The live smoke is the highest-confidence "does it really work" check but can't be fully automated
(another vendor's runtime + auth), so CI asserts the file-shape and the manual smoke confirms the
runtime load — starting with Codex (the Phase-1 target).

## Summary

- **11 tasks** across 3 phases; **10 mapped to tracker issues** (8 pre-existing B-issues + DOR-173/174),
  1 checklist-only (1.5).
- **Ready for dispatch now:** DOR-139, DOR-140 (`agent/ready`). The rest unblock as their dependencies land.
- **Next stage:** EXECUTE — `/flow:execute specs/harness-sync/02-specification.md` (start with the two Phase-1 starters).
