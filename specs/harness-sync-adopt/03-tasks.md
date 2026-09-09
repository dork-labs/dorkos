# Harness Sync — adopt: implementation tasks

Canonical task data lives in [`03-tasks.json`](./03-tasks.json). This file is its human-readable mirror; regenerate both together rather than editing one. Specification: [`02-specification.md`](./02-specification.md). Tracker parent: DOR-1853.

**One sub-issue per slice, deliberately.** The DECOMPOSE stage promotes a task to its own tracker child only when its size reaches `decomposition.subIssueThreshold` (`xl`), and nothing here is `xl`. This programme overrides that: every slice runs as its own worktree, its own adversarial review and its own pull request, so each slice gets a child the dispatch loop can pick up one at a time. Recorded here as the assumption it is, rather than left implicit.

**Four slices, in order, each a pull request.** Slice 1 ships no user surface on its own and is landed separately so the refusal ladder and the allowlist can be reviewed without a command transcript in the way. Slices 2, 3 and 4 each ship one thing a person can use, and each is useful with the later ones absent. Slice 4 is last on purpose and carries its own cut line.

| Slice | Child    | Blocked by                    | What lands                                                                                                                                                              | Contract cells it flips                                                                             |
| ----- | -------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| 1     | DOR-1943 | DOR-1902 (in the merge queue) | the reader and the pure planner, the refusal ladder and the allowlist; `adoptableSkillSources` exported                                                                 | `SK-16` (new) → built                                                                               |
| 2     | DOR-1944 | slice 1                       | `applyAdopt`, `planAdoptedSkillLink` extracted, `dorkos harness adopt`, the sync report's new block, the Skills-page row's copy, and `Provenance`'s `'adopted'` retired | `SRC-07` → built; `SRC-10` → built (retired value); `AP-17` (new) → built; `J-06` Actual rewritten  |
| 3     | DOR-1945 | slice 2                       | `harness.autoAdopt`, its migration and four classification tables, and the two consultation sites                                                                       | D3 implemented; §14 item 3's remaining half struck through; the amendment ADR flipped to `accepted` |
| 4     | DOR-1946 | slice 2 — runs beside slice 3 | `POST /api/harness/adopt`, its Transport method, and the Skills page row's button                                                                                       | `VC-01`'s Actual gains the action                                                                   |

**Critical path:** DOR-1902 → 1.1 → 1.2 → 1.4 → 2.1 → 2.3 → 2.6 → 3.1 → 3.2 → 3.3 → 3.4. Slice 4 branches off 2.6 and runs beside the whole of slice 3.

**The bar, for every slice.** Every new test fails on `main` before its fix lands and the pull request shows both runs. Where a surface does not exist on `main` at all, "fails on main" is trivially true and proves nothing, so each task below names the seeded defect that discriminates: a one-line mutation of the shipped code that must turn the test red. Every enumerating test asserts how many things it found before asserting anything about them.

## Phase 1 — The adopt planner (DOR-1943)

**Acceptance bar.** `planAdopt` is pure (no `fs` import, enforced by the `no-restricted-imports` shape the FSD rules already use, or by a test asserting the module's import list). All ten refusal rules' fourteen sentences are frozen and asserted verbatim. The allowlist reads raw frontmatter, and the parsed-frontmatter run demonstrably passes the `hooks:` case. `readAdoptCandidates` agrees with `adoptableSkillSources` as a property. The census stays green. This slice ships no user surface on its own and is landed separately so the refusal ladder and the allowlist can be reviewed without a command transcript in the way — its pull request carries `skip-changelog`.

### Task 1.1: Build packages/harness/src/adopt/ — the reader, the pure planner, the refusal ladder and the allowlist

_Size: medium · priority: high_

Create `packages/harness/src/adopt/{index,types,read,plan,allowlist,refusals}.ts` and export the unit from `packages/harness/src/index.ts`.

**Types** (`types.ts`): `AdoptCandidate` — `name`, `source` (repo-relative source directory such as `.claude/skills/deploy-checklist`), `root: SkillRoot`, `isSymlink`, `frontmatterKeys: readonly string[]` (the keys the author wrote, in file order, unstripped and unvalidated), `bodyHasClaudeToken`, `unreadable` (the frontmatter would not parse at all — a different answer from 'no keys'), and `targetState: 'absent' | 'occupied'`. `DirectoryOwnership = 'plain' | 'agent-home' | 'room-worktree'`. `AdoptMove` — `name`, `from`, `to` (always `.agents/skills/<name>`), and an optional `link?: ProjectionAction`. `AdoptDeclaration` — `name`, `path` (the candidate's own `source`, because `SK-04`'s five states all resolve from the entry's own path) and a REQUIRED `reason`, because `ClaudeOnlySkillSchema` is `.strict()` with three required fields and an entry without one fails the parse. `AdoptRefusalRule` is the eight-member union `'not-adoptable' | 'hostile-path' | 'room-seeded-name' | 'target-exists' | 'source-is-symlink' | 'unreadable-frontmatter' | 'not-on-allowlist' | 'claude-only-wrong-root'`. `AdoptRefusal` carries `name`, `source`, `reason` and `rule`. `AdoptBlocked` carries `reason` and `rule: 'canonical-layer-ignored' | 'auto-adopt-not-permitted'` — separate from `refusals` because those two facts are about the DIRECTORY, not about a skill, and repeating either once per candidate would print the same paragraph six times and bury the things a person could act on. `AdoptPlan` carries `moves`, `declarations`, `refusals` and an optional `blocked`; `moves` and `declarations` are empty whenever `blocked` is set.

**The reader** (`read.ts`): `readAdoptCandidates` walks the inventory, keeps the harness-native skills with no canonical twin, and reads each candidate's `SKILL.md` through `readRawFrontmatter` from `@dorkos/skills` — never `parseSkillFile`. `SkillFrontmatterSchema` strips keys it does not know and `.catch(undefined)`s values it cannot read; both are right for their own callers and catastrophic here, because a `hooks:` block in a `SKILL.md` frontmatter is a real thing Claude Code honours and DorkOS's own `inventory/hooks.ts` reads (contract HK-12), and the parsed object hides it. `bodyHasClaudeToken` is a substring match for `${CLAUDE_` over the body text already in memory.

**The planner** (`plan.ts`): `planAdopt` is PURE — no `fs` import, no disk walk. `DirectoryOwnership` and the candidate set arrive as inputs, because `packages/harness` keeps no knowledge of the dork home and the same engine has to run offline in a terminal and inside the server. This is a deliberate departure from `buildPlan`, which walks the disk itself at `plan/projector.ts:446` and `:450`.

**The refusal ladder** (`refusals.ts`), in order, first match wins, most fundamental first. Run-level, checked before any candidate: B1 `auto-adopt-not-permitted` when `mode: 'auto'` and `ownership: 'plain'`; B2 `canonical-layer-ignored` when `canonicalLayerIgnoredBy` returned a file (AP-15). B1 comes before B2 because a person who set the flag in a repository DorkOS does not own should be told THAT, not sent to edit a `.gitignore` for a run that was never going to happen. Per candidate: R1 `not-adoptable` (explicit mode, requested name not in the candidate set — three sub-sentences: no such skill, already in `.agents/skills` too, declared in `manifest.claudeOnlySkills`); R2 `hostile-path` (DOR-1882's occupant check says the source, the target, or a directory on the way to either is a file, a live link to a file, a dangling link, or unreadable — adopt adds its own target and every directory on the way to that pre-pass rather than checking them separately); R3 `room-seeded-name` (`ownership: 'room-worktree'` and the name is one of `OPERATING_SKILLS_PACK`'s, SRC-11 — derived from the pack, never hand-listed, and the sentence names the fact rather than a count); R4 `target-exists`; R5 `source-is-symlink`; R6 `unreadable-frontmatter`; R7 `not-on-allowlist`, hard in BOTH modes; R8 `claude-only-wrong-root`. R2 sits before R3–R6 because a hostile path is the only case where the check itself is what prevented a throw. R8 is not in the ladder at all: `--claude-only` runs R1 then R8 and stops, and neither B1 nor B2 applies to it, which is what makes the flag a real way out of R7 rather than a second thing that can be refused for the same reason.

**The allowlist** (`allowlist.ts`): export `AGENTSKILLS_BASE_FIELDS = ['name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools'] as const` — layer 1 of `SkillFrontmatterSchema`. The predicate is two clauses, both read from the file as written: (1) every top-level frontmatter key is in that list, and (2) the body contains no `${CLAUDE_` token. It is an allowlist rather than a denylist because a denylist's failure direction when a vendor ships a new field on a Tuesday is 'moved anyway', and an allowlist's is 'reported and left alone'. The predicate deliberately does NOT hunt English prose for `/reload-plugins` or similar; the two clauses are mechanical facts about the file.

**S7 vs S7c is picked by a second, derived list.** After the allowlist says no, ask whether the offending key is one `SkillFrontmatterSchema` itself declares (layer 2 plus `schedule` and `kind`). Yes gives S7 ('which only Claude Code understands'); no gives S7c ('which DorkOS doesn't recognise'), which claims nothing about who understands it. Read that set off `SkillFrontmatterSchema.shape` minus the six base fields at module scope, never spelled a second time, so a field the schema gains tomorrow moves between the two sentences on its own. A body token is always S7b whatever the frontmatter holds.

**Frozen sentences.** The ten refusal rules produce fourteen frozen sentences (§8 of the specification at `specs/harness-sync-adopt/02-specification.md`: S2, S2b, S2c, S3, S4, S5, S6, S7, S7b, S7c, S8, S9, S12, plus S17 which reuses DOR-1882's occupant sentences verbatim). R7's `{fields}` names the offending keys in the order they appear in the file, joined `a, b and c`. No file CONTENT ever reaches a reason or a log line — the refusals name keys and paths, never values.

Acceptance bar: `planAdopt` is pure, enforced either by the `no-restricted-imports` shape the FSD rules already use or by a test asserting the module's import list. The unit is written against `SkillRoot` as the five-member union DOR-1902 makes it, not against the two-member one. Nothing is exported that nothing uses (`pnpm knip`). TSDoc on every export (hard rule 4).

This slice lands only after DOR-1902 is on `main`: it turns `SkillRoot` into a union of five roots and adopt's whole refusal table is keyed on it, so starting earlier means writing against a shape that is about to change. DOR-1882 is the other prerequisite, for R2's occupant sentences.

Verification: `pnpm vitest run packages/harness/src/adopt/__tests__/plan.test.ts`, `pnpm --filter @dorkos/harness typecheck`, `pnpm --filter @dorkos/harness lint`.

Review rule: the branch faces an independent adversarial review per `REVIEW.md` before a pull request opens, and every new test must be shown failing on `main` first.

### Task 1.2: Pin the refusal ladder, the allowlist and the blocked short-circuit in plan.test.ts

_Size: medium · priority: high · depends on 1.1 · can run beside 1.3_

Write `packages/harness/src/adopt/__tests__/plan.test.ts` over pure fixtures — no staged tree — covering six groups, each with the seeded defect that has to turn it red.

1. **One case per refusal SENTENCE**: fourteen cases over ten rules (B1, B2, R1 three times, R2, R3, R4, R5, R6, R7 three times, R8), each asserting the frozen sentence verbatim against the literal rather than against the constant that produced it. The counts differ because three rules have more than one sentence: R1 by what is wrong with the name, and R7 by whether the offending key is Claude Code's, a body token, or one DorkOS does not know. _Seeded defect, per rule:_ delete that rule's branch and its case or cases go red; the pull request shows ten runs, one branch removed each time.

2. **The allowlist from both sides**: `context: fork` refused; `hooks:` refused; a clean frontmatter with `${CLAUDE_PLUGIN_ROOT}` in the body refused; base fields only moved; `allowed-tools` alone moved. _Seeded defect, and the one that proves the design:_ build the same `hooks:` case against a predicate reading the PARSED frontmatter and watch it pass, because `SkillFrontmatterSchema` strips the key. That single run is the argument for `readRawFrontmatter` made mechanical, and it goes in the pull request.

3. **Ordering**: a candidate that is simultaneously a symlink, at an occupied target, and off the allowlist gets R4's sentence — first match wins, and the ladder's order is asserted rather than emergent.

4. **`blocked` short-circuits**: with `.agents/` gitignored, a plan over six candidates has zero moves, zero refusals, and one `blocked`. _Seeded:_ turn B2 into a per-candidate refusal and the count assertion reds.

5. **Auto mode is strictly narrower than explicit**: over the same candidate set, `mode: 'auto'` in an agent home plans a subset of `mode: 'explicit'`'s moves and never a superset. A property, over a generated candidate set.

6. **No file content escapes**: a test asserts that no value string from a staged `SKILL.md` appears in any refusal or log line — the refusals name keys and paths only.

Every enumerating test asserts HOW MANY things it found before asserting anything about them (the zero-subject rule). Every new test title carries its contract row id as a prefix, `it('SK-16: …')`, which is the retitle convention census assertion 5 enforces.

The bar for the whole programme: every new test fails on `main` before its fix lands and the pull request shows both runs (`plans/harness-sync-test-plan.md` §0). Where the surface does not exist on `main` at all, 'fails on main' is trivially true and proves nothing, which is exactly why each group above names its own seeded defect instead.

Verification: `pnpm vitest run packages/harness/src/adopt/__tests__/plan.test.ts`, `pnpm --filter @dorkos/harness typecheck`, `pnpm --filter @dorkos/harness lint`.

Review rule: the branch faces an independent adversarial review per `REVIEW.md` before a pull request opens, and every new test must be shown failing on `main` first.

### Task 1.3: Export adoptableSkillSources and prove the candidate set agrees with the status model

_Size: medium · priority: high · depends on 1.1 · can run beside 1.2_

Add `export` to `adoptableSkillSources` in `apps/server/src/services/harness/status.ts` — one word, at `status.ts:304` — and write `apps/server/src/services/harness/__tests__/adoptable-agreement.test.ts`.

The test is a PROPERTY over a staged tree: the sources `readAdoptCandidates` returns equal the sources `adoptableSkillSources` marks `adoptable`. It has to live in `apps/server`, not in the engine package, because the server is the only place that can import both sides — `packages/harness` cannot import `apps/server`. This is what makes the deliberate duplication between the two readers CHECKED rather than trusted: the engine needs its own reader because `planAdopt` is pure and the status model's is not, and the property is the only thing standing between two readers and two different answers.

The two exclusions the status model applies are the definition rather than an optimisation, and the property has to hold across both: a skill also present in the canonical layer is a BLOCKER whose fix is a deletion, and a skill named in `manifest.claudeOnlySkills` is a person saying the placement is deliberate. Stage a tree carrying one of each alongside real candidates so the property is exercised on the exclusions, not only on the happy set.

_Seeded defect:_ drop the `alsoCanonical` exclusion from one side and the property reds. Show that run in the pull request.

Assert how many sources the property found before asserting anything about them (the zero-subject rule) — a property that silently ranges over an empty set passes for the wrong reason.

Verification: `pnpm vitest run apps/server/src/services/harness/__tests__/adoptable-agreement.test.ts`, `pnpm --filter @dorkos/server typecheck`, `pnpm --filter @dorkos/server lint`.

Review rule: the branch faces an independent adversarial review per `REVIEW.md` before a pull request opens, and every new test must be shown failing on `main` first.

### Task 1.4: Add the SK-16 contract row and keep the capabilities census green

_Size: medium · priority: medium · depends on 1.2 · can run beside 1.3_

Add row **SK-16** to `meta/harness-sync-capabilities.md`, marked **built**: a skill is safe to share automatically only when its frontmatter holds nothing outside the agentskills.io base fields and its body carries no `${CLAUDE_…}` token — read raw, never parsed. Cite its coverage as `packages/harness/src/adopt/__tests__/plan.test.ts` (both sides of the allowlist, plus the parsed-reader run that demonstrates why the raw reader exists).

`SK-16` is the next free id in its family today (`SK` runs to 15). The ids are not load-bearing and the ROWS are: if DOR-1902 has taken `SK-16` by the time this lands, take the next free one and retitle the tests, which is what census assertion 5 exists to catch.

Census floors in `packages/harness/src/__tests__/capabilities-census.test.ts` move with the row. This slice raises the ones SK-16 touches: `rows`, `titles` by the number of new cases, `claiming` since the new row claims coverage, `built`, and `idsInTitles`. Every one is a `toBeGreaterThanOrEqual`, so none of them BREAKS when it is left alone — which is exactly why raising them is part of the work. A floor nobody raises is a floor that stops meaning anything.

Every new test title carries its row id as a prefix (`it('SK-16: …')`), which is the retitle convention census assertion 5 enforces, and assertion 6 requires a test title per id.

This slice ships no user-facing surface on its own, so its pull request carries the `skip-changelog` label rather than a changelog fragment. It is landed separately so the refusal ladder and the allowlist can be reviewed without a command transcript in the way.

Verification: `pnpm vitest run packages/harness/src/__tests__/capabilities-census.test.ts`, `pnpm exec prettier --check meta/harness-sync-capabilities.md`, `bash scripts/check-banned-words.sh`.

Review rule: the branch faces an independent adversarial review per `REVIEW.md` before a pull request opens, and every new test must be shown failing on `main` first.

## Phase 2 — The move, the command and the report (DOR-1944)

**Acceptance bar.** `checkPlan` is clean immediately after an adopt, and the applied action deep-equals `planAdoptedSkillLink(name)` — the same export `planSkill` now calls. The crash case restores and changes nothing else in the tree. The J-06 sentence matches the capability contract's own wording byte for byte at n=1, and is absent on a Claude-only manifest. `Provenance` no longer carries `'adopted'` and the whole monorepo type-checks. `ADOPTABLE_ADVICE` is a template rather than a literal and the browser assertion moves with it. SRC-07, SRC-10 and AP-17 flip with cited coverage, and `capabilities-census.test.ts` passes.

### Task 2.1: Ship applyAdopt, extract planAdoptedSkillLink, and build the one sentence builder

_Size: large · priority: high · depends on 1.4 · can run beside 2.5_

Three engine changes in `packages/harness`, and they belong together because the second is what makes the first's central claim a fact the compiler holds.

**1. Extract `planAdoptedSkillLink`.** Add `export function planAdoptedSkillLink(name: string): ProjectionAction` to `packages/harness/src/plan/projector.ts` and rewrite `planSkill`'s claude-code branch to `return planAdoptedSkillLink(skill.name)`. Its return value is unchanged from what `planSkill` builds today at `plan/projector.ts:117-119`: `{ kind: 'symlink', artifact: 'skill', harness: 'claude-code', provenance: 'authored', name, source: `.agents/skills/${name}`, target: `.claude/skills/${name}` }`. Adopt cannot call `planSkill` itself: it is module-private at `plan/projector.ts:89` with one call site at `:518`, and its second parameter is a `SkillEntry` that `buildPlan` gets from `scanSkills(repoRoot)` — a walk of `.agents/skills`, which by definition cannot see a skill that has not been moved there yet. One argument, because the name is all the two callers have in common: adopt has no `SkillEntry` and the projector has no candidate.

**2. `applyAdopt`** in `packages/harness/src/adopt/apply.ts`: `export function applyAdopt(repoRoot: string, plan: AdoptPlan): AdoptResult`, where `AdoptResult` is `{ moved: AdoptMove[]; declared: AdoptDeclaration[]; refusals: AdoptRefusal[] }` and `refusals` holds the plan's own plus any raised by the apply itself. Per move, in this order and no other: (a) `mkdirSync(join(repoRoot, '.agents/skills'), { recursive: true })` — creating a directory that may already exist is not a mutation anybody can observe; (b) `renameSync(absFrom, absTo)`, the SINGLE mutating step, atomic because both paths are inside one repository and therefore on one filesystem; (c) if `move.link` is present, realize it through `applyPlan(repoRoot, { actions: [move.link], drops: [], warnings: [], notEnabled: [], narrowedTo: 'claude-code' }, {})` — no `sweepOrphans`, because `applyPlan` throws when a narrowed plan asks for a sweep, which is the backstop rather than a rule to remember; (d) if step (c) threw or returned the action in `conflicts`, RESTORE with `renameSync(absTo, absFrom)` and record the move as a refusal carrying the conflict's own reason.

`move.link` is present exactly when `root === '.claude/skills'`. Every other root's harness already lists `.agents/skills` in its own documented project read paths (`vendor-facts/index.ts`), so it keeps reading the skill at its new home; a link back would be a path DorkOS wrote that no plan action ever names — an orphan by construction, at a path no sweep owns.

There is NO staging directory and NO backup, unlike the marketplace transaction: that module stages because it builds content that does not exist yet and backs up because it overwrites an occupied target, and adopt does neither — R4 refuses an occupied target outright and the content it moves is already whole. Staging would buy a copy step that is not atomic, lost hard links and mode bits, in exchange for closing a window `rename(2)` does not have. `EXDEV` is REFUSED with S10, never degraded to a copy-then-delete, because that failure mode is exactly the half-moved skill this design promises never to leave.

A declaration is the other thing `applyAdopt` writes and it is not a move: for each entry in `plan.declarations` it appends one element to `manifest.claudeOnlySkills` through a `declareClaudeOnlySkill` helper and rewrites nothing else in `.agents/harness.manifest.json` — the same one-inserted-array-element contract `enableHarnessInManifest` keeps. A plan never holds both a move and a declaration for one name, because R8's short-circuit settles which one a run is doing before anything is planned.

**3. `packages/harness/src/report/adoptable.ts`**, beside `drop-list.ts` for the same reason: `adoptableSentence({ root, names, cannotSee, projectPath? }): string`. The harness list is COMPUTED, never written down — `enabled.filter((h) => !skillsFactsFor(h).readPaths.project.includes(root))`, mapped through `HARNESS_LABELS`, kept in manifest order, joined `a, b and c`. When `cannotSee` is empty nothing is printed: a count of zero problems is noise, and the block is not a drift report. It never changes an exit code. Pluralisation is handled in the builder at every n. The optional `projectPath` is the ONE switch between S1/S1b (no `--project`, printed by the CLI, which ran in the repository) and S1d/S1e (the absolute `--project`, printed by every server surface, because the reader is not standing in that directory and a bare command means whatever folder they happen to be in).

Acceptance bar: `checkPlan` is clean immediately after an adopt, and the applied action deep-equals `planAdoptedSkillLink(name)` — the same export `planSkill` now calls, so the equality holds between two callers of one function rather than between two literals that agree today.

Verification: `pnpm vitest run packages/harness/src/adopt/__tests__/apply.test.ts`, `pnpm vitest run packages/harness/src/plan`, `pnpm --filter @dorkos/harness typecheck`, `pnpm --filter @dorkos/harness lint`, `pnpm knip`.

Review rule: the branch faces an independent adversarial review per `REVIEW.md` before a pull request opens, and every new test must be shown failing on `main` first.

### Task 2.2: Cover the move, the crash and the restore in apply.test.ts, and teach snapshotTree to hash

_Size: medium · priority: high · depends on 2.1 · can run beside 2.3, 2.4, 2.5_

Write `packages/harness/src/adopt/__tests__/apply.test.ts` against REAL temp repositories — the `hook-projection-gate` and `project-agent-workspace` suites are the precedent, and this surface's whole subject is what happens to files. Seven cases:

7. **The move.** `.agents/skills/x` holds the same BYTES the source did (a whole-tree content hash, not a path list), and `.claude/skills/x` is a symlink whose link text is `../../.agents/skills/x`.

8. **The link equals the projection action.** After `applyAdopt`, `checkPlan(repo, project(repo))` reports `clean: true`, and the action `applyAdopt` applied deep-equals `planAdoptedSkillLink(name)`. A second case runs `buildPlan` over the post-move tree and asserts its skill action is that same value, which is what stops the extraction drifting from `planSkill` later. _Seeded:_ hand-roll the link text as an absolute path — `linkMatchesPlan` fails and `clean` goes false. This is the test that discharges 'the next sync's plan already matches'.

9. **The crash between rename and link.** Stub `applyPlan` to throw; assert the source directory is back at `.claude/skills/x`, `.agents/skills/x` is absent, and NO OTHER PATH in the tree changed (whole-tree path-set snapshot). _Seeded:_ delete the restore and the source-path assertion reds.

10. **A conflict at the link target** — a real file planted at `.claude/skills/x` between the two steps — restores just the same, and the refusal carries `applySymlink`'s own blocking reason.

11. **A non-Claude root**, staged by hand: the move happens, NO link is left, `checkPlan` is still clean, and the command prints S15b rather than S15 — the same condition asserted on both the filesystem and the sentence, so a run cannot promise a link it did not make. The `.claude/skills` case in the same file asserts S15. _Seeded:_ plan a link for every root and the orphan finders report the new path; print S15 unconditionally and the non-Claude case reds on the copy.

12. **`EXDEV`.** Stub `renameSync` to throw it; S10 verbatim, tree unchanged.

13. **Idempotency.** Adopting the same name twice: the second run is R4, and the tree after equals the tree after the first (path-set plus content hash).

**This is the work that has to teach `snapshotTree` to hash.** Its helper measures the tree's SHAPE and nothing else, and its own docstring at `harness-sync.test.ts:18` names the blind spot and the trigger: an in-place rewrite of a file that already existed would pass it, no check-mode path can reach such a rewrite today, and if one ever can the helper has to start hashing contents. Two of adopt's assertions are exactly that case — a `--check` that must write nothing, and a failed move whose restore has to put the same BYTES back rather than a path with the same name — so this task adds the content hash the docstring asked for. The seeded defect is running the new tests against the shape-only helper and watching them pass; show that run in the pull request.

Only two things are stubbed, and they are the two failures a filesystem will not produce on demand: `applyPlan` throwing, and `renameSync` returning `EXDEV`. Everything else is a real engine over a real temp repository. Every enumerating assertion states how many things it found first.

Verification: `pnpm vitest run packages/harness/src/adopt/__tests__/apply.test.ts`, `pnpm vitest run packages/cli/src/__tests__/harness-sync.test.ts` (the helper's own suite must stay green after it learns to hash), `pnpm --filter @dorkos/harness typecheck`.

Review rule: the branch faces an independent adversarial review per `REVIEW.md` before a pull request opens, and every new test must be shown failing on `main` first.

### Task 2.3: Ship dorkos harness adopt and the sync report's new block

_Size: large · priority: high · depends on 2.1 · can run beside 2.2, 2.4, 2.5_

**The command.** `packages/cli/src/harness-adopt-command.ts`, dispatched from `packages/cli/src/commands/harness-dispatcher.ts` beside `sync` and `hooks`, with its own `--help`/`-h` early exit and its subcommand block in `HELP_TEXT`. The dispatcher's contract is unchanged: return an exit code, never call `process.exit`.

```
Usage: dorkos harness adopt <name> [--project <path>] [--claude-only] [--check]

  <name>              The skill to move, by its folder name
  --project <path>    The project to act on. Defaults to the folder you are in
  --claude-only       Record the skill as Claude-Code-only instead of moving it
  --check             Say what would happen. Writes nothing
```

One positional, required: `parseArgs` with `allowPositionals: true` and exactly one accepted, unlike `parseHarnessSyncArgs`, which sets `allowPositionals: false`. A bare `dorkos harness adopt` is a usage error naming the command that lists candidates (`dorkos harness sync --check`) rather than doing something, because a bare adopt that acted would be one keystroke away from the multi-adopt this work deliberately does not ship. `--project` is resolved by the CLI against its own cwd with `resolve(process.cwd(), value)`; adopt never reaches a server, so the `--project .` hazard does not exist for the command itself, but every string DorkOS PRINTS still carries the absolute root.

**Exit codes.** `0` when the skill moved, was declared, or — under `--check` — would move. `1` when it was refused, and `1` on a usage error. The refusal sentence goes to stdout with the plan; the usage error goes to stderr, matching every other command in this package. `adopt --check` exiting 0 when the move WOULD succeed is the opposite of `sync --check`, and deliberately so: `sync --check` asks 'is my tree in sync?', so outstanding work is non-zero, while `adopt <name> --check` asks 'will this command work?', so success is zero. State the asymmetry in the help text — it is exactly the kind of thing a script author trips over once and never forgives.

A project with no `.agents/harness.manifest.json` gets the same answer `sync --check` gives — the command stops and says where it looked — and never scaffolds one. Scaffolding is a write, and a person asking to move one skill has not asked DorkOS to set the project up.

**The sync report's new block**, in `packages/cli/src/harness-sync-command.ts`: one block printed immediately before `formatClaudeOnly` in BOTH `reportCheck` and `reportFix`, one headline per root, under the heading `Skills only some of your agents can see:`. The CLI passes no `projectPath`, because it ran in the repository and a bare command is correct there — and that is the form the capability contract quotes for J-06. At n = 1 the headline names the skill in its command and stands alone; at n > 1 it is followed by one indented line per skill carrying that skill's own full command, because a headline cannot name three skills in one command and a list of names with no command is a second thing to look up.

**Tests** in `packages/cli/src/__tests__/harness-adopt.test.ts` — real engine, real temp repo, exit codes PAIRED with whole-tree snapshots, the idiom `harness-sync.test.ts` established after DOR-678, where an exit-code-only test passed throughout the life of the bug (`:217-222`). Cases: (14) the transcript — success 0, each refusal 1, `--check` 0 when it would move and 1 when it would not, with identical path-set snapshots before and after so 'writes nothing' is MEASURED; (15) usage — bare `dorkos harness adopt` is an error on stderr naming `dorkos harness sync --check`, two positionals is an error, and `--claude-only` writes one manifest element with every other byte unchanged (byte compare); (16) `--project` — a run from a different cwd against an absolute path and the same run from inside the repository produce identical trees; (17) the J-06 sentence verbatim on a manifest enabling all six tools, then the SAME tree with a Claude-Code-only manifest prints no block at all — _seeded:_ hard-code 'Codex and Gemini' and the second case reds; (18) pluralisation at n=1, n=2, n=3 and `cannotSee` of length 1 and 3.

The J-06 sentence must match the capability contract's own wording byte for byte at n=1.

Verification: `pnpm vitest run packages/cli/src/__tests__/harness-adopt.test.ts`, `pnpm vitest run packages/cli/src/__tests__/harness-sync.test.ts`, `pnpm --filter dorkos typecheck`, `pnpm --filter dorkos lint`.

Review rule: the branch faces an independent adversarial review per `REVIEW.md` before a pull request opens, and every new test must be shown failing on `main` first.

### Task 2.4: Retire Provenance's 'adopted' value across ten sites and regenerate the wire contract

_Size: medium · priority: high · depends on 2.1 · can run beside 2.2, 2.3, 2.5_

Remove `'adopted'` from `Provenance` rather than start producing it. An adopted skill is not a third kind of source: it is a skill that now lives in `.agents/skills`, which is the authored root, scanned by the authored scanner, projected by the authored branch of `planSkill`, and committed like every other authored skill. Keeping the value would be worse than unused — it is ACTIVELY WRONG, because `isEphemeralProvenance('adopted')` returns `true` at `sources/resolve-roots.ts:52`, so anything that ever set it would send the gitignore half of the engine to tell a person to ignore a skill they just committed.

**Five sites carry the value itself** (removing it breaks the build or changes a byte some program reads): `packages/harness/src/plan/types.ts:42` — `Provenance` becomes `'authored' | 'installed'`; `packages/shared/src/harness-schemas.ts:164` — `HarnessProvenanceSchema` drops `'adopted'`, KEEPS `'harness-native'`, and its TSDoc's "`adopted` never occurs in v1" paragraph is replaced by why it is gone; `apps/server/src/services/harness/status.ts:115` — the `satisfies Record<Provenance, HarnessProvenance>` table loses a row, and the compiler naming this file is the point of the `satisfies`; `packages/harness/src/sources/__tests__/resolve-roots.test.ts:20` — the case pinning `adopted` as ephemeral goes with the value; `docs/api/openapi.json:211` and `:51220` — regenerated.

**Five more carry it in prose, nine sentences over five files**: `packages/harness/src/sources/resolve-roots.ts:5`, `:33`, `:47`, `:57` (four doc sentences lose 'and adopted'; the function bodies are unchanged); `packages/harness/src/index.ts:5`; `packages/harness/src/apply/gitignore.ts:5` and `:234`; `packages/harness/src/__tests__/properties/p7-gitignore.property.test.ts:42`; and `packages/harness/src/__tests__/capabilities-census.test.ts:135`, whose `PINNED_GAPS` note ('the test pins only that `adopted` counts as ephemeral provenance') goes with the test.

**Regenerate `docs/api/openapi.json` with BOTH commands the check compares against**: `pnpm docs:export-api` (root, from the route and schema registry) and `pnpm --filter=@dorkos/site generate:api-docs` (the Fumadocs MDX under `docs/api/api/**`) — the pair `docs-openapi-check.yml:147` and `:153` run. This regenerates in THIS slice, not only in slice 4, because the enum is published in the wire contract and narrowing it is the one real cost of the retirement: an outside client built against that document has a union member taken away. It is safe to take because the value could never have arrived — nothing has ever set it and no stored payload carries it — and the only in-repo consumer is this repository's own client, which the compiler holds.

**Test case 20 (`SRC-10`)**: `Provenance` no longer accepts `'adopted'`, and a moved skill's plan action carries `provenance: 'authored'`. _Seeded:_ set `'adopted'` on the moved skill's action and the gitignore check starts demanding a pattern for a committed skill.

ADR-0303's third source class is untouched: the CLASS is the act of adoption, and this decision says the act produces an `authored` skill rather than a standing third provenance.

Verification: `pnpm typecheck` (the whole monorepo must type-check — the `satisfies` table is the point), `pnpm vitest run packages/harness/src/sources`, `pnpm vitest run packages/harness/src/__tests__/capabilities-census.test.ts`, and a clean `docs-openapi-check` after both generators run.

Review rule: the branch faces an independent adversarial review per `REVIEW.md` before a pull request opens, and every new test must be shown failing on `main` first.

### Task 2.5: Turn ADOPTABLE_ADVICE into a template and move the two tests that pin its literal

_Size: medium · priority: high · depends on 1.4 · can run beside 2.1, 2.2, 2.3, 2.4_

`ADOPTABLE_ADVICE` in `apps/client/src/layers/entities/harness/ui/SkillHarnessRow.tsx:21-22` is a constant today and it spells `.claude/skills` into the sentence — right only because that was the one root that existed, and wrong the moment DOR-1902 lands. Make it a TEMPLATE fed from `dirname(row.source)`, so an OpenCode-first repository reads `Lives in .opencode/skills.` with no further change.

Line 3 keeps its firing condition (`row.adoptable`) and gains the command (S13):

```
Lives in {root}. Move it to .agents/skills so every agent can read it.
Run: dorkos harness adopt {name} --project {projectPath}
```

`--project` carries the ABSOLUTE repository root, never `.`. The status response already knows it (`projectPath`, resolved by the route through `validateBoundaryOrDorkHome`). A `.` in a string the SERVER prints is the defect DOR-1921 and `plan/global-installs.ts` both measured: the reader is not in that directory, so a pasted `.` means whatever folder they happen to be in.

**The row's line-3 firing condition is NOT narrowed** to 'some enabled tool cannot see it', even though the terminal headline is. The two sentences make different claims: the row's makes none about any agent tool — it says where the file lives and what moving it buys, both true whatever is enabled — and it is the sentence DOR-1894 shipped and a browser test pins. The headline DOES name tools, and a claim about tools has to be true, so it is computed and withheld when the list is empty.

**This copy is slice 2's change, not slice 4's, and the reason is the cut line.** It is the same sentence the terminal prints, built from the same facts, so it belongs with the rest of the reporting — and putting it here is what makes the cut line honest: cutting the button still leaves the row naming the command.

`ADOPTABLE_ADVICE`'s own docblock says the tests assert the LITERAL, because a test comparing a string against the constant that produced it cannot fail on a copy change. Both tests move with it: the unit case in `apps/client/.../SkillsWithHarnessesList.test.tsx` and the browser assertion at `apps/e2e/tests/harness/skills-page.spec.ts:128-130`, which contains the sentence verbatim.

**Test case 19**: `SkillsWithHarnessesList.test.tsx` renders an adoptable row whose `source` is `.opencode/skills/x` and asserts the sentence says `Lives in .opencode/skills.` plus the `--project`-bearing command. _Seeded:_ leave `ADOPTABLE_ADVICE` a constant and the `.opencode` case reds while the `.claude` one passes — which is the whole difference between a literal and a template. Show that run in the pull request.

The page-level banner is UNCHANGED: `counts.adoptable > 0` still draws its statement with no action, because there is no single skill for a page-level button to adopt.

Verification: `pnpm vitest run apps/client/src/layers/entities/harness`, `pnpm --filter @dorkos/client typecheck`, `pnpm --filter @dorkos/client lint`, and the browser leg `pnpm --filter @dorkos/e2e e2e -- harness/skills-page.spec.ts`.

Review rule: the branch faces an independent adversarial review per `REVIEW.md` before a pull request opens, and every new test must be shown failing on `main` first.

### Task 2.6: Flip SRC-07, SRC-10 and AP-17, rewrite J-06, and write the docs and the changelog fragment

_Size: medium · priority: medium · depends on 2.1, 2.2, 2.3, 2.4, 2.5_

**Contract rows** in `meta/harness-sync-capabilities.md`. `SRC-07`: not built → **built** (DOR-1853) — the harness-native asset has a path back to canonical, and every sync and boot summary names the ones that have not taken it; coverage cited as `adopt/__tests__/plan.test.ts`, `apply.test.ts` and `cli/__tests__/harness-adopt.test.ts`. `SRC-10`: not built → **built, and the third provenance is retired**; coverage cited as `apply.test.ts` (`provenance: 'authored'` on the moved skill) and the compiler on the `satisfies` table. `AP-17` (new): **built** — adopting a skill is one `rename(2)` plus the projection the planner already plans; a failure restores, and a crash between them leaves the skill whole at the canonical root with a projection the next sync makes; coverage cited as `adopt/__tests__/apply.test.ts`. `J-06`: its Actual becomes 'the move exists', and its Expected LOSES 'In a DorkOS-owned directory … the move happens on its own', which is the pre-round-two draft of D3 and contradicts the position this work settles.

`AP-17` is the next free id in its family today (`AP` runs to 16); if DOR-1902 has taken it, take the next free one and retitle the tests. Raise the census floors this slice touches in `capabilities-census.test.ts` — `rows`, `titles`, `claiming`, `built` and `idsInTitles` — every one a `toBeGreaterThanOrEqual`, so none of them breaks when left alone, which is exactly why raising them is part of the work.

**Documentation.** `contributing/harness-sync.md` gains a new section, 'Adopting a skill somebody's agent wrote', covering the refusal ladder, the allowlist and why it is one, the atomic move and what a crash leaves, and the `adopt --check` exit-code asymmetry; plus one line in §11 for `--claude-only` writing `claudeOnlySkills`. `contributing/INDEX.md`: the freshness row for `harness-sync.md` is re-stamped. `plans/harness-sync-test-plan.md`: §11 line 10 marked done with its slices, and its stale seeded defect corrected — the plan says 'J-06: `unmanaged` is empty on a repo with a real dir in `.claude/skills`', which was true before DOR-1894 and is green on `main` today because `unmanaged` is computed and drawn.

**Changelog fragment**: one file in `changelog/unreleased/<id>-harness-adopt.md`, id from `node --experimental-strip-types .claude/scripts/id.ts`, written to the `writing-for-humans` bar — plain enough for a smart ninth grader who does not code. What it says: a skill your agent wrote inside one tool's folder can now be moved to where every agent reads it, with one command, and DorkOS tells you when it will not and why.

This is the task that closes the slice, so it lands last inside it: the contract rows cite coverage that has to exist, and the docs describe behaviour that has to be there.

Verification: `pnpm vitest run packages/harness/src/__tests__/capabilities-census.test.ts`, `pnpm exec prettier --check meta contributing plans changelog`, `bash scripts/check-banned-words.sh`, `bash scripts/check-dead-doc-paths.sh`, and `node .claude/scripts/docs-coverage-map.mjs --check`.

Review rule: the branch faces an independent adversarial review per `REVIEW.md` before a pull request opens, and every new test must be shown failing on `main` first.

## Phase 3 — harness.autoAdopt, the boot path and the config tables (DOR-1945)

**Acceptance bar.** With the default (`false`), an agent home reports every candidate and moves none — the report-only claim, asserted. With `true`, only allowlisted skills move and the summary names both counts. A `true` in a plain project is inert, and the flag is grep-ably absent from `runAutoProjection`, `project-on-agent-created.ts` and `skills-watcher.ts`. The migration is verified on disk and reds with its body removed. All three total guards are classified. §14 item 3's remaining half is struck through and its tests exist.

### Task 3.1: Add harness.autoAdopt with its migration, its three classification verdicts and its feedback entry

_Size: large · priority: high · depends on 2.6 · can run beside 4.1_

Follow the `adding-config-fields` skill end to end, with the one step that skill omits added by hand (`default-verdicts.ts` — a guard that is total over `UserConfigSchema` leaves and reds on any unclassified field).

**The field**, inside the `harness` block of `packages/shared/src/config-schema.ts`: `autoAdopt: z.boolean().default(false)`, with a TSDoc block saying what it does for the person — whether DorkOS may move a skill out of an agent tool's own folder into `.agents/skills` on its own; off everywhere by default and acted on ONLY inside the folders DorkOS owns (an agent's own workspace under `<dorkHome>/agents`, and a room worktree); everywhere else a move is a person's decision made with `dorkos harness adopt <name>`, because it is one-way — five agent tools read `.agents/skills` the moment the folder lands there and nothing can un-share it; and when it is on, the guard is an ALLOWLIST, not a denylist, so a field a vendor adds tomorrow fails closed. The enclosing default literal becomes `.default(() => ({ autoSync: true, autoAdopt: false, approvedHooks: [], refusedHooks: [] }))`, which the config skill's own rule requires and which `USER_CONFIG_DEFAULTS` parses at import time.

**The migration key is chosen AT MERGE as the next value above the table's highest, never reserved in advance.** The table in `apps/server/src/services/core/config-manager.ts` tops out at `'0.75.0'` today, so today's answer is `'0.76.0'`; if DOR-1857's `harness.global` key merges first, rebase onto `'0.77.0'` before landing — one line, in a body nothing has run yet. A reserved GAP is silently fatal under `conf`: `_shouldPerformMigration` skips any key `lte` the stored version (`conf@15.1.0`, `dist/source/index.js:534`), and after the loop the store is stamped with the APP version rather than with the highest key that ran (`:494-495`). A release shipping `'0.77.0'` while `'0.76.0'` was still unmerged would stamp every install at that app version, and `'0.76.0'` — landing later from the other branch — would then be `lte` the stored version on every one of them and never run again. A leaf nothing writes is a leaf whose migration silently did nothing.

The body calls a `seedHarnessAutoAdopt(store)` helper guarded on `'autoAdopt' in harness`, because `harness.autoAdopt` is a NESTED leaf and that body is the only thing that writes it. Pin the body in `apps/server/src/services/core/__tests__/merged-migration-hashes.ts` in the SAME pull request, which is what freezes it from the moment it merges.

**Three total guards, each a real decision, each red until the field is classified.** `CONFIG_DISCLOSURE` (`operator/config-disclosure.ts`): `'harness.autoAdopt': 'expose'` — a preference, no credential and nothing naming where one lives. `CONFIG_WRITE_POLICY` (`operator/config-write-policy.ts`): `'harness.autoAdopt': 'operator-only'` — the same verdict `harness.autoSync` carries, for a stronger reason: turning this on makes DorkOS move a PERSON's own files, unattended, which is 'how far DorkOS reaches on disk', the module's own line for `operator-only`. An agent must not be able to use `config_patch` to grant DorkOS that. `DEFAULT_VERDICTS` (`safe-defaults/default-verdicts.ts`): `'harness.autoAdopt': 'safe'` — a gate that starts closed, on a real safety axis.

**Two registries take NO entry, and each absence is a decision to record in the pull request.** `PROTECTED_STATE` (`safe-defaults/protected-state.ts`): carryover exists so a config wipe cannot loosen something a person tightened, and the default here IS the tight value, so a wipe restoring it restores the protective answer — `harness.autoSync` needs a rule only because it defaults ON. `EXPERIMENTS` (`config/experiments-registry.ts`): that registry is for a staged opt-in awaiting graduation and every entry must name a `graduationIssue`; `autoAdopt` is a permanent posture, off everywhere for good, so there is no graduation and no issue to name.

`FEEDBACK_FLAG_ALLOWLIST` in `packages/shared/src/feedback.ts` gains `'harness.autoAdopt': 'boolean'`. It is an opt-in list rather than a total one, and this flag earns a place: 'a skill moved on its own' is a bug report this value explains in one line.

Verification: `pnpm vitest run apps/server/src/services/core/__tests__/config-manager.test.ts`, `pnpm vitest run apps/server/src/services/core/safe-defaults`, `pnpm vitest run apps/server/src/services/core/operator`, `pnpm --filter @dorkos/shared build && pnpm --filter @dorkos/server typecheck`, `pnpm --filter @dorkos/server lint`.

Review rule: the branch faces an independent adversarial review per `REVIEW.md` before a pull request opens, and every new test must be shown failing on `main` first.

### Task 3.2: Read the flag at exactly two call sites, count adoptable skills into the boot summary, and print S8

_Size: large · priority: high · depends on 3.1_

**The flag is read at exactly TWO call sites**, both of which have already established that DorkOS owns the directory they are standing in: `backfillAgentWorkspaceSkills` in `apps/server/src/services/harness/project-agent-workspace.ts`, per workspace that passed `isAgentHome(agentDir, dorkHome)`, after the seed and the projection; and `RoomWorktreeManager`'s seed-and-project pairing in `apps/server/src/services/rooms/repo/room-worktree-manager.ts` — worktree creation and `refreshPack` — per worktree under `<dorkHome>/rooms/<roomId>/worktrees/`. `runAutoProjection`, `projectOnAgentCreated` and the `.agents/skills` watcher read the flag NOT AT ALL, so a `true` there does nothing and there is no branch that could be mis-written to make it do something. That absence is grep-able and is asserted.

**What auto mode does per owned workspace**, after seeding and projecting: (1) `readAdoptCandidates` over that workspace; (2) `planAdopt({ mode: 'auto', ownership: 'agent-home', … })`; (3) `applyAdopt` for the moves, which will be only the allowlisted ones because R7 is hard in auto mode; (4) count `adoptableSkills` (candidates found) and `adoptedSkills` (moves that landed) into the existing `AgentWorkspaceBackfillSummary`. With `autoAdopt: false` — the default, and therefore what almost every install does — steps 2 and 3 are skipped and step 1 STILL RUNS, so the summary still reports `adoptableSkills`. That is the whole report-only claim.

**Ownership is a path question and the engine never asks it.** `DirectoryOwnership` is an INPUT to `planAdopt`. The server resolves it from `dorkHome` (`isAgentHome`, and the `<dorkHome>/rooms/*/worktrees/*` shape); the CLI resolves it the same way from `resolveDorkHome()`. `packages/harness` keeps no knowledge of the dork home, which is the property that lets one engine run offline in a terminal and inside the server, and the `os.homedir()` ban gains no carve-out.

**The summary.** Two new counters on `AgentWorkspaceBackfillSummary`: `adoptableSkills` (SKILLS, not workspaces, that live only in one agent tool's own folder across every workspace this pass considered — found, whatever was done about them; the name carries the unit because every other field on that interface counts WORKSPACES, and a summary mixing the two silently is the '1 of 0' phrasing the 'partly failed' branch already exists to prevent) and `adoptedSkills` (how many of those this pass actually moved; zero unless the flag is on). All three log branches log the same object, so both counters reach every branch without a fourth being written. When `adoptableSkills > adoptedSkills`, add a `hint`: `N skills in M agent folders live only in one agent tool's folder. Each is named above with its folder.` The two `logger.warn` branches already use the `hint` key at `:444` and `:449`, so neither gains a second one — their existing sentence gains a clause; only the `info` branch, which logs the bare summary today, gains a `hint` of its own.

**The per-workspace sentence** rides a new `logger.info` inside `backfillAgentWorkspaceSkills`'s own per-workspace loop at `project-agent-workspace.ts:405-463`, which is the only place with both `agentDir` and the adopt result in hand. NOT inside `projectAgentWorkspace`: that function is called from three places with different jobs and knows nothing about adoption, and giving it a fourth responsibility would put an adopt line in the agent-creator and room-worktree paths that never asked for one. The line carries `agentDir` and `adoptableSentence({ …, projectPath: agentDir })` — the absolute form, because every surface DorkOS prints from the SERVER uses it.

**S8, in `packages/cli/src/harness-sync-command.ts`**: `dorkos harness sync` in both modes, in a directory DorkOS does not own, prints B1's sentence ONCE when the config says `autoAdopt: true`. The CLI already reads `~/.dork/config.json` for hook decisions and already resolves the dork home, so it can answer 'is this an agent home or a room worktree' from the path alone. That terminal line is the one place a person who set the flag learns why nothing happened.

Verification: `pnpm vitest run apps/server/src/services/harness`, `pnpm vitest run apps/server/src/services/rooms/repo`, `pnpm vitest run packages/cli/src/__tests__/harness-sync.test.ts`, `pnpm --filter @dorkos/server typecheck`, `pnpm --filter @dorkos/server lint`.

Review rule: the branch faces an independent adversarial review per `REVIEW.md` before a pull request opens, and every new test must be shown failing on `main` first.

### Task 3.3: Assert the report-only default, the allowlisted move, the inert flag and the migration on disk

_Size: medium · priority: high · depends on 3.1, 3.2_

Write `apps/server/src/services/harness/__tests__/auto-adopt.test.ts` with a real engine and a real seeder, plus two cases that live elsewhere.

21. **`autoAdopt: false` in an agent home finds candidates and moves none**, and the summary reports `adoptableSkills: 3, adoptedSkills: 0`. THIS IS THE REPORT-ONLY CLAIM, and it is the assertion in the suite that matters most: the default posture finds every candidate and moves none of them. _Seeded:_ make the flag default `true` and the tree changes.

22. **`autoAdopt: true` in an agent home** moves only the allowlisted skill; the summary reports `adoptableSkills: 3, adoptedSkills: 1`, and the per-workspace line names the other two with their absolute-path commands. _Seeded:_ swap the allowlist for a denylist of `context` and `paths` — the `hooks:` skill moves and the count reds. That run is the allowlist-versus-denylist argument made mechanical; show it in the pull request.

23. **`autoAdopt: true` in a room worktree**: a seeded name is refused with S4, an authored one moves, and the moved skill appears in `git status` while its link does not, because the `info/exclude` block covers `/.claude/skills/` and not `.agents/skills`.

24. **`autoAdopt: true` in a plain project moves nothing**, and `dorkos harness sync --check` there prints S8 exactly once. _Seeded:_ read the flag in `runAutoProjection` — the tree changes and the path-set snapshot reds.

25. **The migration**, in `apps/server/src/services/core/__tests__/config-manager.test.ts`: a stale config carrying a `harness` section with no `autoAdopt`, booted, then READ OFF DISK — never through `getDot`, which fills the leaf on the way out and is the DOR-1496 failure this case exists to prevent. _Seeded:_ comment the body out and the on-disk assertion reds.

26. **The three total guards** (`config-disclosure`, `config-write-policy`, `default-verdicts`) go red until the field is classified. Those reds ARE the seeded defect, and the pull request shows them.

Every enumerating assertion states how many things it found before asserting anything about them. The config manager is stubbed only where it already is (`skills-watcher.test.ts`'s shape); everything else is a real engine over a real temp tree.

Verification: `pnpm vitest run apps/server/src/services/harness/__tests__/auto-adopt.test.ts`, `pnpm vitest run apps/server/src/services/core/__tests__/config-manager.test.ts`, `pnpm vitest run apps/server/src/services/core/safe-defaults`, `pnpm --filter @dorkos/server typecheck`.

Review rule: the branch faces an independent adversarial review per `REVIEW.md` before a pull request opens, and every new test must be shown failing on `main` first.

### Task 3.4: Flip the amendment ADR to accepted, write ADR-0303's retirement note, and close §14 item 3

_Size: medium · priority: medium · depends on 3.3 · can run beside 3.5_

**Flip the amendment.** `decisions/260909-085610-adoption-is-explicit-everywhere-and-automatic-only-behind-an-allowlist.md` moves from `status: proposed` to `status: accepted`, in the frontmatter and in its own Status section, and `decisions/manifest.json` gets the same status through the ADR tooling rather than by hand. This is the pull request that flips it because its Decision covers slices 1 to 3 — the report, the explicit verb, and `harness.autoAdopt` behind its allowlist. Slice 4 is a surface for the same decision and changes nothing in it.

**Write ADR-0303's retirement note.** `decisions/0303-harness-sync-multi-source-projection.md` currently carries the amendment as a PROPOSED block that ends 'everything below still governs as written'. With the amendment accepted, that block becomes the full retirement note: the third source class's clause is widened in place, and `adopted` as a standing `Provenance` value is recorded as retired — the class survives as an ACT, and what the act produces is an `authored` skill in the canonical layer. ADR-0303 itself stays `accepted`: its three source classes, its one engine and one drop list, its `provenance` tag, its scope-matching rule and its treatment of installed packages all still govern. Two of its Consequences bullets are narrowed with the clause — 'Adoption is explicit and reviewable, so the canonical source never silently absorbs a foreign asset' still holds for every path a person takes and is replaced by an allowlist where DorkOS is the author, and '`adopt` needs per-source importers and a review UX' is smaller than it reads: skills only, one at a time. Leave the OTHER proposed amendment's block (`260908-191538`, global scope) exactly as it is — that one is still `proposed` and its own retirement note lands with DOR-1857.

**Contract.** In `meta/harness-sync-capabilities.md`: §14 item 3 ('What is left is the OTHER direction: a Claude-made skill still misses Codex and Gemini forever and nothing reports it') is STRUCK THROUGH, closed by this work, which reports it everywhere and gives it one command — census assertion 6 requires a test title per id, so the strike-through has to be backed by the tests slice 3 shipped. §16 D3 gains '**Settled and SHIPPED (DOR-1853)**' — the shape D2 uses, and the only entry using it today; D4's own update is worded differently, so do not copy that one. Add the two clauses the code corrected: the move does not need the stage-backup-rename-restore shape, and R5 does not rest on SK-13. Leave §16's preamble alone — it is about the section, not about D3. Raise the census `closed` floor by one for §14 item 3.

Verification: `node --experimental-strip-types --test .claude/scripts/__tests__/*.test.ts`, `pnpm vitest run packages/harness/src/__tests__/capabilities-census.test.ts`, `pnpm exec prettier --check decisions meta`, `bash scripts/check-banned-words.sh`.

Review rule: the branch faces an independent adversarial review per `REVIEW.md` before a pull request opens, and every new test must be shown failing on `main` first.

### Task 3.5: Document harness.autoAdopt in all four places and ship the changelog fragment

_Size: medium · priority: medium · depends on 3.2 · can run beside 3.4_

**`contributing/configuration.md`**: one row in the Settings Reference table for `harness.autoAdopt`, plus a short narrative section beside `harness.autoSync`'s, saying what the flag does for the person and where it is inert.

**`docs/getting-started/configuration.mdx`**: the same row, mirrored. The specification calls this pairing one `scripts/check-docs-changed.sh` watches; that script does not exist in this repository. The pairing is a rule the `adding-config-fields` skill states at its step 7 and `contributing/configuration.md:454` repeats, and the coverage half is checked by `node .claude/scripts/docs-coverage-map.mjs --check`, which knows `docs/getting-started/configuration.mdx`. Mirror the row by hand and run that check.

**`docs/guides/action-approvals.mdx`**: the list of settings with no screen gains `dorkos config set harness.autoAdopt`, beside `harness.autoSync`. There is deliberately NO Settings screen toggle: this is a posture for somebody running agent folders, not a product switch, and the `dorkos config set` command is the surface, exactly as it is for `harness.autoSync`.

**`contributing/harness-sync.md`**: one line in §10 (Triggers) for the two consultation sites — `backfillAgentWorkspaceSkills` per owned agent workspace, and `RoomWorktreeManager`'s seed-and-project pairing per room worktree — and nothing else, because §10 is a trigger list rather than a design document. Re-stamp the freshness row for `harness-sync.md` in `contributing/INDEX.md`.

**Changelog fragment**: one file in `changelog/unreleased/<id>-harness-auto-adopt.md`, id from `node --experimental-strip-types .claude/scripts/id.ts`, written to the `writing-for-humans` bar. What it says: DorkOS can now move plainly-portable new skills into the shared folder on its own, but only inside the agent folders and room folders it owns, only when you turn it on, and only for skills whose settings hold nothing one tool alone understands — everything else is reported and left where it is.

All user-facing prose here follows the `writing-for-humans` bar: plain enough for a smart ninth grader who does not code, describing what happens for the person rather than how the system works inside. No hype, no dark patterns, and never a claim that an unverified surface works.

Verification: `node .claude/scripts/docs-coverage-map.mjs --check`, `bash scripts/check-dead-doc-paths.sh`, `bash scripts/check-banned-words.sh`, `pnpm exec prettier --check contributing docs changelog`, and `node --experimental-strip-types --test .claude/scripts/__tests__/*.test.ts`.

Review rule: the branch faces an independent adversarial review per `REVIEW.md` before a pull request opens, and every new test must be shown failing on `main` first.

## Phase 4 — The route and the row action (DOR-1946)

**Acceptance bar.** The 403 shape is asserted against `sync`'s. The lock holds plan + apply + status. The response REPLACES the cached status through `queryClient.setQueryData` and nothing is invalidated. The browser leg presses the button on the existing fixture and watches the chip change. `knip` is clean — nothing exported and unused. If the confirm needs more than `AlertDialog` + `Banner`, the whole slice is cut to a follow-up and the cut line in Detailed Design §7 is what the ticket cites.

### Task 4.1: Ship POST /api/harness/adopt with the sync route's own clauses

_Size: medium · priority: high · depends on 2.6 · can run beside 3.1, 3.2, 3.3, 3.4, 3.5_

**Schemas** in `packages/shared/src/harness-schemas.ts`: `HarnessAdoptBodySchema` for `{ projectPath: <absolute>, name: string, claudeOnly?: boolean }` and the response schema for `{ moved: AdoptMove[], declared: AdoptDeclaration[], refusals: AdoptRefusal[], status: HarnessStatusResponse }`. The body schema is declared WITHOUT an `isAbsolute` refinement, and that split is not an oversight — the module says why at `:198-206`: the shared schema is what the CLIENT imports, `isAbsolute` is `node:path` and its answer is platform-dependent, and a regex reimplementation in a browser-safe module would be a second, wrong copy.

**The route** in `apps/server/src/routes/harness.ts`, mirroring `POST /api/harness/sync` clause for clause:

- **Person, not agent.** `resolveDecisionAuthority(readCallerAuthority(req, res))` BEFORE body validation — the order `POST /api/marketplace/sources` uses, so a caller who may not do this at all gets one answer whatever it sent. `403` with `code: 'operator_only_harness_adopt'`, the snake-case shape `HARNESS_SYNC_OPERATOR_ONLY_CODE` already uses at `routes/harness.ts:231` rather than the SCREAMING form, and the message S11: 'This moves a file inside your project, so it is a decision a person makes in DorkOS rather than something an agent does on your behalf.'
- **`400` for a relative `projectPath`** comes from the route module's own `.refine(({ projectPath }) => isAbsolute(projectPath))`, added beside the other two exactly as `HarnessSyncBody` does at `:218-221`, and it fires BEFORE `resolveProject` runs. `resolveProject` then owns the rest: `400` for a NUL byte or a path that is not a directory, `403` for a boundary or permission refusal, `404` for one that leads nowhere (`routes/harness.ts:297-344`).
- **No manifest is `409`**, with the same body `sync` returns: `loadManifest` throws `ENOENT` at the engine, and a project that shares nothing is not an adopt that did no work.
- **`withProjectLock(resolved, …)` around plan + apply + the status recompute**, so the status in the response describes the tree THIS apply left rather than one a watcher or a marketplace install rewrote in between. Same reason, same shape, same lock as `sync`.
- **`200` even for a refusal.** A refusal is an answer carrying its own way out, and the page draws it where the advice line was — the same thing it already does with a drop reason. A `404` for 'no such skill' was considered and rejected: it would make the page special-case one refusal out of eight to render the same sentence.
- **The capability tier, recorded so it is not re-litigated.** Not a registered agent capability in v1 — no agent path needs it. If it is ever surfaced to agents it is `destructive`, deliberately the opposite of `sync`'s verdict, because `sync` writes and removes only files DorkOS made while adopt moves a file a PERSON made.

**Security.** The route resolves `projectPath` through `validateBoundaryOrDorkHome` before anything is planned — the same boundary `sync` passes — and the whole operation writes only inside the repository and only into two paths: `.agents/skills/<name>` and the link at the candidate's own root.

**OpenAPI.** The route registry is generated and checked by `docs-openapi-check`, so the two new schemas ship in `harness-schemas.ts` in the same commit as the route, and `docs/api/openapi.json` is regenerated with BOTH commands the check compares against: `pnpm docs:export-api` and `pnpm --filter=@dorkos/site generate:api-docs`.

The route and the page action are ONE slice on purpose: the app is the primary surface and a route with no caller is dead code by this repository's own standard, so neither can land alone. **Cut line, stated in advance.** If the confirm needs anything beyond the `AlertDialog` and `Banner` primitives the page already uses — a diff, a per-tool preview, a multi-select column — slice 4 is cut WHOLE, route included, to a follow-up, and the command plus the row's printed command are what ships. That outcome is strictly better than today: the row currently names no command at all and spells one root into a literal. The row copy belongs to slice 2 precisely so that this sentence is true.

Verification: `pnpm vitest run apps/server/src/routes/__tests__/harness.test.ts`, `pnpm --filter @dorkos/shared build && pnpm --filter @dorkos/server typecheck`, `pnpm --filter @dorkos/server lint`, and a clean `docs-openapi-check` after both generators run.

Review rule: the branch faces an independent adversarial review per `REVIEW.md` before a pull request opens, and every new test must be shown failing on `main` first.

### Task 4.2: Add adoptHarness to all three Transport files and the mutation hook that writes the cache

_Size: medium · priority: high · depends on 4.1_

**Three files, because `syncHarness` is the sibling and every one of them declares it.** `packages/shared/src/transport.ts` — `adoptHarness` beside `syncHarness` at `:2107`, with TSDoc (hard rule 4). `apps/client/src/layers/shared/lib/transport/harness-methods.ts` — the HTTP half, beside `:23`. `apps/client/src/layers/shared/lib/embedded-mode-stubs.ts` — the descriptive throw the file's own convention requires, beside `:913`. Missing any of the three is a type error or a silent hole in embedded mode, which is why all three are named here.

**The hook.** `apps/client/src/layers/entities/harness/model/use-harness-adopt.ts`, beside `use-harness-sync.ts` and following it exactly. **The response REPLACES the cached status through `queryClient.setQueryData` and NOTHING is invalidated.** `use-harness-sync.ts` states the rule at `:11` and does it at `:39`, and its reason holds here identically: the POST already returns the recomputed status, so an invalidate would throw away the authoritative answer and race a fresh read against the write. This is the single most likely thing to get wrong in this slice, and it is the one an adversarial review should look for first.

The hook surfaces the refusal as data rather than as an error: a `200` carrying refusals is a normal response, and the row draws the refusal sentence where the advice line was.

Export nothing that nothing uses — `pnpm knip` must stay clean, which for a Transport method means the client half has to be reached by the row action in the same slice.

Follow Feature-Sliced Design: `entities/harness` may import from `shared`, never the other way, and imports go through each slice's barrel `index.ts`, never an internal path. That rule is an ESLint error here, not a convention.

Verification: `pnpm vitest run apps/client/src/layers/entities/harness`, `pnpm --filter @dorkos/shared build && pnpm --filter @dorkos/client typecheck`, `pnpm --filter @dorkos/client lint`, `pnpm knip`.

Review rule: the branch faces an independent adversarial review per `REVIEW.md` before a pull request opens, and every new test must be shown failing on `main` first.

### Task 4.3: Add the Share with every agent button, its confirm, and the two dialog variants

_Size: medium · priority: high · depends on 4.2_

On a row with `adoptable: true` in `apps/client/src/layers/entities/harness/ui/SkillHarnessRow.tsx`, one button beside line 3: **Share with every agent**. The copy already landed in slice 2; this task adds the action.

Pressing it opens the confirm dialog the client already uses for a change worth naming first — `AlertDialog` plus `Banner`, and nothing else. Two variants, chosen by the same condition `move.link` is:

- **S14**, for a `.claude/skills` candidate: 'Move {name} so every agent can read it?' / 'It moves from {source} to .agents/skills/{name}, and DorkOS leaves a link behind so Claude Code still finds it.' / 'Move it'.
- **S14b**, for a candidate from any other root: 'Move {name} so every agent can read it?' / 'It moves from {source} to .agents/skills/{name}, where every agent reads it.' / 'Move it'.

S14b exists because four of the five roots get no link. Promising 'a link behind so Claude Code still finds it' for a skill moved out of `.opencode/skills` would be a sentence about something that did not happen, and would leave a person hunting for a link that was never planned.

On success the page draws the same 'What changed' summary the Sync button uses, from the status the route returned. On a refusal the row draws the refusal sentence where the advice line was.

**Why a button at all, when DOR-1894 deliberately shipped none.** The comment on `SkillHarnessRow` gives the reason it was left out — moving a file out from under a person's editor is not something a side panel should offer — and half of that reason was that there was no verb to offer, so the page could not put a button on an action that did not exist. The other half is ANSWERED rather than overruled: the button does not move anything, it opens a confirm that names both paths first, which is the same disclosure the sweep already gets before the Sync button acts. Replace that comment rather than leaving it to contradict the code.

**Test case 31** in `SkillHarnessRow.test.tsx` and `SkillsWithHarnessesList.test.tsx`: the button renders only on an `adoptable` row; the confirm names BOTH paths and prints S14 for a `.claude/skills` candidate and S14b for one from any other root; **cancelling calls nothing** — assert the mutation was not invoked, not merely that the dialog closed; and a refusal draws its sentence where the advice line was.

The page-level banner stays a statement with no action: there is no single skill for a page-level button to adopt. Slice 4 gives the ROW an action.

**Cut line, stated in advance.** If the confirm needs anything beyond the `AlertDialog` and `Banner` primitives the page already uses — a diff, a per-tool preview, a multi-select column — slice 4 is cut WHOLE, route included, to a follow-up, and the command plus the row's printed command are what ships. That outcome is strictly better than today: the row currently names no command at all and spells one root into a literal. The row copy belongs to slice 2 precisely so that this sentence is true.

Verification: `pnpm vitest run apps/client/src/layers/entities/harness`, `pnpm --filter @dorkos/client typecheck`, `pnpm --filter @dorkos/client lint`, and an eyeballed screenshot of the row and both dialog variants in the running app.

Review rule: the branch faces an independent adversarial review per `REVIEW.md` before a pull request opens, and every new test must be shown failing on `main` first.

### Task 4.4: Cover the route's four status codes and the lock, press the button in the browser, and close VC-01

_Size: medium · priority: high · depends on 4.1, 4.3_

**Route tests** in `apps/server/src/routes/__tests__/harness.test.ts`:

27. **Person-only**: an agent caller gets `403` with the code and S11, asserted AGAINST `sync`'s own case so the two cannot drift. _Seeded:_ swap `resolveDecisionAuthority` for `trustedCaller` and the person-in-a-terminal case reds — DOR-502's shape.

28. **`409`** with no manifest; **`400`** for a relative `projectPath`, from the route module's own `.refine` rather than from `resolveProject`; **`404`** for a path that leads nowhere, from `resolveProject`. Each is asserted separately, because 'inherited' is a claim.

29. **`200` with a refusal** in the body, not a 4xx.

30. **The lock**: a POST arriving while another holds the repository queues and still answers `200`, and the returned status describes the tree THIS apply left. _Seeded:_ recompute the status outside the lock and interleave a write.

**Browser leg (case 32)** in `apps/e2e/tests/harness/skills-page.spec.ts`. The fixture already stages the exact tree — `apps/e2e/fixtures/harness-repo.ts` carries 'The skill kept in `.claude/skills` as a real directory — Codex cannot see it'. Press the button, confirm, and the row's chips change from "Codex can't see it" to 'Codex reads it' on the recomputed status, with the summary above the list. _Seeded:_ return the pre-apply status from the route and the chip assertion reds.

**Contract**: `VC-01`'s Actual gains the action. Raise the census floors this slice touches. Every new test title carries its row id as a prefix, which is the retitle convention census assertion 5 enforces.

**`knip` is clean** — nothing exported and unused. That is a real acceptance criterion here, because a Transport method with no caller is exactly what this slice exists to prevent.

**Changelog fragment**: one file in `changelog/unreleased/<id>-harness-adopt-button.md`, id from `node --experimental-strip-types .claude/scripts/id.ts`, to the `writing-for-humans` bar: the Skills page now has a button that moves a skill where every agent can read it, and it names both folders before it does anything.

Every enumerating assertion states how many things it found before asserting anything about them.

Verification: `pnpm vitest run apps/server/src/routes/__tests__/harness.test.ts`, `pnpm --filter @dorkos/e2e e2e -- harness/skills-page.spec.ts`, `pnpm vitest run packages/harness/src/__tests__/capabilities-census.test.ts`, `pnpm knip`, `pnpm exec prettier --check meta changelog`.

Review rule: the branch faces an independent adversarial review per `REVIEW.md` before a pull request opens, and every new test must be shown failing on `main` first.
