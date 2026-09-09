---
slug: harness-sync-adopt
id: 260909-090525
created: 2026-09-09
status: specified
---

# Harness Sync — adopt: report first, move one skill on purpose

**Status:** Approved
**Author:** Claude (delegated; the operator is not available and has settled D3 already)
**Date:** 2026-09-09
**Tracker:** DOR-1853 · **Contract:** `meta/harness-sync-capabilities.md` (D3, SRC-07, SRC-10, J-06)
· **Plan:** `plans/harness-sync-test-plan.md` §11 line 10

## Overview

A skill an agent writes into a harness's own folder — `.claude/skills/deploy-checklist/`, as a real
directory — works in that harness and is invisible to the others, for ever. DorkOS reports that today
and can do nothing about it: `dorkos harness adopt` has been the answer since ADR-0303 and has never
existed, so `Provenance` carries an `'adopted'` value nothing produces and the Skills page prints a
sentence with no button under it.

This ships the verb. `dorkos harness adopt <name>` moves one skill directory into `.agents/skills/`,
where five of the six agent tools read it natively, and leaves a link behind at the old path so the
sixth still finds it. It refuses, with one plain sentence and a way out, wherever the move would
cost more than it gives — ten rules, fourteen sentences, each naming what to do instead. A new `harness.autoAdopt` setting — off everywhere, permitted
only in the folders DorkOS owns — lets the unattended passes do the same move for skills that pass an
allowlist, and report every one they did not.

Everything else stays **report-only**, which is the position ADR-0303's third clause is amended to
say out loud.

## Background / Problem Statement

**The hole, stated as the person feels it.** Somebody runs Claude Code and Codex on one repository.
Mid-session, Claude Code writes a new skill into `.claude/skills/deploy-checklist/`. Claude Code,
OpenCode, Cursor and Copilot read that folder; Codex and Gemini do not, and never will. Nothing moves
the skill, so the person's Codex sessions are missing a skill their Claude Code sessions have, and
the only clue is a line of advice with no action attached to it.

**What already exists, so this does not rebuild it.**

- `packages/harness/src/inventory/skills.ts` finds those directories. A real directory under
  `.claude/skills` with no twin in `.agents/skills` is an entry with `root: '.claude/skills'`.
- `apps/server/src/services/harness/status.ts` turns that into `adoptable: true` on the row and
  `provenance: 'harness-native'` (`adoptableSkillSources`, `status.ts:304`), with two exclusions that
  are the definition rather than an optimisation: a skill also present in the canonical layer is a
  _blocker_ whose fix is a deletion, and a skill named in `manifest.claudeOnlySkills` is a person
  saying the placement is deliberate.
- The Skills page draws one line of advice under such a row and no button
  (`SkillHarnessRow.tsx:22`), and `dorkos harness sync --check` names the skill in its drop list with
  the plan's own "move it to `.agents/skills` to share it" reason.
- `plan/projector.ts:117-119` already knows what a canonical skill's Claude Code projection is: a
  relative symlink from `.claude/skills/<name>` to `.agents/skills/<name>`.

**What does not exist.** The move. `packages/harness/src/adopt/` is not there, `dorkos harness adopt`
is not a subcommand, `POST /api/harness/adopt` is not a route, `harness.autoAdopt` is not a setting,
and `resolveSourceRoots` never returns an `'adopted'` root. Nothing has ever SET the value: it is a
member of two enums and one mapping table, it is named in seven doc comments, and the one test that
mentions it asserts only that it would count as ephemeral if anything ever did (§1.8 has the
measured list).

**Why the first design was wrong, and why that matters here.** The capabilities audit's first draft
proposed auto-moving these directories by default. Two rounds of adversarial review took it apart:
once a directory is physically in `.agents/skills`, five harnesses read it and a `drop` line cannot
un-expose it; `git status` shows a directory move as N deletions plus N additions rather than a
rename; a gitignored `.agents/` turns the move into a deletion for everybody who clones the repo; an
agent is runtime-agnostic, so a skill auto-moved inside an agent home reaches that same agent's next
Codex session; and an agent home has no `git status` and no reader, so the one mitigation an
auto-move leans on is weakest exactly where the boot pass runs. The settled position (§16 D3) is
report-only everywhere by default, an explicit one-skill verb, and an allowlist rather than a
denylist behind the one flag that automates it. This specification implements that position and
nothing wider.

## Goals

- **One skill, one command, one plain sentence when it will not happen.** `dorkos harness adopt
<name>` moves a skill into `.agents/skills`, or says why not in words that name the way out.
- **The move is atomic.** No state exists in which a skill is half-moved. A crash mid-run leaves the
  skill whole at the canonical root with a projection the next sync makes — drift, never damage.
- **The link left behind is not hand-rolled.** It is the projection action the planner already plans
  for that skill, realized by the apply stage the sync already uses, so the next `--check` is clean
  by construction rather than by care.
- **Report-only stays the default everywhere**, including the folders DorkOS owns, and every sync and
  boot summary names the skills only some agent tools can see.
- **`harness.autoAdopt` inverts the failure mode.** Off by default; permitted only in agent homes and
  room worktrees; and when on, it moves only what an allowlist recognises as safe, reporting the
  rest.
- **Every surface says the same sentences.** The terminal, the boot log, the Skills page and the
  route all build their copy from one function.
- **ADR-0303's third clause is amended** to say what the product does, with the parent left
  `accepted`.

## Non-Goals

Each with the owner of the work that is out.

| Out of scope                                                 | Why                                                                                                                                                                | Owner                                |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------ |
| Adopting **hooks**                                           | ADR-0303 already says hook adoption is lossy and deferred; a hook has no one-to-one home across harnesses and a move would have to pick a semantic                 | follow-up to file                    |
| Adopting **commands**                                        | Same clause, same reason: a slash command's _trigger_ is Claude-only by design while its behaviour travels as a skill                                              | follow-up to file                    |
| Adopting **instructions** (`CLAUDE.md` → `AGENTS.md`, IN-06) | D3 keeps this explicit, and it is a _merge_ of two files a person wrote rather than a move of a directory — a different operation with a different failure mode    | follow-up to file                    |
| Adopting **subagents, rules, MCP servers**                   | The engine projects none of the three yet (§8); DOR-1902 makes them visible, and projecting them is unfiled work                                                   | DOR-1902 reports; projection unfiled |
| **Multi-select adopt** (`--all`, a checkbox column)          | One skill per command is what keeps a refusal readable: six rules, each naming one file and one way out. A batch turns that into a wall                            | follow-up to file                    |
| **Undo** (`dorkos harness unadopt`)                          | The move is reversible by hand in one step, and the link left behind says exactly where the skill went                                                             | follow-up to file                    |
| A **Settings screen toggle** for `autoAdopt`                 | It is a posture for somebody running agent homes, not a product switch; `dorkos config set harness.autoAdopt true` is the surface, as it is for `harness.autoSync` | not filed                            |
| The **user tier** (`~/.agents/skills`, `~/.claude/skills`)   | Global scope is a separate spec with its own ADR                                                                                                                   | DOR-1857                             |
| Widening the inventory to other harnesses' skill roots       | Landing separately and first                                                                                                                                       | DOR-1902                             |

## Technical Dependencies

| Depends on                                                                   | For                                                                                                    |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `packages/harness/src/inventory/`                                            | The candidate set. `SkillInventoryEntry` carries `root`, `isSymlink`, `source` and `frontmatterName`   |
| `@dorkos/skills` `readRawFrontmatter` / `SKILL_FILENAME`                     | The allowlist reads the frontmatter **as written**, never the parsed shape (§1.4)                      |
| `packages/harness/src/plan/projector.ts` `planSkill`                         | The link left behind (§1.6)                                                                            |
| `packages/harness/src/apply/apply.ts` `applyPlan` / `applySymlink`           | Realizing that link, with its Windows junction and its occupant checks                                 |
| `packages/harness/src/apply/gitignore.ts` `canonicalLayerIgnoredBy`          | Refusal R1 (AP-15)                                                                                     |
| `packages/harness/src/vendor-facts/index.ts` `skillsFactsFor`                | Which agent tools cannot see a given root — computed, never written down (§4)                          |
| `packages/operating-skills` `OPERATING_SKILLS_PACK`                          | The reserved room names (SRC-11) — seven today, derived from the pack, never hand-listed               |
| `apps/server/src/services/harness/project-agent-workspace.ts`                | `isAgentHome`, and the boot summary line this extends                                                  |
| `apps/server/src/services/rooms/repo/room-worktree-manager.ts`               | The room-worktree pairing and `SEEDED_PACK_EXCLUDES`                                                   |
| `apps/server/src/services/harness/project-with-consent.ts` `withProjectLock` | Serialising the route's plan + apply + status read                                                     |
| `apps/server/src/services/core/approvals` `resolveDecisionAuthority`         | Person-only on the route                                                                               |
| `conf` v15.1.0 + `UserConfigSchema`                                          | `harness.autoAdopt` and its migration, keyed at merge (§3.4)                                           |
| **DOR-1882** (in flight)                                                     | `applyPlan`'s block-and-report occupant checks, whose frozen sentences adopt reuses for a hostile path |
| **DOR-1902** (in flight)                                                     | `SkillRoot` becomes a union of five roots; adopt is written against the union from the first line      |

**Ordering.** This lands **after DOR-1882 and DOR-1902**, both of which are in flight on the same
files. DOR-1902 changes `SkillRoot` from a two-member union to a five-member one and adopt's whole
refusal table is keyed on it; DOR-1882 adds the occupant pre-pass whose sentences adopt reuses rather
than inventing a seventh voice for the same file. Landing before either means writing code against a
shape that is about to change and then rewriting it.

## Detailed Design

### 0. What ships, in four slices, and what each flips

| Slice | What lands                                                                                                                                                              | Contract cells it flips                                                                                  |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| **1** | `packages/harness/src/adopt/` — the reader and the pure planner, the refusal ladder, the allowlist; `adoptableSkillSources` exported                                    | `SK-16` (new) → `built`                                                                                  |
| **2** | `applyAdopt`, `planAdoptedSkillLink` extracted, `dorkos harness adopt`, the sync report's new block, **the Skills-page row's copy**, `Provenance`'s `'adopted'` retired | `SRC-07` → `built`; `SRC-10` → `built` (retired value); `AP-17` (new) → `built`; `J-06` Actual rewritten |
| **3** | `harness.autoAdopt`, its migration and four classification tables, the two consultation sites                                                                           | `D3` implemented; §14 item 3's remaining half struck through                                             |
| **4** | `POST /api/harness/adopt`, its Transport method, and the Skills page row's **button**                                                                                   | `VC-01`'s Actual gains the action                                                                        |

Each slice is a pull request. Slice 1 ships no user surface on its own and is landed separately so
the refusal ladder and the allowlist can be reviewed without a CLI transcript in the way; slices 2, 3
and 4 each ship one thing a person can use, and each is useful with the later ones absent. Slice 4 is
last on purpose (§7 states its cut line).

### 1. The engine unit — `packages/harness/src/adopt/`

#### 1.1 Two halves, because a pure planner cannot read a disk

**`planAdopt` is pure where `buildPlan` is not, and that is a deliberate departure rather than a
precedent.** `buildPlan` walks the disk itself — `scanSkills(repoRoot)` at `plan/projector.ts:450`,
and `inventory = inventorySourceTree(repoRoot)` as a parameter default at `:446` — with
`scanClaudeOnlySkills` answering only the one question about a path the manifest names. That is
workable for a projector whose output is checked against a real tree anyway; it is the wrong shape
for a refusal table of eight rules, each of which has to be provable in isolation. So adopt splits
into a reader and a planner, and the planner touches no filesystem at all.

- **`adopt/read.ts` — `readAdoptCandidates(repoRoot, inventory, manifest)`.** The filesystem half.
  Walks the inventory's skills, keeps the ones the status model already calls adoptable (a
  harness-native root, no canonical twin, not declared in `manifest.claudeOnlySkills`), and for each
  one reads its `SKILL.md` **once**: the raw frontmatter keys as written, and whether the body
  carries a `${CLAUDE_` token. It also probes `.agents/skills/<name>`.
- **`adopt/plan.ts` — `planAdopt(input)`.** Pure. Data in, `AdoptPlan` out. No `fs` import, so the
  refusal table is a total function of facts and every case is a fixture rather than a staged tree.
- **`adopt/apply.ts` — `applyAdopt(repoRoot, plan)`.** The only thing here that writes.
- **`adopt/allowlist.ts`** — the predicate and the six field names, alone in a file so the one place
  that decides what "safe to share" means is greppable.

`readAdoptCandidates` deliberately re-derives the _same_ two exclusions `adoptableSkillSources` uses
rather than importing them: that function lives in `apps/server`
(`services/harness/status.ts:304`) and `packages/harness` cannot import the server — the edge runs
the other way.

> **Decision: export `adoptableSkillSources` and site the equality property in the server. Why:** it
> is module-private today, so nothing outside `status.ts` can even name it, and a duplication nobody
> can compare is a duplication nobody is checking. Slice 1 adds the `export` keyword and nothing
> else. The property test then lives in
> `apps/server/src/services/harness/__tests__/adoptable-agreement.test.ts` rather than in the engine
> package, because the server is the only place that can import both sides — which also means slice 1
> touches `apps/server`, and its file list says so.

#### 1.2 The shapes

```ts
/** One skill that could be moved into the canonical layer, and everything the plan needs about it. */
export interface AdoptCandidate {
  /** The skill's name — its directory name, which is also the target's basename. */
  name: string;
  /** Repo-relative source directory, e.g. `.claude/skills/deploy-checklist`. */
  source: string;
  /** Which inventory root it was found in. */
  root: SkillRoot;
  /** Whether the source directory is itself reached through a symlink. */
  isSymlink: boolean;
  /** The frontmatter keys the author wrote, in file order, unstripped and unvalidated. */
  frontmatterKeys: readonly string[];
  /** Whether the body carries a `${CLAUDE_…}` token (SK-07's rule, applied to the body). */
  bodyHasClaudeToken: boolean;
  /** True when the frontmatter would not parse at all — a different answer from "no keys". */
  unreadable: boolean;
  /** What is at `.agents/skills/<name>` right now. */
  targetState: 'absent' | 'occupied';
}

/** What DorkOS owns the directory a run is happening in as. */
export type DirectoryOwnership = 'plain' | 'agent-home' | 'room-worktree';

/** One move the plan will make. */
export interface AdoptMove {
  name: string;
  /** Repo-relative source directory. */
  from: string;
  /** Always `.agents/skills/<name>`. */
  to: string;
  /**
   * The projection to realize at `from` once the move lands, or absent when the
   * harness that owns `from` reads `.agents/skills` natively (§1.6).
   */
  link?: ProjectionAction;
}

/** One name recorded in `manifest.claudeOnlySkills` instead of being moved (`--claude-only`). */
export interface AdoptDeclaration {
  name: string;
  /** The `path` the manifest entry carries — the candidate's own `source`. */
  path: string;
  /**
   * The `reason` the manifest entry carries. **Required**, because
   * `ClaudeOnlySkillSchema` is `.strict()` with three required fields
   * (`manifest/schema.ts:25-31`) and an entry without one fails the parse — so a
   * declaration that omitted it would break the very manifest it wrote into.
   * Composed from what made the skill Claude-shaped (§8, S18).
   */
  reason: string;
}

/** Which rule refused, so a test and the census can name it. */
export type AdoptRefusalRule =
  | 'not-adoptable'
  | 'hostile-path'
  | 'room-seeded-name'
  | 'target-exists'
  | 'source-is-symlink'
  | 'unreadable-frontmatter'
  | 'not-on-allowlist'
  | 'claude-only-wrong-root';

/** One candidate that will not be moved, and the one sentence saying why. */
export interface AdoptRefusal {
  name: string;
  source: string;
  /** One plain sentence with the way out. Frozen; see §8. */
  reason: string;
  rule: AdoptRefusalRule;
}

/** Something true of the whole RUN rather than of one candidate. */
export interface AdoptBlocked {
  reason: string;
  rule: 'canonical-layer-ignored' | 'auto-adopt-not-permitted';
}

export interface AdoptPlan {
  /** Empty when {@link blocked} is set. */
  moves: AdoptMove[];
  /** Empty when {@link blocked} is set. */
  declarations: AdoptDeclaration[];
  refusals: AdoptRefusal[];
  /** Present when one fact about the directory stops every candidate at once. */
  blocked?: AdoptBlocked;
}
```

**Why `blocked` is separate from `refusals`.** Two of the eight reasons are facts about the
directory, not about a skill: `.agents/` being gitignored, and `autoAdopt` being on somewhere DorkOS
does not own. Repeating one of those once per candidate would print the same paragraph six times and
bury the six things a person could actually act on. One sentence, once, and no moves planned.

#### 1.3 The refusal ladder, in order, first match wins

Order is stated because it decides which sentence a person reads when two apply, and the rule is
**most fundamental first**: a thing that makes the whole run impossible, then a thing that makes the
filesystem operation impossible, then a thing that makes the _result_ wrong.

Run-level, checked before any candidate:

| #   | Rule                       | Fires when                                        |
| --- | -------------------------- | ------------------------------------------------- |
| B1  | `auto-adopt-not-permitted` | `mode: 'auto'` and `ownership: 'plain'`           |
| B2  | `canonical-layer-ignored`  | `canonicalLayerIgnoredBy` returned a file (AP-15) |

**B2 cannot fire in an agent home, and that is correct rather than lucky.** `canonicalLayerIgnoredBy`
returns `undefined` when the repository root holds no `.git` at all, because a `.gitignore` in a
directory git does not track is not a fact about anything. An agent’s own workspace under
`<dorkHome>/agents` is not a git checkout, so the question does not arise. A room worktree **is** one
— its `.git` is a file, which `isGitRepo` already handles — so B2 is live there.

Per candidate:

| #   | Rule                     | Fires when                                                                                                                                                                      |
| --- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | `not-adoptable`          | Explicit mode, and the requested name is not in the candidate set. Three sub-sentences: no such skill; already in `.agents/skills` too; declared in `manifest.claudeOnlySkills` |
| R2  | `hostile-path`           | DOR-1882's occupant check says the source, the target, or a directory on the way to either is a file, a live link to a file, a dangling link, or unreadable                     |
| R3  | `room-seeded-name`       | `ownership: 'room-worktree'` and the name is one of `OPERATING_SKILLS_PACK`'s (SRC-11)                                                                                          |
| R4  | `target-exists`          | `targetState: 'occupied'`                                                                                                                                                       |
| R5  | `source-is-symlink`      | `isSymlink` — the candidate IS a link                                                                                                                                           |
| R6  | `unreadable-frontmatter` | `unreadable`                                                                                                                                                                    |
| R7  | `not-on-allowlist`       | The allowlist predicate says no. **Hard in both modes** — see §2 for why there is no `--force`                                                                                  |
| R8  | `claude-only-wrong-root` | `--claude-only` on a candidate whose root is not `.claude/skills`                                                                                                               |

**B1 before B2**, because a person who set `autoAdopt` in a repository DorkOS does not own should be
told _that_, not sent to edit a `.gitignore` for a run that was never going to happen.

**R2 before R3–R6**, because a hostile path is the only one where the _check itself_ is what
prevented a throw. DOR-1882's pre-pass computes the blocked set before anything writes, and adopt
sits inside that discipline rather than beside it.

**R5 does not rest on SK-13, and an earlier draft said it did.** SK-13 is **built** (contract row
`:127`, DOR-1844 and DOR-1845): `scanSkillDirs` follows a symlinked source, so the non-destructive
shape D3 called impossible — leave the directory where it is and link INTO it from `.agents/skills` —
is possible now. R5 refuses a symlinked source for its own reason, the one S6 gives: DorkOS cannot
move a link without changing where the person's real skill lives, and it has no way to know whether
they meant the link or the target.

> **Decision: adopt still MOVES rather than reverse-linking, even though the reverse link now works.
> Why:** the reverse shape puts a symlink into `.agents/skills`, which is the **committed** layer —
> so the canonical root ends up holding a pointer into a harness's own folder, and which of the two
> is canonical inverts: `.claude/skills` becomes the source of truth and `.agents/skills` becomes the
> projection, which is the opposite of every other line in this engine. AP-15 then bites the other
> way round too: a repository that gitignores `.agents/` currently loses nothing by NOT adopting,
> and under the reverse shape it would ship a link its teammates' clones cannot resolve. And the
> engine's own sweeps would have to learn a link in `.agents/skills` that is neither
> `<pkg>__<name>` nor DorkOS's own — a fourth ownership rule in the one directory whose ownership is
> currently simple. The reverse link is a real option and it is worth writing down that it was
> refused on those three grounds rather than on impossibility.

**R7 is the last of the MOVE rules**, and it applies in both modes. It is the only rule whose answer
is about the file's _content_ rather than about the filesystem, and it is the one D3 spends most of
its argument on.

**R8 is not in that ladder at all.** `--claude-only` writes one line into the manifest and moves
nothing, so nothing about the filesystem or the file's content can stand in its way: it runs **R1
then R8 and stops**. B2 does not apply either — nothing goes into `.agents/`, so a `.gitignore` there
is not a fact about this operation — and neither does B1, since `--claude-only` exists only in
explicit mode. That short-circuit is the reason the flag is a real way out of R7 rather than a second
thing that can be refused for the same reason.

#### 1.4 The allowlist, exactly

> **Decision: the allowlist is the six agentskills.io base fields, and nothing else. Why:** they are
> the fields the open standard defines, they are the fields every one of the six agent tools'
> skill formats descends from, and the codebase already names them in one place —
> `SkillFrontmatterSchema`'s own docblock, which describes its three layers as "(1) the
> agentskills.io open standard (`name`, `description`, `license`, `compatibility`, `metadata`,
> `allowed-tools`); (2) Claude Code's extension fields, adopted **verbatim**; (3) the DorkOS
> `schedule:` block". Layer 1 is the allowlist. Layers 2 and 3 are exactly the things a move would
> hand to a tool that does not implement them.

```ts
/**
 * The agentskills.io base frontmatter fields — layer 1 of `SkillFrontmatterSchema`.
 * A skill whose frontmatter holds only these is one every agent tool can read the same way.
 */
export const AGENTSKILLS_BASE_FIELDS = [
  'name',
  'description',
  'license',
  'compatibility',
  'metadata',
  'allowed-tools',
] as const;
```

The predicate is two clauses, and both are read from the file **as written**:

1. every top-level frontmatter key is in `AGENTSKILLS_BASE_FIELDS`; and
2. the body contains no `${CLAUDE_` token.

**It reads the RAW frontmatter, and that is the sharpest decision in this file.**
`readRawFrontmatter` (`@dorkos/skills/parser`), never `parseSkillFile`. `SkillFrontmatterSchema`
strips keys it does not know and `.catch(undefined)`s values it cannot read, and both are correct
behaviours for their own callers — one unreadable enum must not delete a person's skill from the
product. They are catastrophic here. A `hooks:` block in a `SKILL.md` frontmatter is a real thing
Claude Code honours (it registers those hooks the moment the skill is invoked and keeps running them
for the rest of the session, `vendor-facts`) and a real thing DorkOS's own inventory reads
(`inventory/hooks.ts`, `origin: 'skill-frontmatter'`, contract **HK-12** — HK-14 is the neighbouring
row about `.claude/settings.local.json`). The schema strips it. A
predicate built on the parsed object therefore sees a clean six-key skill and moves a file that runs
shell commands. The raw reader is what makes clause 1 mean what it says.

**Each field a person might expect, and where it lands:**

| Field                                                                                        | In / out                                     | Why                                                                                                                                                                                                                                                                                                                                   |
| -------------------------------------------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`, `description`                                                                        | **in**                                       | Required by the standard; every tool reads both                                                                                                                                                                                                                                                                                       |
| `license`, `compatibility`, `metadata`                                                       | **in**                                       | Standard, descriptive, no behaviour                                                                                                                                                                                                                                                                                                   |
| `allowed-tools`                                                                              | **in**                                       | A base field of the standard. Its _values_ may name a tool a given harness lacks — which is already a `warned` cell on the Skills page ("its frontmatter names a tool Codex does not have"), a thing a person is shown rather than a thing that breaks                                                                                |
| `hooks`                                                                                      | **out**                                      | Not in the schema at all, so the parsed object hides it. Claude Code runs it. Nothing else has skill-scoped hooks. This is the field the raw reader exists for                                                                                                                                                                        |
| `context` (`fork`), `agent`, `background`                                                    | **out**                                      | Claude Code's subagent-forking dialect; no other tool has the concept, so a moved skill silently loses its isolation                                                                                                                                                                                                                  |
| `disable-model-invocation`, `user-invocable`                                                 | **out**                                      | Claude Code dialect adopted verbatim. `disable-model-invocation: true` is a person saying the model must not reach for this on its own; handing the file to five tools whose handling of the key is undocumented overrides that decision without asking                                                                               |
| `paths`                                                                                      | **out**                                      | Claude Code's glob-scoped auto-load. No other tool documents it, so a moved skill loses its scoping and becomes always-eligible — a behaviour change nobody asked for                                                                                                                                                                 |
| `model`, `effort`, `shell`, `argument-hint`, `arguments`, `display-name`, `disallowed-tools` | **out**                                      | The rest of layer 2, same class                                                                                                                                                                                                                                                                                                       |
| `schedule`                                                                                   | **out**, and the consequence is running code | The scheduler watches two roots — `<dorkHome>/skills/` and every project's `.agents/skills/` — and, deliberately, **never `.claude/skills/`** (`services/tasks/skills-roots.ts:30-53`). So a scheduled skill sitting in a harness-native folder does nothing today, and moving it starts a job that runs on a timer with nobody asked |
| `kind`                                                                                       | **out**                                      | A marketplace-author discriminator (ADR-0229), not part of the open standard. Widening the list "because it is harmless" is the first step of the slide D3 refuses                                                                                                                                                                    |

**Why an allowlist and not a denylist**, restated because it is the load-bearing argument: a denylist
of "Claude-only fields" has to be extended every time a vendor adds one, and the failure direction of
forgetting is _moved anyway_. An allowlist's failure direction is _reported and left alone_, which is
what the person asked for in the first place. That inversion is the only version that survives a
vendor shipping a field on a Tuesday.

**Two clauses, not one, because Claude-only-ness hides in the body.** SK-07 already warns about a
projected skill carrying `${CLAUDE_PLUGIN_ROOT}`; a frontmatter-only guard would move exactly that
file. The token check is a substring match on `${CLAUDE_` rather than a list of known names, for the
same reason clause 1 is an allowlist.

**What the predicate deliberately does not check.** Whether the body mentions `/reload-plugins` or
any other Claude-Code-only instruction in prose. That is unbounded, and a substring hunt through
English would refuse skills that merely _mention_ Claude Code. The two clauses are mechanical facts
about the file; anything softer belongs in a person's judgement, which is what the explicit command
is for.

#### 1.5 `applyAdopt` — the exact filesystem sequence, and what a crash leaves

```ts
export function applyAdopt(repoRoot: string, plan: AdoptPlan): AdoptResult;

export interface AdoptResult {
  moved: AdoptMove[];
  declared: AdoptDeclaration[];
  /** The plan's own refusals, plus any raised by the apply itself (EXDEV, a link conflict). */
  refusals: AdoptRefusal[];
}
```

Per move, in this order and no other:

1. `mkdirSync(join(repoRoot, '.agents/skills'), { recursive: true })`. Creating a directory that may
   already exist is not a mutation anybody can observe.
2. `renameSync(absFrom, absTo)`. **The single mutating step.** Both paths are inside one repository,
   so they are on one filesystem and `rename(2)` is atomic — on POSIX, and on NTFS within a volume.
3. If `move.link` is present, realize it through the engine's own apply:
   `applyPlan(repoRoot, { actions: [move.link], drops: [], warnings: [], notEnabled: [], narrowedTo: 'claude-code' }, {})`.
   No `sweepOrphans` — `applyPlan` throws when a narrowed plan asks for a sweep, which is the
   backstop rather than a rule to remember.
4. If step 3 threw, or returned the action in `conflicts`: **restore.** `renameSync(absTo, absFrom)`,
   then record the move as a refusal carrying the conflict's own reason. The restore is one rename
   back into a path this same process vacated a moment ago, so it cannot fail for a reason step 2 did
   not already prove impossible.

**A declaration is the other thing `applyAdopt` writes, and it is not a move.** For each entry in
`plan.declarations` it appends one element to `manifest.claudeOnlySkills` and rewrites nothing else
in `.agents/harness.manifest.json` — the same one-inserted-array-element contract
`enableHarnessInManifest` keeps, through the same kind of helper (`declareClaudeOnlySkill`). A plan
never holds both a move and a declaration for one name, because R8's short-circuit (§1.3) settles
which one a run is doing before anything is planned.

**`EXDEV` is refused, never degraded to a copy.** If step 2 comes back `EXDEV` — a `.claude/`
bind-mounted from elsewhere, a repository straddling volumes — the alternative is copy-then-delete,
which is not atomic and whose failure mode is exactly the half-moved skill this design promises never
to leave. It is refused with a frozen sentence (§8, S10) that tells the person to move the folder by
hand.

**Between steps 2 and 3, `.claude/skills/<name>` does not exist.** The window is one function call
wide and a running Claude Code session could look inside it and not find the skill. SK-11 is what
defuses it: Claude Code picks up a change under `.claude/skills/` within the session, so the link
step restores the skill to that session within seconds of landing — the same live-detection property
the `.agents/skills` watcher already relies on, quoted and dated in `vendor-facts`. Closing the
window instead would mean writing the link before the move, which means writing a link to a directory
that is not there yet.

**What a crash between steps 2 and 3 leaves, stated rather than hoped.** The skill directory whole at
`.agents/skills/<name>`, and nothing at the old path. Nothing is lost — every byte is at the
canonical root, which five of the six agent tools read natively. What is missing is Claude Code's
symlink, and that is precisely the `symlink` action `planSkill` plans for that skill on every
subsequent run. So the next `dorkos harness sync --fix`, the next `.agents/skills` watcher event
(the move itself fires one), the next boot pass, or the next `POST /api/harness/sync` creates it.
**The crash state is drift, which this engine already names and fixes, not damage.**

> **Decision: `applyAdopt` has no staging directory and no backup, unlike the marketplace
> transaction. Why:** the marketplace stages because it _builds_ content that does not exist yet, and
> backs up because it _overwrites_ an occupied target. Adopt does neither: R4 refuses an occupied
> target outright, so there is nothing to back up, and it moves content that is already whole and
> already valid, so there is nothing to stage. Staging it would mean copying a directory into a
> tmpdir and renaming from there — two copies, a non-atomic copy step, and lost hard links and mode
> bits — bought in exchange for closing a window `rename(2)` does not have. What adopt **does** keep
> from that module is its discipline: refuse rather than overwrite, one mutating step, restore on
> failure, and a lock held around the whole operation at the surface that has one.

> **Decision: the CLI takes no lock; the route holds `withProjectLock`. Why:** this is the same split
> `dorkos harness sync --fix` and `POST /api/harness/sync` already make, and the residual is the one
> `project-with-consent.ts` already writes down — two processes on one repository are not serialised
> and the engine has deliberately not taken a lock file. Adopt narrows that residual rather than
> widening it: the whole operation is one `rename`, so a concurrent writer either sees the old
> directory entry or the new one, and the losing side of a race gets `ENOENT` from step 2 and reports
> R1's "there is no skill called …" rather than corrupting anything.

#### 1.6 The link left behind IS a projection action, and here is the proof

`move.link` is present exactly when `root === '.claude/skills'`. For every other root the harness that
owns it already lists `.agents/skills` in its own documented project read paths
(`vendor-facts/index.ts`: OpenCode `['.opencode/skills', '.claude/skills', '.agents/skills']`, Cursor
`['.agents/skills', '.cursor/skills', '.claude/skills', '.codex/skills']`, Gemini `['.gemini/skills',
'.agents/skills']`, Copilot `['.github/skills', '.claude/skills', '.agents/skills']`), so it keeps
reading the skill at its new home. A link back would be a path DorkOS wrote that no plan action ever
names — an orphan by construction, at a path no sweep owns. Claude Code is the exception and the
whole reason the skills half of this engine exists: its `readPaths.project` is `['.claude/skills']`
and nothing else.

The link is **not hand-rolled** — but adopt cannot call the planner's own function to get it, and
that is a real constraint rather than a preference. `planSkill` is **module-private**
(`plan/projector.ts:89`, one call site at `:518`) and its second parameter is a `SkillEntry` that
`buildPlan` gets from `scanSkills(repoRoot)` — a walk of `.agents/skills`, which by definition cannot
see a skill that has not been moved there yet. Exporting `planSkill` as it stands would hand adopt a
function it has nothing to feed.

> **Decision: extract the one-argument helper both callers share. Why:** slice 2 adds
> `export function planAdoptedSkillLink(name: string): ProjectionAction` to `plan/projector.ts`,
> rewrites `planSkill`'s claude-code branch to `return planAdoptedSkillLink(skill.name)`, and has
> `planAdopt` call the same export. That is the only shape in which "the link adopt leaves is the
> link the planner plans" is a fact the compiler holds, rather than two literals that happen to agree
> today. One argument, because the name is all the two callers have in common — adopt has no
> `SkillEntry`, and the projector has no candidate.

Its return value is unchanged from what `planSkill` builds today (`plan/projector.ts:117-119`):

```ts
{ kind: 'symlink', artifact: 'skill', harness: 'claude-code', provenance: 'authored',
  name, source: `.agents/skills/${name}`, target: `.claude/skills/${name}` }
```

and it is realized by `applySymlink` through `applyPlan` — the same function every sync uses, which
computes its link text as `relative(dirname(target), source)` (`../../.agents/skills/<name>`) and
asks `symlinkType()` for the right kind on Windows.

**So "the next sync's plan already matches" is true by construction, not by care.** `checkPlan`
compares the plan's action against what is on disk through `linkMatchesPlan`, and the action it
compares is the one `applySymlink` was just handed. The test states it as an equality rather than as
a description: after `applyAdopt`, `checkPlan(repoRoot, project(repoRoot)).clean === true`, and the
applied action deep-equals `planAdoptedSkillLink(name)` — the export `planSkill`'s own claude-code
branch returns, so the two cannot drift apart. Nothing else in the plan
changes: before the move the skill was reported per-harness off the `.claude/skills` inventory branch
(`native` where the tool reads that folder, `drop` with "move it to `.agents/skills` to share it"
where it does not); after it, it is an ordinary authored skill — one `symlink` for Claude Code,
`native` for the rest. The authored-orphan sweep does not touch the new link, because the skill it
points at is live.

#### 1.7 Windows

Adopt inherits the platform story rather than repeating it.

- The **link** goes through `applySymlink`, which already calls `symlinkType(repoRoot, source)` and
  gets `'junction'` for a directory source — the exact `EPERM`-without-Developer-Mode case that
  function exists for.
- A clone that cannot make symlinks at all (J-10) is the standing case: `applySymlink` returns a
  blocking reason instead of throwing, step 4 restores, and the person is told the move did not
  happen and why. That is strictly better than the alternative, which would be a moved skill Claude
  Code can no longer find.
- The **move** is `renameSync` of a directory within one volume, which NTFS does atomically. The
  bounded `EPERM` retry in `atomic-write.ts` is for replacing an existing _file_ while a reader holds
  it; adopt's target does not exist (R4), so that path is not reachable and is not copied here.

#### 1.8 `Provenance`'s `'adopted'` value is retired

> **Decision: remove `'adopted'` from `Provenance` rather than start producing it. Why:** an adopted
> skill is not a third kind of source — it is a skill that now lives in `.agents/skills`, which is the
> authored root, scanned by the authored scanner, projected by the authored branch of `planSkill`,
> and committed like every other authored skill. Keeping the value would be worse than unused: it is
> **actively wrong**, because `isEphemeralProvenance('adopted')` returns `true`
> (`sources/resolve-roots.ts:52`), so anything that ever set it would send the gitignore half of the
> engine to tell a person to ignore a skill they just committed. `resolveSourceRoots` never returned
> such a root and, after this work, still never will: adopt writes into the authored root, not into a
> new one.

The blast radius, recounted from the table below rather than from memory: **five sites carry the
value itself and nine carry it in prose**, over ten rows — the `openapi.json` row is two generated
lines, and the `resolve-roots.ts` row is four sentences in one file. The boundary between the two is
mechanical rather than a judgement: a site is **code** when removing the value breaks the build or
changes a byte some program reads (a union member, an enum member, a table key, a test argument, the
generated contract), and **prose** when it does not. An earlier draft of this section counted four
and said "seven doc comments"; both were low.

| File                                                                         | Change                                                                                                                                                        |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/harness/src/plan/types.ts:42`                                      | `Provenance` becomes `'authored' \| 'installed'`                                                                                                              |
| `packages/shared/src/harness-schemas.ts:164`                                 | `HarnessProvenanceSchema` drops `'adopted'`, keeps `'harness-native'`, and its TSDoc's "`adopted` never occurs in v1" paragraph is replaced by why it is gone |
| `apps/server/src/services/harness/status.ts:115`                             | The `satisfies Record<Provenance, HarnessProvenance>` table loses a row — the compiler names this file, which is the point of the `satisfies`                 |
| `packages/harness/src/sources/__tests__/resolve-roots.test.ts:20`            | The case pinning `adopted` as ephemeral goes with the value                                                                                                   |
| `docs/api/openapi.json:211`, `:51220`                                        | Regenerated — the enum is published in the wire contract (see below)                                                                                          |
| `packages/harness/src/sources/resolve-roots.ts:5`, `:33`, `:47`, `:57`       | **Four** doc sentences lose "and adopted"; the function bodies are unchanged                                                                                  |
| `packages/harness/src/index.ts:5`                                            | Doc prose naming the provenance                                                                                                                               |
| `packages/harness/src/apply/gitignore.ts:5`, `:234`                          | Doc prose naming "installed/adopted" projections as the ephemeral family                                                                                      |
| `packages/harness/src/__tests__/properties/p7-gitignore.property.test.ts:42` | Doc prose                                                                                                                                                     |
| `packages/harness/src/__tests__/capabilities-census.test.ts:135`             | The `PINNED_GAPS` note "the test pins only that `adopted` counts as ephemeral provenance" goes with the test                                                  |

**It is a narrowing of a PUBLISHED wire enum, and that is the one real cost.** The value has never
been produced — no stored payload carries it and nothing has ever set it — but the enum itself is
served in the generated contract at `docs/api/openapi.json:211` and `:51220`, so an outside client
built against that document has a union member taken away. It is safe to take because it could never
have arrived, and the only in-repo consumer is this repository's own client, which the compiler
holds. The consequence for the work is concrete: **`docs/api/openapi.json` regenerates in slice 2,
not just in slice 4**, and `docs-openapi-check` is the gate that says so.

ADR-0303's third source class is untouched — the _class_ is the act of adoption, and this decision
says the act produces an `authored` skill rather than a standing third provenance. That sharpening is
part of what the amendment ADR records.

### 2. `--claude-only`

> **Decision: `--claude-only` records the name in `manifest.claudeOnlySkills` and moves nothing. Why:**
> it is the true answer to the question R7 asks. The refusal says "this file is Claude-Code-shaped";
> `--claude-only` is the person answering "yes, on purpose". SK-04 then governs from that moment on:
> the skill stays a real directory in `.claude/skills`, Claude Code reads it natively, every other
> enabled tool gets the drop line that says the placement is deliberate, and the status row stops
> being `adoptable` — because `adoptableSkillSources` already excludes declared names. One flag, one
> meaning, and the state it produces is one the engine understands end to end today.

**The drop line is a fixed engine string, not the entry's `reason`.** It is
`CLAUDE_ONLY_DROP_REASON` ("claude-only skill, kept in `.claude/skills` by
`manifest.claudeOnlySkills`", `plan/projector.ts:124-125`) and the two per-harness variants in
`plan/source-artifacts.ts:299` and `:314`. **The `reason` a manifest entry carries is stored and
never surfaced anywhere** — measured, not assumed. That is a field validated and unread, which is the
exact shape DOR-1858 retired four other manifest keys for; this work does not fix it, because
changing a required field is a manifest-compatibility decision of its own, and it is filed as a
follow-up instead. Meanwhile `--claude-only` writes a real one (S18) rather than a placeholder,
because a person opening that file should find a sentence.

> **Decision: there is no `--force`. Why:** a flag that moved the skill anyway would be exactly the
> failure D3 refuses. The exposure is one-way — five tools read `.agents/skills` the instant the
> directory lands there — and `manifest.claudeOnlySkills` cannot un-expose a moved skill, because per
> SK-04 it only fires _after_ the move. So the two ways out of R7 are `--claude-only` (declare the
> placement deliberate) and editing the file (take the Claude-only field out and adopt it). Both are
> reviewable; neither is irreversible. A `--force` would be the one path that is neither.

**The write.** `--claude-only` appends one element to `manifest.claudeOnlySkills` and leaves every
other byte of `.agents/harness.manifest.json` where it was — the same contract
`enableHarnessInManifest` already keeps for the one other flag that writes a manifest somebody else
wrote. The entry carries the candidate's own `source` as its `path`, because SK-04's five states are
all resolved from the entry's own `path` and assuming the `.claude/skills/<name>` convention is the
defect DOR-1847 fixed.

**R8, its scope limit.** `manifest.claudeOnlySkills` is named for Claude Code and every one of SK-04's
five states is about `.claude/skills`. A candidate under `.opencode/skills` has no such declaration to
make, so `--claude-only` on one is refused (S9) rather than silently recording something the projector
would then resolve against the wrong folder.

### 3. `harness.autoAdopt`

#### 3.1 The field

```ts
// packages/shared/src/config-schema.ts, inside the `harness` block
/**
 * Whether DorkOS may move a skill out of an agent tool's own folder and into
 * `.agents/skills` on its own, where every agent tool reads it.
 *
 * Off everywhere by default, and acted on ONLY inside the folders DorkOS owns —
 * an agent's own workspace under `<dorkHome>/agents`, and a room worktree.
 * Everywhere else a move is a person's decision, made with
 * `dorkos harness adopt <name>`, because it is one-way: five agent tools read
 * `.agents/skills` the moment the folder lands there and nothing can un-share it.
 *
 * When it is on, the guard is an ALLOWLIST, not a denylist: only a skill whose
 * settings hold nothing outside the agentskills.io base fields and whose text
 * carries no `${CLAUDE_…}` token is moved. Everything else is reported and left
 * alone, so a field a vendor adds tomorrow fails closed (contract §16 D3).
 */
autoAdopt: z.boolean().default(false),
```

and the enclosing `.default(() => ({ autoSync: true, autoAdopt: false, approvedHooks: [],
refusedHooks: [] }))` literal, which the skill's own rule requires and which `USER_CONFIG_DEFAULTS`
parses at import time.

#### 3.2 What "permitted" means

> **Decision: `true` is accepted at write time and acted on only where DorkOS owns the directory. A
> `true` in a plain project is inert — not by a check somebody could forget, but by construction —
> and `dorkos harness sync` says so once. Why:** the value is one global boolean in
> `~/.dork/config.json` and a config write has no project in hand, so refusing the write would refuse
> it for the agent homes it exists for. And a runtime "ignored with a warning" that lived in every
> trigger would be five checks to keep in step. Instead the flag is read at exactly **two** call
> sites, both of which have already established that DorkOS owns the directory they are standing in:
>
> 1. `backfillAgentWorkspaceSkills` (`project-agent-workspace.ts`), per workspace that passed
>    `isAgentHome(agentDir, dorkHome)`, after the seed and the projection.
> 2. `RoomWorktreeManager`'s seed-and-project pairing — worktree creation and `refreshPack` — per
>    worktree under `<dorkHome>/rooms/<roomId>/worktrees/`.
>
> `runAutoProjection`, `projectOnAgentCreated` and the `.agents/skills` watcher all run in
> directories a person owns and **none of them reads the flag at all**. So a `true` there does
> nothing, and there is no branch that could be mis-written to make it do something.

The one place a person who set it learns why nothing happened is the terminal: `dorkos harness sync`
(both modes) in a directory DorkOS does not own prints B1 (§8, S8) once when the config says
`autoAdopt: true`. The CLI already reads `~/.dork/config.json` for hook decisions and already
resolves the dork home, so it can answer "is this an agent home or a room worktree" from the path
alone.

**Ownership is a path question, and the engine never asks it.** `DirectoryOwnership` is an _input_ to
`planAdopt`. The server resolves it from `dorkHome` (`isAgentHome`, and the
`<dorkHome>/rooms/*/worktrees/*` shape); the CLI resolves it the same way from `resolveDorkHome()`.
`packages/harness` keeps no knowledge of dork home, which is the property that lets the same engine
run offline in a terminal and inside the server.

#### 3.3 What auto mode actually does in an agent home

For each owned workspace, after seeding and projecting:

1. `readAdoptCandidates` over that workspace.
2. `planAdopt({ mode: 'auto', ownership: 'agent-home', … })`.
3. `applyAdopt` for the moves — which will be only the allowlisted ones, because R7 is hard in auto
   mode.
4. Count `adoptableSkills` (candidates found) and `adoptedSkills` (moves that landed) into the existing
   `AgentWorkspaceBackfillSummary`, so all three of its branches report them (§4b).

With `autoAdopt: false` — the default, and therefore what almost every install does — steps 2 to 3
are skipped and step 1 still runs, so the summary still reports `adoptableSkills`. **That is the whole
report-only claim**, and it is the assertion in the test suite that matters most: the default posture
finds every candidate and moves none of them.

#### 3.4 The migration and the four classification tables

> **Decision: the key is chosen AT MERGE as the next value above the highest key already in the
> table — not reserved in advance. Whichever of DOR-1853 and DOR-1857 lands first takes `'0.76.0'`;
> the other takes `'0.77.0'`. Why:** an earlier draft of this spec reserved `'0.77.0'` on the grounds
> that `harness-sync-global` §2.3 had claimed `'0.76.0'` first. **That is unsafe, and `conf`'s own
> source is why.** `_shouldPerformMigration` skips any key `lte` the stored version
> (`conf@15.1.0`, `dist/source/index.js:534`), and after the loop the store is stamped with the APP
> version rather than with the highest key that ran (`:494-495`). So a release that shipped
> `'0.77.0'` while `'0.76.0'` was still unmerged would stamp every install at that app version, and
> `'0.76.0'` — landing later, from the other branch — would then be `lte` the stored version on every
> one of them and **never run again**. A leaf nothing writes is a leaf whose migration silently did
> nothing, which is the DOR-1496 failure with a gap instead of a wrong body.
>
> The convention already says this and this spec had simply read it too narrowly:
> `contributing/configuration.md:399` — "Pick the key first: strictly greater than the newest `v*`
> tag" — and `:586` — "conf runs a key only when `key > storedVersion && key <= projectVersion`" —
> plus `adding-config-fields`'s "never extend a key that already exists". The operational rule that
> satisfies all three without a gap is **contiguous, decided at merge**: read the table, take the
> next value above its highest key, and pin it in `merged-migration-hashes.ts` in the same pull
> request. The table tops out at `'0.75.0'` today, so today's answer is `'0.76.0'` — and if the
> global spec merges first, this one rebases onto `'0.77.0'` before it lands. That rebase is one
> line, in a body nothing has run yet, which is exactly the window the append-only rule leaves open.

```ts
// The key is the next value above the table's highest at MERGE time — `'0.76.0'`
// as of writing, `'0.77.0'` if DOR-1857's `harness.global` key lands first. Never
// a reserved gap: see the decision above.
'0.76.0': (store: { get: (key: string) => unknown; set: (key: string, value: unknown) => void }) => {
  // `harness.autoAdopt` — whether DorkOS may move a skill into `.agents/skills`
  // on its own inside the folders it owns (DOR-1853). A nested leaf, so this
  // body is the only thing that writes it; see `seedHarnessAutoAdopt`.
  seedHarnessAutoAdopt(store);
},
```

`seedHarnessAutoAdopt` is guarded on `'autoAdopt' in harness` and pinned in
`__tests__/merged-migration-hashes.ts` in the same pull request, which is what freezes the body from
the moment it merges.

The three **total** guards each need a verdict, and each is a real decision:

| Table                                                    | Verdict                                | Why                                                                                                                                                                                                                                                                                  |
| -------------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `CONFIG_DISCLOSURE`                                      | `'harness.autoAdopt': 'expose'`        | A preference. No credential, and nothing that names where one lives                                                                                                                                                                                                                  |
| `CONFIG_WRITE_POLICY`                                    | `'harness.autoAdopt': 'operator-only'` | The same verdict `harness.autoSync` carries, for a stronger reason: turning this on makes DorkOS move a person's own files, unattended. That is "how far DorkOS reaches on disk", which is the module's own line for `operator-only`. An agent must not be able to grant DorkOS that |
| `DEFAULT_VERDICTS` (`safe-defaults/default-verdicts.ts`) | `'harness.autoAdopt': 'safe'`          | A gate that starts closed, on a real safety axis                                                                                                                                                                                                                                     |

Two registries take **no** entry, and each absence is a decision:

- `PROTECTED_STATE` (`safe-defaults/protected-state.ts`) — carryover exists so a config wipe cannot
  loosen something a person tightened. The default here _is_ the tight value, so a wipe restoring it
  restores the protective answer. `harness.autoSync` needs a rule because it defaults ON.
- `EXPERIMENTS` (`config/experiments-registry.ts`) — that registry is for a staged opt-in awaiting
  graduation, and every entry must name a `graduationIssue`. `autoAdopt` is a permanent posture: D3
  says off everywhere, for good, so there is no graduation and no issue to name. (Checked: the
  registry's guard validates entries, and has no reverse direction forcing every `false`-defaulting
  boolean into it.)

`FEEDBACK_FLAG_ALLOWLIST` (`packages/shared/src/feedback.ts`) gains `'harness.autoAdopt': 'boolean'`.
It is an opt-in list rather than a total one, and this flag earns a place: "a skill moved on its own"
is a bug report this value explains in one line.

### 4. Reporting — four surfaces, one sentence builder

VC-01 exists and is drawn. This **extends** it and rebuilds none of it.

```ts
// packages/harness/src/report/adoptable.ts — beside drop-list.ts, for the same reason
export function adoptableSentence(input: {
  /** Which harness-native root these skills live in. */
  root: SkillRoot;
  /** The skill names, sorted. */
  names: readonly string[];
  /** The ENABLED harnesses whose documented read paths do not include `root`, in manifest order. */
  cannotSee: readonly HarnessId[];
  /** Absolute repository root, when the reader may not be standing in it. Server surfaces pass it. */
  projectPath?: string;
}): string;
```

**The harness list is computed, never written down.**
`enabled.filter((h) => !skillsFactsFor(h).readPaths.project.includes(root))`, mapped through
`HARNESS_LABELS`, kept in manifest order, joined `a, b and c`. On a repository enabling all six, a
`.claude/skills` skill yields `['codex', 'gemini']` — because those two are the only ones whose
vendor-documented project read paths omit `.claude/skills` — which is exactly the contract's own
sentence. On an OpenCode-first repository (DOR-1902), a `.opencode/skills` skill yields the other
five.

**When `cannotSee` is empty, nothing is printed.** Every agent tool this project uses can already see
the skill; a count of zero problems is noise, and the block is not a drift report.

**It never changes an exit code.** A skill somebody keeps in a tool's own folder is a real choice —
the same rule AP-15 already follows for a gitignored `.agents/`.

**Pluralisation, at every n.** Handled in the builder and pinned by test at n=1, n=2 and n=3, and
separately for a `cannotSee` list of length 1, 2 and 3:

- n = 1: `1 skill lives only in .claude/skills and Codex and Gemini cannot see it — dorkos harness adopt deploy-checklist moves it`
- n = 3: `3 skills live only in .claude/skills and Codex and Gemini cannot see them — dorkos harness adopt <name> moves one`
- `cannotSee` of length 1: `… and Codex cannot see it — …`

At n = 1 the headline names the skill in its command and stands alone. At n > 1 it is followed by one
indented line per skill carrying that skill's own full command, because a headline cannot name three
skills in one command and a list of names with no command is a second thing to look up.

#### a) `dorkos harness sync --check` and `--fix`

One new block, printed **immediately before `formatClaudeOnly`** in both `reportCheck` and
`reportFix` — the same neighbourhood, because both are about skills the projection can see and
cannot share, and a person reading one wants the other in the same breath. One headline per root:

```

Skills only some of your agents can see:
  1 skill lives only in .claude/skills and Codex and Gemini cannot see it — dorkos harness adopt deploy-checklist moves it
```

The CLI passes **no** `projectPath`: it ran in the repository, so a bare command is correct there and
is the contract's own sentence.

#### b) The boot summary — the real line, named

The unattended pass's single summary line is
`logger.info('[HarnessSync] Agent workspace skill backfill complete', summary)` at the end of
`backfillAgentWorkspaceSkills` (`apps/server/src/services/harness/project-agent-workspace.ts`), with
two `logger.warn` siblings for "repaired nothing" and "partly failed". All three log the same
`AgentWorkspaceBackfillSummary` object, so two new counters on that interface reach every branch
without a fourth being written:

```ts
/**
 * SKILLS — not workspaces — that live only in one agent tool's own folder, across
 * every workspace this pass considered. Found, whatever was done about them.
 *
 * The name carries the unit because every other field on this interface counts
 * WORKSPACES, and a summary that mixed the two silently is the "1 of 0" phrasing
 * the `partly failed` branch below already exists to prevent.
 */
adoptableSkills: number;
/** How many of those this pass actually moved. Zero unless `harness.autoAdopt` is on. */
adoptedSkills: number;
```

and, when `adoptableSkills > adoptedSkills`, a `hint` saying so and pointing at the per-workspace
lines: `N skills in M agent folders live only in one agent tool's folder. Each is named above with
its folder.`

**The two `logger.warn` branches already use the `hint` key** (`:444` and `:449` log
`{ ...summary, hint }`), so neither gains a second one — their existing sentence gains a clause. Only
the `info` branch, which logs the bare summary today, gains a `hint` of its own.

The **sentence itself is per workspace**, because a command needs one absolute path and an aggregate
has none. It rides a new `logger.info` inside **`backfillAgentWorkspaceSkills`'s own per-workspace
loop** (`project-agent-workspace.ts:405-463`), which is the only place with both `agentDir` and the
adopt result in hand. Not inside `projectAgentWorkspace`: the two `logger.debug` lines at `:312` and
`:331` are that function's own, it is called from three places with different jobs, and it knows
nothing about adoption. Giving it a fourth responsibility would put an adopt line in the agent-creator
and room-worktree paths that never asked for one. The line carries `agentDir` and
`adoptableSentence({ …, projectPath: agentDir })` — the same shape the "partly failed" branch already
promises when it says "Each failure was logged above with its workspace path".

`projectAgentWorkspace` itself gains no reporting: it returns a status the caller counts, exactly as
it already does for `applied` and `conflicts`.

#### c) The Skills page row

Line 3 keeps its firing condition (`row.adoptable`), gains the command, and **stops being a
literal**:

```
Lives in .claude/skills. Move it to .agents/skills so every agent can read it.
Run: dorkos harness adopt deploy-checklist --project /Users/x/proj
```

`ADOPTABLE_ADVICE` (`SkillHarnessRow.tsx:21-22`) is a constant today and it spells `.claude/skills`
into the sentence — which is right only because that is the only root that exists, and is wrong the
moment DOR-1902 lands. It becomes a template fed from `dirname(row.source)`, so an OpenCode-first
repository reads `Lives in .opencode/skills.` with no further change. Its own docblock says the tests
"assert the literal — a test comparing a string against the constant that produced it cannot fail on
a copy change", so both of those tests move with it: the unit case in
`SkillsWithHarnessesList.test.tsx` and the e2e assertion at `skills-page.spec.ts:128-130`, which
contains the sentence verbatim. **This is slice 2's change, not slice 4's** — it is copy, it is built
from the same facts as the terminal's, and keeping it out of the button's slice is what makes the cut
line honest.

> **Decision: the row's line-3 firing condition is NOT narrowed to "some enabled tool cannot see it",
> even though the CLI headline is. Why:** the two sentences make different claims. The row's line
> makes none about any agent tool — it says where the file lives and what moving it buys, both true
> whatever is enabled — and it is the sentence DOR-1894 shipped and an e2e test pins. The headline
> _does_ name tools ("Codex and Gemini cannot see it"), and a claim about tools has to be true, so it
> is computed and withheld when the list is empty. Narrowing the row instead would be rebuilding a
> shipped surface to fix a problem it does not have.

**`--project` carries the absolute repository root, never `.`.** The status response already knows it
(`projectPath`, resolved by the route through `validateBoundaryOrDorkHome`). A `.` in a string the
_server_ prints is the defect DOR-1921 and `plan/global-installs.ts` both measured: the reader is not
in that directory, so a pasted `.` means whatever directory they happen to be in. `dorkos harness
adopt` is offline and resolves `--project` against the caller's own cwd, so an absolute path is what
makes the pasted command mean the same thing from anywhere.

#### d) The banner

Unchanged. `counts.adoptable > 0` still draws "Some skills live where only a few of your agents
look." with no action, because there is no single skill for a page-level button to adopt. Slice 4
gives the **row** an action; the banner stays a statement.

### 5. The CLI — `dorkos harness adopt`

```
Usage: dorkos harness adopt <name> [--project <path>] [--claude-only] [--check]

  <name>              The skill to move, by its folder name
  --project <path>    The project to act on. Defaults to the folder you are in
  --claude-only       Record the skill as Claude-Code-only instead of moving it
  --check             Say what would happen. Writes nothing
```

- **One positional, required.** `parseArgs` with `allowPositionals: true` and exactly one accepted —
  unlike `parseHarnessSyncArgs`, which sets `allowPositionals: false`. A bare `dorkos harness adopt`
  is a usage error naming the command that lists candidates
  (`dorkos harness sync --check`), rather than doing something: a bare adopt that acted would be one
  keystroke away from the multi-adopt this spec deliberately does not ship.
- **`--project` is resolved by the CLI, against its own cwd.** `resolve(process.cwd(), value)`.
  Adopt never reaches a server, so the `--project .` hazard does not exist for the command itself —
  but every string DorkOS _prints_ still carries the absolute root (§4c).
- **Exit codes.** `0` when the skill moved, was declared, or — under `--check` — would move. `1` when
  it was refused, and `1` on a usage error. The refusal sentence goes to stdout with the plan; the
  usage error goes to stderr, matching every other command in this package.
- **A project with no `.agents/harness.manifest.json`** gets the same answer `sync --check` gives —
  the command stops and says where it looked — and never scaffolds one. Scaffolding is a write, and a
  person asking to move one skill has not asked DorkOS to set the project up.

> **Decision: `adopt --check` exits 0 when the move WOULD succeed, which is the opposite of
> `sync --check`. Why:** they ask different questions. `sync --check` asks "is my tree in sync?", so
> work outstanding is a non-zero answer. `adopt <name> --check` asks "will this command work?", so
> success is zero and a refusal is one. The asymmetry is stated in the help text and in
> `contributing/harness-sync.md`, because it is exactly the kind of thing a script author trips over
> once and never forgives.

**Where it lives.** `packages/cli/src/harness-adopt-command.ts`, dispatched from
`commands/harness-dispatcher.ts` beside `sync` and `hooks`, with its own `--help`/`-h` early exit and
its subcommand block in `HELP_TEXT`. The dispatcher's contract is unchanged: return an exit code,
never call `process.exit`.

**`dorkos harness sync` gains no `--project`.** It acts on the folder you run it in, and changing that
is a separate decision about a shipped command with its own tests. Adopt introduces the flag because
its command is _printed by the server_ for somebody who may be anywhere.

### 6. `POST /api/harness/adopt`

> **Decision: the route ships, in v1, in the same slice as the page action. Why:** the app is the
> primary surface, and a route with no caller is dead code by this repository's own standard. They
> are one slice so that neither can land alone, and so that cutting the page (§7) cuts the route with
> it and leaves the CLI shipping on its own — which is a coherent product, not a half-built one.

It mirrors `POST /api/harness/sync` clause for clause:

- **Person, not agent.** `resolveDecisionAuthority(readCallerAuthority(req, res))` **before** body
  validation, the order `POST /api/marketplace/sources` uses, so a caller who may not do this at all
  gets one answer whatever it sent. `403` with `code: 'operator_only_harness_adopt'` — the snake-case shape
  `HARNESS_SYNC_OPERATOR_ONLY_CODE` already uses (`routes/harness.ts:231`), not the SCREAMING form —
  and the message at §8 S11. A test asserts the refusal shape against `sync`'s own case, so the two cannot drift.
- **Body** `{ projectPath: <absolute>, name: string, claudeOnly?: boolean }` — the shape declared as
  `HarnessAdoptBodySchema` in `packages/shared/src/harness-schemas.ts`, **without** an `isAbsolute`
  refinement, and refined in `routes/harness.ts` beside the other two. That split is not an
  oversight; the module says why at `:198-206`: the shared schema is what the CLIENT imports,
  `isAbsolute` is `node:path` and its answer is platform-dependent, and a regex reimplementation in a
  browser-safe module would be a second, wrong copy. So the route adds
  `.refine(({ projectPath }) => isAbsolute(projectPath))` exactly as `HarnessSyncBody` does at
  `:218-221`, and **that** is what returns `400` for a relative path — before `resolveProject` runs.
  `projectPath` then goes through `resolveProject`, which owns the rest: `400` for a NUL byte or a
  path that is not a directory, `403` for a boundary or permission refusal, `404` for one that leads
  nowhere (`routes/harness.ts:297-344`).
- **No manifest is `409`**, with the same body `sync` returns: `loadManifest` throws `ENOENT` at the
  engine and a project that shares nothing is not an adopt that did no work.
- **`withProjectLock(resolved, …)` around plan + apply + the status recompute**, so the status in the
  response describes the tree this apply left rather than one a watcher or a marketplace install
  rewrote in between. Same reason, same shape, same lock as `sync`.
- **`200` even for a refusal.** The response is
  `{ moved: AdoptMove[], declared: AdoptDeclaration[], refusals: AdoptRefusal[], status: HarnessStatusResponse }`.
  A refusal is an answer carrying its own way out, and the page draws it in the place the advice line
  was — the same thing it already does with a drop reason. A `404` for "no such skill" was considered
  and rejected: it would make the page special-case one refusal out of eight to render the same
  sentence.
- **The capability tier, recorded so it is not re-litigated.** Not a registered capability in v1 — no
  agent path needs it. If it is ever surfaced to agents it is **`destructive`**, and that is
  deliberately the opposite of `sync`'s verdict: `sync` writes and removes only files DorkOS made,
  while adopt moves a file a _person_ made.
- **OpenAPI.** The route registry is generated and checked by `docs-openapi-check`, so the two new
  schemas ship in `harness-schemas.ts` in the same commit as the route.

### 7. The Skills page row action (slice 4)

On a row with `adoptable: true`, one button beside line 3: **Share with every agent**. Pressing it
opens the confirm dialog the client already uses for a change worth naming first:

> **Move `deploy-checklist` so every agent can read it?**
> It moves from `.claude/skills/deploy-checklist` to `.agents/skills/deploy-checklist`, and DorkOS
> leaves a link behind so Claude Code still finds it.
> `[Cancel]` `[Move it]`

On success the page draws the same "What changed" summary the Sync button uses, from the status the
route returned — **written into the cache with `queryClient.setQueryData`, never an invalidate**, for
the reason `use-harness-sync.ts:11` gives about its own POST: the response already carries the
recomputed status, so re-reading would discard the authoritative answer and race the write. On a
refusal the row draws the refusal sentence where the advice line was.

> **Decision: the button ships, although DOR-1894 deliberately shipped none. Why:** the comment on
> `SkillHarnessRow` gives the reason it was left out — "moving a file out from under a person's
> editor is not something a side panel should offer (D3)" — and half of that reason was that D3 had
> no verb to offer; the page could not put a button on an action that did not exist. The other half
> stands and is **answered rather than overruled**: the button does not move anything, it opens a
> confirm that names both paths first, which is the same disclosure the sweep already gets before the
> Sync button acts. The alternative is printing a terminal command inside the app, which is what the
> target-toggle decision (§16 D24) does — and the difference is that a toggle writes a file the whole
> project shares while this moves one file the person is looking at.

> **Cut line, stated in advance.** If the confirm needs anything beyond the `AlertDialog` and
> `Banner` primitives the page already uses — a diff, a per-tool preview, a multi-select column —
> slice 4 is cut whole (route included) to a follow-up, and the CLI plus the row's printed command
> are what ships — the row copy belongs to slice 2 precisely so that this sentence is true. That
> outcome is strictly better than today: the row currently names no command at all, and spells one
> root into a literal.

### 8. Every user-facing string this work freezes

Written to the `writing-for-humans` bar: a smart ninth-grader who does not code can read every one,
and each says what to do next. `{n}`, `{name}`, `{source}`, `{file}`, `{root}`, `{tools}`,
`{fields}` and `{projectPath}` are substitutions. Each is asserted verbatim by at least one test, and the tests compare against the
literal rather than against the constant that produced it.

| #        | Where                                                 | The sentence                                                                                                                                                                                                                                                                                                                      |
| -------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **S1**   | Sync + boot, n=1                                      | `1 skill lives only in {root} and {tools} cannot see it — dorkos harness adopt {name} moves it`                                                                                                                                                                                                                                   |
| **S1b**  | Sync + boot, n>1                                      | `{n} skills live only in {root} and {tools} cannot see them — dorkos harness adopt {name} moves one`                                                                                                                                                                                                                              |
| **S1c**  | Sync + boot, block heading                            | `Skills only some of your agents can see:`                                                                                                                                                                                                                                                                                        |
| **S1d**  | Boot log + Skills page, n=1                           | `1 skill lives only in {root} and {tools} cannot see it — dorkos harness adopt {name} --project {projectPath} moves it`                                                                                                                                                                                                           |
| **S1e**  | Boot log + Skills page, n>1                           | `{n} skills live only in {root} and {tools} cannot see them — dorkos harness adopt <name> --project {projectPath} moves one`                                                                                                                                                                                                      |
| **S2**   | R1, no such skill                                     | `There is no skill called "{name}" in {root}. Run dorkos harness sync --check to see what is here.`                                                                                                                                                                                                                               |
| **S2b**  | R1, already canonical                                 | `"{name}" is already in .agents/skills, where every agent reads it. The copy in {source} is a second one that gets in the way — delete one of them.`                                                                                                                                                                              |
| **S2c**  | R1, declared                                          | `"{name}" is listed in manifest.claudeOnlySkills, which says the Claude-Code-only spot is on purpose. Take it out of that list first if you want to share it.`                                                                                                                                                                    |
| **S3**   | B2 (AP-15)                                            | `DorkOS can't move a skill into .agents/skills here: {file} tells git to ignore .agents/, so moving it would take the skill out of git for everybody who clones this project. Stop ignoring .agents/ in {file}, or leave the skill where it is.`                                                                                  |
| **S4**   | R3 (SRC-11)                                           | `"{name}" is one of the skills DorkOS puts in every room folder, so .agents/skills/{name} is hidden from git here and would be deleted when the room folder is cleaned up. Rename your skill and adopt it under the new name.`                                                                                                    |
| **S5**   | R4                                                    | `.agents/skills/{name} already has something in it. Look at both copies, keep the one you want, and adopt again.`                                                                                                                                                                                                                 |
| **S6**   | R5                                                    | `{source} is a link to a folder somewhere else, so DorkOS can't move it without changing where your real skill lives. Move the real folder into .agents/skills yourself, or leave the link alone.`                                                                                                                                |
| **S7**   | R7, frontmatter                                       | `"{name}" uses {fields} in its settings, which only Claude Code understands, so moving it would hand it to agents that can't run it properly. Run dorkos harness adopt {name} --claude-only to say it belongs to Claude Code, or take {fields} out and adopt it.`                                                                 |
| **S7b**  | R7, body token                                        | `"{name}" mentions ${CLAUDE_PLUGIN_ROOT} in its text, which only Claude Code fills in, so moving it would hand it to agents that read a broken path. Run dorkos harness adopt {name} --claude-only to say it belongs to Claude Code, or take the token out and adopt it.`                                                         |
| **S7c**  | R7, a key DorkOS does not know                        | `"{name}" uses {fields} in its settings, which DorkOS doesn't recognise, so it can't tell whether your other agents can run it. Run dorkos harness adopt {name} --claude-only to keep it where it is, or take {fields} out and adopt it.`                                                                                         |
| **S8**   | B1                                                    | `harness.autoAdopt is on, and it does nothing here: DorkOS only moves skills on its own inside the agent folders and room folders it owns. Run dorkos harness adopt <name> to move one yourself.`                                                                                                                                 |
| **S9**   | R8                                                    | `--claude-only records a skill as belonging to Claude Code, and "{name}" lives in {root}. Leave it where it is, or move the folder yourself.`                                                                                                                                                                                     |
| **S10**  | `EXDEV`                                               | `DorkOS can't move {source} into .agents/skills because the two folders are on different drives. Move the folder yourself, then run dorkos harness sync --fix.`                                                                                                                                                                   |
| **S11**  | Route 403                                             | `This moves a file inside your project, so it is a decision a person makes in DorkOS rather than something an agent does on your behalf.` (error: `Only a person can move a skill`)                                                                                                                                               |
| **S12**  | R6                                                    | `DorkOS can't read the settings at the top of {source}/SKILL.md, so it can't tell whether the skill is safe to share. Fix that file and adopt again.`                                                                                                                                                                             |
| **S13**  | Row line 3                                            | `Lives in {root}. Move it to .agents/skills so every agent can read it.` **+** `Run: dorkos harness adopt {name} --project {projectPath}`. **Not unchanged**: `ADOPTABLE_ADVICE` (`SkillHarnessRow.tsx:21-22`) hard-codes `.claude/skills` as a literal, so it becomes a template fed from `dirname(row.source)`                  |
| **S14**  | Confirm dialog                                        | `Move {name} so every agent can read it?` / `It moves from {source} to .agents/skills/{name}, and DorkOS leaves a link behind so Claude Code still finds it.` / `Move it`                                                                                                                                                         |
| **S14b** | Confirm dialog, a root that gets no link              | `Move {name} so every agent can read it?` / `It moves from {source} to .agents/skills/{name}, where every agent reads it.` / `Move it`                                                                                                                                                                                            |
| **S15**  | CLI success                                           | `Moved {name} to .agents/skills/{name}. Claude Code still finds it through a link at {source}.`                                                                                                                                                                                                                                   |
| **S15b** | CLI success, a root that gets no link                 | `Moved {name} to .agents/skills/{name}, where every agent reads it.`                                                                                                                                                                                                                                                              |
| **S16**  | CLI `--claude-only` success                           | `Recorded {name} as belonging to Claude Code. It stays in {source}, and your other agents are told why they don't get it.`                                                                                                                                                                                                        |
| **S17**  | R2                                                    | DOR-1882's frozen occupant sentences, reused verbatim, so a sync and an adopt say the same words about the same file                                                                                                                                                                                                              |
| **S18**  | The `reason` `--claude-only` writes into the manifest | From R7's frontmatter case: `Kept in Claude Code: its settings use {fields}, which only Claude Code understands.` · From R7's body case: `Kept in Claude Code: its text uses ${CLAUDE_PLUGIN_ROOT}, which only Claude Code fills in.` · On a skill that would have passed the allowlist anyway: `Kept in Claude Code on purpose.` |

R7's `{fields}` names the offending keys in the order they appear in the file, joined `a, b and c` —
the person's own file read back to them, which is what makes "take them out" actionable.

**Two forms of the same sentence, and which surface prints which is a rule, not a choice.** S1/S1b
carry no `--project`; S1d/S1e carry the absolute one. **Every surface DorkOS prints from the SERVER
uses the absolute form** — the boot log and the Skills page row — because the reader is not standing
in that directory and a bare command means whatever folder they happen to be in. The CLI prints
S1/S1b, because it ran in the repository and a bare command is right there; that is also the form the
capability contract quotes for J-06. This is DOR-1921's and DOR-1922's lesson applied ahead of time
rather than after (`plan/global-installs.ts` records the measurement), and `adoptableSentence`'s
optional `projectPath` is the one switch between them.

**S14b and S15b exist because four of the five roots get no link** (§1.6, Decision 16). Promising "a
link behind so Claude Code still finds it" for a skill moved out of `.opencode/skills` would be a
sentence about something that did not happen — and would leave a person hunting for a link that was
never planned. The variant is chosen by the same condition `move.link` is: present only for
`.claude/skills`.

**S7c is picked by a second list, derived rather than written.** S7 says "which only Claude Code
understands", and that is true of the layer-2 dialect fields — but it is false for a typo
(`descripton:`) and for a third-party key that no agent tool documents. So the predicate asks a
second question after the allowlist says no: is the offending key one `SkillFrontmatterSchema` itself
declares (layer 2 plus `schedule` and `kind`)? Yes → **S7**. No → **S7c**, which claims nothing about
who understands it and says only that DorkOS cannot tell. The set is read off
`SkillFrontmatterSchema.shape` minus the six base fields at module scope, never spelled a second
time, so a field the schema gains tomorrow moves between the two sentences on its own. A body token
is always **S7b**, whatever the frontmatter holds, because that fact is about the text.

**S18 is written into somebody's manifest, so it is a sentence and not a code.** It is the one frozen
string here that a person reads in a file rather than on a screen, and it has to still make sense a
year later beside a dozen others — which is why it names what made the skill Claude-shaped rather
than saying "declared by `dorkos harness adopt --claude-only`".

**S4 does not say "seven".** The reserved set is `OPERATING_SKILLS_PACK`, and
`SEEDED_PACK_EXCLUDES`'s own comment says why a hand-written count is a bug waiting to happen: the
pack has grown before and a list extended by hand is a list that will be one behind. The sentence
names the fact ("one of the skills DorkOS puts in every room folder") rather than a number the code
would have to keep true.

## User Experience

**The person with a Claude-first repository who has just added Codex.** They open the DorkOS app,
land on the agent profile's Skills page, and see six rows with a "Codex can't see it" chip and a line
saying where the skill lives. Today that line is where it ends. Now each of those rows has a **Share
with every agent** button; pressing one names both paths and asks; saying yes moves the folder, and
the chip flips from "Codex can't see it" to "Codex reads it" on the recomputed status, with a "What
changed" summary above the list.

**The person in a terminal.** `dorkos harness sync --check` ends with a new block naming the skills
only some of their agents can see, with the exact command for each. `dorkos harness adopt
deploy-checklist` moves one and says what it did. If it will not, it says why in one sentence with
the way out, and exits 1.

**The person who keeps a skill Claude-only on purpose.** The refusal already tells them the flag:
`dorkos harness adopt deploy-checklist --claude-only` writes one line into the manifest, the skill
stops being reported as adoptable everywhere, and the other tools' drop lines start carrying the
manifest's reason. They are never asked about it again.

**The person running agents in DorkOS-owned folders.** `dorkos config set harness.autoAdopt true`.
From the next boot, an agent's own workspace gets its plainly-portable new skills moved into
`.agents/skills` automatically, and the server log names every one it did _not_ move and why.
Nothing changes in any of their own repositories.

**The exit paths.** Every refusal is a sentence, never a stack trace or an exit code alone. A crash
mid-move leaves the skill whole and the next sync finishes the job. A Windows clone that cannot make
symlinks gets the move undone and is told so, rather than a moved skill Claude Code can no longer
find.

## Testing Strategy

**The bar, restated for this surface.** Every new test fails on `main` before its fix lands, and the
pull request shows both runs (`plans/harness-sync-test-plan.md` §0). Where a surface does not exist
on `main` at all, "fails on main" is trivially true and proves nothing — the plan's line 9 says so
about the status work — so each slice below names the **seeded defect** that discriminates: a
one-line mutation of the shipped code that must turn the test red. Every enumerating test asserts
**how many** things it found before asserting anything about them (the zero-subject rule).

**Note: the plan's own seeded defect for this line is stale.** §11 line 10 says "J-06: `unmanaged` is
empty on a repo with a real dir in `.claude/skills`". That was true before DOR-1894; `unmanaged` is
computed and drawn today, so the assertion is green on `main`. Each slice names its own instead.

### Slice 1 — the planner (`packages/harness/src/adopt/__tests__/`)

`plan.test.ts` — pure fixtures, no staged tree:

1. **One case per refusal SENTENCE** — fourteen cases over ten rules (B1, B2, R1×3, R2, R3, R4, R5,
   R6, R7×3, R8), each asserting the frozen sentence verbatim. The counts differ because three rules
   have more than one sentence: R1 by what is wrong with the name, and R7 by whether the offending
   key is Claude Code's, a body token, or one DorkOS does not know (§8).
   _Seeded defect, per rule:_ delete that rule's branch and its case or cases red. The PR shows ten
   runs, one branch removed each time — the mutation discipline, not a claim that the file is new.
2. **The allowlist from both sides.** `context: fork` refused; `hooks:` refused; a clean frontmatter
   with `${CLAUDE_PLUGIN_ROOT}` in the body refused; base fields only moved; `allowed-tools` alone
   moved.
   _Seeded defect, and the one that proves the design:_ build the same `hooks:` case against a
   predicate reading the **parsed** frontmatter and watch it pass, because `SkillFrontmatterSchema`
   strips the key. That single run is the argument for `readRawFrontmatter` made mechanical.
3. **Ordering.** A candidate that is simultaneously a symlink, at an occupied target, and off the
   allowlist gets R4's sentence — first match wins, and the ladder's order is asserted rather than
   emergent.
4. **`blocked` short-circuits.** With `.agents/` gitignored, a plan over six candidates has zero
   moves, zero refusals, and one `blocked`. _Seeded:_ turn B2 into a per-candidate refusal and the
   count assertion reds.
5. **Auto mode is strictly narrower than explicit.** Over the same candidate set, `mode: 'auto'` in an
   agent home plans a subset of `mode: 'explicit'`'s moves, and never a superset. A property, over a
   generated candidate set.
6. **The candidate set agrees with the status model.** A property over a staged tree: the sources
   `readAdoptCandidates` returns equal the sources `adoptableSkillSources` marks `adoptable`. It
   lives in `apps/server/src/services/harness/__tests__/adoptable-agreement.test.ts`, not in the
   engine package, because the server is the only place that can import both sides. This is what
   makes the deliberate duplication (§1.1) checked rather than trusted.
   _Seeded:_ drop the `alsoCanonical` exclusion from one side and the property reds.

### Slice 2 — apply and CLI

`adopt/__tests__/apply.test.ts`, real temp repositories:

7. **The move.** `.agents/skills/x` holds the same bytes as the source did (a whole-tree content
   hash, not a path list), and `.claude/skills/x` is a symlink whose link text is
   `../../.agents/skills/x`.
8. **The link equals the projection action.** After `applyAdopt`, `checkPlan(repo, project(repo))`
   reports `clean: true`, and the action `applyAdopt` applied deep-equals
   `planAdoptedSkillLink(name)` — the export `planSkill`'s claude-code branch now returns, so the
   equality holds between two callers of one function rather than between two literals that agree
   today. A second case runs `buildPlan` over the post-move tree and asserts its skill action is that
   same value, which is what stops the extraction drifting from `planSkill` later.
   _Seeded:_ hand-roll the link text as an absolute path — `linkMatchesPlan` fails and `clean` goes
   false. This is the test that discharges "the next sync's plan already matches".
9. **The crash between rename and link.** Stub `applyPlan` to throw; assert the source directory is
   back at `.claude/skills/x`, `.agents/skills/x` is absent, and **no other path in the tree
   changed** (whole-tree path-set snapshot, the CLI file's idiom). _Seeded:_ delete the restore and
   the source-path assertion reds.
10. **A conflict at the link target** (a real file at `.claude/skills/x` planted between the two
    steps) restores just the same, and the refusal carries `applySymlink`'s own blocking reason.
11. **A non-Claude root** (staged by hand until DOR-1902 lands): the move happens, **no link is
    left**, `checkPlan` is still clean, and the CLI prints **S15b** rather than S15 — the same
    condition, asserted on both the filesystem and the sentence, so a run cannot promise a link it
    did not make. The `.claude/skills` case in the same file asserts S15. _Seeded:_ plan a link for
    every root and the orphan finders report the new path; print S15 unconditionally and the
    non-Claude case reds on the copy.
12. **`EXDEV`.** Stub `renameSync` to throw it; S10 verbatim, tree unchanged.
13. **Idempotency.** Adopting the same name twice: the second run is R4, and the tree after equals the
    tree after the first (path-set + content hash).

`packages/cli/src/__tests__/harness-adopt.test.ts`, real engine, real temp repo — exit codes paired
with whole-tree snapshots, the idiom `harness-sync.test.ts` established after DOR-678 (an
exit-code-only test "passed throughout the life of the bug", `:217-222`).

**And this is the work that has to teach `snapshotTree` to hash.** Its helper measures the tree's
SHAPE and nothing else, and its own docstring (`harness-sync.test.ts:18`) names the blind spot and
the trigger: "an in-place rewrite of a file that already existed would pass it. No check-mode path
can reach such a rewrite today; **if one ever can, this helper has to start hashing contents**." Two
of adopt's assertions are exactly that case — a `--check` that must write nothing, and a failed move
whose restore has to put the same BYTES back, not merely a path with the same name — so slice 2 adds
the content hash the docstring asked for, and the seeded defect is running the new tests against the
shape-only helper and watching them pass:

14. **The transcript**: success (0), each refusal (1), `--check` (0 when it would move, 1 when it
    would not, **and identical path-set snapshots before and after** so "writes nothing" is measured).
15. **Usage**: bare `dorkos harness adopt` is an error on stderr naming `dorkos harness sync --check`;
    two positionals is an error; `--claude-only` writes one manifest element and every other byte is
    unchanged (byte compare).
16. **`--project`**: run from a different cwd against an absolute path, and the same run from inside
    the repository, produce identical trees.
17. **The J-06 sentence, verbatim**, on a manifest enabling all six tools; then the **same tree** with
    a Claude-Code-only manifest prints **no block at all**. _Seeded:_ hard-code "Codex and Gemini"
    and the second case reds.
18. **Pluralisation**: n=1, n=2, n=3, and `cannotSee` of length 1 and 3.
19. **The row's copy is a template, not a literal.** `SkillsWithHarnessesList.test.tsx` renders an
    adoptable row whose `source` is `.opencode/skills/x` and asserts the sentence says
    `Lives in .opencode/skills.` plus the `--project`-bearing command; the e2e assertion at
    `skills-page.spec.ts:128-130` moves to the new sentence. _Seeded:_ leave `ADOPTABLE_ADVICE` a
    constant and the `.opencode` case reds while the `.claude` one passes — which is the whole
    difference between a literal and a template.
20. **`SRC-10`**: `Provenance` no longer accepts `'adopted'`, and a moved skill's plan action carries
    `provenance: 'authored'`. _Seeded:_ set `'adopted'` on the moved skill's action and the gitignore
    check starts demanding a pattern for a committed skill.

### Slice 3 — the flag, the boot path, the config tables

`apps/server/src/services/harness/__tests__/auto-adopt.test.ts`, real engine, real seeder:

21. **`autoAdopt: false` in an agent home finds candidates and moves none**, and the summary reports
    `adoptableSkills: 3, adoptedSkills: 0`. _This is the report-only claim._ _Seeded:_ make the flag
    default `true` and the tree changes.
22. **`autoAdopt: true` in an agent home** moves only the allowlisted skill; the summary reports
    `adoptableSkills: 3, adoptedSkills: 1`, and the per-workspace line names the other two with
    their absolute-path commands. _Seeded:_ swap the allowlist for a denylist of `context` and
    `paths` — the `hooks:` skill moves and the count reds.
23. **`autoAdopt: true` in a room worktree**: a seeded name is refused with S4, an authored one moves,
    and the moved skill appears in `git status` while its link does not (the `info/exclude` block
    covers `/.claude/skills/` and not `.agents/skills/`).
24. **`autoAdopt: true` in a plain project moves nothing**, and `dorkos harness sync --check` there
    prints S8 exactly once. _Seeded:_ read the flag in `runAutoProjection` — the tree changes and the
    path-set snapshot reds.
25. **The migration**, in `config-manager.test.ts`: a stale config carrying a `harness` section with
    no `autoAdopt`, booted, then **read off disk** — never through `getDot`, which fills the leaf on
    the way out (DOR-1496). _Seeded:_ comment the body out and the on-disk assertion reds.
26. **The three total guards** (`config-disclosure`, `config-write-policy`, `default-verdicts`) go red
    until the field is classified. Those reds _are_ the seeded defect, and the PR shows them.

### Slice 4 — route and page

`apps/server/src/routes/__tests__/harness.test.ts`:

27. **Person-only**: an agent caller gets 403 with the code and S11, asserted against `sync`'s own
    case so the two cannot drift. _Seeded:_ swap `resolveDecisionAuthority` for `trustedCaller` and
    the person-in-a-terminal case reds (DOR-502's shape).
28. **409** with no manifest; **400** for a relative `projectPath` — from the route module's own
    `.refine`, not from `resolveProject`; **404** for one that leads nowhere — from `resolveProject`.
    Each is asserted, because "inherited" is a claim.
29. **200 with a refusal** in the body, not a 4xx.
30. **The lock**: a POST arriving while another holds the repository queues and still answers 200, and
    the returned status describes the tree _this_ apply left. _Seeded:_ recompute the status outside
    the lock and interleave a write.

Client (`SkillHarnessRow.test.tsx`, `SkillsWithHarnessesList.test.tsx`):

31. The button renders only on an `adoptable` row; the confirm names both paths and prints **S14** for a `.claude/skills` candidate and **S14b** for one from any other root; **cancelling calls
    nothing**; a refusal draws its sentence where the advice line was.

E2E (`apps/e2e/tests/harness/skills-page.spec.ts`) — the fixture already stages the exact tree
(`apps/e2e/fixtures/harness-repo.ts`: "The skill kept in `.claude/skills` as a real directory — Codex
cannot see it"):

32. Press the button, confirm, and the row's chips change from "Codex can't see it" to "Codex reads
    it" on the recomputed status, with the summary above the list. _Seeded:_ return the pre-apply
    status from the route and the chip assertion reds.

### Mocking strategy

Real engine and real temp repositories throughout — the `hook-projection-gate` and
`project-agent-workspace` suites are the precedent, and this surface's whole subject is what happens
to files. The two things that are stubbed are the two failures a filesystem will not produce on
demand: `applyPlan` throwing (case 9) and `renameSync` returning `EXDEV` (case 12). The config
manager is stubbed only where it already is (`skills-watcher.test.ts`'s shape).

## Performance Considerations

**The read is one extra open per CANDIDATE, not per skill.** `readAdoptCandidates` reads one
`SKILL.md` for each candidate, and candidates are the small subset of a repository's skills that live
in a harness-native root with no canonical twin — 0 on this repository, 6 on the J-01 fixture. The
body scan for `${CLAUDE_` is a substring search over text already in memory. `inventorySkills`
already opens the same file to read its `frontmatterName`, so the two reads can be folded into one
pass by widening `SkillInventoryEntry` if a measurement ever asks for it; that is deliberately NOT
done here, because DOR-1902 is changing that interface and one extra open of a small file is not
worth coupling the two.

**The boot pass gains one read per adoptable skill per owned workspace.** An agent home holds the
seven-skill pack plus whatever that agent wrote, so the candidate set is single digits and the pass
already yields to the event loop between workspaces. The measured budget the status route works to is
≤150 ms for a whole repository (`specs/harness-sync-status`), and this adds strictly less work than
the inventory it rides on.

**The move is one `rename(2)`**, independent of how large the skill is. That is the performance
argument for the design as much as the correctness one: a staged copy would be O(bytes) and would
scale with a skill's bundled files.

**The route** does what `POST /api/harness/sync` does, minus the sweeps and minus the approval wait:
plan, one rename, one symlink, one status recompute, inside one lock turn.

## Security Considerations

- **It writes only inside the repository, and only into two paths.** `.agents/skills/<name>` and the
  link at the candidate's own root. Both are inside `repoRoot`, and the route resolves `projectPath`
  through `validateBoundaryOrDorkHome` before anything is planned — the same boundary `sync` passes.
- **A hostile path cannot make it throw or make it write outside** (R2). It reuses DOR-1882's
  occupant pre-pass, which computes the blocked set before anything writes; adopt adds its own target
  and every directory on the way to it to that pass rather than checking them separately.
- **The route is person-only** and is not a registered agent capability. If it ever becomes one it is
  `destructive`, because it moves a file a person made — the opposite of `sync`, which only ever
  touches files DorkOS made.
- **`harness.autoAdopt` is `operator-only` in `CONFIG_WRITE_POLICY`**, so an agent cannot use
  `config_patch` to grant DorkOS the right to move a person's files unattended.
- **Nothing reads a home directory.** `packages/harness` keeps no dork-home knowledge;
  `DirectoryOwnership` arrives as an input. The `os.homedir()` ban is untouched and this work adds no
  carve-out.
- **No file content reaches a log, a reason or a response.** The refusals name _keys_
  (`context`, `hooks`) and paths, never values — the same rule the MCP-count work follows for
  `opencode.json`. A test asserts that no value string from a staged `SKILL.md` appears in any
  refusal or log line.
- **The allowlist fails closed.** A frontmatter key nobody has classified is refused, so a field a
  vendor ships tomorrow leaves the skill exactly where it was.

## Documentation

| File                                         | Change                                                                                                                                                                                                                                                                                                                                                           |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `contributing/harness-sync.md`               | A new section, "Adopting a skill somebody's agent wrote", covering the refusal ladder, the allowlist and why it is one, the atomic move and what a crash leaves, and the `adopt --check` exit-code asymmetry. It also gains one line in §10 (Triggers) for the two `autoAdopt` consultation sites, and one in §11 for `--claude-only` writing `claudeOnlySkills` |
| `contributing/INDEX.md`                      | The freshness row for `harness-sync.md` is re-stamped                                                                                                                                                                                                                                                                                                            |
| `contributing/configuration.md`              | One row in the Settings Reference table for `harness.autoAdopt`, plus a short narrative section beside `harness.autoSync`'s                                                                                                                                                                                                                                      |
| `docs/getting-started/configuration.mdx`     | The same row, mirrored — the pairing `check-docs-changed.sh` already watches                                                                                                                                                                                                                                                                                     |
| `docs/guides/action-approvals.mdx`           | The list of settings with no screen gains `dorkos config set harness.autoAdopt`, beside `harness.autoSync`                                                                                                                                                                                                                                                       |
| `meta/harness-sync-capabilities.md`          | SRC-07, SRC-10, J-06 and §14 item 3 rewritten; two new rows, SK-16 and AP-17 (§Contract)                                                                                                                                                                                                                                                                         |
| `plans/harness-sync-test-plan.md`            | §11 line 10 marked done with its slices, and its stale seeded defect corrected                                                                                                                                                                                                                                                                                   |
| `docs/api/openapi.json`                      | Regenerated for the new route (`docs-openapi-check`)                                                                                                                                                                                                                                                                                                             |
| `changelog/unreleased/<id>-harness-adopt.md` | One fragment, user-facing and plain: a skill your agent wrote in one tool's folder can be moved where every agent reads it, with one command or one button, and DorkOS tells you when it will not and why                                                                                                                                                        |

## Implementation Phases

Four slices, in order, each a pull request, each with the bar it has to clear.

### Slice 1 — the planner

**Files.** `packages/harness/src/adopt/{index,types,read,plan,allowlist,refusals}.ts`;
`packages/harness/src/index.ts` (barrel); `packages/harness/src/adopt/__tests__/plan.test.ts`;
`apps/server/src/services/harness/status.ts` (**one word** — `adoptableSkillSources` gains `export`)
and `apps/server/src/services/harness/__tests__/adoptable-agreement.test.ts`, which is where the
equality property has to live because it is the only place that can import both sides.

**Acceptance bar.** `planAdopt` is pure (no `fs` import, enforced by the ESLint no-restricted-imports
shape the FSD rules already use, or by a test asserting the module's import list). All ten refusal
sentences are frozen and asserted verbatim. The allowlist reads raw frontmatter and the
parsed-frontmatter run demonstrably passes the `hooks:` case. `readAdoptCandidates` agrees with
`adoptableSkillSources` as a property. The census stays green.

### Slice 2 — the apply, the CLI, the report

**Files.** `packages/harness/src/adopt/apply.ts`; `packages/harness/src/report/adoptable.ts`;
`packages/harness/src/plan/projector.ts` (`planAdoptedSkillLink` extracted, `planSkill`'s claude-code
branch rewritten to call it); `packages/harness/src/plan/types.ts`, `sources/resolve-roots.ts`,
`packages/shared/src/harness-schemas.ts`, `apps/server/src/services/harness/status.ts` (the
`'adopted'` retirement); `packages/cli/src/harness-adopt-command.ts`,
`packages/cli/src/commands/harness-dispatcher.ts`, `packages/cli/src/harness-sync-command.ts` (the
new block); **the row's copy** —
`apps/client/src/layers/entities/harness/ui/SkillHarnessRow.tsx` with its unit test and
`apps/e2e/tests/harness/skills-page.spec.ts`, which pins the old literal; `docs/api/openapi.json`
regenerated by **both** commands the check compares against —
`pnpm docs:export-api` (root, from the route/schema registry) **and**
`pnpm --filter=@dorkos/site generate:api-docs` (the Fumadocs MDX under `docs/api/api/**`), the pair
`docs-openapi-check.yml:147` and `:153` run; tests as listed.

**The row's copy is slice 2, not slice 4, and the reason is the cut line.** The sentence is the same
sentence the terminal prints, built by the same function, so it belongs with the rest of the
reporting — and putting it here is what makes §7's cut line true: cutting the button still leaves the
row naming the command.

**Acceptance bar.** `checkPlan` is clean immediately after an adopt, and the applied action
deep-equals `planAdoptedSkillLink(name)` — the same export `planSkill` now calls. The crash case
restores and changes nothing else in the tree. The J-06 sentence matches the contract's own wording
byte for byte at n=1, and is absent on a Claude-only manifest. `Provenance` no longer carries
`'adopted'` and the whole monorepo type-checks. `ADOPTABLE_ADVICE` is a template rather than a
literal and the e2e assertion moves with it. SRC-07, SRC-10 and AP-17 flip with cited coverage, and
`capabilities-census.test.ts` passes.

### Slice 3 — the flag, the boot path, the tables

**Files.** `packages/shared/src/config-schema.ts`; `apps/server/src/services/core/config-manager.ts`

- `__tests__/merged-migration-hashes.ts`; `operator/config-disclosure.ts`,
  `operator/config-write-policy.ts`, `safe-defaults/default-verdicts.ts`;
  `packages/shared/src/feedback.ts`; `apps/server/src/services/harness/project-agent-workspace.ts`;
  `apps/server/src/services/rooms/repo/room-worktree-manager.ts`;
  `packages/cli/src/harness-sync-command.ts` (S8); the docs rows.

**Acceptance bar.** With the default (`false`), an agent home reports every candidate and moves none —
the report-only claim, asserted. With `true`, only allowlisted skills move and the summary names both
counts. A `true` in a plain project is inert, and the flag is grep-ably absent from
`runAutoProjection`, `project-on-agent-created.ts` and `skills-watcher.ts`. The migration is verified
on disk and reds with its body removed. All three total guards are classified. §14 item 3's remaining
half is struck through and its tests exist.

### Slice 4 — the route and the row action (cut together, or not at all)

**Files.** `packages/shared/src/harness-schemas.ts` (the body and response schemas);
`apps/server/src/routes/harness.ts`; **the three files a Transport method has to touch, because
`syncHarness` is the sibling and every one of them declares it** —
`packages/shared/src/transport.ts` (`adoptHarness` beside `syncHarness` at `:2107`),
`apps/client/src/layers/shared/lib/transport/harness-methods.ts` (the HTTP half, beside `:23`) and
`apps/client/src/layers/shared/lib/embedded-mode-stubs.ts` (the descriptive throw the file's own
convention requires, beside `:913`); `apps/client/src/layers/entities/harness/ui/SkillHarnessRow.tsx`
(the button and its confirm — the copy already landed in slice 2);
`apps/client/src/layers/entities/harness/model/use-harness-adopt.ts` beside `use-harness-sync.ts`;
`apps/e2e/tests/harness/skills-page.spec.ts`; `docs/api/openapi.json` (both generators, as in
slice 2).

**Acceptance bar.** The 403 shape is asserted against `sync`'s. The lock holds plan + apply + status.
**The response REPLACES the cached status through `queryClient.setQueryData` and nothing is
invalidated** — `use-harness-sync.ts` states the rule at `:11` and does it at `:39`, and its reason
holds here identically: the POST already returns the recomputed status, so an invalidate would throw
away the authoritative answer and race a fresh read against the write. The browser leg presses the
button on the existing fixture and watches the chip change. `knip` is clean — nothing exported and
unused. If the confirm needs more than `AlertDialog` + `Banner`, the whole slice is cut to a
follow-up and this spec's §7 cut line is what the ticket cites.

## Contract and census changes

| Row               | Now                                                                                                                                    | After                                                                                                                                                                                                                                                                               | Coverage cited                                                                                        |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `SRC-07`          | **not built** (adopt: DOR-174 task 3.2)                                                                                                | **built** (DOR-1853) — the harness-native asset has a path back to canonical, and every sync and boot summary names the ones that have not taken it                                                                                                                                 | `adopt/__tests__/plan.test.ts`, `apply.test.ts`, `cli/__tests__/harness-adopt.test.ts`                |
| `SRC-10`          | **not built**; `U` pins `adopted` as ephemeral                                                                                         | **built, and the third provenance is retired**: adoption produces an `authored` skill, `Provenance` is `'authored' \| 'installed'`, and the value that could only ever have been wrong is gone                                                                                      | `apply.test.ts` (`provenance: 'authored'` on the moved skill), the compiler on the `satisfies` table  |
| `J-06`            | Actual: "What is still missing is the MOVE"                                                                                            | Actual: the move exists; **Expected loses "In a DorkOS-owned directory … the move happens on its own"**, which is the pre-round-two draft of D3 and contradicts the position the ticket settles                                                                                     | `cli/__tests__/harness-adopt.test.ts` (the sentence), `services/harness/__tests__/auto-adopt.test.ts` |
| **`SK-16`** (new) | —                                                                                                                                      | **built**: a skill is safe to share automatically only when its frontmatter holds nothing outside the agentskills.io base fields and its body carries no `${CLAUDE_…}` token — read raw, never parsed                                                                               | `adopt/__tests__/plan.test.ts` (both sides, plus the parsed-reader run)                               |
| **`AP-17`** (new) | —                                                                                                                                      | **built**: adopting a skill is one `rename(2)` plus the projection the planner already plans; a failure restores, and a crash between them leaves the skill whole at the canonical root with a projection the next sync makes                                                       | `adopt/__tests__/apply.test.ts`                                                                       |
| §14 item 3        | "What is left is the OTHER direction: a Claude-made skill still misses Codex and Gemini forever and nothing reports it (SRC-07, J-06)" | Struck through — closed by DOR-1853, which reports it everywhere and gives it one command                                                                                                                                                                                           | assertion 6 of the census requires a test title per id                                                |
| §16 D3            | §16's preamble says of all five positions "None is settled by this file"                                                               | D3 gains "**Settled and SHIPPED (DOR-1853)**" — the shape **D2** uses, and the only entry using it today; D4's own update is worded differently — plus the two clauses the code corrected (§Deviations 4 and 10). The preamble is left alone: it is about the section, not about D3 | —                                                                                                     |

`SK-16` and `AP-17` are the next free ids in their families today (`SK` runs to 15, `AP` to 16). The
ids are not load-bearing and the rows are: if DOR-1902 has taken one by the time this lands, take the
next free one and retitle the tests, which is what census assertion 5 exists to catch.

Census floors move, and **six** of the nine are touched rather than two: `rows` (≥ 86) by +2,
`titles` (≥ 590) by the number of new cases, `claiming` (≥ 50) by +2 since both new rows claim
coverage, `built` (≥ 45) by +2, `idsInTitles` (≥ 73) by +2, and `closed` (≥ 12) by +1 for §14 item 3.
Every one is a `toBeGreaterThanOrEqual`, so none of them BREAKS — which is exactly why they are
listed: a floor nobody raises is a floor that stops meaning anything. Every new test title carries its
row id as a prefix (`it('SRC-07: …')`), which is the retitle convention assertion 5 enforces.

## Decisions

Every open question this stage raised, resolved with its reason. The operator delegated; nothing
below waits on an answer. Each is stated inline in the section that needs it and collected here so a
reader can hold one list.

| #   | Question                                                                          | Decision                                                                                                                                                             | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Where the engine lives, and what shape it has                                     | `packages/harness/src/adopt/` — a filesystem reader, a **pure** planner, an apply, and the allowlist alone in its own file                                           | A **deliberate departure** from `buildPlan`, which is not pure — it calls `scanSkills(repoRoot)` at `projector.ts:450` — and the departure is the point: a refusal table of eight rules has to be provable rule by rule, so every case is a fixture instead of a staged tree. The allowlist alone in one file is the greppable answer to "what does DorkOS think is safe to share"                                                                    |
| 2   | Whether the refusal table is per-candidate or per-run                             | Both. Two run-level `blocked` reasons, eight per-candidate `refusals`                                                                                                | A gitignored `.agents/` and an `autoAdopt` in the wrong place are facts about the directory. Printing either once per candidate buries the six things a person could act on                                                                                                                                                                                                                                                                           |
| 3   | The refusal order                                                                 | Run-level first (B1 then B2), then R1 → R8, first match wins                                                                                                         | Most fundamental first: what makes the run impossible, then what makes the filesystem operation impossible, then what makes the _result_ wrong. Asserted by a test rather than left emergent                                                                                                                                                                                                                                                          |
| 4   | The allowlist's contents                                                          | The six agentskills.io base fields: `name`, `description`, `license`, `compatibility`, `metadata`, `allowed-tools`                                                   | They are layer 1 of `SkillFrontmatterSchema`, which the codebase already names in one place. Layers 2 and 3 are exactly the things another tool does not implement                                                                                                                                                                                                                                                                                    |
| 5   | `allowed-tools`: in or out                                                        | **In**                                                                                                                                                               | A base field of the open standard. A value naming a tool a given harness lacks is already a `warned` cell a person is shown, not a breakage                                                                                                                                                                                                                                                                                                           |
| 6   | `hooks`: in or out                                                                | **Out**, and it is the reason the predicate reads raw frontmatter                                                                                                    | `SkillFrontmatterSchema` strips it, Claude Code runs it, and `inventory/hooks.ts` reads it (HK-12). A parsed-object predicate would move a file that runs shell commands                                                                                                                                                                                                                                                                              |
| 7   | `context` / `disable-model-invocation` / `paths`: in or out                       | **Out**, all three                                                                                                                                                   | Claude Code dialect. `context: fork` loses its isolation, `disable-model-invocation: true` is a person's decision the move would override, and `paths` loses its scoping and becomes always-eligible                                                                                                                                                                                                                                                  |
| 8   | `schedule`: in or out                                                             | **Out**, and it is the one with a running consequence                                                                                                                | The scheduler watches `.agents/skills` and `<dorkHome>/skills`, and never `.claude/skills` (`skills-roots.ts:30-53`). Auto-adopting a scheduled skill starts a timed job nobody asked for                                                                                                                                                                                                                                                             |
| 9   | Which frontmatter the predicate reads                                             | The **raw** frontmatter (`readRawFrontmatter`), never `parseSkillFile`'s output                                                                                      | Parsing strips unknown keys and swallows unreadable values — both correct for their own callers and catastrophic here. Decision 6 is the measured case                                                                                                                                                                                                                                                                                                |
| 10  | Whether R7 is a warning-plus-`--force` or a hard refusal                          | **Hard, in both modes**, with no `--force`                                                                                                                           | The exposure is one-way and `manifest.claudeOnlySkills` cannot un-expose a moved skill (SK-04 fires after the move). The two ways out — declare it, or edit the file — are both reviewable and both reversible                                                                                                                                                                                                                                        |
| 11  | What `--claude-only` does                                                         | Records the name in `manifest.claudeOnlySkills` and moves nothing                                                                                                    | It is the true answer to the question R7 asks, and SK-04 already governs the state it produces end to end. One flag, one meaning                                                                                                                                                                                                                                                                                                                      |
| 12  | `--claude-only` on a non-Claude root                                              | Refused (R8, S9)                                                                                                                                                     | The manifest key is named for Claude Code and every one of SK-04's five states is about `.claude/skills`                                                                                                                                                                                                                                                                                                                                              |
| 13  | Whether the move stages and backs up like the marketplace transaction             | **No staging, no backup** — but the same discipline: refuse rather than overwrite, one mutating step, restore on failure, a lock at the surface that has one         | The marketplace stages because it _builds_ content and backs up because it _overwrites_. Adopt does neither: R4 refuses an occupied target, and the content already exists and is whole. Staging would cost two copies, a non-atomic step and lost modes to close a window `rename(2)` does not have                                                                                                                                                  |
| 14  | What a crash between the move and the link leaves                                 | The skill whole at `.agents/skills/<name>`, no link, nothing lost                                                                                                    | Five of six tools read it there already, and the missing link is exactly the action `planSkill` plans on every later run — so the next sync, watcher event, boot pass or button finishes it. The state is drift, which this engine names and fixes                                                                                                                                                                                                    |
| 15  | `EXDEV`                                                                           | Refused with S10, never a copy                                                                                                                                       | A copy is not atomic, and a half-copied skill is the one state this design promises never to leave                                                                                                                                                                                                                                                                                                                                                    |
| 16  | Which roots get a link back                                                       | Only `.claude/skills`                                                                                                                                                | Every other root's owner already lists `.agents/skills` in its documented read paths. A link elsewhere would be a path DorkOS wrote that no plan names — an orphan by construction                                                                                                                                                                                                                                                                    |
| 17  | How the link is created                                                           | By handing `planSkill`'s own action to `applyPlan` — narrowed to `claude-code`, sweeps off                                                                           | It makes "the next sync's plan already matches" true by construction, and inherits the Windows junction, the occupant checks and the clone-without-symlinks story instead of repeating them                                                                                                                                                                                                                                                           |
| 18  | Whether `Provenance`'s `'adopted'` survives                                       | **Retired**                                                                                                                                                          | A moved skill is plain `authored`. Worse than unused, the value is wrong: `isEphemeralProvenance('adopted')` is `true`, so anything setting it would tell a person to gitignore a skill they just committed. Four references, all measured                                                                                                                                                                                                            |
| 19  | What "permitted" means for `autoAdopt`                                            | Accepted at write time; acted on at exactly two call sites, both of which have already established DorkOS owns the directory                                         | One global boolean has no project in hand at write time, so a write-time refusal would refuse it for the agent homes it is for. Two sites rather than five checks means a `true` elsewhere is inert by construction                                                                                                                                                                                                                                   |
| 20  | Where a person learns a `true` did nothing                                        | `dorkos harness sync` prints S8 once, in a directory DorkOS does not own                                                                                             | The terminal is where somebody who set the flag looks. The CLI already reads the config and resolves the dork home                                                                                                                                                                                                                                                                                                                                    |
| 21  | The migration key                                                                 | **Chosen at merge as the next value above the table's highest key — contiguous, never a reserved gap.** `'0.76.0'` as of writing; `'0.77.0'` if DOR-1857 lands first | A reserved gap is silently fatal: `conf` skips any key `lte` the stored version (`conf@15.1.0/dist/source/index.js:534`) and stamps the store with the APP version after the loop (`:494-495`), so shipping `'0.77.0'` while `'0.76.0'` was unmerged would make `'0.76.0'` unreachable on every install for ever. `contributing/configuration.md:399`/`:586` and `adding-config-fields` state the rule; contiguity is what satisfies it without a gap |
| 22  | Whether `autoAdopt` is an experiment                                              | **No registry entry**                                                                                                                                                | The registry is for a staged opt-in awaiting graduation and every entry needs a `graduationIssue`. This is a permanent posture — D3 says off everywhere, for good                                                                                                                                                                                                                                                                                     |
| 23  | Whether `autoAdopt` needs a carryover rule                                        | **No `PROTECTED_STATE` entry**                                                                                                                                       | Carryover protects a tightening from a wipe. The default _is_ the tight value here; `harness.autoSync` needs one because it defaults ON                                                                                                                                                                                                                                                                                                               |
| 24  | Whether the row's advice line narrows to "some enabled tool cannot see it"        | **No** — unchanged firing, and it gains the command                                                                                                                  | The row's line makes no claim about any tool, so it is true whatever is enabled. The headline _does_ name tools, so the headline is computed and withheld when the list is empty                                                                                                                                                                                                                                                                      |
| 25  | Whether the CLI's own printed command carries `--project`                         | No; the **server's** printed commands always do, absolutely                                                                                                          | The CLI ran in the repository, so a bare command is right there and is the contract's own sentence. A `.` in a server-printed string resolves against whatever directory the reader is in                                                                                                                                                                                                                                                             |
| 26  | `adopt --check`'s exit code                                                       | `0` when it would move, `1` when it would be refused — the opposite of `sync --check`                                                                                | They ask different questions: "is my tree in sync?" versus "will this command work?". Stated in the help and the guide because it is what a script author trips over                                                                                                                                                                                                                                                                                  |
| 27  | Whether a bare `dorkos harness adopt` does something                              | Usage error, naming `dorkos harness sync --check`                                                                                                                    | A bare adopt that acted would be one keystroke from the multi-adopt this spec deliberately does not ship                                                                                                                                                                                                                                                                                                                                              |
| 28  | Whether the route ships in v1                                                     | **Yes**, in the same slice as the page action, so neither lands alone                                                                                                | The app is the primary surface, and a route with no caller is dead code by this repository's standard. Cutting the page cuts the route, leaving the CLI as a coherent product                                                                                                                                                                                                                                                                         |
| 29  | Whether the Skills page gets a button, against DOR-1894's stated "no button (D3)" | **Yes**, behind a confirm naming both paths                                                                                                                          | Half of that comment's reason was that no verb existed. The other half is answered: the button does not move anything, it discloses first — the same shape the sweep gets before the Sync button acts                                                                                                                                                                                                                                                 |
| 30  | A refusal's HTTP status                                                           | `200` with the refusal in the body                                                                                                                                   | Refusals are answers carrying their own way out, and the page has one place to draw the sentence. A `404` for one of eight would make the page special-case it                                                                                                                                                                                                                                                                                        |
| 31  | The route's capability tier if it is ever offered to agents                       | `destructive`, not `act`                                                                                                                                             | `sync` touches only files DorkOS made; adopt moves a file a person made. That is the whole difference                                                                                                                                                                                                                                                                                                                                                 |
| 32  | Where `DirectoryOwnership` is decided                                             | By the caller, never by the engine                                                                                                                                   | `packages/harness` keeps no dork-home knowledge, which is what lets one engine run offline in a terminal and inside the server                                                                                                                                                                                                                                                                                                                        |
| 33  | Whether `dorkos harness sync` gains `--project` too                               | No                                                                                                                                                                   | A shipped command with its own tests and its own contract ("acts on the folder you run it in"). Changing it is a separate decision                                                                                                                                                                                                                                                                                                                    |
| 34  | Ordering against the two in-flight tickets                                        | After **DOR-1882** and **DOR-1902**                                                                                                                                  | 1902 changes `SkillRoot` from two members to five and the whole refusal table is keyed on it; 1882 adds the occupant pre-pass whose sentences adopt reuses rather than inventing a seventh voice for the same file                                                                                                                                                                                                                                    |

## Deviations from the brief, the contract and the plan

Where a document and the code disagreed, the code won and the disagreement is recorded here.

| #   | What was said                                                                                                                                                                                                                                                                                                                                                                                                                           | What the code holds                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | What this spec does                                                                                                                                                                                                                                                                                                                                                           |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | The brief calls `--project` part of "the sibling command's shape"                                                                                                                                                                                                                                                                                                                                                                       | `dorkos harness sync` has **no** `--project`. It parses `check/fix/harness/strict/allow-hooks/enable/global/write-gitignore` with `allowPositionals: false` and acts on `process.cwd()`; the dispatcher's help says "Sync acts on the folder you run it in"                                                                                                                                                                                                                                                                                   | `adopt` introduces `--project`, resolved by the CLI against its own cwd. `sync` is untouched (Decision 33)                                                                                                                                                                                                                                                                    |
| 2   | "DOR-1921/1922 learned `--project .` resolves against the SERVER's cwd"                                                                                                                                                                                                                                                                                                                                                                 | True, and it is about **server-bound** commands. `plan/global-installs.ts` states it for `dorkos install`/`uninstall`, which forward the flag verbatim to a server that resolves it against its own working directory                                                                                                                                                                                                                                                                                                                         | Adopt is offline, so a `.` would be harmless _for the command_. Every string DorkOS **prints** still carries the absolute root, because a pasted command must mean the same thing from anywhere (Decision 25)                                                                                                                                                                 |
| 3   | The brief: "the next key is `'0.76.0'` unless `'0.75.0'` is still unreleased" — and this spec's own second draft answered `'0.77.0'`, reserving a gap because `harness-sync-global` §2.3 claimed `'0.76.0'` first                                                                                                                                                                                                                       | `'0.75.0'` is merged (DOR-1849) and frozen. But a **reserved gap is unsafe**: `conf` skips a key `lte` the stored version (`conf@15.1.0/dist/source/index.js:534`) and stamps the app version after the loop (`:494-495`), so a release carrying `'0.77.0'` without `'0.76.0'` makes `'0.76.0'` unreachable for ever                                                                                                                                                                                                                          | The key is chosen **at merge**, contiguous with the table's highest — `'0.76.0'` today, `'0.77.0'` if DOR-1857 lands first (Decision 21). The "conf does not read file order" sentence is deleted: order was never the question, contiguity is                                                                                                                                |
| 4   | The brief: the move must have "the stage → backup → rename → restore shape"                                                                                                                                                                                                                                                                                                                                                             | The marketplace transaction stages because it builds content and backs up because it overwrites. Adopt refuses an occupied target and moves content that already exists                                                                                                                                                                                                                                                                                                                                                                       | No staging, no backup; the same discipline otherwise (Decision 13). The reason is written into the module docs so the next reader does not re-add them                                                                                                                                                                                                                        |
| 5   | J-06's **Expected** column: "In a DorkOS-owned directory (an agent home, a room worktree) the move happens on its own and the output says so"                                                                                                                                                                                                                                                                                           | That is D3's **pre-round-two** draft. Round two took the last step to report-only everywhere, DorkOS-owned directories included, and the ticket restates it                                                                                                                                                                                                                                                                                                                                                                                   | The J-06 row's Expected column is corrected in this work, not just its Actual                                                                                                                                                                                                                                                                                                 |
| 6   | `plans/harness-sync-test-plan.md` §11 line 10's seeded defect: "J-06: `unmanaged` is empty on a repo with a real dir in `.claude/skills`"                                                                                                                                                                                                                                                                                               | `unmanaged` shipped in DOR-1891…1896. That assertion is **green on `main`** today                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Each slice names its own seeded defect, and the plan line is corrected                                                                                                                                                                                                                                                                                                        |
| 7   | `SkillHarnessRow.tsx:53-54`: "no button, because moving a file out from under a person's editor is not something a side panel should offer (D3)"                                                                                                                                                                                                                                                                                        | Half that reason was that no verb existed to offer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | The button ships behind a confirm; the comment is rewritten to say what it now decides (Decision 29)                                                                                                                                                                                                                                                                          |
| 8   | The `adding-config-fields` skill's checklist                                                                                                                                                                                                                                                                                                                                                                                            | It lists `CONFIG_DISCLOSURE` and `CONFIG_WRITE_POLICY` but **not** `safe-defaults/default-verdicts.ts`, whose guard is equally total over `UserConfigSchema` leaves and will red until the field is classified                                                                                                                                                                                                                                                                                                                                | The verdict is specified (`safe`), and the skill's omission is filed as a follow-up                                                                                                                                                                                                                                                                                           |
| 9   | `specs/harness-sync-status` §1.5: "`.opencode/skills` and `.cursor/skills` are not inventoried … widening the inventory is a follow-up"                                                                                                                                                                                                                                                                                                 | DOR-1902 **is** that follow-up and lands first                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Adopt is written against `SkillRoot` — the union — from the first line, never against `.claude/skills`                                                                                                                                                                                                                                                                        |
| 10  | The brief left open whether `'adopted'` survives                                                                                                                                                                                                                                                                                                                                                                                        | Four references, and `isEphemeralProvenance('adopted') === true` is actively wrong for a skill landing in the committed canonical layer                                                                                                                                                                                                                                                                                                                                                                                                       | Retired (Decision 18). ADR-0303's third source class is untouched — the _class_ is the act; the act produces an `authored` skill                                                                                                                                                                                                                                              |
| 11  | This spec's own first draft said `buildPlan` is pure, `snapshotTree` hashes contents, `.agents/skills` is the scheduler's only root, skill-frontmatter hooks are HK-14, a `claudeOnlySkills` entry has two fields, and the drop line carries that entry's `reason`                                                                                                                                                                      | Every one is wrong: `buildPlan` calls `scanSkills(repoRoot)` (`projector.ts:450`); `snapshotTree` is shape-only and its own docstring says when it must start hashing (`harness-sync.test.ts:18`); the scheduler watches `<dorkHome>/skills` too (`skills-roots.ts:30-53`); frontmatter hooks are **HK-12**; `ClaudeOnlySkillSchema` is `.strict()` with a required `reason` (`manifest/schema.ts:25-31`); and the drop line is the fixed `CLAUDE_ONLY_DROP_REASON` (`projector.ts:124-125`), with the entry's `reason` stored and never read | All six corrected in place, by an adversarial fact-check of this document against the source before it was frozen. The last one is filed as a follow-up: a required manifest field nothing surfaces is the shape DOR-1858 retired four keys for                                                                                                                               |
| 12  | This spec's own first draft said `'adopted'` had four references and that no route had ever served it                                                                                                                                                                                                                                                                                                                                   | Five code references and seven doc comments, and the enum IS published in the generated wire contract at `docs/api/openapi.json:211` and `:51220`                                                                                                                                                                                                                                                                                                                                                                                             | §1.8's table is the measured list, and `docs/api/openapi.json` moves into slice 2                                                                                                                                                                                                                                                                                             |
| 13  | The brief: `POST /api/harness/adopt` "mirrors `sync`", person-only, project-locked                                                                                                                                                                                                                                                                                                                                                      | It does, with one honest difference: `sync` sweeps and adopt does not, so adopt takes no `sweepOrphans` and `applyPlan` throws if a narrowed plan ever asks for one                                                                                                                                                                                                                                                                                                                                                                           | Stated, and the throw is named as the backstop rather than a rule to remember                                                                                                                                                                                                                                                                                                 |
| 14  | This spec's second draft, and D3 itself, said the non-destructive shape (leave the directory, link into it from `.agents/skills`) was impossible "with SK-13 unfixed", and attributed R5 to SK-13                                                                                                                                                                                                                                       | **SK-13 is built** (contract row `:127`, DOR-1844/1845): `scanSkillDirs` follows a symlinked source, so the reverse shape works today                                                                                                                                                                                                                                                                                                                                                                                                         | The move still wins, on three stated grounds rather than on impossibility (§1.3): the reverse link inverts which root is canonical, AP-15 bites the other way round, and `.agents/skills` would grow a fourth ownership rule. R5 is re-attributed to its own reason, which is S6's                                                                                            |
| 15  | The review round found six more in this document: `planSkill` is module-private and takes a `SkillEntry` a pre-move skill cannot produce; `adoptableSkillSources` is private and lives in `apps/server`; a reserved migration-key gap is silently fatal under `conf`; S8's `{name}` has no value where it prints; §4b named `projectAgentWorkspace` for a line its CALLER has to write; and S13 called a hard-coded literal "unchanged" | Each verified at the source now cited in §1.1, §1.6, §3.4, §4b, §4c and §8                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | All six corrected, and each produced a design decision rather than a wording change: a shared `planAdoptedSkillLink` export, an `export` on `adoptableSkillSources` with the property sited in the server, a contiguous merge-time key, `<name>` in the run-level sentence, the per-workspace loop that owns `agentDir`, and the row's literal becoming a template in slice 2 |

## Open Questions

None. Every question this stage raised is resolved above with its reason.

## Follow-ups to file

1. **`adding-config-fields` omits `default-verdicts.ts`** from its step list, though that guard is
   total over `UserConfigSchema` leaves and reds on any unclassified field. One step, between the
   current steps 4 and 5.
2. **Adopting hooks** — ADR-0303 says lossy and deferred; this is the ticket that either does it or
   records why it never will.
3. **Adopting commands** — same clause.
4. **Adopting instructions** (`CLAUDE.md` → `AGENTS.md`, IN-06) — explicit by D3, and a merge rather
   than a move.
5. **Undo** — `dorkos harness unadopt <name>`, or a decision that the link left behind is enough.
6. **Multi-select adopt** — only if the refusal ladder can stay readable at n>1, which is the reason
   it is out here.
7. **Projecting subagents, rules and MCP servers** — the kinds §8 makes visible and nothing projects.
8. **`manifest.claudeOnlySkills[].reason` is required and never surfaced.** Every entry must carry
   one (`ClaudeOnlySkillSchema` is `.strict()`), and no drop line, warning, status cell or log line
   ever reads it — the drop reason is the fixed `CLAUDE_ONLY_DROP_REASON`. That is a field validated
   and unread, the shape DOR-1858 retired four manifest keys for. Either surface it beside the fixed
   sentence or make it optional; both are manifest-compatibility decisions and neither belongs in
   this work.

## Related ADRs

- **`0303-harness-sync-multi-source-projection.md`** — the parent. Its third clause ("agent-native
  assets — promoted to canonical only via an **explicit, reviewable `dorkos harness adopt`** (skills
  - instructions in v1), never automatically") is what this work amends.
- **`260909-085610-adoption-is-explicit-everywhere-and-automatic-only-behind-an-allowlist.md`** — the
  amendment this spec seeds (`amends: 0303`, `status: proposed` until the slice-3 pull request flips
  it — slice 3 is the last one its Decision describes).
- **`260908-191538-global-scope-projection-is-skills-only-and-symlinked.md`** — the other proposed
  amendment to 0303, and the shape this one follows. It narrows a different clause; the two do not
  overlap.
- **`260908-085032-one-status-model-answers-for-the-app-and-the-terminal.md`** — why `unmanaged` is a
  row-level fact rather than a per-tool cell, which is why adopt's advice is one line and not six
  chips.
- **`0301`** (vendored maps — DorkOS owns the projector, so adding a source is our choice),
  **`0302`**, **`260706-192819`**, **`260823-200728`** (Claude Code's frontmatter dialect adopted
  verbatim — the reason layers 2 and 3 of `SkillFrontmatterSchema` exist to be excluded here),
  **`0229`** (the `kind` discriminator), **`0220`** (the agentskills.io standard this allowlist is
  layer 1 of).

## References

- `meta/harness-sync-capabilities.md` — §16 D3, rows SRC-06/07/10/11, SK-04/07/13, AP-15, VC-01,
  J-06, §14 items 3 and 11.
- `plans/harness-sync-test-plan.md` — §0 (the bar), §6 ("Adopt tests, once D3 lands"), §11 line 10.
- `specs/harness-sync-status/02-specification.md` — §1.5 (`unmanaged`, exactly), the row layout, the
  banner table.
- `specs/harness-sync-global/02-specification.md` — §2.3 (the `'0.76.0'` claim), and the Decisions
  table style this one follows.
- `contributing/harness-sync.md` — §8 (concurrency, and what is not guaranteed across processes),
  §10 (triggers), §11 (the manifest key by key), §12 (the status model).
- `contributing/configuration.md`, `.claude/skills/adding-config-fields/SKILL.md`,
  `.claude/skills/writing-adrs/SKILL.md`, `.claude/skills/writing-for-humans/SKILL.md`.
- Code read for this spec: `packages/harness/src/{inventory,plan,apply,sources,vendor-facts,report}/`,
  `packages/skills/src/{schema,parser}.ts`, `packages/operating-skills/src/pack.ts`,
  `packages/cli/src/{harness-sync-command.ts,commands/harness-dispatcher.ts}`,
  `apps/server/src/{routes/harness.ts,services/harness/*,services/marketplace/transaction.ts,services/rooms/repo/room-worktree-manager.ts,services/core/config-manager.ts,services/core/operator/*,services/core/safe-defaults/*}`,
  `apps/client/src/layers/entities/harness/`, `packages/shared/src/{config-schema,harness-schemas,feedback}.ts`.
- Tickets: **DOR-1853** (this), **DOR-1882** and **DOR-1902** (both in flight on these files),
  DOR-1857 (global scope), DOR-1849 (`'0.75.0'`), DOR-1891…1896 (the status surface), DOR-174
  (cancelled; re-scoped by this).
