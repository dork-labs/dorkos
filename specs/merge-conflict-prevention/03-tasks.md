# Tasks: merge-conflict-prevention (DOR-184)

Spec: `specs/merge-conflict-prevention/02-specification.md` · Mode: full · Generated 2026-07-03

Execution order is validate-first: prove the design in throwaway repos (Phase 1) before touching
the live registries (Phase 2+). Terminal state for autonomous execution is opened PRs parked at
the always-on human-review gate; no self-merge of the breaking manifest reshape.

## Phase 1 — Host core + validation

### Task 1.1: Add timestamp id generator `.claude/scripts/id.ts`

`generateId(now?)` -> UTC `YYMMDD-HHMMSS`; `isTimestampId`/`isLegacyId`/`parseIdDate`; injectable
clock; zero deps. Unit tests: format, padding, chronological string sort, legacy-sorts-before-new.
Size: small · deps: none · parallel: 1.2

### Task 1.2: Ephemeral-repo merge harness (with negative controls)

Vitest suite spinning real git repos in `mkdtemp`. Cases: (A) old array+nextNumber scheme
CONFLICTS; (B) object-keyed timestamp scheme AUTO-MERGES; (C) changelog `merge=union` tangles;
(D) per-section sentinel anchors AUTO-MERGE. Must be able to fail. Size: large · deps: 1.1

## Phase 2 — Host surfaces

### Task 2.1: Reshape manifests to id-keyed (version 2)

Migration script: `{version, nextNumber, [array]}` -> `{version: 2, {idKey: {id, ...}}}`; legacy
number becomes the string key + id; drop `nextNumber`; preserve all fields; same entry count.
Size: medium · deps: 1.2

### Task 2.2: Update `spec-manifest-ops.ts` + `adr-drift-check.mjs`

All commands operate on the id-keyed shape; `add` allocates a timestamp id (no nextNumber).
Drift-check reads id-keyed, accepts both filename forms, flags duplicate ids. Size: large · deps: 2.1

### Task 2.3: Templates + adr commands + `.gitattributes`

`/adr:create`, `/adr:from-spec`, ADR/spec templates, writing-adrs/managing-specs -> timestamp ids +
id-keyed entries. Add `.gitattributes` (optional mergiraf opt-in; lockfile marker). No changelog
union. Size: medium · deps: 2.2

## Phase 3 — Changelog

### Task 3.1: Per-section sentinel anchors + populator

Anchor per `[Unreleased]` subsection; `changelog-populator.py` inserts above the anchor + dedups.
Size: medium · deps: 1.2 · parallel: 2.1

## Phase 4 — Plugin delegation (marketplace PR)

### Task 4.1: Flow plugin delegates id-allocation to host

Edit `plugins/flow/skills/specifying-work/SKILL.md` steps 7-8 + `templates/docs/adr.md` to delegate
to host tooling; keep harness-neutral; plugin tests green; open PR coordinated with DOR-133; no
merge. Size: medium · deps: 2.2 · parallel: 5.1

## Phase 5 — Docs

### Task 5.1: Document id convention, changelog sentinel, optional driver

`contributing/` guide + `AGENTS.md` Artifacts section. Size: small · deps: 2.3 · parallel: 4.1

## Critical path

1.1 -> 1.2 -> 2.1 -> 2.2 -> 2.3 -> (4.1 ∥ 5.1). 3.1 runs parallel to 2.1 after 1.2. No sub-issues
promoted (all tasks below the xl threshold).
