# Implementation Summary: Unified Workflow System — the `/flow` engine

**Created:** 2026-06-14
**Last Updated:** 2026-06-14
**Spec:** specs/unified-workflow-system/02-specification.md

## Progress

**Status:** Complete
**Tasks Completed:** 20 / 20

## Session

- **Session 1** — 2026-06-14
- **Worktree:** `spec-unified-workflow-system` (branch `spec-unified-workflow-system`), executing in place (Phase 0: already in a secondary worktree).
- **Git base:** `3d67e89e` (decompose + ADR curation commit).
- **Cleanup:** on completion, merge via PR then `/worktree:remove spec-unified-workflow-system --delete-branch`.

## Tasks Completed

### Session 1 - 2026-06-14

- Task #1 (0.1): Stand up the `.agents/flow/` marketplace plugin-type package skeleton
- Task #2 (0.2): Register the flow bundle in harness-sync wiring (`skillBundles[]`, per-skill symlink mechanism)
- Task #3 (0.3): Define the Zod config schema + generate `config.schema.json` — **engine home = `packages/flow/` (`@dorkos/flow`)**
- Task #4 (1.1): Build the `linear-adapter` skill (v1 PMClient prose contract) — ALL flow tracker I/O confined here; flow-bundle-scoped grep guard + 36-case doc-completeness test
- Task #5 (1.2): `capturing-work` + `triaging-work` stage skills + thin `/flow:capture`, `/flow:triage` (21 LOC each)
- Task #6 (1.3): `specifying-work` skill + minimal `ideating-features` pointer edit + 4 externalized doc templates + thin `/flow:ideate`, `/flow:specify` (22 LOC each)
- Task #7 (1.4): `decomposing-work` + `verifying-work` + `closing-work` skills + minimal `executing-specs` pointer edit + thin `/flow:decompose`, `/flow:execute`, `/flow:verify`, `/flow:done` (16–19 LOC)
- Task #9 (1.6): `@dorkos/flow` `tasks-schema.ts` — `03-tasks.json` schema + `issue`/`parentIssue`, XOR provenance block, `isPromotableToSubIssue` (17 tests)
- Task #8 (1.5): `/flow` orchestrator command (38 LOC, command↔stage map) + hard-rename — removed 10 legacy commands (`/ideate`, `/ideate-to-spec`, `/pm`, `/review-recent-work`, `/spec:{create,decompose,execute,tasks-sync}`, `/linear:{idea,done}`) + empty `linear/` dir; fixed `/spec:feedback` refs → `/flow:{execute,decompose}`
- Task #10 (2.1): `packages/flow/src/calibration.ts` — `resolveInvolvement` uncertainty-gated ladder (§5, the core behavior), 53 table-driven tests
- Task #11 (2.2): `packages/flow/src/work-item.ts` (shared `WorkItem` TS type) + `dispatch.ts` — two-pass eligibility filter + 7-tier ranking ladder (§4), 29 tests; ownership-class injected (3.1 seam)
- Task #12 (2.3): `packages/flow/src/gates.ts` — 4 hard gates + auto-merge recovery ladder (§5/§6); `evaluateAutoMerge` routes mechanical-vs-functional through `resolveInvolvement`; 30 tests (suite 181/181)
- Task #13 (2.4): `flow-loop.mjs` Stop hook (replaces `autonomous-check.mjs`, reads canonical `.dork/flow/auto-run.json` sentinel, FAIL-OPEN no-op unless `/flow auto` active — verified) + `comms.ts` + `comment-response.ts` + `/flow auto` drain in `flow.md` (2×2 mode matrix); 31 tests (suite 212/212)
- Task #14 (2.5): `.dork/tasks/flow-drain/SKILL.md` — autonomous loop seated on the existing Pulse scheduler (one tick = one issue, fresh session); Pulse-seat integration test (real chokidar+croner, `FakeAgentRuntime`) + stage→projection test; 17 tests (`@dorkos/flow` suite 226/226). Added `.dork/flow/` to `.gitignore` (runtime sentinel); `.dork/tasks/` stays tracked.

**P2 committed:** `ccd442e2`.

- Task #15 (3.1): `packages/flow/src/identity.ts` — `classifyOwnership` (the one primitive both dispatch + comment-response inject) + `resolveIdentityMode` (shared vs two-account, detected from `reviewer`); 22 tests (suite 248/248)
- Task #16 (3.2): `.agents/flow/skills/tending-tracker/SKILL.md` — the team-member loop (inbox polling, 5 comment-response rules wired to real `classifyOwnership`, durable `agent/*` claims, `needsInput` handoff, calibration-driven soft-escalation, answers→memory) + 12-test integration suite. Registered + symlinked. (Live shared-tracker dry run = manual human step.)
- Task #17 (3.3): `packages/flow/src/flow-run.ts` — durable `FlowRun` (session↔issue) + next-tick recovery ladder; `needs-input` never reclaimed; resume (re-attach worktree at HEAD + resume session) not restart; over-`maxRetries` → `agent/blocked`; 16 tests (suite 276/276)

**P3 committed:** `c10ffa32`.

- Task #18 (4.1): `packages/flow/src/evidence.ts` (`selectEvidence`, 22 tests, suite 298) + VERIFY proof pipeline prose in `verifying-work` (v1-vs-P5/DOR-95 boundary) + `apps/e2e/tests/flow/verify-proof-pipeline.spec.ts` (real WebM + bundle→PR/tracker stub, runs headless)
- Task #19 (4.2): templates set (`templates/records/{idea,research,hypothesis,task,project}.md`, `pr.md`, `templates/README.md`) + `.agents/flow/README.md`/`SPEC.md` filled + `contributing/flow-engine.md` (+ INDEX) + AGENTS.md `/flow Workflow` section + Compact Instructions block + removed-command reference sweep (working-in-worktrees, executing-specs, parallel-execution, writing-adrs)
- Task #20 (5.1): added the **P5 — Flow Engine — Extension (NOT built here)** section to `.agents/flow/SPEC.md` — documents what P5 promotes (server `PMClient`, webhook/Agent Accounts, `WorkspaceManager`, unattended evidence DOR-95, heartbeat/fencing DOR-89, 2nd PM adapter) + reaffirmed non-goals. Docs-only; no server code. The v1 promotion surface (config schema + `PMClient` verbs + `FlowRun` + typed engine) is documented in SPEC.md.

## Outcome

**All 20 tasks complete across P0–P5.** Five phase commits on `spec-unified-workflow-system`: `bc4009af` (P0) · `662eba7a` (P1) · `ccd442e2` (P2) · `c10ffa32` (P3) · P4/P5 (this commit). The `/flow` engine ships as a `.agents/flow/` marketplace plugin bundle (8 skills + 9 commands + templates + config) with the typed core in `@dorkos/flow` (298 unit tests), the autonomous loop seated on Pulse, and the legacy `/ideate`·`/pm`·`/spec:*`·`/linear:*` surface hard-renamed away. P5 (server Extension) is documented-only, out of scope.

Manual follow-ups (carried in Known Issues): the live shared-Linear dry run (3.2 acceptance), and eventual `linear-loop`/legacy-skill retirement (staged migration).

## Files Modified/Created

**Source files:**

- `.agents/flow/README.md` — bundle manual (headings scaffolded; prose lands later)
- `.agents/flow/SPEC.md` — bundle contract (stage model, PMClient placeholder, FlowRun, config schema ref)
- `.agents/flow/config.json` — §9 resolved defaults, verbatim; `$schema: ./config.schema.json`
- `.agents/flow/manifest.json` — plugin-type marketplace manifest; `members` block (config/skills/commands/hooks/templates) with honest projection split
- `.agents/flow/skills/.gitkeep`, `.agents/flow/templates/.gitkeep` — track empty dirs
- `.claude-plugin/plugin.json` — Claude Code plugin manifest (name/version/description)
- `.agents/harness.manifest.json` — `skillBundles[]` entry registering the flow bundle (per-skill symlink; P1 skills append to `skillBundles[0].skills`)
- `packages/flow/` — **new `@dorkos/flow` workspace package** (the engine's typed core): `package.json`, `tsconfig.json`, `eslint.config.js`, `vitest.config.ts`, `src/config-schema.ts` (authoritative Zod schema, all sub-schemas exported), `src/generate-config-schema.ts` (`z.toJSONSchema` bridge), `src/index.ts` (barrel), `scripts/generate-config-schema.ts` (CLI generator)
- `.agents/flow/config.schema.json` — generated artifact (config.json `$schema` target)

**Test files:**

- `packages/flow/src/__tests__/config-schema.test.ts` — 13 tests (parse/reject, `z.toJSONSchema` round-trip via Ajv, default resolution, generated-schema-validates-config.json)
- `packages/flow/src/__tests__/tracker-confinement.test.ts` — grep guard (flow-bundle-scoped: zero tracker strings outside `linear-adapter`)
- `packages/flow/src/__tests__/linear-adapter-doc.test.ts` — 36-case adapter doc-completeness

**1.1 additions:** `.agents/flow/skills/linear-adapter/SKILL.md` (the adapter); `.agents/harness.manifest.json` `skillBundles[0].skills` registers `linear-adapter`; symlink `.claude/skills/linear-adapter → ../../.agents/flow/skills/linear-adapter`.

**Downstream contract (relay to P1–P3 engine tasks):** import from `@dorkos/flow` barrel or `@dorkos/flow/config-schema`; extend `packages/flow/src/config-schema.ts`; nested-object defaults use Zod v4 `.prefault({})` (not `.default({})`); top-level schema is `.strict()`; `zod@^4.3.6`.

**P1 additions (1.1–1.6):**

- `.agents/flow/skills/{linear-adapter, capturing-work, triaging-work, specifying-work, decomposing-work, verifying-work, closing-work}/SKILL.md` — the adapter + 6 gerund stage skills (all registered in `.agents/harness.manifest.json` `skillBundles[0].skills` + symlinked into `.claude/skills/`)
- `.claude/commands/flow.md` (orchestrator) + `.claude/commands/flow/{capture,triage,ideate,specify,decompose,execute,verify,done}.md` (thin ≤40-LOC triggers)
- `.agents/flow/templates/docs/{ideation.md, specification.md, tasks.json, adr.md}` — doc scaffolds externalized from the legacy `/ideate`·`/spec:create`·`/spec:decompose`
- `packages/flow/src/tasks-schema.ts` (+ barrel) — canonical `03-tasks.json` schema + provenance block
- Edited (minimal pointers to the unified stage model): `.agents/skills/ideating-features/SKILL.md`, `.claude/skills/executing-specs/SKILL.md`
- Deleted: 10 legacy command files; edited `.claude/commands/spec/feedback.md` (ref rename)

**Test files (P1):** `packages/flow/src/__tests__/{tracker-confinement, linear-adapter-doc, tasks-schema}.test.ts` — full `@dorkos/flow` suite 69/69.

**Test files:**

_(None yet)_

## Known Issues

- **Deferred doc/reference sweep (→ task 4.2):** the hard-rename (1.5) removed 10 legacy commands, but broader documentation still references them — `AGENTS.md` (Linear/Worktrees/loop sections), skill-internal "Integration with Other Commands" tables (e.g. `executing-specs`), and `contributing/` guides. Task 4.2 explicitly owns the `AGENTS.md` `/flow` section + pointing the named skills at the unified model; the full reference sweep lands there. Flow-bundle lineage notes ("absorbs the legacy `/spec:decompose`") are intentional/accurate and kept.
- **`specs/manifest.json` status:** a spec-lifecycle hook flipped `unified-workflow-system` → `implemented` on the first `04-implementation.md` write (premature during execution; self-consistent once all phases land — the skill sets it at the end regardless).
- **Legacy skills retained (staged migration):** superseded skills (`capturing-linear-ideas`, `closing-linear-loop`, etc.) are intentionally NOT deleted (per `project_dual_harness_skills`: command↔skill duplication is an intentional staged migration). 1.5 removed only the command surface.

## Implementation Notes

### Session 1

Execution strategy (adapted from the `executing-specs` skill for this spec's coupling):

- **Git ownership:** implementation agents do NOT commit; the orchestrator (main context) owns all git and commits at phase boundaries (one-writer rule; lets the changelog-populator post-commit hook be suppressed for docs commits).
- **Parallelism:** only file-disjoint tasks run concurrently. Tasks sharing `.agents/flow/manifest.json`, the harness manifest, or the common engine source tree are serialized.
- **Gates:** holistic batch/phase-level review (not the skill's default per-task two-stage review), per established repo preference.
- **Analysis agent skipped:** the dependency graph and batch plan were computed inline from `03-tasks.json` (avoids a redundant agent).

Computed batch plan (topological over the 03-tasks.json dependency graph):

- **P0:** 0.1 → {0.2, 0.3}
- **P1:** 1.1 → {1.2, 1.3, 1.4 ∥ 1.6} → 1.5
- **P2:** {2.1, 2.2} → 2.3 → 2.4 → 2.5
- **P3:** 3.1 → {3.2, 3.3}
- **P4:** 4.1 → 4.2
- **P5:** 5.1 (docs-only; server build NOT built here)
