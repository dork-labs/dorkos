---
slug: merge-conflict-prevention
id: 260703-193514
created: 2026-07-03
status: ideation
linearIssue: DOR-184
---

# Prevent Multi-Agent Merge Conflicts in Shared Registries and Identifiers

**Slug:** merge-conflict-prevention
**Author:** Dorian
**Date:** 2026-07-03

---

## 1) Intent & Assumptions

- **Task brief:** DorkOS runs many AI agents concurrently and must keep doing so. Merge
  conflicts recur almost exclusively in shared registry / generated files and in
  counter-allocated identifiers (near-zero application-source conflicts). Eliminate that
  conflict class **structurally** so parallel agents stop colliding, without slowing anyone
  down or adding fragile per-clone setup. Three incident logs at `.temp/conflict-incidents/`
  (2026-06-27/28) document the pattern: `decisions/manifest.json` + `specs/manifest.json`
  (the `nextNumber` counter and add/add collisions on numbered files, e.g. two different
  `0294-*.md`), `CHANGELOG.md` `[Unreleased]`, and `pnpm-lock.yaml`.

- **Assumptions (settled by the operator 2026-07-03; do not re-litigate):**
  1. **Root cause is branch-level, not a filesystem race.** Two branches each read their own
     `nextNumber` and pick the same value. Advisory locking (`flock`) cannot fix this; only a
     coordination-free identifier scheme (or merge-time allocation) can.
  2. **Prevention over merge-time resolution.** Custom merge drivers and `merge=union` do NOT
     run on GitHub's server-side merge button and require a per-clone `.git/config` bootstrap
     that fails silently. DorkOS merges via GitHub, so a driver is the wrong primary layer.
  3. **Identifier scheme: timestamp ids going forward** (`YYMMDD-HHMMSS`). The ~260 existing
     numbered ADRs/specs stay frozen (renumbering would break thousands of cross-references,
     the opposite of reducing churn). New artifacts stamp their own creation-time id, so
     allocation never collides. Legacy 4-digit ids (start with `0`) sort cleanly before new
     ids (start with `2`).
  4. **Manifests become id-keyed with no `nextNumber` counter,** so two branches adding
     different entries are different keys and auto-merge with the DEFAULT git driver.
  5. **CHANGELOG uses a per-section sentinel anchor** (`### Added / ### Changed / ### Removed`),
     which is default-driver and GitHub-merge compatible. NOT `union` (our multi-section block
     is exactly union's unsafe case; scikit-learn #21516 hit it).
  6. **Validate with an ephemeral-repo test harness** (Vitest driving `mkdtemp` + `git init` +
     divergent branches + merge + assert), never the real repo.

- **Out of scope:**
  - Application-source merge conflicts (not the problem; near-zero observed).
  - Renumbering or migrating the ~260 existing ADRs/specs (frozen permanently).
  - EXECUTE-stage worktree mechanics — the "one checkout, one writer" policy already exists in
    `executing-specs` Phase 0; this work does not change it.
  - A hosted/server-side merge service.
  - Deep `pnpm-lock.yaml` redesign — keep the proven `pnpm install` + `--frozen-lockfile`
    recipe unless a trivially better default emerges in SPECIFY.

## 2) Pre-reading Log

- `.temp/conflict-incidents/{incidents.md, 2026-06-27-app-upgrade.md, 2026-06-27-canvas-blintz-reconcile.md}`:
  every conflict is a shared registry/generated file or a doc both sides added independently;
  the `0294` ADR add/add is the canonical identifier collision.
- `research/20260703_multi_agent_merge_conflict_prevention.md`: full survey + ~30 citations;
  union pitfalls, custom-driver limits, GitHub server-side constraint, JSON-driver landscape,
  ephemeral-repo testing pattern, id anti-pattern (TypeDoc #2188).
- `.claude/scripts/spec-manifest-ops.ts` `cmdAdd` (lines 296-309): `number: manifest.nextNumber`
  then `manifest.nextNumber++` — the host-side counter allocator.
- `plugins/flow/skills/specifying-work/SKILL.md` steps 7-8: "numbered from `decisions/manifest.json`
  `nextNumber`, increment it"; `plugins/flow/templates/docs/adr.md`: `number: NNNN` + increment
  comment + `NNNN-<slug>.md` filename. The only plugin-side encodings of the counter mechanic.
- `plugins/flow/skills/executing-specs/SKILL.md` (lines 325-330): already decoupled — "use your
  harness's manifest-maintenance command... skip if no manifest." The delegation pattern to copy.
- `.claude/git-hooks/changelog-populator.py`: post-commit hook that appends to `[Unreleased]`;
  the only writer of `CHANGELOG.md`. The plugin has zero changelog logic.
- `CHANGELOG.md`: `[Unreleased]` is multi-section (`### Added/### Changed/### Removed`).
- `AGENTS.md` Worktrees section: "one checkout, one writer"; intent stages stay in `main`,
  isolation begins at EXECUTE.

## 3) Codebase Map

- **Host-side (dorkos) — where the substance lives:**
  - `.claude/scripts/spec-manifest-ops.ts` — becomes the timestamp-id allocator + id-keyed writer.
  - `.claude/scripts/adr-drift-check.mjs` — keep as the safety-net that flags collisions/orphans.
  - `decisions/manifest.json`, `specs/manifest.json` — restructure from `{nextNumber, array}` to
    id-keyed. (Specs are already `specs/<slug>/` dirs; only the manifest/frontmatter carry a number.)
  - `decisions/NNNN-<slug>.md` — new ADRs become `<id>-<slug>.md`; legacy files untouched.
  - `.claude/commands/adr/*` (`/adr:create`, `/adr:from-spec`), `writing-adrs`, `managing-specs`.
  - `.claude/git-hooks/changelog-populator.py` + `CHANGELOG.md` — per-section sentinel anchors.
  - `.gitattributes` — none exists today; add if we adopt any local driver / union carve-out.
- **Plugin-side (marketplace `plugins/flow/`) — small delegation refactor, lands via PR:**
  - `skills/specifying-work/SKILL.md` steps 7-8 — delegate id allocation to host tooling.
  - `templates/docs/adr.md` — `number: NNNN` → `id:`; drop the increment comment; filename pattern.
  - Read-only touch points (`ideating-features`, `closing-work`, `executing-specs`,
    `templates/records/project.md`) — no behavior change; only affected if manifest shape changes,
    and they reference it loosely in prose.
- **Potential blast radius:** any tool that PARSES a manifest by `number` or as an array (host
  scripts, `/adr:list`, drift-check). Prose cross-references stay valid because legacy ids freeze.
- **Config/owners:** flow plugin is mid-extraction under spec #266 / DOR-133; plugin edits must
  coordinate with that branch/PR.

## 4) Root Cause Analysis

- **Repro:** two branches each run SPECIFY (or `/adr:create`) from their own view of
  `nextNumber: N`; both allocate `N`, both write `N+1`. On merge: manifest content conflict on
  `nextNumber` plus an add/add collision on `N-<slug>.md`.
- **Observed vs expected:** a conflict on essentially every concurrent registry touch, vs a clean
  auto-merge when two agents register unrelated artifacts.
- **Evidence:** incident log `2026-06-27-canvas-blintz-reconcile.md` (two `0294-*.md`);
  `spec-manifest-ops.ts` lines 296-309; `specifying-work` steps 7-8.
- **Root-cause hypotheses:**
  - (high) A single shared mutable counter allocated at author-time on divergent branches. The
    counter is the contention point; the numbered filename is the collateral collision.
  - (rejected) A runtime concurrency race solvable by locking — refuted: the colliding branches
    are separated in time, not racing on one file.
- **Decision:** remove the shared counter; mint coordination-free ids (timestamp) so no two
  branches can allocate the same identifier regardless of ordering.

## 5) Research

Full detail + citations in `research/20260703_multi_agent_merge_conflict_prevention.md`. Options
weighed:

1. **`merge=union` for everything** — rejected. Does not run on GitHub server-side merge; unsafe
   for our multi-section changelog (interleaves / mis-files entries); would corrupt JSON.
2. **Custom JSON merge driver as the primary fix** — rejected as primary. Needs per-clone
   `.git/config` bootstrap (silent fallback when absent) and does not run on GitHub server-side
   merges. Viable only as an optional local belt-and-suspenders (e.g. `mergiraf`).
3. **`flock` / advisory locking on the manifest** — rejected. Solves same-instant same-machine
   races; our collisions are branch-level.
4. **Merge-time sequential numbering** (assign the next number on merge to `main` via CI) —
   viable; preserves dense pretty numbers but adds a post-merge assigner and the number is
   unknown until merge. Not chosen (more machinery than the operator wants).
5. **Slug as primary key** — viable; simplest merge story but drops the numeric handle and
   chronological listing. Partially adopted (manifests become key-based).
6. **Timestamp ids + id-keyed manifests + per-section changelog sentinels** — **chosen.** Zero
   coordination, collision-proof in practice, chronological sort preserved, GitHub-merge
   compatible, no per-clone setup. Manifests may later be generated from per-file frontmatter
   (regenerate-don't-merge) — flagged as an open option, not required for v1.

**Recommendation:** ship the prevention bundle (assumptions 3-5), validated by the ephemeral-repo
harness (assumption 6), with the plugin delegating id allocation to host tooling so it stays
harness-neutral.

## 6) Decisions

| #   | Decision             | Choice                                                                                  | Rationale                                                                                        |
| --- | -------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 1   | Layer to fix at      | Prevent structurally, not resolve at merge time                                         | Merge drivers/union don't run on GitHub server-side merges + need per-clone bootstrap            |
| 2   | Identifier scheme    | Timestamp `YYMMDD-HHMMSS` for NEW artifacts; freeze the ~260 existing numbered ones     | Coordination-free = collision-proof; no renumbering churn; legacy sorts before new               |
| 3   | Manifest structure   | Id-keyed object, drop `nextNumber` counter                                              | Different keys auto-merge with the DEFAULT driver; kills both the counter and array conflicts    |
| 4   | CHANGELOG            | Per-section sentinel anchor, not `union`                                                | Default-driver + GitHub compatible; union is unsafe for our multi-section block                  |
| 5   | Plugin vs host split | Plugin DELEGATES id allocation to host tooling; DorkOS timestamp scheme lives host-side | Keeps the marketplace plugin harness-neutral; matches the pattern `executing-specs` already uses |
| 6   | Validation           | Ephemeral-repo Vitest harness (mkdtemp + git + divergent branches + merge + assert)     | Hermetic, reproducible, permanent regression guard; never pollute the real repo                  |
| 7   | Drift-check          | Keep `adr-drift-check` as the backstop for any residual same-instant collision          | Belt-and-suspenders; already exists and runs on SessionStart                                     |

**Open questions to resolve in SPECIFY** (recommendation noted; none block ideation):

- **Timestamp granularity:** seconds `YYMMDD-HHMMSS` (recommended, collision-proof) vs minutes +
  a short disambiguator. Recommend seconds.
- **Committed id-keyed manifest vs generate-from-frontmatter:** recommend keep the committed
  id-keyed manifest for v1 (less refactoring, tooling reads it, merges clean); flag generation as
  a future simplification.
- **Exact changelog sentinel format** for the 3-section block + the populator-hook change.
- **Optional local JSON merge driver** (`mergiraf`) as belt-and-suspenders for local
  merges/rebases: recommend document-as-optional, not required.
- **`pnpm-lock.yaml`:** recommend keeping the `pnpm install` + `--frozen-lockfile` recipe.
- **Mixed-id-space UX** in `/adr:list`, drift-check, and cross-references (numeric + timestamp
  coexisting).
- **Migration sequencing** so `/flow`'s daily use never breaks, coordinated with DOR-133.

**Next step:** SPECIFY (`specifying-work` / `/flow:specify merge-conflict-prevention`). The
substantive open item for the spec is the committed-vs-generated manifest choice and the exact
changelog sentinel format; the identifier scheme and layer are settled here.
