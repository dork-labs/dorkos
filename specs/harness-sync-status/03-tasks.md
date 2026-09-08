# Harness Sync status — implementation tasks

Canonical task data lives in [`03-tasks.json`](./03-tasks.json); this file is its human-readable mirror. Spec: [`02-specification.md`](./02-specification.md). Parent work item: [DOR-1852](https://linear.app/dorkspace/issue/DOR-1852).

## One sub-issue per slice — a deliberate override

The DECOMPOSE stage promotes a task to its own tracker sub-issue only when its size reaches `decomposition.subIssueThreshold` (default `xl`), and nothing here is `xl`. This programme overrides that on purpose: every slice runs as its own worktree, its own adversarial review and its own PR, so each one needs a tracker item the dispatch loop can pick up on its own. Seven children were created for the seven slices that ship a diff. Two phases have no child because their work is already tracked elsewhere: phase 2 is satisfied by DOR-1855, merged on `main` as `dc03b4b16`, and phase 3 is DOR-1889, which was filed before this decomposition ran and which gates phase 8.

## Phases

| Phase | Slice    | Tracker                                                        | Blocked by                                                                                                       | Tasks | Ships                                                              |
| ----- | -------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ----- | ------------------------------------------------------------------ |
| 1     | Slice 1  | [DOR-1890](https://linear.app/dorkspace/issue/DOR-1890)        | —                                                                                                                | 2     | the harness vocabulary moves into @dorkos/shared                   |
| 2     | Slice 2  | [DOR-1855](https://linear.app/dorkspace/issue/DOR-1855) (done) | —                                                                                                                | 1     | conflict reachable on a read (already shipped by DOR-1855)         |
| 3     | Slice 2b | [DOR-1889](https://linear.app/dorkspace/issue/DOR-1889)        | —                                                                                                                | 2     | checkPlan can say what a sync would delete (DOR-1889)              |
| 4     | Slice 3  | [DOR-1891](https://linear.app/dorkspace/issue/DOR-1891)        | [DOR-1890](https://linear.app/dorkspace/issue/DOR-1890), [DOR-1889](https://linear.app/dorkspace/issue/DOR-1889) | 3     | the status model and its response contract                         |
| 5     | Slice 4  | [DOR-1892](https://linear.app/dorkspace/issue/DOR-1892)        | [DOR-1891](https://linear.app/dorkspace/issue/DOR-1891)                                                          | 3     | the read-only status endpoint                                      |
| 6     | Slice 5  | [DOR-1893](https://linear.app/dorkspace/issue/DOR-1893)        | [DOR-1892](https://linear.app/dorkspace/issue/DOR-1892)                                                          | 3     | the read-only client — chips, rows and panels                      |
| 7     | Slice 6  | [DOR-1894](https://linear.app/dorkspace/issue/DOR-1894)        | [DOR-1893](https://linear.app/dorkspace/issue/DOR-1893)                                                          | 3     | the Skills page and an honest skills count                         |
| 8     | Slice 7  | [DOR-1895](https://linear.app/dorkspace/issue/DOR-1895)        | [DOR-1894](https://linear.app/dorkspace/issue/DOR-1894), [DOR-1889](https://linear.app/dorkspace/issue/DOR-1889) | 5     | the sync route and the drift banner that names what it deletes     |
| 9     | Slice 8  | [DOR-1896](https://linear.app/dorkspace/issue/DOR-1896)        | [DOR-1895](https://linear.app/dorkspace/issue/DOR-1895)                                                          | 4     | the browser test, the reason guard, the contract rows and the docs |

## Critical path

The longest dependency chain is 1.1 → 4.1 → 4.2 → 5.1 → 6.1 → 6.2 → 7.1 → 8.1 → 8.2 → 8.3 → 9.1 → 9.2 → 9.4 (13 tasks), and an equally long chain enters through Slice 2b — 3.1 → 3.2 → 4.2 and onward — because task 4.2 depends on both. At slice level that reads (Slice 1 and Slice 2b) → Slice 3 → Slice 4 → Slice 5 → Slice 6 → Slice 7 → Slice 8, with Slice 2 already on `main`. Slice 1 and Slice 2b are the two phases that can start on day one, and they are independent of each other; everything from Slice 3 onward is a single file. Slice 2b (DOR-1889) blocks Slice 3 as well as Slice 7: `buildHarnessStatus` computes `sweepPreview`, and that field is only truthful once the engine can say what a sync would delete. Inside a phase, tasks 5.2 and 5.3 run beside each other, 7.1, 7.2 and 7.3 all run beside each other, and 8.4 and 8.5 run beside each other.

## Phase 1 · Slice 1 — the harness vocabulary moves down

**Tracker:** [DOR-1890](https://linear.app/dorkspace/issue/DOR-1890) · sub-issue of [DOR-1852](https://linear.app/dorkspace/issue/DOR-1852) · no blockers.

Spec: `specs/harness-sync-status/02-specification.md` — §Implementation Phases, Slice 1; §3 "Why the harness vocabulary moves down"; Decision 17.

### Task 1.1: Move the harness vocabulary into @dorkos/shared and re-export it from packages/harness

**Size:** medium · **Priority:** high · **Depends on:** — · **Runs beside:** 3.1

Create `packages/shared/src/harness-schemas.ts` and make it the one definition of the harness vocabulary.

Files:

- `packages/shared/src/harness-schemas.ts` (NEW) — `export const HARNESS_IDS = ['claude-code', 'codex', 'cursor', 'gemini', 'copilot', 'opencode'] as const;`, `export const HarnessIdSchema = z.enum(HARNESS_IDS);`, `export type HarnessId = z.infer<typeof HarnessIdSchema>;` and `export const HARNESS_LABELS: Readonly<Record<HarnessId, string>>`, moved out of `packages/harness/src/manifest/schema.ts` (lines 7-31 today) without changing a single string.
- `packages/shared/package.json` — add `"./harness-schemas"` to the `exports` map. The package has no root entry; every consumer imports a subpath.
- `packages/harness/package.json` — add `"@dorkos/shared": "workspace:*"` to `dependencies`.
- `packages/harness/src/manifest/schema.ts` — the four names become re-exports of `@dorkos/shared/harness-schemas`, so every existing import keeps working and there is exactly one definition.

Why the move (Decision 17): the client needs `HarnessId` and `HARNESS_LABELS` to draw a chip row. It cannot import them from `@dorkos/harness`, which is a Node filesystem engine, and `@dorkos/shared` cannot depend on `@dorkos/harness` either — `harness -> skills -> shared` is an existing edge, so the reverse one is a cycle. Re-declaring the six ids in shared is duplication that goes stale on the day a seventh harness lands. The new dependency edge closes no cycle, because `harness -> skills -> shared` already implies it.

Hard rule 4 applies: every export carries a TSDoc block description, not `@param`/`@returns` tags alone.

Acceptance bar: not one import anywhere changes; `pnpm typecheck` and `pnpm test -- --run` green across the monorepo; `packages/harness/src/vendor-facts/__tests__/vendor-facts.test.ts` still asserts a skills row for every id in `HARNESS_IDS`, so the move inherits a guard rather than needing a new one.

Verification: `pnpm --filter @dorkos/shared build`; `pnpm --filter @dorkos/shared typecheck`; `pnpm --filter @dorkos/harness typecheck`; `pnpm --filter @dorkos/shared lint`; `pnpm --filter @dorkos/harness lint`; `pnpm vitest run packages/harness/src/vendor-facts/__tests__/vendor-facts.test.ts`. The branch faces an independent adversarial review per `REVIEW.md` before a PR opens.

### Task 1.2: Prove the vocabulary move changed no import and no behaviour

**Size:** medium · **Priority:** high · **Depends on:** 1.1 · **Runs beside:** —

This slice's bar is a null result, so it is measured rather than assumed.

Run and record, on the branch and against the merge base:

- `pnpm typecheck` and `pnpm test -- --run` across the monorepo — both green, with no test file edited to make them so.
- `git diff --stat` shows changes confined to `packages/shared/src/harness-schemas.ts`, `packages/shared/package.json`, `packages/harness/package.json` and `packages/harness/src/manifest/schema.ts`. Any other file in the diff means an import changed, which the slice bar forbids.
- The count of `from '@dorkos/harness'` imports across `apps/` and `packages/` is identical on both trees.
- `pnpm knip` (after building dists) reports no new dead export, since `manifest/schema.ts` now re-exports rather than declares.

Seeded defect: delete one id from `HARNESS_IDS` in the new shared module and `packages/harness/src/vendor-facts/__tests__/vendor-facts.test.ts` reds. That proves the moved constant is the one the guard reads, and not a stale copy left behind in `manifest/schema.ts` — the failure mode a re-export refactor actually has.

Verification: `pnpm vitest run packages/harness/src/vendor-facts/__tests__/vendor-facts.test.ts`; `pnpm --filter @dorkos/harness typecheck`; `pnpm --filter @dorkos/harness lint`; `pnpm knip`. The branch faces an independent adversarial review per `REVIEW.md` before a PR opens.

## Phase 2 · Slice 2 — `conflict` becomes reachable on a read

**Tracker:** [DOR-1855](https://linear.app/dorkspace/issue/DOR-1855) · no blockers.

Spec: `specs/harness-sync-status/02-specification.md` — §1.4 "The prerequisite"; §Implementation Phases, Slice 2.

### Task 2.1: Confirm DOR-1855 landed the read-side conflict prerequisite on main before Slice 3 asserts against it

**Size:** medium · **Priority:** high · **Depends on:** — · **Runs beside:** — · **Status:** done

This phase is already satisfied and gets no sub-issue. DOR-1855 is merged on `main` as `dc03b4b16` ("the projection engine runs on Windows too, and a clone without symlinks is told so", PR #1687), and it made exactly the change this slice would otherwise have made. Verified on this worktree's base `b27b8313c`: `findBlockedSymlinkTargets` is defined at `packages/harness/src/apply/apply.ts:596` and folded into `checkPlan().blocked` at line 635, and `packages/harness/src/apply/symlink-occupants.ts` exists.

What it delivered, and what Slice 3 depends on:

- `findBlockedSymlinkTargets` runs in `checkPlan` beside `findBlockedGenerateTargets`, so `checkPlan().blocked` is no longer generate-only.
- `isDrifted` answers `false` for a `file` or `directory` occupant of a symlink target, so `blocked` and `drifted` stay mutually exclusive rather than double-counting one cell.
- `apply/symlink-occupants.ts` gives each of the three occupant shapes its own sentence — a `core.symlinks=false` clone, a case-only name difference, and anything else real. Those sentences are what derivation row 2 renders as the cell's `reason`.

Why it mattered: row 2 of the derivation table — "on a read: the action is in `checkPlan().blocked`" produces `conflict` — was unreachable before it. Measured at `87d893503` on a project with `.agents/skills/alpha` and somebody's own real directory at `.claude/skills/alpha`: READ reported `drifted=2 blocked=0 clean=false`, APPLY reported `applied=1 conflicts=1` with an undefined reason, and the second READ was unchanged. Rendered naively that is a banner reading "Some agent files are out of date. Sync now", a click that changes nothing, and a banner that comes straight back forever.

One confirmation step before Slice 3 starts, and no diff: re-run that reproduction on current `main` and record that READ now reports `blocked=1` carrying a reason string, and that the second READ is unchanged rather than pretending a re-run would help. If it does not reproduce that way, this phase becomes real work again, needs its own sub-issue, and its seeded defect is the reproduction above — revert the change, `blocked` returns to `0`, and the case reds.

Verification: `pnpm vitest run packages/harness/src/apply/__tests__`; `pnpm --filter @dorkos/harness typecheck`. No adversarial review is owed for a phase that ships no diff; the review that mattered happened on PR #1687.

## Phase 3 · Slice 2b — `checkPlan` can say what a sync would delete

**Tracker:** [DOR-1889](https://linear.app/dorkspace/issue/DOR-1889) · no blockers.

Spec: `specs/harness-sync-status/02-specification.md` — §2.2.1 "The engine cannot answer that question yet"; §Implementation Phases, Slice 2b; Decisions 36 and 37.

### Task 3.1: Split the five one-pass sweeps into find/sweep halves and make checkPlan().orphans their union

**Size:** medium · **Priority:** high · **Depends on:** — · **Runs beside:** 1.1

Engine-only change, already tracked as DOR-1889, and Slice 7 may not ship before it.

`applyPlan().swept` is the union of six sweeps (`packages/harness/src/apply/apply.ts:501-509`): installed orphans, authored orphans, generated orphans, generated command orphans, OpenCode command orphans, and the settings-hooks orphan. `checkPlan().orphans` is one of them — `findOrphanedAuthoredLinks` (`apply/apply.ts:584`), which explicitly skips anything carrying the installed-projection marker (`apply/authored-orphans.ts:59`). Only the authored sweep has ever been split into a `find*` and a `sweep*`; the other five enumerate and delete in a single pass, so nothing outside an apply can ask them what they would take.

Split each of the five the way `authored-orphans.ts` already is — an enumerating `find*` and a `sweep*` that calls it and deletes: `sweepInstalledOrphans`, `sweepGeneratedCommandOrphans`, `sweepOpencodeCommandOrphans` (all in `packages/harness/src/apply/apply.ts`), `sweepGeneratedOrphans` (`apply/generated-targets.ts`) and `sweepSettingsHooksOrphan` (via `apply/settings-hooks.ts`). Then `checkPlan().orphans` returns the union of all six finders, sorted and de-duplicated, and `clean` is false whenever any of them is non-empty.

The harness-filter guard moves with the widened set. `packages/cli/src/harness-sync-command.ts:310` zeroes orphans under `--harness <id>`, because a filtered plan reads another harness's live projections as orphans — the same hazard `projectWithConsent` refuses outright when a filter meets a sweep. Widening the set widens that hazard. If DOR-1854 has landed its `isAtomicTempName` skips on the command sweeps, the find halves keep them.

Two consequences the PR states rather than letting a reader discover: `dorkos harness sync --check` starts reporting a case it was silent about and exits non-zero where it exited `0`, which is the correct direction of `reportCheck`'s own rule that a `--check` staying silent about something a `--fix` will remove is the same lie as one reporting something a `--fix` will not; and the widened orphan set inherits the filter guard above.

Acceptance bar: on the ten-path fixture, `checkPlan().orphans` equals the next `applyPlan().swept` as sets. On the plugin-only fixture, `clean` is `false` and the nine paths are named where the tree previously read clean.

Verification: `pnpm vitest run packages/harness/src/apply/__tests__`; `pnpm --filter @dorkos/harness typecheck`; `pnpm --filter @dorkos/harness lint`. The branch faces an independent adversarial review per `REVIEW.md` before a PR opens.

### Task 3.2: Pin the widened orphan set with the two measured reproductions and the two CLI cases

**Size:** medium · **Priority:** high · **Depends on:** 3.1 · **Runs beside:** —

Two fixtures, both measured at `87d893503` on a repo enabling `claude-code, codex, opencode` with one authored skill and one project-scoped plugin shipping skills, commands and hooks.

Fixture A, ten paths — the person deletes the skill and uninstalls the plugin. Before the change, READ reports `drifted=0 blocked=0 clean=false orphans=[".claude/skills/alpha"]` while APPLY sweeps ten: `.agents/skills/acme__greet`, `.claude/skills/acme__greet`, `.claude/skills/alpha`, `.codex/hooks.json`, `.codex/hooks.json.dorkos-generated`, `.claude/commands/acme/.gitignore`, `.claude/commands/acme/hello.md`, `.opencode/commands/.gitignore`, `.opencode/commands/acme-hello.md`, `.claude/settings.local.json`. Assert set equality in both directions between `checkPlan().orphans` and the next `applyPlan().swept`, with the count asserted before the contents so an empty-versus-empty pass is impossible.

Fixture B, plugin only — only the plugin is uninstalled. Before the change, `checkPlan().clean` is `true` and `orphans` is empty while a sync removes nine files: a tree the engine calls clean and a sync that deletes nine paths. Assert `clean` is `false` and that all nine paths are named.

CLI cases, in `packages/cli/src/__tests__/harness-sync.test.ts`: `dorkos harness sync --check` now exits non-zero on fixture B where it exited `0`, and `--harness <id>` still reports no orphans, proving the filter guard travelled with the widened set.

Seeded defects: revert the union in `checkPlan` and both fixtures red — A on the count, B on `clean`. Drop the harness-filter guard and the `--harness <id>` case reds by reporting another harness's live projections as orphans. Use real `mkdtempSync` temp trees, never `node:fs` mocks, so the assertion is about files rather than about a stub.

Verification: `pnpm vitest run packages/harness/src/apply/__tests__`; `pnpm vitest run packages/cli/src/__tests__/harness-sync.test.ts`; `pnpm --filter @dorkos/harness typecheck`; `pnpm --filter dorkos typecheck`; lint on both packages. The branch faces an independent adversarial review per `REVIEW.md` before a PR opens.

## Phase 4 · Slice 3 — the status model and its contract

**Tracker:** [DOR-1891](https://linear.app/dorkspace/issue/DOR-1891) · sub-issue of [DOR-1852](https://linear.app/dorkspace/issue/DOR-1852) · blocked by [DOR-1890](https://linear.app/dorkspace/issue/DOR-1890), [DOR-1889](https://linear.app/dorkspace/issue/DOR-1889).

Spec: `specs/harness-sync-status/02-specification.md` — §1 (the whole status model), §4 (the response schema), §Testing Strategy "Unit — the derivation table".

### Task 4.1: Add the HarnessStatusResponse and HarnessSyncResponse contract to @dorkos/shared

**Size:** medium · **Priority:** high · **Depends on:** 1.1 · **Runs beside:** —

Extend `packages/shared/src/harness-schemas.ts` (created in Slice 1) with the response contract, exported at `@dorkos/shared/harness-schemas`. The two exported types are `HarnessStatusResponse` and `HarnessSyncResponse`, and those names are used everywhere — the schema, the route, the `Transport` signature, the client hooks and the mock factory.

Schemas to add:

- `HarnessCellStateSchema` = `z.enum(['native', 'projected', 'drifted', 'dropped', 'warned', 'conflict', 'pending-approval'])`. Seven values; `unmanaged` is row-level and is not a cell state (Decision 4).
- `HarnessArtifactKindSchema` = `z.enum(['skill', 'instruction', 'hook', 'command', 'plugin', 'agent', 'rule', 'mcp'])`.
- `HarnessProvenanceSchema` = `z.enum(['authored', 'installed', 'adopted', 'harness-native'])`. `harness-native` is this model's fourth value; the engine has three. `adopted` never occurs in v1 because nothing produces an adopted projection yet, and it stays in the enum because the engine's `Provenance` has it and dropping it would make the mapping table lie.
- `HarnessCellSchema` = `{ state, reason?: string, target?: string, warnings?: string[] }`.
- `HarnessRowSchema` = `{ artifact, provenance, name: string, source?: string, adoptable: boolean, cells: z.record(HarnessIdSchema, HarnessCellSchema) }`.
- `HarnessProjectEntrySchema` = `{ kind: z.enum(['drop','warning']), artifact, name, source?, reason: string }` — an entry that is about no harness at all.
- `HarnessPendingApprovalSchema` = `{ packageName, events: string[], commandCount: nonneg int, reason: z.enum(['unasked','refused','unreadable-config']), detail?: string }`. No command strings, ever.
- `HarnessStatusResponseSchema` = `{ projectPath, state: z.enum(['ready','not-set-up','unreadable','unavailable']), detail?, computedAt, enabled: HarnessId[], notEnabled: { harness, signal }[], clean: boolean, counts: { skills, drifted, conflicts, orphans, adoptable, pendingApproval } (all nonneg ints), sweepPreview: string[], rows: HarnessRow[], projectLevel: HarnessProjectEntry[], pendingApproval: HarnessPendingApproval[] }`.
- `HarnessSyncResponseSchema` = `{ status: HarnessStatusResponseSchema, applied: nonneg int, swept: string[], conflicts: nonneg int, askedAbout: string[] }`.

Three properties the TSDoc has to carry, because they are contracts rather than shapes: `counts.skills` is a count of ROWS, not of inventory entries — a skill present in both `.agents/skills` and `.claude/skills` is two files and two rows and counts twice, because the number under the profile row has to match the number of rows the page draws (measured: 6 on the J-01 fixture, 31 on this repository). `sweepPreview` is every path a sync would delete, equal to the next `swept` and never a subset of it. There is no `drops` map: every non-agnostic drop is already a cell of some row, and carrying one measured 46,244 bytes against 32,415 for the same facts twice.

Hard rule 4: TSDoc block description on every export.

Verification: `pnpm --filter @dorkos/shared build`; `pnpm --filter @dorkos/shared typecheck`; `pnpm --filter @dorkos/shared lint`. The branch faces an independent adversarial review per `REVIEW.md` before a PR opens.

### Task 4.2: Build buildHarnessStatus() — the eight states derived from five reads

**Size:** large · **Priority:** high · **Depends on:** 4.1, 2.1, 3.2 · **Runs beside:** —

Create `apps/server/src/services/harness/status.ts` exporting `buildHarnessStatus()` — a plain function over an options bag, so the CLI can pass the consent copy it reads off disk (`planWithConsent` already accepts a `decisions` override, DOR-678).

It is a pure function of five reads, all of which already exist: `planWithConsent(projectPath, { dorkHome, decisions })` -> `{ plan, withheld }`; `checkPlan(projectPath, plan)` -> `{ drifted, blocked, orphans, leftAlone, clean }`; `inventorySourceTree(projectPath)` -> `SourceInventory`; `loadManifest(projectPath).harnesses` -> the enabled set; and `loadManifest(projectPath).claudeOnlySkills` -> the declared Claude-only names. After a write a sixth joins them: `applyPlan`'s `{ applied, conflicts, swept, leftAlone }`, returned through `projectWithConsent`. The model never re-derives a harness's behaviour: where a chip says "Codex can't see it", the sentence under it is the plan's own `reason` string, unchanged, so a wrong chip is a plan bug fixed in the plan. `harnessCoverage()` is not called — its own module doc calls it the oracle a projection is measured against, and running it here would put a second, independent model of six vendors' behaviour on a screen where it could disagree with the first (Decision 7).

The derivation table, per cell, first match wins: (1) after a write, the action is in `applyPlan().conflicts` -> `conflict`, reason is the action's; (2) on a read, the action is in `checkPlan().blocked` -> `conflict`, reason is the action's; (3) the cell is a hook contributed by a package in `withheld` -> `pending-approval`; (4) the action is in `checkPlan().drifted` -> `drifted`, no reason, the row's target says where; (5) the action is in `plan.drops` -> `dropped`, the drop's reason verbatim; (6) the action is in `plan.actions` with `kind: 'native'` -> `native`, the action's reason when it carries one; (7) the action is in `plan.actions` with `kind` in symlink/scaffold/generate/merge -> `projected`; (8) nothing above names the cell and a `ProjectionWarning` does -> `warned`, the warning's reason verbatim. `conflict` outranks `drifted` because "re-run and it fixes itself" and "re-running will never fix this" mean opposite things to a person. `pending-approval` outranks everything but `conflict` because a withheld package's hooks are filtered out before the plan is built, so the state fills a hole rather than overriding anything.

Row identity is `(artifact, source, name)`, all three load-bearing. Warnings attach rather than fork: a warning attaches to the row whose `(artifact, source)` it shares, choosing by `name` when more than one such row exists, and forms its own row only when it matches none. A `ProjectionWarning` has two shapes — projected-but-suspect rides its cell as `warnings: string[]` beside whatever state row 6 or 7 gave it, read-but-unusable has no action or drop to ride and row 8 makes it `warned`. Anything carrying `harnessAgnostic === true` is filed under `projectLevel[]` and is never a cell and never a row; `source` absence is not the discriminator, because `planUnreadableHookWarnings` carries a `source` and is still agnostic. Provenance comes from the action or drop, a warning-only row takes `authored`, and one override on top is the only producer of `harness-native`: the row's `source` is an inventory skill whose `root` is `.claude/skills`.

`adoptable` is row-level and reads straight off the inventory: `inventory.skills.filter((s) => s.root === '.claude/skills' && !canonicalNames.has(s.name) && !claudeOnlyNames.has(s.name))`. Both exclusions are the definition rather than an optimisation. `pendingApproval` carries the package name, the events and the count and never the command strings — the approval card is the surface built to show those, with redaction, a length cap, escaping and a plain-words event.

The envelope around the rows, field by field, so none of it has to be inferred. `projectPath` is the canonical absolute path the boundary validator resolved. `state` is `ready` when the manifest parsed, `not-set-up` when there is no `.agents/harness.manifest.json`, `unreadable` when there is one and it will not parse (with `detail` carrying the parse failure in words), and `unavailable` when the build has no harness service; on any state but `ready` only `projectPath`, `state` and `detail` are meaningful, every list is empty and every count is zero. `computedAt` is the ISO timestamp of the read. `enabled` is `loadManifest(projectPath).harnesses` in manifest order, because the chip row draws in that order. `notEnabled` is read defensively as `plan.notEnabled ?? []` so the code compiles whether or not DOR-1851 has landed; each entry is `{ harness, signal }`, and it is `[]` on the J-01 fixture because that tree holds no `.cursor/`, `.codex/` or `.opencode/` footprint for detection to find.

`clean` is false whenever `checkPlan()` reports any drift, any blocked action, or any orphan. Do not read `DriftResult.clean` while filtering orphans out — that is a seeded defect in the unit suite, and it is what makes a tree with only orphans look clean. Once Slice 2b has landed, `checkPlan().orphans` is the union of all six sweeps, so `clean` is false when only orphans exist and false on the plugin-only fixture where `main` reads clean while a sync deletes nine files.

`sweepPreview` is `checkPlan().orphans` — repo-relative, sorted, de-duplicated — and it is every path a sync would delete, exactly the set the next `swept` returns. The contract is equality, not containment: "most of what will be deleted" is a warning with a hole in it, and the hole is where the surprise lives. This field is the reason this task depends on Slice 2b (DOR-1889): before that widening the preview is 1 path against a click that deletes 10.

`counts` is six numbers. `skills` counts ROWS whose `artifact` is `skill`, so a skill present in both `.agents/skills` and `.claude/skills` is two files, two rows and two counts, because the number under the profile row has to match the number of rows the page draws. `drifted` and `conflicts` count cells in those states. `orphans` is `checkPlan().orphans.length`. `adoptable` counts rows with `adoptable: true`. `pendingApproval` is the length of the `pendingApproval[]` list, one entry per withheld package. Measured on J-01: `{ skills: 6, drifted: 2, conflicts: 0, orphans: 0, adoptable: 6, pendingApproval: 0 }`, over 17 rows and 51 cells, with drops falling 1 under Claude Code, 16 under Codex and 9 under Cursor, and `projectLevel` empty because that fixture installs no marketplace plugin.

Vocabulary drift is caught at compile time: map the engine's `ArtifactType` and `Provenance` onto the schema's through a `satisfies Record<ArtifactType, z.infer<typeof HarnessArtifactKindSchema>>` table, the technique `plan/source-artifacts.ts` already uses so the compiler names the gap when a kind is added.

Acceptance bar: the J-01 fixture derives 17 rows and 51 cells with no missing cell; every one of the eight states is produced by a named case. Budget: p50 under 150 ms of event-loop time and under 250 KB for a repo of this size (measured here: 22.1 ms and 32,415 bytes), re-measured in the PR.

Verification: `pnpm --filter @dorkos/server typecheck`; `pnpm --filter @dorkos/server lint`; the unit suite of task 4.3. The branch faces an independent adversarial review per `REVIEW.md` before a PR opens.

### Task 4.3: Pin the derivation with twelve unit cases over the real J-01 fixture and three small trees

**Size:** medium · **Priority:** high · **Depends on:** 4.2 · **Runs beside:** —

Write `apps/server/src/services/harness/__tests__/status-model.test.ts` over the real J-01 fixture, staged the way `packages/harness/src/__tests__/journeys/j01-claude-project-nothing-silent.test.ts:60-135` stages it — a root `CLAUDE.md`, six skills as real directories under `.claude/skills/`, two commands, one subagent, three rules (`api` with globs, `testing` whose `paths: **/*.test.ts` will not parse, `style` with no frontmatter), hooks in both `.claude/settings.json` and `.claude/settings.local.json`, one skill declaring hooks in its own frontmatter, a `.mcp.json` with two servers, no `.agents/`, no `AGENTS.md`, manifest enabling `claude-code, codex, cursor`. Real `mkdtempSync` temp dirs, no `node:fs` mocks. Three small extra trees cover what J-01 cannot produce. Every test title carries the contract row id `VC-01`, because the T8 census reads titles.

Twelve cases, each with the seeded defect that must red it first. The count is twelve: the spec's Slice 3 bar line says "each of the eleven seeded defects reds its case", and the table it refers to lists twelve. The table is right, and this task is written against the table; the bar line is a stale number to be corrected in a later docs pass, not a case to be dropped.

1. J-01 derives 17 rows and 51 cells with no enabled harness missing a cell, asserted before anything else — a `rows: []` early return otherwise still passes every other case.
2. The two MCP servers stay two rows and the two settings-file hook groups stay two rows — drop `name` (or `source`) from the row key and it reds.
3. The unparseable rule's warning rides the `claude-code` cell it already had and forks no row — key the warning by `(artifact, source, name)` and it reds with a second `rule` row holding one cell and two missing cells.
4. A `.claude/skills` skill is `native` for Claude Code and Cursor and `dropped` for Codex, with the reasons verbatim — paraphrase one reason and it reds.
5. All six J-01 skills are `adoptable`, and on a tree whose skills are declared `counts.adoptable` is 0 — drop the `listed` exclusion.
6. A skill in both roots is not adoptable and both rows appear — drop the `alsoCanonical` exclusion, or dedupe by name.
7. A harness-agnostic drop and a harness-agnostic warning both land in `projectLevel` and in no cell — key project-level on `source === undefined`.
8. A real directory at a symlink target is `conflict` on a read — revert Slice 2's prerequisite and `blocked` is 0 and the case reds.
9. A withheld package's hooks are `pending-approval` and no command text is anywhere in the response — pass `request.hooks` through.
10. An unreadable plugin `hooks/hooks.json` produces a `warned` cell, the row-8 shape J-01 cannot make — make every warning an annotation.
11. `clean` is false when only orphans exist and `sweepPreview` names them — read `clean` off `DriftResult` while filtering orphans out.
12. An uninstalled plugin alone makes `clean` false and `sweepPreview` names all nine of its paths — revert Slice 2b and `clean` is `true` and the preview is empty.

Verification: `pnpm vitest run apps/server/src/services/harness/__tests__/status-model.test.ts`; `pnpm --filter @dorkos/server typecheck`; `pnpm --filter @dorkos/server lint`. The branch faces an independent adversarial review per `REVIEW.md` before a PR opens.

## Phase 5 · Slice 4 — GET /api/harness/status

**Tracker:** [DOR-1892](https://linear.app/dorkspace/issue/DOR-1892) · sub-issue of [DOR-1852](https://linear.app/dorkspace/issue/DOR-1852) · blocked by [DOR-1891](https://linear.app/dorkspace/issue/DOR-1891).

Spec: `specs/harness-sync-status/02-specification.md` — §2.1, §Security Considerations, §Testing Strategy "Route — supertest".

### Task 5.1: Add apps/server/src/routes/harness.ts with the GET, and mount it at /api/harness

**Size:** medium · **Priority:** high · **Depends on:** 4.2 · **Runs beside:** —

Create `apps/server/src/routes/harness.ts` with `GET /api/harness/status?projectPath=<absolute path>` only, and mount it in `apps/server/src/index.ts` with `app.use('/api/harness', createHarnessRouter(deps))`, beside its neighbours.

The module doc states the rule the route inherits, in these words: this route never writes. `dorkos harness sync --check` learned that the hard way (DOR-678, contract AP-03) — run in a folder with no manifest, it quietly scaffolded one into whatever directory the person was standing in. Three things are therefore deliberately not done: no `scaffoldManifest`, so a project with no manifest answers `state: 'not-set-up'`; no `enableHarnessInManifest`, because the not-enabled notice is copy; and no store creation, because the route runs inside the server whose `conf` store is already open, so `storedHookDecisions()` is the correct reader and writes nothing. `readHookDecisionsFromDisk` exists for the CLI, a separate process where opening the store would create the file; that is DOR-678's rule and it does not transfer to the server.

Four values of one `state` field: `ready` when the manifest parsed, everything populated; `not-set-up` when there is no `.agents/harness.manifest.json`, carrying `projectPath`, `state` and empty lists; `unreadable` when there is one and it will not parse, carrying `state` and `detail` (the parse failure, in words); `unavailable` when the build has no harness service, carrying `state` and `detail`. `not-set-up` is a `200` and not a `404`, because a `404` says the route is not there while a project with no manifest is a state the page is built to render, and turning it into an error class makes every caller re-derive the difference.

Failures that are still failures: a missing or blank `projectPath` is `400`; a path outside the boundary is `403`; an unexpected throw is `500` with the message logged and not echoed.

Boundary: `validateBoundaryOrDorkHome`, not `validateBoundary`. The page's whole subject is an agent, and a DorkOS-managed agent lives at `{dorkHome}/agents/<slug>` — the exact subtree `validateBoundary` refuses, so using it would 403 the surface this is built for. `boundary.ts`'s own rule admits read-only listing to the wider validator because it is names only, no file contents and no writes, and this response carries artifact names, repo-relative paths and reasons and never file bytes. The GET carries no caller-authority bar: it is a read of names, paths and reasons about a project the caller can already see, the same information `dorkos harness sync --check` prints to anyone with a shell, and gating it would make an agent unable to answer "what can you see?" about itself.

Verification: `pnpm --filter @dorkos/server typecheck`; `pnpm --filter @dorkos/server lint`; the supertest suite of task 5.3. The branch faces an independent adversarial review per `REVIEW.md` before a PR opens.

### Task 5.2: Register the GET in the OpenAPI registry and regenerate docs/api/openapi.json

**Size:** medium · **Priority:** medium · **Depends on:** 5.1 · **Runs beside:** 5.3

Hand-register the route in `apps/server/src/services/core/openapi-registry.ts` — the legacy half, because no capability projects these paths — with one `registerPath` call for `GET /api/harness/status`, then regenerate `docs/api/openapi.json` with `pnpm docs:export-api`. The `docs-openapi-check` workflow is the gate and it reports on `merge_group`, so a stale generated file blocks the queue rather than the PR.

Two things to get right while writing it. The response schema is `HarnessStatusResponseSchema` from `@dorkos/shared/harness-schemas` registered through `@asteasolutions/zod-to-openapi`, not a hand-written duplicate — a second copy of a 13-field envelope is a copy that goes stale. And the route description is read against the retired-word list before it is written: `docs/api/openapi.json` is a literal scan target of `scripts/check-banned-words.sh`, so a retired noun in a summary line fails the `typecheck` workflow rather than a review.

Also cover the documented failure codes in the registration — `400` for a missing or blank `projectPath`, `403` for a path outside the boundary, `500` for an unexpected throw — so a reader of `/api/docs` sees the same four `state` values and the same three failures the route actually produces.

Acceptance bar: `docs-openapi-check` green; `bash scripts/check-banned-words.sh` clean with the regenerated file in the tree; the `/api/docs` entry shows the four `state` values.

Verification: `pnpm docs:export-api` then `git diff --stat docs/api/openapi.json`; `bash scripts/check-banned-words.sh`; `pnpm --filter @dorkos/server typecheck`; `pnpm --filter @dorkos/server lint`. The branch faces an independent adversarial review per `REVIEW.md` before a PR opens.

### Task 5.3: Cover the GET with supertest: the never-writes snapshot and both boundary cases

**Size:** medium · **Priority:** high · **Depends on:** 5.1 · **Runs beside:** 5.2

Write `apps/server/src/routes/__tests__/harness.test.ts` with the GET half of the route suite. The fixture is a temp repo plus a fake `HookApprovalGateway` — the narrow interface `hook-approval.ts` exports for exactly this. No `FakeAgentRuntime`: these routes touch no runtime, and wiring one in would be a prop the test never reads.

Three cases, each with the seeded defect that reds it:

1. `AP-03 / DOR-678` — a GET on a manifest-less repo answers `state: 'not-set-up'`, and a whole-tree path-set snapshot taken before the call is byte-identical to the one taken after. Seeded defect: call `scaffoldManifest` in the route and the snapshot diverges by the manifest it wrote. The snapshot is the assertion, not the status code, because the status code was already right on the day DOR-678 shipped the bug.
2. A GET on an agent home under `{dorkHome}/agents/*` answers `200`. Seeded defect: swap `validateBoundaryOrDorkHome` for `validateBoundary` and it reds with `403` — the exact regression that would 403 the surface this is built for.
3. A GET outside the boundary answers `403`. Seeded defect: drop the validator and it reds.

Add the two envelope cases while the fixture is there: a repo whose `.agents/harness.manifest.json` will not parse answers `state: 'unreadable'` with `detail` carrying the parse failure in words, and a missing or blank `projectPath` answers `400`.

Verification: `pnpm vitest run apps/server/src/routes/__tests__/harness.test.ts`; `pnpm --filter @dorkos/server typecheck`; `pnpm --filter @dorkos/server lint`. The branch faces an independent adversarial review per `REVIEW.md` before a PR opens.

## Phase 6 · Slice 5 — the read-only client

**Tracker:** [DOR-1893](https://linear.app/dorkspace/issue/DOR-1893) · sub-issue of [DOR-1852](https://linear.app/dorkspace/issue/DOR-1852) · blocked by [DOR-1892](https://linear.app/dorkspace/issue/DOR-1892).

Spec: `specs/harness-sync-status/02-specification.md` — §3 (code structure), §5 (Transport), §User Experience "A skill row" and the panels.

### Task 6.1: Add getHarnessStatus to Transport with its HTTP, embedded and mock implementations

**Size:** medium · **Priority:** high · **Depends on:** 5.1 · **Runs beside:** —

Add one method to the `Transport` port and give it its three implementations.

- `packages/shared/src/transport.ts` — `getHarnessStatus(projectPath: string): Promise<HarnessStatusResponse>`, with the TSDoc sentence "Read what DorkOS shares with each agent tool for one project. Never writes."
- `apps/client/src/layers/shared/lib/transport/harness-methods.ts` (NEW) — the `HttpTransport` half, following `marketplace-methods.ts`: `fetchJSON` plus `buildQueryString`, with no path segments to encode. Wire it through `transport/http-transport.ts` and `transport/index.ts`.
- `apps/client/src/layers/shared/lib/embedded-mode-stubs.ts` — the `DirectTransport` (Obsidian) stub resolves `{ state: 'unavailable', detail: 'Agent file sharing runs in the DorkOS app.', … }` with empty lists. It returns `unavailable` rather than an empty list on purpose: an empty list would tell an Obsidian user they have no skills, which is the same lie this whole change is fixing (Decision 26). The file's stated convention is empty arrays for list operations and descriptive errors for write operations, and this read is the documented exception with its reason beside it.
- `packages/test-utils/src/mock-factories.ts` — the mock `Transport` gains the method, defaulting to a clean `ready` status so every existing client test keeps compiling and no test has to know about harnesses to run.

Hard rule 4: TSDoc block description on every export.

Verification: `pnpm --filter @dorkos/shared build`; `pnpm --filter @dorkos/shared typecheck`; `pnpm --filter @dorkos/client typecheck`; `pnpm --filter @dorkos/test-utils typecheck`; `pnpm --filter @dorkos/client lint`. The branch faces an independent adversarial review per `REVIEW.md` before a PR opens.

### Task 6.2: Build the entities/harness slice: query keys, the two read hooks, the display helpers, the chip, the row, the list and the two panels

**Size:** large · **Priority:** high · **Depends on:** 6.1 · **Runs beside:** —

Create `apps/client/src/layers/entities/harness/` with `index.ts` as the barrel every consumer imports through. FSD placement is `entities` and not `features`: it is a path in and a list out, the same reasoning `SkillPacksList`'s own doc gives for living in `entities/marketplace`. The profile feature composes it, which is the allowed direction.

Files:

- `model/query-keys.ts` — `harnessKeys.status(projectPath)`.
- `model/use-harness-status.ts` — `useQuery` with `staleTime: 30_000`, matched to the marketplace hook beside it, and refetch-on-mount.
- `model/use-harness-status-cached.ts` — a `useQuery` with `enabled: false` that subscribes to the cached entry and never fetches (Decision 28).
- `lib/harness-status.ts` — pure display helpers: the chip word per state, the tone, and the drop grouping that builds the per-harness panels from `rows` (there is no `drops` map in the response; grouping on the client is what keeps one copy of each sentence).
- `ui/HarnessStateChip.tsx`, `ui/SkillHarnessRow.tsx`, `ui/SkillsWithHarnessesList.tsx`, `ui/NotSharedPanel.tsx`.

A skill row is two lines plus a third when adoptable: line 1 the skill name with its source path muted and right-aligned, truncated from the left with the full path in `title`; line 2 one chip per enabled harness in manifest order, wrapping with `flex-wrap`; line 3 only when `adoptable`, muted, one sentence, no button. Chips wrap and there is no breakpoint: a docked panel at its narrowest, a phone sheet and a full-page profile all get the same rows with chips falling onto a second line, because one layout is one thing to keep true and a sideways-scrolling chip strip hides state behind a gesture on the surface whose job is to show state.

The healthy row collapses. When every enabled harness is `native` or `projected` the row draws one chip — "Shared with all 3" — instead of three identical ones, and any exception expands it to the full chip row automatically. A page-level "Show every agent tool" toggle expands them all, held in component `useState` because it is a view preference for one visit rather than app state. The reason is the 31-skill case: a wall of identical chips is what a person reads past to find the row that matters. The collapsed chip is a button and its `title` names the harnesses, so nothing is unreachable.

Chip words, one per state, plain: `native` "<harness> reads it" neutral; `projected` "<harness> shared" neutral; `drifted` "<harness> out of date" info; `dropped` "<harness> can't see it" muted; `warned` "<harness> may not work" warning; `conflict` "<harness> blocked" warning; `pending-approval` "<harness> needs your OK" warning. Every chip carries its `reason` as its accessible description and its `title`; a chip with no reason carries its target path instead; a cell with `warnings` keeps its state chip and gains a small marker whose description is the warning text.

`NotSharedPanel` is one collapsed panel per enabled harness that has `dropped` cells, headed with the harness label, each row `<kind> <name>` and the reason verbatim. This is the honesty gate, and verbatim is the point: the CLI prints the same string, so a paraphrase would have two surfaces describing one fact in two voices with no way to tell which is current. It also renders `projectLevel` as a "Project-level notices" panel, mirroring the CLI's `plugin layers:` heading, so a project running only Codex is never shown a notice filed under Claude Code.

Import through barrels only, never internal paths. Verification: `pnpm --filter @dorkos/client typecheck`; `pnpm --filter @dorkos/client lint` (the FSD layer rule is a `no-restricted-imports` error). The branch faces an independent adversarial review per `REVIEW.md` before a PR opens.

### Task 6.3: Cover the list, the chip row, the collapse, the six page states and the cached hook with component tests

**Size:** medium · **Priority:** high · **Depends on:** 6.2 · **Runs beside:** —

Write `apps/client/src/layers/entities/harness/ui/__tests__/` with React Testing Library and jsdom, feeding a mock `Transport` through `TransportProvider`.

Cases:

- The list draws one row per skill and one chip per enabled harness, with both counts asserted first so an empty render cannot pass the rest.
- A healthy row draws one collapsed chip; a row with one exception draws the full chip row; the page-level toggle expands them all.
- Each of the six page states renders its own copy: loading draws three skeleton rows and no spinner; error draws "Couldn't load skills." and a Retry; `not-set-up` draws "DorkOS isn't sharing agent files for this folder yet." plus the `dorkos harness sync --fix` line and a docs link; `unreadable` draws "DorkOS can't read this folder's agent file settings." plus `detail`; `unavailable` draws "Agent file sharing runs in the DorkOS app."; and a `ready` status with zero skills draws "No skills here yet." with the marketplace link, which is honest because it is now measured over every source rather than over marketplace skill-packs.
- The "Not shared with <harness>" panel renders one section per enabled harness with `dropped` cells and repeats each reason verbatim, so the tooltip is never the only copy of a sentence.
- The cached hook renders nothing on a cold cache and the count on a warm one, and fires no request either way. Seeded defect: drop `enabled: false` and a request is made, which the mock `Transport` call count reds.

Verification: `pnpm vitest run apps/client/src/layers/entities/harness/ui/__tests__`; `pnpm --filter @dorkos/client typecheck`; `pnpm --filter @dorkos/client lint`. The branch faces an independent adversarial review per `REVIEW.md` before a PR opens.

## Phase 7 · Slice 6 — the page

**Tracker:** [DOR-1894](https://linear.app/dorkspace/issue/DOR-1894) · sub-issue of [DOR-1852](https://linear.app/dorkspace/issue/DOR-1852) · blocked by [DOR-1893](https://linear.app/dorkspace/issue/DOR-1893).

Spec: `specs/harness-sync-status/02-specification.md` — §User Experience "The Skills page" and "The profile row's count"; §3 (code structure).

### Task 7.1: Compose the Skills page from the new slice and delete SkillPacksList

**Size:** medium · **Priority:** high · **Depends on:** 6.2 · **Runs beside:** 7.2, 7.3

Rewrite `apps/client/src/layers/features/profile/ui/pages/SkillsPage.tsx` to compose the `entities/harness` slice through its barrel. No new route: this is the agent profile's existing Skills page at `?profilePage=skills`, reachable from the `skills` row in the Toolkit section, in the docked panel, the sheet and the full-page profile alike.

Order on the page, top to bottom: the not-enabled notice as its own row when `notEnabled` is non-empty; the skills list, one row per skill; a "Not shared with <harness>" panel per enabled harness, collapsed by default; a "Project-level notices" panel when `projectLevel` is non-empty; and "Browse skill-packs", the existing marketplace link, unchanged and still at the foot. The banner and the "What changed" summary land in Slice 7 and their slots are left for it.

The not-enabled notice is copy, not a button: "Cursor files are in this folder, but DorkOS isn't sharing to it." plus "Run `dorkos harness sync --fix --enable cursor` in this folder to turn it on." `enableHarnessInManifest` writes `.agents/harness.manifest.json`, a committed and team-shared file, and a button in a side panel that edits one with no diff and no undo is a bigger promise than the fact it fixes (Decision 24). If DOR-1851 has not landed, read `plan.notEnabled ?? []` and this row simply does not draw.

Delete `apps/client/src/layers/entities/marketplace/ui/SkillPacksList.tsx` and its export from `apps/client/src/layers/entities/marketplace/index.ts`. It read `GET /api/marketplace/installed`, filtered to `type === 'skill-pack'`, and rendered "No skills installed. Browse the marketplace to add skills to this agent." to a person with 31 skills. It is deleted rather than left beside the new list, because a superseded component that still compiles is the legacy pattern the codebase standard refuses.

Acceptance bar: on this repository the page lists 31 skills; `pnpm knip` reports no new dead export after the deletion; a screenshot of the page at the docked panel's narrowest width goes in the PR.

Verification: `pnpm vitest run apps/client/src/layers/features/profile`; `pnpm --filter @dorkos/client typecheck`; `pnpm --filter @dorkos/client lint`; `pnpm knip`. The branch faces an independent adversarial review per `REVIEW.md` before a PR opens.

### Task 7.2: Make the profile row read the skills count from cache and never fire the query

**Size:** medium · **Priority:** high · **Depends on:** 6.2 · **Runs beside:** 7.1, 7.3

`apps/client/src/layers/features/profile/model/use-managed-agent-facts.ts` counts installed marketplace `skill-pack` packages today, which is why the Toolkit row says "Skills 0" about an agent with 31. Point it at `use-harness-status-cached` instead and read `counts.skills`.

It must not fire the status query. `buildHarnessStatus` is three synchronous filesystem walks — `project()`, `checkPlan()` and `inventorySourceTree()` all use `node:fs`'s blocking API, measured at 22.1 ms together on this repository — and the profile opens on every `/session`, so making the row's number cost a ~22 ms event-loop stall on every profile open would be paying for a number nobody asked for yet (Decision 28). The row reads whatever `harnessKeys.status(projectPath)` already holds through the `enabled: false` hook, and renders nothing when it is empty. `countValue(null)` in `lib/profile-rows.ts` already draws no value rather than inventing a zero, so the row goes from "Skills 0" (a lie) to "Skills" (silence) to "Skills 31" (the truth) once the page has been opened. Silence is the correct middle state and it is the one the module was already designed for.

Acceptance bar: on this repository the row says nothing before the Skills page has been opened and 31 after; the mock `Transport` records no `getHarnessStatus` call from a profile open alone. Seeded defect: drop `enabled: false` and the request-count assertion reds.

Verification: `pnpm vitest run apps/client/src/layers/features/profile`; `pnpm --filter @dorkos/client typecheck`; `pnpm --filter @dorkos/client lint`. The branch faces an independent adversarial review per `REVIEW.md` before a PR opens.

### Task 7.3: Add the Dev Playground showcase for the harness status states

**Size:** medium · **Priority:** medium · **Depends on:** 6.2 · **Runs beside:** 7.1, 7.2

Add `apps/client/src/dev/showcases/HarnessStatusShowcases.tsx` and register it in `apps/client/src/dev/playground-registry.ts`. The Dev Playground is mounted by `main.tsx` on `/dev/*` under `import.meta.env.DEV` only and never reaches the router, so nothing here ships to a person.

Cover every visual state the slice can produce, from fixture data rather than from a live query, so the page renders with no server: a healthy row collapsed to one chip; the same row expanded by the page-level toggle; one row per chip word — `native`, `projected`, `drifted`, `dropped`, `warned`, `conflict`, `pending-approval` — so a tone regression is visible side by side; an adoptable row with its third line; a row whose cell carries `warnings` beside its state chip; a "Not shared with <harness>" panel with its reasons verbatim; a "Project-level notices" panel; the not-enabled notice; and the six page states including the zero-skills one.

Fixture data lives beside the showcase and reuses the `HarnessStatusResponse` type, so a schema change breaks the showcase at compile time rather than leaving it quietly wrong. Include one row with a very long source path and one with six enabled harnesses, since left-truncation and chip wrapping are the two things this page can get wrong at a narrow width.

Verification: `pnpm --filter @dorkos/client typecheck`; `pnpm --filter @dorkos/client lint`; open `/dev` in the dev server and screenshot the showcase for the PR. The branch faces an independent adversarial review per `REVIEW.md` before a PR opens.

## Phase 8 · Slice 7 — the sync: route, banner, and everything that tells the person

**Tracker:** [DOR-1895](https://linear.app/dorkspace/issue/DOR-1895) · sub-issue of [DOR-1852](https://linear.app/dorkspace/issue/DOR-1852) · blocked by [DOR-1894](https://linear.app/dorkspace/issue/DOR-1894), [DOR-1889](https://linear.app/dorkspace/issue/DOR-1889).

Spec: `specs/harness-sync-status/02-specification.md` — §2.2 and all of its sub-sections; §User Experience "The banner" and "The What changed summary".

### Task 8.1: Extract the asking half into ask-withheld-hooks.ts with a reproject callback

**Size:** medium · **Priority:** high · **Depends on:** 7.1 · **Runs beside:** —

Lift the withheld-hooks sequence out of `apps/server/src/services/harness/auto-project.ts` into a new `apps/server/src/services/harness/ask-withheld-hooks.ts`, signature:

```ts
export async function askAboutWithheldHooks(
  withheld: readonly WithheldHooks[],
  opts: {
    projectPath: string;
    dorkHome: string;
    approvals: HookApprovalGateway;
    /** Re-project once at least one card is granted. The caller owns the sweep decision and the logging. */
    reproject: () => void;
  }
): Promise<{ askedAbout: string[]; granted: string[] }>;
```

The whole sequence moves, re-projection included: project with the unapproved packages' hooks withheld; filter the withheld list through `mayAskAboutHooks`, skipping what is already refused or already on screen; raise one card per package, all before any is awaited; on a yes, `recordHookApproval` and then project a second time, because the first pass deliberately left those hooks out (`auto-project.ts:301-303` calls `projectAndLog` again). `runAutoProjection` passes `reproject: () => projectAndLog(ctx, dorkHome)`, which is where its `packageName` and `action` still live, so nothing about its log lines changes. The sync route passes a `reproject` that calls `projectWithConsent` with the same `sweepOrphans: true` it used on pass one.

Two reasons for this shape rather than a second `*WithConsent` function (Decision 11). `project-with-consent.ts` is the only non-test module allowed to call `project(`, and the reason given is that every new trigger reaching for its own projection is how hooks nobody allowed get installed; adding `syncWithConsent` beside it would either duplicate the seam or route around it. And the asking half is not projection — it raises cards, records answers and calls back, and builds no plan — so extracting it moves nothing across the guarded line and the guard's allowlist does not grow.

Acceptance bar: `apps/server/src/services/harness/__tests__/project-seam-guard.test.ts` passes with an unchanged allowlist, and `runAutoProjection`'s existing suite (`__tests__/auto-project.test.ts`) passes untouched. Seeded defect: drop `reproject` from the extracted signature and the auto-project case that asserts the second projection reds.

Verification: `pnpm vitest run apps/server/src/services/harness/__tests__`; `pnpm --filter @dorkos/server typecheck`; `pnpm --filter @dorkos/server lint`. The branch faces an independent adversarial review per `REVIEW.md` before a PR opens.

### Task 8.2: Add POST /api/harness/sync with its person-only bar, its 409, and sweepOrphans: true

**Size:** large · **Priority:** high · **Depends on:** 8.1, 3.2 · **Runs beside:** —

Add `POST /api/harness/sync` to `apps/server/src/routes/harness.ts`. Body `{ projectPath: string }`; answers `200` with `{ status, applied, swept, conflicts, askedAbout }`, where `status` is the recomputed `HarnessStatusResponse`.

It goes through `projectWithConsent(projectPath, { dorkHome, sweepOrphans: true })` — the one seam. Never `project()`; `__tests__/project-seam-guard.test.ts` refuses it, and the refusal is the point.

`sweepOrphans: true`, and never silently. Two reasons for the sweep: a Sync button is the full-plan case, and `applyPlan`'s doc says the sweep wants a full unfiltered plan, which this route builds because it takes no harness filter and `projectWithConsent` throws if a filter is ever combined with a sweep; and without the sweep the button cannot do the job it is on the page for, because half of what the banner reports is orphaned links and `checkPlan` counts orphans against `clean`, so a sync that does not sweep leaves the banner up after the person clicks it. It is safe because the engine only deletes what it can prove it wrote — a generated per-harness hooks file is owned only when its `.dorkos-generated` sidecar matches (`apply/generated-ownership.ts`, DOR-1842), the sweep is scoped to enabled harnesses, and `apply-ownership.property.test.ts` holds AP-07. It is honest because `sweepPreview` on the GET names every path before the click and `swept` on this response names every path after, which is what the terminal has always done.

A project with no manifest answers `409`, not `200` and not `500`: `loadManifest` throws `ENOENT` there, so the route probes for `.agents/harness.manifest.json` before it reaches the seam and answers `{ error, code: 'harness_not_set_up', message }`. A sync against a project that syncs nothing is not a success with zero work done, and the page never offers the button in that state, so the code is only reachable by a caller that ignored the status.

A person, not an agent, may call it: `if (!resolveDecisionAuthority(readCallerAuthority(req, res)).allowed) return res.status(403).json({ … })`, the `refuseUntrustedSourceWrite` shape from `routes/marketplace.ts`. Read through `resolveDecisionAuthority` rather than `trustedCaller` deliberately — this wants the agent bar, refusing anything naming itself an agent or holding an approval token, and not the cookie requirement DOR-474 put inside `trustedCaller`, which would lock out a person's own terminal (DOR-502).

The route does not wait for the approval cards. `runAutoProjection`'s promise stays unresolved while a card is pending, which is why the install route treats it as fire-and-forget; a button that hangs on a modal is worse than one that returns and says what is waiting. The response carries `askedAbout` and the returned status carries `pendingApproval`. Concurrency: take `withProjectLock(projectPath, …)` if DOR-1854 shipped one; if DOR-1854 landed as the proof that the apply already converges, no change is needed here. The module doc records the capability tier so it is not re-litigated later: this is not a registered capability in v1, and if it is ever surfaced to agents it is `act`, never `destructive`.

Verification: `pnpm vitest run apps/server/src/routes/__tests__/harness.test.ts`; `pnpm vitest run apps/server/src/services/harness/__tests__/project-seam-guard.test.ts`; `pnpm --filter @dorkos/server typecheck`; `pnpm --filter @dorkos/server lint`. The branch faces an independent adversarial review per `REVIEW.md` before a PR opens.

### Task 8.3: Build the drift banner, the What changed summary, and the sync mutation that does not invalidate

**Size:** large · **Priority:** high · **Depends on:** 8.2 · **Runs beside:** —

Add `syncHarness(projectPath: string): Promise<HarnessSyncResponse>` to `Transport` (`packages/shared/src/transport.ts`), its `HttpTransport` half in `apps/client/src/layers/shared/lib/transport/harness-methods.ts`, its embedded stub in `embedded-mode-stubs.ts` throwing 'Agent file sharing is not supported in embedded mode', and its mock in `packages/test-utils/src/mock-factories.ts`. Then add `model/use-harness-sync.ts`, `ui/HarnessDriftBanner.tsx` and `ui/HarnessSyncSummary.tsx` to `entities/harness`, and slot the banner and the summary into `SkillsPage.tsx`.

The banner: one condition, one message, one action, first match wins. `counts.drifted > 0 || sweepPreview.length > 0` draws "Some agent files are out of date." with a "Sync now" action; `counts.conflicts > 0` draws "DorkOS can't update some files. Something else is in the way." with no action; `counts.adoptable > 0` draws "Some skills live where only a few of your agents look." with no action; otherwise nothing is drawn. The action's predicate is exactly what `applyPlan` would act on — a drift-only predicate left a click that removed files with no banner, and a banner a click could not clear.

The removal warning is not optional. When `sweepPreview` is non-empty the banner carries a `details` disclosure — the collapsible region the `Banner` component already supports — headed "Syncing also removes N links whose skill is gone" and listing every path. A person is told what a click deletes before the click, which is what `reportCheck` has always printed in the terminal. A banner with a destructive action and no manifest of it is the failure this whole slice exists to prevent.

It is inline at the top of the page and not the app-wide `AppBannerSlot`, which ranks one banner for the whole app and would follow the person to every route with a project-scoped fact. No red and no count in the nav: `info` for drift and adoptable, `warning` for a conflict and for the removal disclosure, `critical` never; drift is a file that has not been written yet, not an error. There is no `onDismiss` — it clears by being recomputed.

The "What changed" summary replaces the banner after a sync, until dismissed or navigated away: "Agent files updated. 4 files written." plus "Removed 2 links whose skill is gone:" and every path in `swept`. A toast fires beside it for the "it worked" moment, but a list of deleted files is not a thing that should fade after four seconds. When cards were raised it adds one line: "One package is waiting for your approval."

The mutation's `onSuccess` writes `response.status` into `harnessKeys.status(projectPath)` with `queryClient.setQueryData` and does not invalidate. Invalidating would throw away the one answer that knows about `applyPlan().conflicts` — derivation row 1 — and replace it with a fresh read that has forgotten. Freshness comes from `staleTime: 30_000` and refetch-on-mount, plus `useEventSubscription('approval_resolved', …)` — the same global-stream hook `entities/attention/model/use-pending-approvals.ts:134` already uses — invalidating `harnessKeys.status(projectPath)` when any approval is decided, which is how the page notices pass two finishing without polling and without the POST hanging.

Verification: `pnpm vitest run apps/client/src/layers/entities/harness`; `pnpm --filter @dorkos/client typecheck`; `pnpm --filter @dorkos/client lint`; `pnpm --filter @dorkos/shared build`. The branch faces an independent adversarial review per `REVIEW.md` before a PR opens.

### Task 8.4: Cover the sync end to end: the POST suite and the banner cases, with the equality assertion first

**Size:** medium · **Priority:** high · **Depends on:** 8.2, 8.3 · **Runs beside:** 8.5

Extend `apps/server/src/routes/__tests__/harness.test.ts` with the POST half and `apps/client/src/layers/entities/harness/ui/__tests__/` with the banner half. Server fixture stays a temp repo plus a fake `HookApprovalGateway`; client tests feed a mock `Transport` through `TransportProvider`.

Route cases, each with the seeded defect that reds it: a POST on a manifest-less repo answers `409 harness_not_set_up` and writes nothing (let `loadManifest` throw and it reds with a `500` and a stack in the log); `VC-05` — a POST presenting an agent identity answers `403` and the same call without one answers `200` (drop the `resolveDecisionAuthority` bar); `TR-08` — a POST repairs a deleted link and the returned status is `clean` (return the pre-apply status); `AP-07` — a POST sweeps an uninstalled package's projections, asserted as an exact before/after tree diff, and `swept` names every path it deleted (pass `sweepOrphans: false` and the swept paths survive); the GET's `sweepPreview` equals the next POST's `swept` as sets on the ten-path fixture (revert Slice 2b's union and the preview is 1 path against a sweep of 10); `HK-11` — a hand-written `.codex/hooks.json` with no sidecar survives the POST and is reported as a conflict (widen the sweep past sidecar-matched files); `VC-02` — the POST raises one card per unapproved package and returns without awaiting it (await the cards and the test times out).

Client cases: the banner appears for drift with its action, for a conflict without one, for adoptable without one, and not at all when clean — four cases, one per branch of the table. A status with a non-empty `sweepPreview` draws the removal disclosure naming every path and still offers the action (render the banner without the disclosure and it reds). Clicking "Sync now" calls `syncHarness` once and disables while pending, and the returned status rather than a refetch is what the banner re-renders from (invalidate instead of `setQueryData` and a post-write `conflict` cell reverts to `drifted`). The "What changed" summary lists every path in `swept`.

Verification: `pnpm vitest run apps/server/src/routes/__tests__/harness.test.ts`; `pnpm vitest run apps/client/src/layers/entities/harness`; `pnpm --filter @dorkos/server typecheck`; `pnpm --filter @dorkos/client typecheck`; lint on both. The branch faces an independent adversarial review per `REVIEW.md` before a PR opens.

### Task 8.5: Register POST /api/harness/sync in the OpenAPI registry and regenerate docs/api/openapi.json

**Size:** medium · **Priority:** medium · **Depends on:** 8.2 · **Runs beside:** 8.4

Hand-register the second of the two routes in `apps/server/src/services/core/openapi-registry.ts` — the legacy half, because no capability projects these paths. The code-structure section says that file gains two `registerPath` calls: task 5.2 added the GET's, and this one adds `POST /api/harness/sync`. Then regenerate `docs/api/openapi.json` with `pnpm docs:export-api` and commit the regenerated file in the same PR. `docs-openapi-check` is the gate, and it reports on `merge_group`, so a stale generated file blocks the merge queue rather than the PR.

What the registration carries, because these are the answers a caller has to handle: the request body `{ projectPath: string }`; `200` with `HarnessSyncResponseSchema` from `@dorkos/shared/harness-schemas`, registered through `@asteasolutions/zod-to-openapi` rather than hand-written, since a second copy of a five-field envelope wrapping a thirteen-field one is a copy that goes stale; `403` for a caller presenting an agent identity or an approval token; and `409` with `code: 'harness_not_set_up'` for a project with no manifest. The description says in plain words that this call applies the projection plan and removes orphaned links the engine can prove it wrote, and that the exact paths it will remove are readable in advance from the GET's `sweepPreview`.

The route description is read against the retired-word list before it is written, not swept afterwards: `docs/api/openapi.json` is a literal scan target of `scripts/check-banned-words.sh`, so a retired noun in a summary line fails the `typecheck` workflow rather than a review.

Seeded defect: skip the `registerPath` call — or add it and leave `docs/api/openapi.json` unregenerated — and `docs-openapi-check` reds, naming the path the document is missing. That is the only failure this task can have, and it is exactly the one the gate exists to catch.

Verification: `pnpm docs:export-api` then `git diff --stat docs/api/openapi.json`; `bash scripts/check-banned-words.sh`; `pnpm --filter @dorkos/server typecheck`; `pnpm --filter @dorkos/server lint`. The branch faces an independent adversarial review per `REVIEW.md` before a PR opens.

## Phase 9 · Slice 8 — T7, the contract and the docs

**Tracker:** [DOR-1896](https://linear.app/dorkspace/issue/DOR-1896) · sub-issue of [DOR-1852](https://linear.app/dorkspace/issue/DOR-1852) · blocked by [DOR-1895](https://linear.app/dorkspace/issue/DOR-1895).

Spec: `specs/harness-sync-status/02-specification.md` — §Testing Strategy "Browser — T7" and "Reason vocabulary"; §Documentation; §Implementation Phases, Slice 8.

### Task 9.1: Give registerAgent a path option and add the harness-repo e2e fixture

**Size:** medium · **Priority:** high · **Depends on:** 8.3 · **Runs beside:** 9.3

`RoomsApi.registerAgent(name, emoji, color, options)` builds its own path under a private `agentRoot` (`apps/e2e/fixtures/rooms-api.ts:189-195`) and takes no path, so a spec cannot stage files before registration. Two edits, both named:

- `registerAgent` gains `options.path?: string` — an already-staged directory. It must sit under this run's `agentRoot` so `scanRoot: FIXTURE_AGENT_ROOT` still derives the `run-<runId>` namespace, and `agentRoot` becomes a readonly public field so a sibling fixture can build paths under it.
- `apps/e2e/fixtures/harness-repo.ts` (NEW) stages a tree there and removes it in teardown, registered in `apps/e2e/fixtures/index.ts` beside `roomsApi`.

The staged tree is a manifest enabling `claude-code, codex`, one `.agents/skills/<a>/SKILL.md`, and one real `.claude/skills/<b>/` directory — enough to produce a projected row, a native row, an adoptable row and a Codex drop.

Seeded defect for the pair: stage the tree at a path outside `agentRoot`, and the registration lands in the wrong namespace, which the browser spec's own assertion on the agent's `projectPath` reds. That is the failure this option can actually cause, so it is the one that has to be provable.

One caveat to build the fixture around rather than discover: registering an agent runs `projectAgentWorkspace` (TR-03), which seeds the operating-skills pack, so the staged repo holds more skills than the two the fixture put there. The fixture exposes the two names it staged so assertions can name their skills and assert a floor on the row count rather than an exact total.

Verification: `pnpm --filter @dorkos/e2e typecheck`; `pnpm --filter @dorkos/e2e lint`; the spec of task 9.2. The branch faces an independent adversarial review per `REVIEW.md` before a PR opens.

### Task 9.2: Write the T7 browser spec on the default chromium leg

**Size:** medium · **Priority:** high · **Depends on:** 9.1 · **Runs beside:** —

Write `apps/e2e/tests/harness/skills-page.spec.ts` on the default `chromium` project, not a test-mode one, and say so in the file header the way `tests/profile/profile-pushin.spec.ts` does. The test-mode legs exist because a spec would otherwise start a real, billable turn, and each of the seven `testIgnore` entries on the `chromium` project says so. This spec starts no turn — it registers an agent, opens a profile page, reads chips and clicks Sync — so putting it on a test-mode leg would mean a new `playwright.config.ts` project, a new `testIgnore` entry and a second Vite/Express pair booted for no reason. No `playwright.config.ts` change is needed: the default project's `**/*.spec.ts` match reaches `tests/harness/` already.

The spec:

1. Stage a repo at `<agentRoot>/harness-<n>/` through the new fixture: a manifest enabling `claude-code, codex`, one `.agents/skills/<a>/SKILL.md`, one real `.claude/skills/<b>/` directory.
2. Register an agent at that path, then `rightPanel.openProfilePage('skills', agent.projectPath)`.
3. Assert the list has at least two rows; `<a>` shows Codex "reads it" and Claude Code "shared"; `<b>` carries the adoptable line; the "Not shared with Codex" panel names `<b>` with its reason verbatim.
4. Delete `.claude/skills/<a>` on disk, reload: the banner is there and its disclosure names the path. Click "Sync now": the banner goes, the "What changed" summary names what was written, and the link is back on disk.
5. Seeded defect: render the banner unconditionally and step 4's final assertion reds.

Assertions name their skills and assert a floor on the row count, never an exact total, because registering an agent seeds the operating-skills pack.

Verification: `pnpm --filter @dorkos/e2e exec playwright test tests/harness/skills-page.spec.ts --project=chromium`; `pnpm --filter @dorkos/e2e typecheck`; `pnpm --filter @dorkos/e2e lint`. The branch faces an independent adversarial review per `REVIEW.md` before a PR opens.

### Task 9.3: Fix the retired noun in NON_PORTABLE_LAYER_REASONS and add the reason-vocabulary guard

**Size:** medium · **Priority:** high · **Depends on:** 8.4 · **Runs beside:** 9.1

One engine string in `packages/harness/src/plan/installed-projector.ts` reads `plugin layer "adapters" is not a portable harness asset — messaging adapters run inside DorkOS, not in a harness`. The quoted layer name is what a package author writes and is the Connections ADR's own carve-out, but the prose half uses a retired user-facing noun. It becomes `— Messaging runs inside DorkOS, not in a harness`. Every `reason` string the engine emits is now rendered to a person by the Skills page, so this is user-facing copy that happens to live in a package.

Neither vocabulary gate can reach that package: `scripts/check-vocab-gate.ts:165` scans three `apps/*/src` roots and `scripts/check-banned-words.sh:83-94` scans a literal file list plus `docs/` and `blog/`. A hand sweep would therefore rot, so add `packages/harness/src/__tests__/reason-vocabulary.test.ts`: build a plan over a fixture that exercises each reason family and fail on any retired user-facing term outside a quoted package-layer name.

It reads the term list from `scripts/vocab-gate/banned-terms.json` rather than restating it, so a wave added there reaches this package on the day it reaches the app and this file never becomes a second list to keep in step. Two floors keep it from passing on nothing, in this repo's "nothing zero-subject" shape: it asserts it parsed at least as many waves and terms as the file holds today, and at least as many reason strings as the fixture produces, before it asserts anything about either.

Seeded defects, both required: restore the retired noun in `NON_PORTABLE_LAYER_REASONS` and the test reds; point the loader at a missing path and the floor reds instead of the suite going quietly green.

Verification: `pnpm vitest run packages/harness/src/__tests__/reason-vocabulary.test.ts`; `bash scripts/check-banned-words.sh`; `pnpm check:vocab-gate`; `pnpm --filter @dorkos/harness typecheck`; `pnpm --filter @dorkos/harness lint`. The branch faces an independent adversarial review per `REVIEW.md` before a PR opens.

### Task 9.4: Flip the contract rows and write the docs, the test-plan correction and the changelog fragment

**Size:** medium · **Priority:** high · **Depends on:** 9.2, 9.3 · **Runs beside:** —

Edit the capability census in the same PR that builds the surface, which is §17's own rule: a harness feature adds its rows there in the same PR.

`meta/harness-sync-capabilities.md`: VC-01 goes `partial -> built`, citing the derivation test; VC-02 gains its app half; TR-08 goes `not built -> built`; §11's opening "None of it exists" and §12 J-06's "Today" cell are both updated; §16 D6 gains a "shipped as" line. VC-05 stays `partial` — its app half is out of scope here, and saying otherwise would be exactly the kind of false row the census exists to catch. No row may claim a surface this PR did not build.

Docs:

- `contributing/harness-sync.md` — a new §7, "The status model and its two readers": the eight states, the derivation table, the row-key rule and the harness-agnostic rule, why the model lives in the server rather than the engine, and the rule that a wrong chip is a plan bug.
- `docs/getting-started/configuration.mdx` §Harness Sync — one paragraph: the agent profile's Skills page shows what is shared with which tool, and the Sync action re-runs the projection and says what it removed.
- `docs/guides/action-approvals.mdx:123` stays unchanged. It says `harness.autoSync` has "no screen yet", which is still true: that switch is the DOR-144 half this work cuts.
- `plans/harness-sync-test-plan.md` §11 line 9 — marked done, with T7's leg correction noted: it runs on the default `chromium` leg, not "against the test-mode runtime" as the plan's §9 says.
- `changelog/unreleased/<id>-every-skill-you-have-in-one-list.md` — a fragment written to the `writing-for-humans` bar, plain enough for a smart 9th grader who doesn't code, with the id minted by `.claude/scripts/id.ts`. Never edit `CHANGELOG.md`.

All of this prose is user-facing, so it is written against the retired-word list first rather than swept afterwards.

Verification: `bash scripts/check-banned-words.sh`; `pnpm check:vocab-gate`; `pnpm exec prettier --check meta docs contributing changelog plans`; `node .claude/scripts/docs-coverage-map.mjs` if `contributing/INDEX.md` changes. The branch faces an independent adversarial review per `REVIEW.md` before a PR opens.
