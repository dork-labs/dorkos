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
sixth still finds it. It refuses, with one plain sentence and a way out, in six situations where the
move would cost more than it gives. A new `harness.autoAdopt` setting — off everywhere, permitted
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
and `resolveSourceRoots` never returns an `'adopted'` root — the value has one reference outside its
own declaration, a test asserting it counts as ephemeral.

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
| `conf` v15.1.0 + `UserConfigSchema`                                          | `harness.autoAdopt` and its `'0.77.0'` migration (§3)                                                  |
| **DOR-1882** (in flight)                                                     | `applyPlan`'s block-and-report occupant checks, whose frozen sentences adopt reuses for a hostile path |
| **DOR-1902** (in flight)                                                     | `SkillRoot` becomes a union of five roots; adopt is written against the union from the first line      |

**Ordering.** This lands **after DOR-1882 and DOR-1902**, both of which are in flight on the same
files. DOR-1902 changes `SkillRoot` from a two-member union to a five-member one and adopt's whole
refusal table is keyed on it; DOR-1882 adds the occupant pre-pass whose sentences adopt reuses rather
than inventing a seventh voice for the same file. Landing before either means writing code against a
shape that is about to change and then rewriting it.

## Detailed Design

### 0. What ships, in four slices, and what each flips

| Slice | What lands                                                                                            | Contract cells it flips                                                                                  |
| ----- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| **1** | `packages/harness/src/adopt/` — the reader and the pure planner, the refusal ladder, the allowlist    | `SK-16` (new) → `built`                                                                                  |
| **2** | `applyAdopt`, `dorkos harness adopt`, the sync report's new block, `Provenance`'s `'adopted'` retired | `SRC-07` → `built`; `SRC-10` → `built` (retired value); `AP-17` (new) → `built`; `J-06` Actual rewritten |
| **3** | `harness.autoAdopt`, its migration and four classification tables, the two consultation sites         | `D3` implemented; §14 item 3's remaining half struck through                                             |
| **4** | `POST /api/harness/adopt` and the Skills page row action                                              | `VC-01`'s Actual gains the action                                                                        |

Each slice is a pull request. Slice 1 ships no user surface on its own and is landed separately so
the refusal ladder and the allowlist can be reviewed without a CLI transcript in the way; slices 2, 3
and 4 each ship one thing a person can use, and each is useful with the later ones absent. Slice 4 is
last on purpose (§7 states its cut line).

### 1. The engine unit — `packages/harness/src/adopt/`

#### 1.1 Two halves, because a pure planner cannot read a disk

`engine.ts` already sets the precedent: `buildPlan` stays pure and `scanClaudeOnlySkills` answers the
filesystem question for it. Adopt splits the same way.

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
rather than importing them: that function lives in `apps/server`, and `packages/harness` cannot
import the server. A property test holds the two answers equal on a staged tree
(§Testing, slice 1), so the duplication is checked rather than trusted.

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
  /** Whether the source directory is itself reached through a symlink (SK-13). */
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
| R5  | `source-is-symlink`      | `isSymlink` (SK-13)                                                                                                                                                             |
| R6  | `unreadable-frontmatter` | `unreadable`                                                                                                                                                                    |
| R7  | `not-on-allowlist`       | The allowlist predicate says no. **Hard in both modes** — see §2 for why there is no `--force`                                                                                  |
| R8  | `claude-only-wrong-root` | `--claude-only` on a candidate whose root is not `.claude/skills`                                                                                                               |

**B1 before B2**, because a person who set `autoAdopt` in a repository DorkOS does not own should be
told _that_, not sent to edit a `.gitignore` for a run that was never going to happen.

**R2 before R3–R6**, because a hostile path is the only one where the _check itself_ is what
prevented a throw. DOR-1882's pre-pass computes the blocked set before anything writes, and adopt
sits inside that discipline rather than beside it.

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
(`inventory/hooks.ts`, `origin: 'skill-frontmatter'`, contract HK-14). The schema strips it. A
predicate built on the parsed object therefore sees a clean six-key skill and moves a file that runs
shell commands. The raw reader is what makes clause 1 mean what it says.

**Each field a person might expect, and where it lands:**

| Field                                                                                        | In / out                                     | Why                                                                                                                                                                                                                                                     |
| -------------------------------------------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`, `description`                                                                        | **in**                                       | Required by the standard; every tool reads both                                                                                                                                                                                                         |
| `license`, `compatibility`, `metadata`                                                       | **in**                                       | Standard, descriptive, no behaviour                                                                                                                                                                                                                     |
| `allowed-tools`                                                                              | **in**                                       | A base field of the standard. Its _values_ may name a tool a given harness lacks — which is already a `warned` cell on the Skills page ("its frontmatter names a tool Codex does not have"), a thing a person is shown rather than a thing that breaks  |
| `hooks`                                                                                      | **out**                                      | Not in the schema at all, so the parsed object hides it. Claude Code runs it. Nothing else has skill-scoped hooks. This is the field the raw reader exists for                                                                                          |
| `context` (`fork`), `agent`, `background`                                                    | **out**                                      | Claude Code's subagent-forking dialect; no other tool has the concept, so a moved skill silently loses its isolation                                                                                                                                    |
| `disable-model-invocation`, `user-invocable`                                                 | **out**                                      | Claude Code dialect adopted verbatim. `disable-model-invocation: true` is a person saying the model must not reach for this on its own; handing the file to five tools whose handling of the key is undocumented overrides that decision without asking |
| `paths`                                                                                      | **out**                                      | Claude Code's glob-scoped auto-load. No other tool documents it, so a moved skill loses its scoping and becomes always-eligible — a behaviour change nobody asked for                                                                                   |
| `model`, `effort`, `shell`, `argument-hint`, `arguments`, `display-name`, `disallowed-tools` | **out**                                      | The rest of layer 2, same class                                                                                                                                                                                                                         |
| `schedule`                                                                                   | **out**, and the consequence is running code | `.agents/skills` is the only skills root the DorkOS scheduler watches (DOR-1518). Auto-adopting a scheduled skill turns a dormant file into a job that runs on a timer with nobody asked                                                                |
| `kind`                                                                                       | **out**                                      | A marketplace-author discriminator (ADR-0229), not part of the open standard. Widening the list "because it is harmless" is the first step of the slide D3 refuses                                                                                      |

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

The link is **not hand-rolled**. `move.link` is byte-for-byte what `planSkill(harness:
'claude-code', …)` returns for the moved skill (`plan/projector.ts:117-119`):

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
applied action deep-equals `planSkill`'s own return value for that skill. Nothing else in the plan
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

The blast radius is four references, measured:

| File                                                              | Change                                                                                                                                                        |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/harness/src/plan/types.ts:42`                           | `Provenance` becomes `'authored' \| 'installed'`                                                                                                              |
| `packages/harness/src/sources/resolve-roots.ts`                   | Two doc sentences lose "and adopted"; the function body is unchanged                                                                                          |
| `packages/shared/src/harness-schemas.ts:164`                      | `HarnessProvenanceSchema` drops `'adopted'`, keeps `'harness-native'`, and its TSDoc's "`adopted` never occurs in v1" paragraph is replaced by why it is gone |
| `apps/server/src/services/harness/status.ts:115`                  | The `satisfies Record<Provenance, HarnessProvenance>` table loses a row — the compiler names this file, which is the point of the `satisfies`                 |
| `packages/harness/src/sources/__tests__/resolve-roots.test.ts:20` | The case pinning `adopted` as ephemeral goes with the value                                                                                                   |

This is a **narrowing of a wire enum**, which is normally a compatibility question. It is safe here
because nothing has ever produced the value: no stored payload carries it, no route has ever served
it, and the client never switched on it. ADR-0303's third source class is untouched — the _class_ is
the act of adoption, and this decision says the act produces an `authored` skill rather than a
standing third provenance. That sharpening is part of what the amendment ADR records.

### 2. `--claude-only`

> **Decision: `--claude-only` records the name in `manifest.claudeOnlySkills` and moves nothing. Why:**
> it is the true answer to the question R7 asks. The refusal says "this file is Claude-Code-shaped";
> `--claude-only` is the person answering "yes, on purpose". SK-04 then governs from that moment on:
> the skill stays a real directory in `.claude/skills`, Claude Code reads it natively, every other
> enabled tool gets a drop line carrying the manifest's own reason, and the status row stops being
> `adoptable` — because `adoptableSkillSources` already excludes declared names. One flag, one
> meaning, and the state it produces is one the engine understands end to end today.

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

> **Decision: the migration key is `'0.77.0'`, not `'0.76.0'`. Why:** `'0.75.0'` merged with DOR-1849
> and is frozen from merge — the table's own comment says "anything further opens `'0.76.0'`" — and
> `specs/harness-sync-global/02-specification.md` §2.3 has already claimed `'0.76.0'` for
> `harness.global`, citing the same comment. Both keys sit above the newest tag (`v0.74.0`), so both
> are unreleased and both may be opened; they write **disjoint leaves** under `harness`, so `conf`
> running them in insertion order lands the same config whichever merges first. If DOR-1857 lands
> after this one, the two keys are simply out of chronological order in the file, which `conf` does
> not read. If a third claimant appears first, take the next ascending unclaimed key.

```ts
'0.77.0': (store: { get: (key: string) => unknown; set: (key: string, value: unknown) => void }) => {
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

The **sentence itself is per workspace**, because a command needs one absolute path and an aggregate
has none. It rides a new `logger.info` beside the two `logger.debug` lines
`projectAgentWorkspace`'s caller already writes per workspace, carrying `agentDir` and
`adoptableSentence({ …, projectPath: agentDir })` — the same shape the "partly failed" branch already
promises when it says "Each failure was logged above with its workspace path".

`projectAgentWorkspace` itself gains no reporting: it returns a status the caller counts, exactly as
it already does for `applied` and `conflicts`.

#### c) The Skills page row

Line 3 keeps its firing condition (`row.adoptable`) and gains the command:

```
Lives in .claude/skills. Move it to .agents/skills so every agent can read it.
Run: dorkos harness adopt deploy-checklist --project /Users/x/proj
```

The root comes from `row.source`, which the row already carries, so DOR-1902's other roots read
`Lives in .opencode/skills.` with no further change.

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
- **Body** `{ projectPath: <absolute>, name: string, claudeOnly?: boolean }`, validated by
  `HarnessAdoptBodySchema` in `packages/shared/src/harness-schemas.ts` with the same
  `isAbsolute` refinement the other two carry. `projectPath` then goes through
  `validateBoundaryOrDorkHome` by way of the module's existing `resolveProject` helper, so the
  boundary, the `404` for a path that leads nowhere and the `400` for a relative one are all
  inherited rather than re-implemented.
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
route returned. On a refusal the row draws the refusal sentence where the advice line was.

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
> are what ships. That outcome is strictly better than today: the row currently names no command at
> all.

### 8. Every user-facing string this work freezes

Written to the `writing-for-humans` bar: a smart ninth-grader who does not code can read every one,
and each says what to do next. `{n}`, `{name}`, `{source}`, `{file}`, `{root}`, `{tools}`,
`{fields}` and `{projectPath}` are substitutions. Each is asserted verbatim by at least one test, and the tests compare against the
literal rather than against the constant that produced it.

| #       | Where                       | The sentence                                                                                                                                                                                                                                                              |
| ------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **S1**  | Sync + boot, n=1            | `1 skill lives only in {root} and {tools} cannot see it — dorkos harness adopt {name} moves it`                                                                                                                                                                           |
| **S1b** | Sync + boot, n>1            | `{n} skills live only in {root} and {tools} cannot see them — dorkos harness adopt {name} moves one`                                                                                                                                                                      |
| **S1c** | Sync + boot, block heading  | `Skills only some of your agents can see:`                                                                                                                                                                                                                                |
| **S2**  | R1, no such skill           | `There is no skill called "{name}" in {root}. Run dorkos harness sync --check to see what is here.`                                                                                                                                                                       |
| **S2b** | R1, already canonical       | `"{name}" is already in .agents/skills, where every agent reads it. The copy in {source} is a second one that gets in the way — delete one of them.`                                                                                                                      |
| **S2c** | R1, declared                | `"{name}" is listed in manifest.claudeOnlySkills, which says the Claude-Code-only spot is on purpose. Take it out of that list first if you want to share it.`                                                                                                            |
| **S3**  | B2 (AP-15)                  | `DorkOS can't move a skill into .agents/skills here: {file} tells git to ignore .agents/, so moving it would take the skill out of git for everybody who clones this project. Stop ignoring .agents/ in {file}, or leave the skill where it is.`                          |
| **S4**  | R3 (SRC-11)                 | `"{name}" is one of the skills DorkOS puts in every room folder, so .agents/skills/{name} is hidden from git here and would be deleted when the room folder is cleaned up. Rename your skill and adopt it under the new name.`                                            |
| **S5**  | R4                          | `.agents/skills/{name} already has something in it. Look at both copies, keep the one you want, and adopt again.`                                                                                                                                                         |
| **S6**  | R5 (SK-13)                  | `{source} is a link to a folder somewhere else, so DorkOS can't move it without changing where your real skill lives. Move the real folder into .agents/skills yourself, or leave the link alone.`                                                                        |
| **S7**  | R7, frontmatter             | `"{name}" uses {fields} in its settings, which only Claude Code understands, so moving it would hand it to agents that can't run it properly. Run dorkos harness adopt {name} --claude-only to say it belongs to Claude Code, or take {fields} out and adopt it.`         |
| **S7b** | R7, body token              | `"{name}" mentions ${CLAUDE_PLUGIN_ROOT} in its text, which only Claude Code fills in, so moving it would hand it to agents that read a broken path. Run dorkos harness adopt {name} --claude-only to say it belongs to Claude Code, or take the token out and adopt it.` |
| **S8**  | B1                          | `harness.autoAdopt is on, and it does nothing here: DorkOS only moves skills on its own inside the agent folders and room folders it owns. Run dorkos harness adopt {name} to move one yourself.`                                                                         |
| **S9**  | R8                          | `--claude-only records a skill as belonging to Claude Code, and "{name}" lives in {root}. Leave it where it is, or move the folder yourself.`                                                                                                                             |
| **S10** | `EXDEV`                     | `DorkOS can't move {source} into .agents/skills because the two folders are on different drives. Move the folder yourself, then run dorkos harness sync --fix.`                                                                                                           |
| **S11** | Route 403                   | `This moves a file inside your project, so it is a decision a person makes in DorkOS rather than something an agent does on your behalf.` (error: `Only a person can move a skill`)                                                                                       |
| **S12** | R6                          | `DorkOS can't read the settings at the top of {source}/SKILL.md, so it can't tell whether the skill is safe to share. Fix that file and adopt again.`                                                                                                                     |
| **S13** | Row line 3                  | `Lives in {root}. Move it to .agents/skills so every agent can read it.` (unchanged) + `Run: dorkos harness adopt {name} --project {projectPath}`                                                                                                                         |
| **S14** | Confirm dialog              | `Move {name} so every agent can read it?` / `It moves from {source} to .agents/skills/{name}, and DorkOS leaves a link behind so Claude Code still finds it.` / `Move it`                                                                                                 |
| **S15** | CLI success                 | `Moved {name} to .agents/skills/{name}. Claude Code still finds it through a link at {source}.`                                                                                                                                                                           |
| **S16** | CLI `--claude-only` success | `Recorded {name} as belonging to Claude Code. It stays in {source}, and your other agents are told why they don't get it.`                                                                                                                                                |
| **S17** | R2                          | DOR-1882's frozen occupant sentences, reused verbatim, so a sync and an adopt say the same words about the same file                                                                                                                                                      |

R7's `{fields}` names the offending keys in the order they appear in the file, joined `a, b and c` —
the person's own file read back to them, which is what makes "take them out" actionable.

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

1. **One case per refusal rule**, ten in all (B1, B2, R1×3, R2, R3, R4, R5, R6, R7×2, R8), each
   asserting the frozen sentence verbatim.
   _Seeded defect, per rule:_ delete that rule's branch and the matching case reds. The PR shows ten
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
6. **The candidate set agrees with the status model.** A property over a staged tree: the names
   `readAdoptCandidates` returns equal the sources `adoptableSkillSources` marks `adoptable`. This is
   what makes the deliberate duplication (§1.1) checked rather than trusted.
   _Seeded:_ drop the `alsoCanonical` exclusion from one side and the property reds.

### Slice 2 — apply and CLI

`adopt/__tests__/apply.test.ts`, real temp repositories:

7. **The move.** `.agents/skills/x` holds the same bytes as the source did (a whole-tree content
   hash, not a path list), and `.claude/skills/x` is a symlink whose link text is
   `../../.agents/skills/x`.
8. **The link equals the projection action.** After `applyAdopt`, `checkPlan(repo, project(repo))`
   reports `clean: true`, and the applied action deep-equals `planSkill`'s own return value for that
   skill. _Seeded:_ hand-roll the link text as an absolute path — `linkMatchesPlan` fails and `clean`
   goes false. This is the test that discharges "the next sync's plan already matches".
9. **The crash between rename and link.** Stub `applyPlan` to throw; assert the source directory is
   back at `.claude/skills/x`, `.agents/skills/x` is absent, and **no other path in the tree
   changed** (whole-tree path-set snapshot, the CLI file's idiom). _Seeded:_ delete the restore and
   the source-path assertion reds.
10. **A conflict at the link target** (a real file at `.claude/skills/x` planted between the two
    steps) restores just the same, and the refusal carries `applySymlink`'s own blocking reason.
11. **A non-Claude root** (staged by hand until DOR-1902 lands): the move happens, **no link is left**,
    and `checkPlan` is still clean. _Seeded:_ plan a link for every root and the orphan finders
    report the new path.
12. **`EXDEV`.** Stub `renameSync` to throw it; S10 verbatim, tree unchanged.
13. **Idempotency.** Adopting the same name twice: the second run is R4, and the tree after equals the
    tree after the first (path-set + content hash).

`packages/cli/src/__tests__/harness-adopt.test.ts`, real engine, real temp repo — exit codes paired
with whole-tree path-set snapshots, the idiom `harness-sync.test.ts` established after DOR-678, whose
helper now hashes contents so an in-place rewrite cannot pass:

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
19. **`SRC-10`**: `Provenance` no longer accepts `'adopted'`, and a moved skill's plan action carries
    `provenance: 'authored'`. _Seeded:_ set `'adopted'` on the moved skill's action and the gitignore
    check starts demanding a pattern for a committed skill.

### Slice 3 — the flag, the boot path, the config tables

`apps/server/src/services/harness/__tests__/auto-adopt.test.ts`, real engine, real seeder:

20. **`autoAdopt: false` in an agent home finds candidates and moves none**, and the summary reports
    `adoptableSkills: 3, adoptedSkills: 0`. _This is the report-only claim._ _Seeded:_ make the flag
    default `true` and the tree changes.
21. **`autoAdopt: true` in an agent home** moves only the allowlisted skill; the summary reports
    `adoptableSkills: 3, adoptedSkills: 1`, and the per-workspace line names the other two with
    their absolute-path commands. _Seeded:_ swap the allowlist for a denylist of `context` and
    `paths` — the `hooks:` skill moves and the count reds.
22. **`autoAdopt: true` in a room worktree**: a seeded name is refused with S4, an authored one moves,
    and the moved skill appears in `git status` while its link does not (the `info/exclude` block
    covers `/.claude/skills/` and not `.agents/skills/`).
23. **`autoAdopt: true` in a plain project moves nothing**, and `dorkos harness sync --check` there
    prints S8 exactly once. _Seeded:_ read the flag in `runAutoProjection` — the tree changes and the
    path-set snapshot reds.
24. **The migration**, in `config-manager.test.ts`: a stale config carrying a `harness` section with
    no `autoAdopt`, booted, then **read off disk** — never through `getDot`, which fills the leaf on
    the way out (DOR-1496). _Seeded:_ comment the body out and the on-disk assertion reds.
25. **The three total guards** (`config-disclosure`, `config-write-policy`, `default-verdicts`) go red
    until the field is classified. Those reds _are_ the seeded defect, and the PR shows them.

### Slice 4 — route and page

`apps/server/src/routes/__tests__/harness.test.ts`:

26. **Person-only**: an agent caller gets 403 with the code and S11, asserted against `sync`'s own
    case so the two cannot drift. _Seeded:_ swap `resolveDecisionAuthority` for `trustedCaller` and
    the person-in-a-terminal case reds (DOR-502's shape).
27. **409** with no manifest; **400** for a relative `projectPath`; **404** for one that leads
    nowhere — each inherited from `resolveProject` and asserted, because inheritance is a claim.
28. **200 with a refusal** in the body, not a 4xx.
29. **The lock**: a POST arriving while another holds the repository queues and still answers 200, and
    the returned status describes the tree _this_ apply left. _Seeded:_ recompute the status outside
    the lock and interleave a write.

Client (`SkillHarnessRow.test.tsx`, `SkillsWithHarnessesList.test.tsx`):

30. The button renders only on an `adoptable` row; the confirm names both paths; **cancelling calls
    nothing**; a refusal draws its sentence where the advice line was.

E2E (`apps/e2e/tests/harness/skills-page.spec.ts`) — the fixture already stages the exact tree
(`apps/e2e/fixtures/harness-repo.ts`: "The skill kept in `.claude/skills` as a real directory — Codex
cannot see it"):

31. Press the button, confirm, and the row's chips change from "Codex can't see it" to "Codex reads
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
`packages/harness/src/index.ts` (barrel); `packages/harness/src/adopt/__tests__/plan.test.ts`.

**Acceptance bar.** `planAdopt` is pure (no `fs` import, enforced by the ESLint no-restricted-imports
shape the FSD rules already use, or by a test asserting the module's import list). All ten refusal
sentences are frozen and asserted verbatim. The allowlist reads raw frontmatter and the
parsed-frontmatter run demonstrably passes the `hooks:` case. `readAdoptCandidates` agrees with
`adoptableSkillSources` as a property. The census stays green.

### Slice 2 — the apply, the CLI, the report

**Files.** `packages/harness/src/adopt/apply.ts`; `packages/harness/src/report/adoptable.ts`;
`packages/harness/src/plan/types.ts`, `sources/resolve-roots.ts`,
`packages/shared/src/harness-schemas.ts`, `apps/server/src/services/harness/status.ts` (the
`'adopted'` retirement); `packages/cli/src/harness-adopt-command.ts`,
`packages/cli/src/commands/harness-dispatcher.ts`, `packages/cli/src/harness-sync-command.ts` (the
new block); tests as listed.

**Acceptance bar.** `checkPlan` is clean immediately after an adopt, and the applied action
deep-equals `planSkill`'s. The crash case restores and changes nothing else in the tree. The J-06
sentence matches the contract's own wording byte for byte at n=1, and is absent on a Claude-only
manifest. `Provenance` no longer carries `'adopted'` and the whole monorepo type-checks. SRC-07,
SRC-10 and AP-17 flip with cited coverage, and `capabilities-census.test.ts` passes.

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

**Files.** `packages/shared/src/harness-schemas.ts` (two schemas);
`apps/server/src/routes/harness.ts`; `apps/client/src/layers/entities/harness/ui/SkillHarnessRow.tsx`

- a `use-harness-adopt.ts` beside `use-harness-sync.ts`; `apps/e2e/tests/harness/skills-page.spec.ts`;
  `docs/api/openapi.json`.

**Acceptance bar.** The 403 shape is asserted against `sync`'s. The lock holds plan + apply + status.
The browser leg presses the button on the existing fixture and watches the chip change. `knip` is
clean — nothing exported and unused. If the confirm needs more than `AlertDialog` + `Banner`, the
whole slice is cut to a follow-up and this spec's §7 cut line is what the ticket cites.

## Contract and census changes

| Row               | Now                                                                                                                                    | After                                                                                                                                                                                                                         | Coverage cited                                                                                        |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `SRC-07`          | **not built** (adopt: DOR-174 task 3.2)                                                                                                | **built** (DOR-1853) — the harness-native asset has a path back to canonical, and every sync and boot summary names the ones that have not taken it                                                                           | `adopt/__tests__/plan.test.ts`, `apply.test.ts`, `cli/__tests__/harness-adopt.test.ts`                |
| `SRC-10`          | **not built**; `U` pins `adopted` as ephemeral                                                                                         | **built, and the third provenance is retired**: adoption produces an `authored` skill, `Provenance` is `'authored' \| 'installed'`, and the value that could only ever have been wrong is gone                                | `apply.test.ts` (`provenance: 'authored'` on the moved skill), the compiler on the `satisfies` table  |
| `J-06`            | Actual: "What is still missing is the MOVE"                                                                                            | Actual: the move exists; **Expected loses "In a DorkOS-owned directory … the move happens on its own"**, which is the pre-round-two draft of D3 and contradicts the position the ticket settles                               | `cli/__tests__/harness-adopt.test.ts` (the sentence), `services/harness/__tests__/auto-adopt.test.ts` |
| **`SK-16`** (new) | —                                                                                                                                      | **built**: a skill is safe to share automatically only when its frontmatter holds nothing outside the agentskills.io base fields and its body carries no `${CLAUDE_…}` token — read raw, never parsed                         | `adopt/__tests__/plan.test.ts` (both sides, plus the parsed-reader run)                               |
| **`AP-17`** (new) | —                                                                                                                                      | **built**: adopting a skill is one `rename(2)` plus the projection the planner already plans; a failure restores, and a crash between them leaves the skill whole at the canonical root with a projection the next sync makes | `adopt/__tests__/apply.test.ts`                                                                       |
| §14 item 3        | "What is left is the OTHER direction: a Claude-made skill still misses Codex and Gemini forever and nothing reports it (SRC-07, J-06)" | Struck through — closed by DOR-1853, which reports it everywhere and gives it one command                                                                                                                                     | assertion 6 of the census requires a test title per id                                                |
| §16 D3            | "None is settled by this file"                                                                                                         | Gains "**Settled and SHIPPED (DOR-1853)**", the shape the D2 and D4 entries already use, plus the two clauses the code corrected (§Deviations 4 and 10)                                                                       | —                                                                                                     |

`SK-16` and `AP-17` are the next free ids in their families today (`SK` runs to 15, `AP` to 16). The
ids are not load-bearing and the rows are: if DOR-1902 has taken one by the time this lands, take the
next free one and retitle the tests, which is what census assertion 5 exists to catch.

Census floors move: `rows` +2, `titles` by the number of new cases. Every new test title carries its
row id as a prefix (`it('SRC-07: …')`), which is the retitle convention assertion 5 enforces.

## Decisions

Every open question this stage raised, resolved with its reason. The operator delegated; nothing
below waits on an answer. Each is stated inline in the section that needs it and collected here so a
reader can hold one list.

| #   | Question                                                                          | Decision                                                                                                                                                     | Why                                                                                                                                                                                                                                                                                                  |
| --- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Where the engine lives, and what shape it has                                     | `packages/harness/src/adopt/` — a filesystem reader, a **pure** planner, an apply, and the allowlist alone in its own file                                   | `engine.ts` already sets the precedent (`buildPlan` pure, `scanClaudeOnlySkills` answering the disk question). A pure planner makes every refusal a fixture instead of a staged tree, and the allowlist in one file is the greppable answer to "what does DorkOS think is safe to share"             |
| 2   | Whether the refusal table is per-candidate or per-run                             | Both. Two run-level `blocked` reasons, eight per-candidate `refusals`                                                                                        | A gitignored `.agents/` and an `autoAdopt` in the wrong place are facts about the directory. Printing either once per candidate buries the six things a person could act on                                                                                                                          |
| 3   | The refusal order                                                                 | Run-level first (B1 then B2), then R1 → R8, first match wins                                                                                                 | Most fundamental first: what makes the run impossible, then what makes the filesystem operation impossible, then what makes the _result_ wrong. Asserted by a test rather than left emergent                                                                                                         |
| 4   | The allowlist's contents                                                          | The six agentskills.io base fields: `name`, `description`, `license`, `compatibility`, `metadata`, `allowed-tools`                                           | They are layer 1 of `SkillFrontmatterSchema`, which the codebase already names in one place. Layers 2 and 3 are exactly the things another tool does not implement                                                                                                                                   |
| 5   | `allowed-tools`: in or out                                                        | **In**                                                                                                                                                       | A base field of the open standard. A value naming a tool a given harness lacks is already a `warned` cell a person is shown, not a breakage                                                                                                                                                          |
| 6   | `hooks`: in or out                                                                | **Out**, and it is the reason the predicate reads raw frontmatter                                                                                            | `SkillFrontmatterSchema` strips it, Claude Code runs it, and `inventory/hooks.ts` reads it (HK-14). A parsed-object predicate would move a file that runs shell commands                                                                                                                             |
| 7   | `context` / `disable-model-invocation` / `paths`: in or out                       | **Out**, all three                                                                                                                                           | Claude Code dialect. `context: fork` loses its isolation, `disable-model-invocation: true` is a person's decision the move would override, and `paths` loses its scoping and becomes always-eligible                                                                                                 |
| 8   | `schedule`: in or out                                                             | **Out**, and it is the one with a running consequence                                                                                                        | `.agents/skills` is the only skills root the scheduler watches (DOR-1518). Auto-adopting a scheduled skill starts a timed job nobody asked for                                                                                                                                                       |
| 9   | Which frontmatter the predicate reads                                             | The **raw** frontmatter (`readRawFrontmatter`), never `parseSkillFile`'s output                                                                              | Parsing strips unknown keys and swallows unreadable values — both correct for their own callers and catastrophic here. Decision 6 is the measured case                                                                                                                                               |
| 10  | Whether R7 is a warning-plus-`--force` or a hard refusal                          | **Hard, in both modes**, with no `--force`                                                                                                                   | The exposure is one-way and `manifest.claudeOnlySkills` cannot un-expose a moved skill (SK-04 fires after the move). The two ways out — declare it, or edit the file — are both reviewable and both reversible                                                                                       |
| 11  | What `--claude-only` does                                                         | Records the name in `manifest.claudeOnlySkills` and moves nothing                                                                                            | It is the true answer to the question R7 asks, and SK-04 already governs the state it produces end to end. One flag, one meaning                                                                                                                                                                     |
| 12  | `--claude-only` on a non-Claude root                                              | Refused (R8, S9)                                                                                                                                             | The manifest key is named for Claude Code and every one of SK-04's five states is about `.claude/skills`                                                                                                                                                                                             |
| 13  | Whether the move stages and backs up like the marketplace transaction             | **No staging, no backup** — but the same discipline: refuse rather than overwrite, one mutating step, restore on failure, a lock at the surface that has one | The marketplace stages because it _builds_ content and backs up because it _overwrites_. Adopt does neither: R4 refuses an occupied target, and the content already exists and is whole. Staging would cost two copies, a non-atomic step and lost modes to close a window `rename(2)` does not have |
| 14  | What a crash between the move and the link leaves                                 | The skill whole at `.agents/skills/<name>`, no link, nothing lost                                                                                            | Five of six tools read it there already, and the missing link is exactly the action `planSkill` plans on every later run — so the next sync, watcher event, boot pass or button finishes it. The state is drift, which this engine names and fixes                                                   |
| 15  | `EXDEV`                                                                           | Refused with S10, never a copy                                                                                                                               | A copy is not atomic, and a half-copied skill is the one state this design promises never to leave                                                                                                                                                                                                   |
| 16  | Which roots get a link back                                                       | Only `.claude/skills`                                                                                                                                        | Every other root's owner already lists `.agents/skills` in its documented read paths. A link elsewhere would be a path DorkOS wrote that no plan names — an orphan by construction                                                                                                                   |
| 17  | How the link is created                                                           | By handing `planSkill`'s own action to `applyPlan` — narrowed to `claude-code`, sweeps off                                                                   | It makes "the next sync's plan already matches" true by construction, and inherits the Windows junction, the occupant checks and the clone-without-symlinks story instead of repeating them                                                                                                          |
| 18  | Whether `Provenance`'s `'adopted'` survives                                       | **Retired**                                                                                                                                                  | A moved skill is plain `authored`. Worse than unused, the value is wrong: `isEphemeralProvenance('adopted')` is `true`, so anything setting it would tell a person to gitignore a skill they just committed. Four references, all measured                                                           |
| 19  | What "permitted" means for `autoAdopt`                                            | Accepted at write time; acted on at exactly two call sites, both of which have already established DorkOS owns the directory                                 | One global boolean has no project in hand at write time, so a write-time refusal would refuse it for the agent homes it is for. Two sites rather than five checks means a `true` elsewhere is inert by construction                                                                                  |
| 20  | Where a person learns a `true` did nothing                                        | `dorkos harness sync` prints S8 once, in a directory DorkOS does not own                                                                                     | The terminal is where somebody who set the flag looks. The CLI already reads the config and resolves the dork home                                                                                                                                                                                   |
| 21  | The migration key                                                                 | `'0.77.0'`                                                                                                                                                   | `'0.75.0'` merged and is frozen; `specs/harness-sync-global` §2.3 already claims `'0.76.0'`. Both are above `v0.74.0`, both write disjoint `harness` leaves, so order does not change the result                                                                                                     |
| 22  | Whether `autoAdopt` is an experiment                                              | **No registry entry**                                                                                                                                        | The registry is for a staged opt-in awaiting graduation and every entry needs a `graduationIssue`. This is a permanent posture — D3 says off everywhere, for good                                                                                                                                    |
| 23  | Whether `autoAdopt` needs a carryover rule                                        | **No `PROTECTED_STATE` entry**                                                                                                                               | Carryover protects a tightening from a wipe. The default _is_ the tight value here; `harness.autoSync` needs one because it defaults ON                                                                                                                                                              |
| 24  | Whether the row's advice line narrows to "some enabled tool cannot see it"        | **No** — unchanged firing, and it gains the command                                                                                                          | The row's line makes no claim about any tool, so it is true whatever is enabled. The headline _does_ name tools, so the headline is computed and withheld when the list is empty                                                                                                                     |
| 25  | Whether the CLI's own printed command carries `--project`                         | No; the **server's** printed commands always do, absolutely                                                                                                  | The CLI ran in the repository, so a bare command is right there and is the contract's own sentence. A `.` in a server-printed string resolves against whatever directory the reader is in                                                                                                            |
| 26  | `adopt --check`'s exit code                                                       | `0` when it would move, `1` when it would be refused — the opposite of `sync --check`                                                                        | They ask different questions: "is my tree in sync?" versus "will this command work?". Stated in the help and the guide because it is what a script author trips over                                                                                                                                 |
| 27  | Whether a bare `dorkos harness adopt` does something                              | Usage error, naming `dorkos harness sync --check`                                                                                                            | A bare adopt that acted would be one keystroke from the multi-adopt this spec deliberately does not ship                                                                                                                                                                                             |
| 28  | Whether the route ships in v1                                                     | **Yes**, in the same slice as the page action, so neither lands alone                                                                                        | The app is the primary surface, and a route with no caller is dead code by this repository's standard. Cutting the page cuts the route, leaving the CLI as a coherent product                                                                                                                        |
| 29  | Whether the Skills page gets a button, against DOR-1894's stated "no button (D3)" | **Yes**, behind a confirm naming both paths                                                                                                                  | Half of that comment's reason was that no verb existed. The other half is answered: the button does not move anything, it discloses first — the same shape the sweep gets before the Sync button acts                                                                                                |
| 30  | A refusal's HTTP status                                                           | `200` with the refusal in the body                                                                                                                           | Refusals are answers carrying their own way out, and the page has one place to draw the sentence. A `404` for one of eight would make the page special-case it                                                                                                                                       |
| 31  | The route's capability tier if it is ever offered to agents                       | `destructive`, not `act`                                                                                                                                     | `sync` touches only files DorkOS made; adopt moves a file a person made. That is the whole difference                                                                                                                                                                                                |
| 32  | Where `DirectoryOwnership` is decided                                             | By the caller, never by the engine                                                                                                                           | `packages/harness` keeps no dork-home knowledge, which is what lets one engine run offline in a terminal and inside the server                                                                                                                                                                       |
| 33  | Whether `dorkos harness sync` gains `--project` too                               | No                                                                                                                                                           | A shipped command with its own tests and its own contract ("acts on the folder you run it in"). Changing it is a separate decision                                                                                                                                                                   |
| 34  | Ordering against the two in-flight tickets                                        | After **DOR-1882** and **DOR-1902**                                                                                                                          | 1902 changes `SkillRoot` from two members to five and the whole refusal table is keyed on it; 1882 adds the occupant pre-pass whose sentences adopt reuses rather than inventing a seventh voice for the same file                                                                                   |

## Deviations from the brief, the contract and the plan

Where a document and the code disagreed, the code won and the disagreement is recorded here.

| #   | What was said                                                                                                                                    | What the code holds                                                                                                                                                                                                                                         | What this spec does                                                                                                                                                                                           |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | The brief calls `--project` part of "the sibling command's shape"                                                                                | `dorkos harness sync` has **no** `--project`. It parses `check/fix/harness/strict/allow-hooks/enable/global/write-gitignore` with `allowPositionals: false` and acts on `process.cwd()`; the dispatcher's help says "Sync acts on the folder you run it in" | `adopt` introduces `--project`, resolved by the CLI against its own cwd. `sync` is untouched (Decision 33)                                                                                                    |
| 2   | "DOR-1921/1922 learned `--project .` resolves against the SERVER's cwd"                                                                          | True, and it is about **server-bound** commands. `plan/global-installs.ts` states it for `dorkos install`/`uninstall`, which forward the flag verbatim to a server that resolves it against its own working directory                                       | Adopt is offline, so a `.` would be harmless _for the command_. Every string DorkOS **prints** still carries the absolute root, because a pasted command must mean the same thing from anywhere (Decision 25) |
| 3   | The brief: "the next key is `'0.76.0'` unless `'0.75.0'` is still unreleased"                                                                    | `'0.75.0'` is merged (DOR-1849, `seedHarnessRefusedHooks`) and frozen from merge, and `specs/harness-sync-global/02-specification.md` §2.3 has **already claimed `'0.76.0'`**, citing the same comment                                                      | The key is `'0.77.0'`, with the tie-break rule written down (Decision 21)                                                                                                                                     |
| 4   | The brief: the move must have "the stage → backup → rename → restore shape"                                                                      | The marketplace transaction stages because it builds content and backs up because it overwrites. Adopt refuses an occupied target and moves content that already exists                                                                                     | No staging, no backup; the same discipline otherwise (Decision 13). The reason is written into the module docs so the next reader does not re-add them                                                        |
| 5   | J-06's **Expected** column: "In a DorkOS-owned directory (an agent home, a room worktree) the move happens on its own and the output says so"    | That is D3's **pre-round-two** draft. Round two took the last step to report-only everywhere, DorkOS-owned directories included, and the ticket restates it                                                                                                 | The J-06 row's Expected column is corrected in this work, not just its Actual                                                                                                                                 |
| 6   | `plans/harness-sync-test-plan.md` §11 line 10's seeded defect: "J-06: `unmanaged` is empty on a repo with a real dir in `.claude/skills`"        | `unmanaged` shipped in DOR-1891…1896. That assertion is **green on `main`** today                                                                                                                                                                           | Each slice names its own seeded defect, and the plan line is corrected                                                                                                                                        |
| 7   | `SkillHarnessRow.tsx:52-54`: "no button, because moving a file out from under a person's editor is not something a side panel should offer (D3)" | Half that reason was that no verb existed to offer                                                                                                                                                                                                          | The button ships behind a confirm; the comment is rewritten to say what it now decides (Decision 29)                                                                                                          |
| 8   | The `adding-config-fields` skill's checklist                                                                                                     | It lists `CONFIG_DISCLOSURE` and `CONFIG_WRITE_POLICY` but **not** `safe-defaults/default-verdicts.ts`, whose guard is equally total over `UserConfigSchema` leaves and will red until the field is classified                                              | The verdict is specified (`safe`), and the skill's omission is filed as a follow-up                                                                                                                           |
| 9   | `specs/harness-sync-status` §1.5: "`.opencode/skills` and `.cursor/skills` are not inventoried … widening the inventory is a follow-up"          | DOR-1902 **is** that follow-up and lands first                                                                                                                                                                                                              | Adopt is written against `SkillRoot` — the union — from the first line, never against `.claude/skills`                                                                                                        |
| 10  | The brief left open whether `'adopted'` survives                                                                                                 | Four references, and `isEphemeralProvenance('adopted') === true` is actively wrong for a skill landing in the committed canonical layer                                                                                                                     | Retired (Decision 18). ADR-0303's third source class is untouched — the _class_ is the act; the act produces an `authored` skill                                                                              |
| 11  | The brief: `POST /api/harness/adopt` "mirrors `sync`", person-only, project-locked                                                               | It does, with one honest difference: `sync` sweeps and adopt does not, so adopt takes no `sweepOrphans` and `applyPlan` throws if a narrowed plan ever asks for one                                                                                         | Stated, and the throw is named as the backstop rather than a rule to remember                                                                                                                                 |

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
