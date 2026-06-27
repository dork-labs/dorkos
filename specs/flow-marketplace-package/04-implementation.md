# Implementation Summary: Ship /flow as a portable DorkOS Marketplace plugin

**Created:** 2026-06-26
**Last Updated:** 2026-06-26
**Spec:** specs/flow-marketplace-package/02-specification.md

## Session / Workspace

- **Worktree:** `/Users/doriancollier/.dork/workspaces/dorkos/spec-flow-marketplace-package`
- **Branch:** `spec-flow-marketplace-package` (from `main@37dc1c3e`)
- **Ports:** DORKOS_PORT=4368 VITE_PORT=4518 SITE_PORT=4668
- **Tracker:** DOR-133 (umbrella). Mode: autonomous (operator away; carried to the human-review gate / PR).

## Progress

**Status:** Complete (executable scope). 17 of 18 tasks done; Phase 6 (assembly) deferred, blocked on DOR-145 + DOR-138.
**Tasks Completed:** 17 / 18

## Tasks Completed

### Session 1 - 2026-06-26

- Task 2.1: G8-decouple the 7 generic stage skills from the tracker (`e2a05308`)
- Task 2.2: extend the tracker-confinement guard to enforce G8 (`cbaf098f`)
- Task 3.1: author the adapter contract `adapters/SPEC.md` (16 verbs, INV-1..5) (`dc1fceae`)
- Task 7.1: install/adapter/autonomy docs + amend ADR-0281/0229 (`be12b528`)
- Tasks 1.1/1.5/1.6: relocate `@dorkos/flow` to `.agents/flow/engine` as `@dorkos/flow-engine` (`76dca351`)
- Task 3.3: the `building-adapters` skill (`c4a22eef`)
- Task 4.1: the repo-local config triad (`b2c8b168`)
- Tasks 1.2/1.3: compile the oracles to dependency-free CLI scripts (`0ce87148`)
- Task 4.2: `/flow:init` first-run setup (`de0dcfed`)
- Tasks 1.4/4.3: call the oracle scripts + route first-run setup (`9a19142b`)
- Task 3.2: the adapter conformance harness `validate-adapter.mjs` (`12589f7a`)
- Task 5.1: thin the `flow-drain` Pulse tick (`6f3648a3`)
- Task 3.4: the `linear-mcp` + `linear-composio` reference adapters (`9b9cc515`)

### Not done

- **Task 6.1 (Phase 6, assembly): BLOCKED** on DOR-145 (`dorkos package build`) and DOR-138 (the projection engine), which do not exist yet. Left as the tracked follow-up. `.dork/manifest.json` + `.claude-plugin/plugin.json` + `package build` + dogfood install are deferred to when those land.

## Files Modified/Created

**Engine (relocated + new):**

- `.agents/flow/engine/` - the whole `@dorkos/flow` source + 391-test vitest suite, relocated from `packages/flow/` and renamed `@dorkos/flow-engine` (private, build-only, imported by nothing). `packages/flow/` deleted.
- `.agents/flow/engine/cli/{dispatch,involvement,gates,recovery,validate-config}.ts` + `_shared.ts` - the CLI wrappers.
- `.agents/flow/engine/build.mjs` - esbuild build emitting the scripts.
- `.agents/flow/engine/src/__tests__/{scripts-cli,validate-adapter}.test.ts` - new contract tests.

**Shipped scripts (the runtime artifact):**

- `.agents/flow/scripts/{dispatch,involvement,gates,recovery,validate-config}.mjs` - compiled, dependency-free oracle scripts (validate-config bundles zod). Prettier-ignored (generated).
- `.agents/flow/scripts/validate-adapter.mjs` - the hand-authored conformance harness.

**Adapter contract + references:**

- `.agents/flow/adapters/SPEC.md` - the generic contract (WorkItem model, 16 verbs, INV-1..5).
- `.agents/flow/adapters/reference/{linear-mcp,linear-composio}/SKILL.md` - the two reference adapters.
- `.agents/flow/adapters/reference/fixtures/work-items.{good,bad}.json` - the conformance fixtures.

**Skills + commands:**

- `.agents/flow/skills/{capturing,closing,decomposing,specifying,tending-tracker,triaging,verifying}-work/SKILL.md` - G8-decoupled (generic "adapter" language).
- The same skills + `.claude/commands/flow.md` + `flow/status.md` - rewired to call `node .agents/flow/scripts/<oracle>.mjs`; first-run guard added to `flow.md`.
- `.agents/flow/skills/building-adapters/` + `initializing-flow/` - new skills.
- `.claude/commands/flow/init.md` - the `/flow:init` trigger.
- `.dork/tasks/flow-drain/SKILL.md` - thinned to delegate to one `/flow continue` tick.

**Config + docs + ADRs:**

- `.agents/flow/{config.local.example.json,CONFIG.md}` + `.gitignore` (secrets) - the config triad.
- `docs/guides/flow/{installing-in-your-project,building-your-adapter,bring-your-own-scheduler}.mdx` + `meta.json`.
- `decisions/0281` + `0229` amended; draft ADRs `0294`/`0295`/`0296` seeded (at SPECIFY).

**Build wiring:** `pnpm-workspace.yaml`, `vitest.workspace.ts`, `.prettierignore`, `pnpm-lock.yaml`.

## Verification

- Flow engine: **413 tests pass** (391 relocated + 17 CLI-contract + 5 conformance), typecheck + lint clean.
- Full repo `pnpm test -- --run`: 19/21 packages green; `apps/server` 3036/3038 pass; the one failure (`agents.test.ts` PATCH timeout) is a **confirmed parallel-load flake** (passes in isolation: 29 tests, 33ms) in code this change does not touch.
- Repo-wide typecheck + lint: green on all 13 commits (pre-commit hook).
- Scripts smoke: `node .agents/flow/scripts/dispatch.mjs` on an empty queue returns the correct no-work outcome; `--help` works on all five.
- Tracker-confinement guard: green, now enforcing G8 on the generic stage skills + the building-adapters carve-out.

## Known Issues / Assumptions logged (for the review gate)

- **Interim build = esbuild** (DOR-145 `dorkos package build` not built yet). The five oracle bundles are committed (the shipped artifact) and prettier-ignored so committed == build output.
- **`@dorkos/flow` retired, relocated as `@dorkos/flow-engine`** (private, build-only, imported by nothing) rather than fully dissolved into loose source. This keeps the 391-test suite discoverable by the turbo runner and deps (zod/ajv) resolvable, while honoring ADR-0294's intent (no consumed package; runtime ships as scripts). This is the key reviewable decision.
- **The 16-verb count** (vs the spec's "13"): the `linear-adapter` header's "13" was stale; the typed PMClient enumerates 16. The contract + reference adapters use the real 16.
- **INV-5 (candidate-vs-eligible):** the conformance harness asserts dispatch-admitted items carry `agent/ready`, NOT that the candidate set is ready-only (a literal reading would break starvation detection). Caught during contract authoring.
- **Script path:** the surfaces reference `.agents/flow/scripts/<oracle>.mjs` (correct from repo root in this repo / dogfood). The final portable install path is an assembly-phase (DOR-145) concern.
- **Potential merge collision:** other worktrees may touch `packages/flow`; this branch deletes it. Sequence the merges accordingly.
- **Not hardened:** `.agents/flow/adapters/` is not in the confinement guard's scanned roots, so `SPEC.md` cleanliness is verified by author-time grep, not the guard. Adding `adapters/` as a scanned root with a `reference/` carve-out is a possible future hardening.

## Implementation Notes

### Session 1

Executed autonomously (operator away) across `/flow` DECOMPOSE -> EXECUTE -> VERIFY. Work ran in an isolated gtr worktree, parallelized across background subagents in file-disjoint batches (up to 3 concurrent), one writer per file, with the orchestrator owning all git and verification. Each phase landed as a green commit. Next stage: REVIEW (human gate) via the PR.
