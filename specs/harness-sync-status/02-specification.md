---
slug: harness-sync-status
number: 260908-084301
created: 2026-09-08
status: specified
---

# Harness Sync status — one status model, a real Skills page, and the drift banner

**Status:** Draft
**Author:** specifier-1852 (DOR-1852)
**Date:** 2026-09-08

> **Every number, plan excerpt and reproduction in this document was produced by running the engine at
> `87d893503`** (this branch's base) over a real temp-dir fixture — never read off a type or inferred from a
> doc comment. Where a claim rests on a run, the run is named.

## Overview

Harness Sync knows, for every agent file in a project and every agent tool the project syncs to, exactly what
is happening: read where it sits, written by DorkOS, out of date, blocked, dropped with a reason, or waiting
on a person's yes. It knows this in four separate function calls, and it tells nobody but a terminal.

This adds the missing three things:

1. **`GET /api/harness/status?projectPath=…`** — one read-only call assembling those four answers into one
   eight-state model, per artifact, per harness.
2. **A real Skills page** on the agent profile — every skill, its source, and a chip per enabled harness —
   replacing a list that reads marketplace `skill-pack` packages only and tells a person with 31 skills
   "No skills installed".
3. **A drift banner** with one action (`POST /api/harness/sync`) that names what the click will delete before
   it deletes it, and clears when the tree is clean — plus the drop list as a
   **"Not shared with `<harness>`"** panel with every reason spelled out.

It closes contract rows VC-01 (the status model), VC-02's app half, and TR-08 (a person asks from the app),
and it re-scopes the canceled DOR-144 down to the half that can ship on its own.

## Background / Problem Statement

The Harness Sync specification promised a UI surface: target selection, a per-artifact status table, a drift
indicator with one-click re-sync, and a "Not projected" panel it called **Priya's honesty gate**
(`specs/harness-sync/02-specification.md` §"The Harnesses UI surface"). The contract's §11 records the
outcome in one sentence: **none of it exists.** The whole human-visible surface is one CLI command, one
approval card, and five sentences of documentation.

Three measured consequences, all on this repository's own tree:

- The agent profile's Skills page reads `GET /api/marketplace/installed`, filters to `type === 'skill-pack'`,
  and renders **"No skills installed. Browse the marketplace to add skills to this agent."** The source
  inventory on this repo finds **31 skills**, 13 of them real directories in `.claude/skills`.
- Nothing in the app says a projection has drifted. A deleted `.claude/skills/<x>` link is invisible until
  somebody runs `dorkos harness sync --check` in the right folder.
- Nothing in the app reports an **adoptable** skill — one that lives where only some agent tools look. The
  contract's J-06 says the expected behaviour is "the next sync reports it"; the actual behaviour is
  "nothing reports it", and DOR-1853 (adopt) is explicitly blocked on a screen that can show one.

The engine is not the gap. `project()`, `checkPlan()`, `planWithConsent()` and `inventorySourceTree()` between
them already know almost every fact this page needs. VC-01's verdict is precise: _"nothing assembles the eight
into one answer."_ Two things they do **not** know are named in §1.4 and §2.2.1, and each gets a fix rather
than a shrug.

## Goals

- One read-only call that answers, per artifact and per harness, which of eight states it is in — with the
  derivation stated as a table a test can walk.
- A Skills page that lists **every** skill a person has, whatever its source, and says for each which agent
  tools can see it.
- The drop list, verbatim and per harness, so nothing DorkOS cannot share is silently omitted.
- A banner that appears when the tree is not clean, offers exactly one action when that action helps, **says
  what that action will delete before it is clicked**, and disappears when it stops being true.
- **One model, two renderers.** Whatever the page says, the CLI must be able to say about the same artifact
  — so the assembly lives in one module rather than in the route.
- A projection stays the person's decision: the read is open, the write is not.

## Non-Goals

Each carries the ticket that owns it, or a note that nothing does yet.

| Cut                                                                                                                                    | Owner                                                                            |
| -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| **Adopt by move** — `dorkos harness adopt`, `harness.autoAdopt`. The page reports an adoptable skill; it never moves one.              | **DOR-1853** (contract §16 D3, which requires the status surface to exist first) |
| **Global scope** — `~/.dork/plugins`, `~/.claude/skills`, Claude Code's own `enabledPlugins`                                           | **DOR-1857**                                                                     |
| **Seeing and revoking allowed hooks in the app** (VC-05's app half). `dorkos harness hooks --list \| --revoke` stays the only surface. | **unowned** — see §Follow-ups to file                                            |
| **Turning a harness on from the app** (`--enable`). The not-enabled notice is copy.                                                    | **unowned** — see §Follow-ups to file; the CLI half is DOR-1851                  |
| **The DOR-144 global half** — a per-harness projection default, a `harness.autoSync` toggle, a target matrix in Settings               | **unowned** (DOR-144 is canceled) — see §Follow-ups to file                      |
| **A `/harnesses` route.** Superseded by the profile's Skills page, not deferred.                                                       | — (deviation from `specs/harness-sync`, recorded in §Deviations)                 |
| **Widening the inventory past `.claude/skills`** — `.opencode/skills`, `.cursor/skills`. So `unmanaged` is scoped to `.claude/skills`. | **unowned** — see §Follow-ups to file; SRC-07 is `.claude/skills` by definition  |
| **Teaching the CLI to read the status model.** The direction is in the ADR; the port is later.                                         | **unowned** — see §Follow-ups to file                                            |
| **Server-side caching, or pushing status changes over SSE.** Recomputed per call.                                                      | — (§Performance Considerations sets the measured budget that makes this fine)    |
| **Non-skill artifacts as rows.** Rules, subagents, commands, hooks and MCP servers reach the page through the drop panels only.        | — (§User Experience; the API is deliberately wider than the page — Decision 27)  |

## Technical Dependencies

Nothing new is installed. `packages/harness/package.json` gains `@dorkos/shared` as a dependency (§3), which
is a workspace edge that already exists in the other direction through `@dorkos/skills` and closes no cycle
(§3, "Why the harness vocabulary moves down").

Three sibling tickets are **in review, not on `main`**. Each is named with what it contributes and what to do
if it is late, so no slice is blocked on a merge it does not control:

| Ticket       | Contributes                                                                                                                        | If it is late                                                                                                                       |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| **DOR-1851** | `ProjectionPlan.notEnabled: DetectedHarness[]` (`{ harness, signal }`), plus `enableHarnessInManifest`, `missingGitignoreLines`    | Read it as `plan.notEnabled ?? []` and drop the not-enabled row from the page. Nothing else here depends on it.                     |
| **DOR-1854** | a per-`projectPath` lock (`withProjectLock`), or the proof that the apply already converges                                        | The POST takes the lock if there is one and needs no change if the answer was the proof. Neither outcome blocks anything.           |
| **DOR-1855** | `findBlockedSymlinkTargets` in `checkPlan`, and `apply/symlink-occupants.ts`'s three reasons — **the engine half of §1.4's row 2** | Slice 2 opens with the same change, scoped to what this needs (§1.4, "The prerequisite"). It is small and it is named, not assumed. |

Also unchanged: Zod 4 (already in `@dorkos/shared`), TanStack Query, shadcn/ui,
`@asteasolutions/zod-to-openapi` for the `/api/docs` entry.

## Detailed Design

### 1. The status model (VC-01)

#### 1.1 The eight states

One state per **cell** — an artifact paired with one enabled harness — except the eighth, which is a fact
about the file and belongs to the row.

| State              | Means                                                                                                                                                               |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `native`           | This harness reads the file where it already sits. DorkOS writes nothing.                                                                                           |
| `projected`        | DorkOS writes or links a file for this harness, and what is on disk matches the plan.                                                                               |
| `drifted`          | DorkOS should have written something here and what is on disk does not match. A sync fixes it.                                                                      |
| `dropped`          | This artifact has no home in this harness. Carries the reason.                                                                                                      |
| `warned`           | Nothing else names this cell, and a warning does — a declaration DorkOS read and could not use.                                                                     |
| `conflict`         | A file DorkOS does not own occupies the target. A sync cannot fix it; a person moves the file.                                                                      |
| `pending-approval` | A package's hooks are held back until a person allows those exact commands.                                                                                         |
| `unmanaged`        | **Row-level.** The file is authored in a harness-native directory that is neither the canonical layer nor anything DorkOS projects. Reported, never moved (§16 D3). |

#### 1.2 Inputs, and nothing else

The model is a pure function of five reads, all of which exist:

```
planWithConsent(projectPath, { dorkHome, decisions })  →  { plan, withheld }
checkPlan(projectPath, plan)                           →  { drifted, blocked, orphans, leftAlone, clean }
inventorySourceTree(projectPath)                       →  SourceInventory
loadManifest(projectPath).harnesses                    →  the enabled set
loadManifest(projectPath).claudeOnlySkills             →  the declared Claude-only names
```

After a write, a sixth input joins them: `applyPlan`'s `{ applied, conflicts, swept, leftAlone }`, returned
through `projectWithConsent`.

The model **never re-derives a harness's behaviour**. Where a chip says "Codex can't see it", the sentence
under it is the plan's own `reason` string, unchanged. Two consequences worth stating:

- A wrong chip is a **plan** bug and is fixed in the plan. The status model has no opinion of its own to
  correct. (DOR-1847's false-native work is exactly this class, and it lands in the projector, not here.)
- `harnessCoverage()` — the vendor-facts **walk** — is not used. Its own module doc calls it "the oracle a
  projection is measured against"; it is the test tier's, and running it in the read path would put a second,
  independent model of six vendors' behaviour on a screen where it could disagree with the first.

#### 1.3 Row identity, and the entries that are not rows

##### Harness-agnostic entries are project-level

Both the plan's action list and its warning list can carry entries that are **not about one harness**.
`ProjectionAction.harnessAgnostic` and `ProjectionWarning.harnessAgnostic` (DOR-1849) say so, and the field
they carry beside it — `harness` — is an arbitrary placeholder the emitters document as such:

- `dropWholePlugin` (`plan/installed-projector.ts:766-778`) sets `harness: DROP_ATTRIBUTION` (`'codex'`) with
  the comment _"Not about Codex: a package this shape is not portable to any harness."_ It carries **no**
  `source`.
- `planUnreadableHookWarnings` (`plan/unreadable-hooks.ts:88-99`) sets `harness: 'claude-code'` and **does**
  carry a `source` (the declaring file, added by the DOR-1845 review so the completeness check can match it).
  Its own doc says the placeholder used to make "a project running codex alone read the loss under a
  `claude-code:` heading naming a harness it does not run".
- The plugin-layer drops (`installed-projector.ts:753-763`) are agnostic and carry no `source` either.

**So `source` absence is not the discriminator; `harnessAgnostic === true` is.** Anything carrying that flag
is filed under `projectLevel[]` and rendered once, at project level, under its own heading — mirroring the
CLI's `plugin layers:` heading, which exists for exactly this reason. **It never becomes a cell and never a
row.** Following the alternative would either draw "Claude Code may not work" on a project that does not run
Claude Code, or drop the warning off the page entirely — which is contract VC-02's own complaint, arriving
in a new surface.

##### The row key is `(artifact, source, name)`

All three components are load-bearing, and each has a measured counter-example on the J-01 fixture (§1.7):

- **Without `source`:** the plan emits two `claude-code` actions both named `hooks`, one sourced from
  `.claude/settings.json` and one from `.claude/settings.local.json`. Keying on `name` alone collapses two
  different files into one row.
- **Without `name`:** the two MCP servers `linear` and `shadcn` share one `source` (`.mcp.json`). Keying on
  `(artifact, source)` alone collapses them — measured: 2 mcp rows become 1.
- **Without `artifact`:** a skill and a skill-frontmatter hook can share a source
  (`.claude/skills/release/SKILL.md` is the hook's source; `.claude/skills/release` is the skill's) — they
  are different rows about different things.

##### Warnings attach; they do not fork the row

`ProjectionWarning` has no `provenance`, and its `name` does not always match the action's: on J-01 the
unparseable rule's warning carries `name: ".claude/rules/testing.md"` while the action for the same file
carries `name: "testing"`. Keying a warning by `(artifact, source, name)` therefore makes it its own row —
measured: a second `rule` row holding one cell and **two missing cells**.

The rule, one sentence: **a warning attaches to the row whose `(artifact, source)` it shares, choosing by
`name` when more than one such row exists, and forms its own row only when it matches none.** With it, J-01
derives 17 rows and 51 cells with **no missing cell** — 17 × 3 enabled harnesses.

##### Provenance

Taken from the action or drop when the row has one; a warning-only row takes `authored`, because every
non-agnostic warning the engine emits today is about a file in the person's own tree that the inventory read
as authored. One override sits on top and is the only producer of the model's fourth value: when the row's
`source` is an inventory skill whose `root` is `.claude/skills`, the provenance is **`harness-native`**.
Measured on J-01: `["authored", "harness-native"]` are the only two values that occur.

#### 1.4 The derivation table

Per cell, in order. **The first row that matches wins**, which is the whole of the precedence rule.

| #   | Condition                                                                                    | State              | Reason shown                               |
| --- | -------------------------------------------------------------------------------------------- | ------------------ | ------------------------------------------ |
| 1   | after a write: the action is in `applyPlan().conflicts`                                      | `conflict`         | the action's `reason`                      |
| 2   | on a read: the action is in `checkPlan().blocked`                                            | `conflict`         | the action's `reason`                      |
| 3   | the cell is a hook contributed by a package in `withheld`                                    | `pending-approval` | from `WithheldReason` (see §1.6)           |
| 4   | the action is in `checkPlan().drifted`                                                       | `drifted`          | none — the row's target says where         |
| 5   | the action is in `plan.drops`                                                                | `dropped`          | the drop's `reason`, verbatim              |
| 6   | the action is in `plan.actions` with `kind: 'native'`                                        | `native`           | the action's `reason`, when it carries one |
| 7   | the action is in `plan.actions` with `kind` in `symlink` / `scaffold` / `generate` / `merge` | `projected`        | none — the row's target says where         |
| 8   | nothing above names the cell and a `ProjectionWarning` does                                  | `warned`           | the warning's `reason`, verbatim           |

**Why `conflict` outranks `drifted`.** They mean opposite things to a person: "re-run and it fixes itself"
versus "re-running will never fix this". Only the second changes what the person does next.

**Why `pending-approval` outranks everything but `conflict`.** A withheld package's hooks are filtered out of
the plan _before_ it is built, so no action or drop names them at all — the state fills a hole rather than
overriding anything. It is placed above `drifted` so that if a future engine change ever puts a withheld hook
in the plan as well, the answer stays "a person has to decide", which is the loud, safe reading the seam
already chose when it tests refusal before approval.

**`warned` is the state of last resort and an annotation everywhere else.** A `ProjectionWarning` has two
shapes (`plan/types.ts`): _projected-but-suspect_, where the artifact **is** in `actions`, and
_read-but-unusable_, where it reached no harness at all. The first rides the cell it belongs to as
`warnings: string[]` beside whatever state row 6 or 7 gave it; the second has no action or drop to ride, so
row 8 makes `warned` its state. J-01 exercises the **first** shape only (the unparseable rule rides the
`claude-code` cell it already had); row 8 needs an installed plugin whose `hooks/hooks.json` cannot be read,
which J-01 has none of, so the unit suite stages one separately.

##### The prerequisite: row 2 is unreachable on `main`, and the banner loops because of it

Measured at `87d893503` — a project with `.agents/skills/alpha` and somebody's own **real directory** at
`.claude/skills/alpha`, which is where the projection wants its link:

```
READ    checkPlan → drifted=2  blocked=0  clean=false
APPLY   applyPlan → applied=1  conflicts=1  swept=0   (the conflict action's `reason` is undefined)
READ    checkPlan → drifted=1  blocked=0  clean=false   ← unchanged
```

Two separate faults, both on `main`:

- `isDrifted` (`apply/apply.ts:517-522`) calls a symlink target that is not a symlink **drifted**, and
  `findBlockedGenerateTargets` (`apply/generated-targets.ts:235-240`) only ever looks at `kind === 'generate'`.
  So `checkPlan().blocked` is generate-only and row 2 fires **only** on the POST's recomputed status.
- The conflict `applyPlan` returns carries no `reason` at all, so even the post-write chip would be blank.

Rendered naively, that is a banner that says "Some agent files are out of date. **Sync now**", a click that
changes nothing, and a banner that comes straight back — forever.

**Decision: the engine reports it, and `status.ts` never probes disk on its own.** A second occupant probe in
the server would recreate the exact `--check`-versus-`--fix` split one layer up, and the sentence a person
reads belongs beside the predicate that decides it. That engine change is **DOR-1855**, in review: its
`checkPlan` already runs `findBlockedSymlinkTargets` beside `findBlockedGenerateTargets`, its `isDrifted`
answers `false` for a `file`/`directory` occupant so the two lists stay exclusive, and
`apply/symlink-occupants.ts` gives each of the three shapes its own sentence (a `core.symlinks=false` clone,
a case-only name difference, and anything else real).

**If DOR-1855 has not landed when slice 2 starts, slice 2 opens with the same change**, scoped to what this
needs: a `findBlockedSymlinkTargets` in `apply/apply.ts` reading `occupantKind` from `apply/link-state.ts`
(already imported there), folded into `checkPlan().blocked`, with `isDrifted`'s symlink branch returning
`false` for a `file` or `directory` occupant. **Its seeded defect is the reproduction above**: with the change
reverted, `blocked` is `0` and the "a real directory at a link target is a conflict on a read" case reds. It
is a named prerequisite, not an assumption — and either way the derivation table is reachable end to end
before any UI reads it.

#### 1.5 `unmanaged`, exactly

> An `unmanaged (adoptable)` skill is a **real directory holding a `SKILL.md` under a harness-native skills
> root** (today: `.claude/skills`) that is **not** also present in the canonical layer (`.agents/skills`) and
> is **not** declared in `manifest.claudeOnlySkills`.

Read straight off the inventory:

```ts
inventory.skills.filter(
  (s) => s.root === '.claude/skills' && !canonicalNames.has(s.name) && !claudeOnlyNames.has(s.name)
);
```

`canonicalNames` and `claudeOnlyNames` are the same two flags `planClaudeSkillsDirSkill` already takes
(`alsoCanonical`, `listed`), so the status model reads the two facts the projector reads and never invents a
third.

The two exclusions are the definition, not an optimisation — and the first one's reason is the projector's,
not one this spec invents:

- **also canonical** — the plan's own words for this case are _"a second copy of a skill that also lives in
  `.agents/skills`; this one sits at the path DorkOS projects the canonical skill to, so it blocks that
  projection — remove it, or remove the canonical copy"_ (`plan/source-artifacts.ts:288-293`). That is not
  "nothing to adopt": it is a **blocker**, and the fix is a deletion, not a move. Calling it adoptable would
  offer the one action that makes it worse.
  **Both rows appear on the page**, because they are two files: `.agents/skills/release` and
  `.claude/skills/release` have different `source` values and therefore different row keys. The second row
  carries the sentence above on every harness cell, which is exactly what a person needs to see to resolve it.
- **declared** — a `manifest.claudeOnlySkills` entry is a person saying "this placement is deliberate". The
  plan's drop reason already says so in those words. Calling it adoptable would be arguing with a decision
  that was written down.

Measured on this repository: 13 real directories in `.claude/skills`, **0** also canonical, **13** declared,
so `counts.adoptable` is **0** here. The J-01 fixture is the opposite — 6 directories, none declared, so all
six are adoptable. The two fixtures between them exercise both exclusions.

**`unmanaged` is not a chip.** The plan already answers per-harness for a `.claude/skills` skill —
`native` where the harness reads that directory, `dropped` with the "move it to `.agents/skills` to share it"
reason where it does not (measured in §1.7). Drawing the same fact a third time in every harness column is
the "two alarms about one fact" failure the design system names for banners. It is a row-level boolean,
rendered as one line of advice under the skill's name.

**Scope limit, stated.** `.opencode/skills` and `.cursor/skills` are not inventoried, so a skill living there
is not reported as adoptable. That is SRC-07's own scope (it names `.claude/skills`), and widening the
inventory is a follow-up.

#### 1.6 `pending-approval`, and what it may say

`planWithConsent` returns `withheld: WithheldHooks[]`, each carrying a `WithheldReason` and the full
`HookProjectionRequest` — **including every command string**. The status response carries the package name,
the events, and the count. **It never carries the commands.**

| `WithheldReason`    | What the page says                                                                               |
| ------------------- | ------------------------------------------------------------------------------------------------ |
| `unasked`           | "`<package>` wants to run commands. Approve it to share its hooks."                              |
| `refused`           | "You turned down `<package>`'s commands. `dorkos harness hooks --revoke <package>` undoes that." |
| `unreadable-config` | "DorkOS couldn't read your settings, so nothing was installed on a guess." + the reason          |

**Decision: the commands stay off this route.** Why: the approval card is the surface built to show them —
secret-redacted, capped at 200 characters, quoted and escaped, with the event said in plain words
(`hook-approval.ts`). Reproducing that on a status page means reproducing four safety properties in a second
place. It also keeps the response free of file **content**, which is what lets the route use the wider
boundary validator (§Security Considerations).

#### 1.7 A worked example — the real J-01 fixture, run

The tree is the J-01 journey fixture exactly as
`packages/harness/src/__tests__/journeys/j01-claude-project-nothing-silent.test.ts:60-135` stages it: a root
`CLAUDE.md`; six skills as real directories in `.claude/skills/`; two commands; one subagent; **three** rules
(`api` with globs, `testing` whose `paths: **/*.test.ts` is the YAML trap that will not parse, `style` with no
frontmatter); hooks in both `.claude/settings.json` and `.claude/settings.local.json`; one skill declaring
hooks in its own frontmatter; a `.mcp.json` with **two** servers. No `.agents/`, no `AGENTS.md`. The manifest
enables `claude-code, codex, cursor`.

**What the engine answers at `87d893503`:**

```
inventorySourceTree  skills=6 (all .claude/skills)  commands=2  hooks=3  agents=1  rules=3  mcp=2  unreadable=1
project()            actions=25  drops=26  warnings=1  notEnabled=(absent — DOR-1851 unlanded)
checkPlan()          drifted=2  blocked=0  orphans=0  leftAlone=0  clean=false
```

**What §1.3 + §1.4 derive from it** (run, not written by hand):

```
rows=17  cells=51  (17 × 3 enabled harnesses — no missing cell)
rows by artifact:  skill 6 · hook 3 · rule 3 · mcp 2 · command 1 · agent 1 · instruction 1
counts:            { skills: 6, drifted: 2, conflicts: 0, orphans: 0, adoptable: 6, pendingApproval: 0 }
drops per harness: claude-code 1 · codex 16 · cursor 9
projectLevel:      []   (this fixture installs no marketplace plugin, so nothing is harness-agnostic)
```

`notEnabled` is `[]` for this tree even once DOR-1851 lands, and not because the field is missing: the fixture
holds no `.cursor/`, `.codex/` or `.opencode/` footprint for detection to find. A tree that does is the J-14
journey, and that is where the field is exercised.

Two rows, verbatim from the run:

```jsonc
// A skill that lives where only some agents look — six of these on this tree.
{
  "artifact": "skill",
  "provenance": "harness-native",
  "name": "release",
  "source": ".claude/skills/release",
  "adoptable": true,
  "cells": {
    "claude-code": {
      "state": "native",
      "reason": "Claude Code reads .claude/skills directly (vendor docs, 2026-09-07)",
    },
    "cursor": {
      "state": "native",
      "reason": "Cursor reads .claude/skills directly (vendor docs, 2026-09-07)",
    },
    "codex": {
      "state": "dropped",
      "reason": "kept in .claude/skills, which Codex does not read (vendor docs, 2026-09-07) — move it to .agents/skills to share it, or list it in manifest.claudeOnlySkills to say the Claude-only placement is deliberate",
    },
  },
}
```

```jsonc
// The warning case: it rides the cell it belongs to rather than forking a row.
{
  "artifact": "rule",
  "provenance": "authored",
  "name": "testing",
  "source": ".claude/rules/testing.md",
  "adoptable": false,
  "cells": {
    "claude-code": {
      "state": "native",
      "reason": "Claude Code reads .claude/rules/*.md and applies each rule to the files its \"paths\" frontmatter names (vendor docs, 2026-09-07)",
      "warnings": [
        ".claude/rules/testing.md has frontmatter this reader cannot parse, so its \"paths\" globs were not read",
      ],
    },
    "codex": {
      "state": "dropped",
      "reason": "Codex has no path-scoped rules format — its only per-directory mechanism is a nested AGENTS.md (vendor docs, 2026-09-07)",
    },
    "cursor": {
      "state": "dropped",
      "reason": "not projected yet — Cursor keeps path-scoped rules in .cursor/rules/*.mdc under a \"globs\" key, and ignores a plain .md there (vendor docs, 2026-09-07)",
    },
  },
}
```

The envelope around them:

```jsonc
{
  "projectPath": "/Users/x/acme",
  "state": "ready",
  "computedAt": "2026-09-08T08:42:00.000Z",
  "enabled": ["claude-code", "codex", "cursor"],
  "notEnabled": [],
  "clean": false,
  "counts": {
    "skills": 6,
    "drifted": 2,
    "conflicts": 0,
    "orphans": 0,
    "adoptable": 6,
    "pendingApproval": 0,
  },
  "orphans": [],
  "sweepPreview": [],
  "rows": [/* the 17 above */],
  "projectLevel": [],
  "pendingApproval": [],
  "warnings": [],
}
```

Three things this example is meant to make undeniable:

- **The six `.claude/skills` skills are not invisible.** Since DOR-1845 the plan names each one for each
  harness. What was missing was somewhere to draw it.
- **`adoptable: true` on all six** is what a person with a Claude-first repo actually has, and it is the fact
  DOR-1853 needs a screen for.
- **26 drops reach the page** — 16 for Codex, 9 for Cursor, 1 for Claude Code — and every one of them is a
  sentence the terminal already prints. The panel is a rendering of that list, not a summary of it.

### 2. The API

Both routes live in a new `apps/server/src/routes/harness.ts`, mounted at `/api/harness` in
`apps/server/src/index.ts` beside its neighbours, and hand-registered in
`apps/server/src/services/core/openapi-registry.ts` (the legacy half — no capability projects these paths).
`docs/api/openapi.json` is regenerated with `pnpm docs:export-api`; `docs-openapi-check` is the gate.

#### 2.1 `GET /api/harness/status?projectPath=<absolute path>`

Answers `200 HarnessStatusResponse` in every case a person's project can be in. It is a **read**, and the
route's own module doc states the rule it inherits:

> **This route never writes.** `dorkos harness sync --check` learned this the hard way (DOR-678, contract
> AP-03): run in a folder with no manifest, it quietly scaffolded one into whatever directory the person was
> standing in. The route must not scaffold, must not create a config store, and must not repair anything.

Concretely, three things are deliberately not done:

- **No `scaffoldManifest`.** A project with no manifest answers `state: 'not-set-up'`.
- **No `enableHarnessInManifest`.** The not-enabled notice is copy.
- **No store creation.** The route runs inside the server, whose `conf` store is already open, so
  `storedHookDecisions()` is the correct reader and writes nothing. `readHookDecisionsFromDisk` exists for the
  **CLI**, a separate process where opening the store would create the file — that is DOR-678's rule and it
  does not transfer to the server. Stated because "never open the config store" reads like it should.

**Four states, one field.**

| `state`       | When                                                       | What else is populated                          |
| ------------- | ---------------------------------------------------------- | ----------------------------------------------- |
| `ready`       | the manifest parsed                                        | everything                                      |
| `not-set-up`  | no `.agents/harness.manifest.json`                         | `projectPath`, `state`, empty lists             |
| `unreadable`  | there is one and it will not parse                         | `state`, `detail` (the parse failure, in words) |
| `unavailable` | this build has no harness service (the Obsidian transport) | `state`, `detail`                               |

**`not-set-up` is a `200`, not a `404`.** A `404` says the route is not there. A project with no manifest is a
project in a state the page is built to render — "DorkOS isn't sharing agent files for this folder yet" — and
turning that into an error class makes every caller re-derive the difference between "no such endpoint" and
"nothing set up here".

**Failures that are still failures:** a missing, blank or **relative** `projectPath` is `400`; a path outside
the boundary is `403`; an unexpected throw is `500` with the message logged, not echoed.

Two more the first draft of this section missed, both settled at implementation (DOR-1892):

- **A `projectPath` that leads nowhere is `404`, not a `200 not-set-up`.** The status model reads `ENOENT`
  the same way whether a project is empty or absent and says so in its own docs, and the boundary validator
  does **not** settle it either — measured, `validateBoundaryOrDorkHome` canonicalizes a not-yet-existing path
  through its deepest existing ancestor and RETURNS it, which is deliberately what lets a workspace about to
  be cloned validate. So the route takes one `stat` after the boundary check. Telling somebody "DorkOS isn't
  sharing agent files for this folder yet" about a folder that is not there is the thing this prevents, and
  `404` is what `GET /api/directory` — the other route on this validator — already answers.
- **A `projectPath` that is a file, not a directory, is `400`.** The same `stat`, the same neighbour's answer
  (`Not a directory`). Without it the manifest read fails with `ENOTDIR` rather than `ENOENT` and the caller
  gets `unreadable` carrying a raw `ENOTDIR: not a directory, open …` where the parse-failure sentence belongs.

**Relative is refused rather than resolved.** `path.isAbsolute` is checked in the route, not in
`HarnessStatusQuerySchema`: that schema lives in `@dorkos/shared/harness-schemas`, which the client is built to import,
and `node:path` is both a Node module and a platform-dependent answer (`C:\…` is absolute on Windows and not
on POSIX). A relative path would otherwise resolve against the server's own `process.cwd()` — still
boundary-checked, so nothing escapes, but the answer describes a directory the caller never named, chosen by
wherever the operator started the process.

#### 2.2 `POST /api/harness/sync`

Body `{ projectPath: string }`. Answers `200 HarnessSyncResponse`:

```ts
{
  status: HarnessStatusResponse;       // recomputed after the apply — see §2.2.6
  applied: number;
  swept: string[];                     // repo-relative paths this call deleted
  conflicts: number;
  askedAbout: string[];                // package names a card was raised for
}
```

**A project with no manifest answers `409`**, not `200` and not `500`. `loadManifest` throws `ENOENT` there,
so the route probes for `.agents/harness.manifest.json` before it reaches the seam and answers
`{ error, code: 'harness_not_set_up', message }`. A sync on a project that syncs nothing is not a success with
zero work done — it is a request against a project that is not in a state where the verb means anything, and
the page never offers the button in that state, so a 4xx is only reachable by a caller that ignored the
status.

**It goes through `projectWithConsent(projectPath, { dorkHome, sweepOrphans: true })`** — the one seam. Never
`project()`; `__tests__/project-seam-guard.test.ts` refuses it, and the refusal is the point.

##### 2.2.1 `sweepOrphans: true` — the decision, why it is safe, and what the person is told first

**Decision: yes, and never silently.**

Two reasons for the sweep:

- **A Sync button is the full-plan case.** `applyPlan`'s doc says the sweep wants a full, unfiltered plan, and
  this route builds one — it takes no harness filter, and `projectWithConsent` _throws_ if a filter is ever
  combined with a sweep, so the constraint is enforced rather than remembered.
- **Without the sweep the button cannot do the job it is on the page for.** Half of what the banner reports is
  orphaned links — `.claude/skills/<x>` pointing at a skill somebody deleted or renamed. `checkPlan` counts
  orphans against `clean`, so a sync that does not sweep leaves the banner up after the person clicks it. That
  is the exact failure `reportCheck` documents in the CLI: "a `--check` that reports something the `--fix` it
  recommends would NOT remove is a non-zero exit the person can never clear".

**Why HK-11 does not recur.** HK-11 was a sweep deleting three hand-written hooks files — including one for a
harness the manifest did not even name — because the engine had no way to prove which generated files were
its own. That proof now exists: a generated per-harness hooks file is owned only when its `.dorkos-generated`
sidecar matches (`apply/generated-ownership.ts`, DOR-1842), the sweep is scoped to enabled harnesses, and
`apply-ownership.property.test.ts` holds AP-07 — the engine only ever deletes what it wrote. J-09 pins the
residual in the other direction: a **hand-edited** `.codex/hooks.json` is neither repaired nor swept; it stays
`blocked` and the tree stays unclean until the person moves it.

**But a provable delete is still a delete, and one click was about to do it in silence.** Measured at
`87d893503` — a project whose `.agents/skills/beta` was projected and then removed:

```
READ    checkPlan → drifted=0  blocked=0  orphans=[".claude/skills/beta"]  clean=false
APPLY   applyPlan → swept=[".claude/skills/beta"]     the file is gone
```

Rendered from the response as first drafted, the person saw "Some agent files are out of date. **Sync now**",
clicked, and got "Agent files updated." Nothing named the file that had just been deleted. The terminal has
never behaved that way: `reportCheck` prints _"Orphaned projections — what they came from is gone (N):"_ with
every path **before** a `--fix`, and `reportFix` prints _"Swept N orphaned projection(s) — what they came from
is gone:"_ with every path after (the heading said "Orphaned links — the skill they pointed at is gone" until
Slice 2b widened the list past links; DOR-1889). The page mirrors both:

- **Before the click** the response carries `sweepPreview: string[]` — **every** path a sync would remove —
  and the banner names them in a disclosure region (§User Experience). The field is in the response rather
  than derived on the client precisely so a renderer cannot forget it.
- **After the click** the POST's `swept` is rendered as a "What changed" summary listing every path. Not a
  toast alone: a list of deleted files is not a thing that should fade after four seconds.

**The contract is equality, not containment: `sweepPreview` is exactly the set the next `swept` returns.**
"Most of what will be deleted" is not a warning; it is a warning with a hole in it, and the hole is where the
surprise lives.

##### The engine cannot answer that question yet, and Slice 2b is the fix

`applyPlan().swept` is the union of **six** sweeps (`apply/apply.ts:501-509`): installed orphans, authored
orphans, generated orphans, generated command orphans, OpenCode command orphans, and the settings-hooks
orphan. `checkPlan().orphans` is **one** of them — `findOrphanedAuthoredLinks` alone
(`apply/apply.ts:584`), which explicitly skips anything carrying the installed-projection marker
(`apply/authored-orphans.ts:59`). Only the authored sweep has ever been split into a `find*` and a `sweep*`;
the other five enumerate and delete in a single pass, so nothing outside an apply can ask them what they
would take.

Measured at `87d893503`, a repo enabling `claude-code, codex, opencode` with one authored skill and one
project-scoped plugin shipping skills, commands and hooks — the person deletes the skill and uninstalls the
plugin:

```
READ    checkPlan → drifted=0  blocked=0  clean=false  orphans=[".claude/skills/alpha"]
APPLY   applyPlan → swept = [".agents/skills/acme__greet", ".claude/skills/acme__greet",
                             ".claude/skills/alpha", ".codex/hooks.json",
                             ".codex/hooks.json.dorkos-generated", ".claude/commands/acme/.gitignore",
                             ".claude/commands/acme/hello.md", ".opencode/commands/.gitignore",
                             ".opencode/commands/acme-hello.md", ".claude/settings.local.json"]

preview: 1 path.   the click: 10.
```

And with **only** the plugin uninstalled, it is worse than an undercount:

```
READ    checkPlan → clean=TRUE   orphans=[]        ← no banner is drawn at all
APPLY   applyPlan → swept = 9 paths
```

A tree the engine calls clean, and a sync that deletes nine files. That is a pre-existing gap in `checkPlan`,
not one this work introduces — but a page built on top of it would ship the gap to a person as a button, so
this spec fixes it rather than promising around it.

**Slice 2b splits the other five sweeps the way the authored one already is** — each keeps its enumeration in
a `find*` and its deletion in a `sweep*` that calls it — and `checkPlan().orphans` returns the **union**, with
`clean` false whenever any of them is non-empty. Two things follow, both stated so they are not discovered:

- **`dorkos harness sync --check` starts reporting a case it was silent about**, and exits non-zero where it
  exited 0. That is the correct direction of `reportCheck`'s own rule — a `--check` that stays silent about
  something a `--fix` **will** remove is the same lie as one that reports something a `--fix` will not.
- **The widened set inherits the harness-filter guard.** `reportCheck` already zeroes orphans under
  `--harness <id>` (`harness-sync-command.ts:310`) because a filtered plan reads another harness's live
  projections as orphans — the same hazard `projectWithConsent` refuses outright when a filter meets a sweep.
  Widening the set widens that hazard, so the guard moves with it.

**Slice 7 may not ship before Slice 2b.** Not a preference: a banner that undercounts a destructive click is
worse than no banner, because it teaches a person the list is the whole list.

**Two guards this PR adds on top**, both as tests rather than as prose: an exact before/after tree diff over a
sync that sweeps an uninstalled package's projections and touches nothing authored; and an assertion that a
hand-written hooks file with no sidecar survives the button.

##### 2.2.2 Who asks about withheld hooks

**Decision: the route asks, through an extracted asking half — not a new `syncWithConsent`.**

`runAutoProjection` owns this sequence today: project with the unapproved packages' hooks withheld; filter the
withheld list through `mayAskAboutHooks` (skipping what is already refused or already on screen); raise one
card per package, all before any is awaited; on a yes, `recordHookApproval` **and then project a second
time** — the re-projection is real (`auto-project.ts:301-303` calls `projectAndLog` again), because the first
pass deliberately left those hooks out.

The whole sequence, re-projection included, is lifted into:

```ts
// apps/server/src/services/harness/ask-withheld-hooks.ts
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

`runAutoProjection` passes `reproject: () => projectAndLog(ctx, dorkHome)` — which is where its `packageName`
and `action` still live, so nothing about its log lines changes. The route passes a `reproject` that calls
`projectWithConsent` with the same `sweepOrphans: true` it used on pass one. The caller keeps what is
caller-specific; the module keeps only the asking and the recording.

Two reasons for this shape:

- **A second `*WithConsent` function is exactly what the seam guard exists to prevent.**
  `project-with-consent.ts` is "the only non-test module allowed to call `project(`", and the reason given is
  that every new trigger reaching for its own projection is how hooks nobody allowed get installed. Adding
  `syncWithConsent` beside it would either duplicate the seam or route around it.
- **The asking half is not projection.** It raises cards, records answers and calls back; it builds no plan.
  Extracting it therefore moves nothing across the guarded line and the guard's allowlist does not grow.

**The POST does not wait for the cards.** `runAutoProjection`'s promise "stays unresolved while an approval is
pending, which is why the install route treats this as fire-and-forget". A button that hangs on a modal is
worse than one that returns and says what is waiting: the response carries `askedAbout` and the returned
status carries `pendingApproval`, and the page says "One package is waiting for your approval". Pass two runs
on its own when the person answers; §2.2.6 says how the page finds out.

##### 2.2.3 The capability tier

**Decision: `POST /api/harness/sync` is not registered as a capability in v1**, and if it is ever surfaced to
agents it is **`act`**, never `destructive`.

- _Not registered_ because it has no agent-facing surface: an agent that installs a package already gets
  projection through `runAutoProjection`, and DOR-1850's watcher will cover the rest. A capability nobody
  invokes is a tool description and a tier gate maintained for no caller.
- _`act`, not `destructive`_, for the reason `hook-approval.ts` states about its sibling: promoting
  `marketplace.install` to `destructive` "would put an approval card in front of every ordinary install, which
  is the routine-card harm this repo has refused twice (DOR-504, DOR-506)". A re-sync is the routine action
  here; the part of it that actually runs code — a package's hooks — already has its own card, on the content
  rather than on the verb. The sweep is the destructive-shaped half, it removes only files the engine can
  prove it wrote, and §2.2.1 makes it announced rather than silent, which is the mitigation a card would
  otherwise be standing in for.
- The tier is written down in the route's module doc so that the day somebody adds the MCP surface, the
  argument is already made and does not get re-litigated as `destructive`.

##### 2.2.4 Who may call it

**Decision: a person, not an agent** — the `refuseUntrustedSourceWrite` shape from `routes/marketplace.ts`:

```ts
if (!resolveDecisionAuthority(readCallerAuthority(req, res)).allowed) return res.status(403).json({ … });
```

Read deliberately through `resolveDecisionAuthority` rather than `trustedCaller`: this wants the **agent bar**
— refuse anything naming itself an agent or holding an approval token — and not the cookie requirement
DOR-474 put inside `trustedCaller`, which would lock out a person's own terminal. Same reasoning as DOR-502,
recorded there in full.

The **GET** carries no such bar. It is a read of names, paths and reasons about a project the caller can
already see, it is the same information `dorkos harness sync --check` prints to anyone with a shell, and
gating it would make an agent unable to answer "what can you see?" about itself.

##### 2.2.5 Concurrency

A sync and a marketplace install can land on one project at once — AP-10, and the reason DOR-1854 exists.
The route takes `withProjectLock(projectPath, …)` if DOR-1854 ships one. If DOR-1854 lands as the _proof_ that
the apply already converges, the route needs no change and the spec's assumption is discharged.

##### 2.2.6 The returned status is what the page renders

The mutation's `onSuccess` writes `response.status` into `harnessKeys.status(projectPath)` with
`queryClient.setQueryData` and **does not invalidate**. Invalidating would throw away the one answer that
knows about `applyPlan().conflicts` — derivation row 1, the only row that can distinguish "a person has to
move a file" from "re-run and it fixes itself" while DOR-1855 is unlanded — and replace it with a fresh read
that has forgotten. The freshness that a refetch would have bought comes back through the query's own
`staleTime: 30_000` and its refetch-on-mount, plus one subscription:

**`useEventSubscription('approval_resolved', …)`** — the same global-stream hook
`entities/attention/model/use-pending-approvals.ts:134` already uses — invalidates
`harnessKeys.status(projectPath)` when any approval is decided. That is how the page notices pass two of
§2.2.2 finishing, without polling and without the POST hanging.

### 3. Code structure

```
packages/shared/src/harness-schemas.ts             # NEW — the response contract + the harness vocabulary
packages/shared/package.json                       #   + "./harness-schemas" in the exports map
packages/shared/src/transport.ts                   #   + getHarnessStatus / syncHarness

packages/harness/package.json                      #   + "@dorkos/shared": "workspace:*" (dependencies)
packages/harness/src/manifest/schema.ts            # HARNESS_IDS / HarnessIdSchema / HarnessId /
                                                   #   HARNESS_LABELS become re-exports from @dorkos/shared
packages/harness/src/apply/apply.ts                # findBlockedSymlinkTargets in checkPlan — DOR-1855's, or
                                                   #   slice 2's own if it has not landed (§1.4)
packages/harness/src/plan/installed-projector.ts   # one copy fix (§User Experience, "Reasons, verbatim")
packages/harness/src/__tests__/reason-vocabulary.test.ts   # NEW — the retired-word guard (§Testing)

apps/server/src/services/harness/status.ts         # NEW — buildHarnessStatus(); the derivation table
apps/server/src/services/harness/ask-withheld-hooks.ts  # NEW — the asking half, lifted from auto-project.ts
apps/server/src/services/harness/auto-project.ts   # now calls ask-withheld-hooks.ts with its own `reproject`
apps/server/src/routes/harness.ts                  # NEW — GET /status, POST /sync
apps/server/src/index.ts                           #   + app.use('/api/harness', createHarnessRouter(deps))
apps/server/src/services/core/openapi-registry.ts  #   + two registerPath calls

apps/client/src/layers/entities/harness/           # NEW slice
  index.ts
  model/query-keys.ts                              #   harnessKeys.status(projectPath)
  model/use-harness-status.ts
  model/use-harness-status-cached.ts               #   reads the cache, never fetches (Decision 28)
  model/use-harness-sync.ts
  lib/harness-status.ts                            #   pure display helpers: chip word, tone, drop grouping
  ui/HarnessStateChip.tsx
  ui/SkillHarnessRow.tsx
  ui/SkillsWithHarnessesList.tsx
  ui/NotSharedPanel.tsx
  ui/HarnessDriftBanner.tsx
  ui/HarnessSyncSummary.tsx                        #   the "What changed" block (§2.2.1)
apps/client/src/layers/shared/lib/transport/harness-methods.ts   # NEW — HttpTransport half
apps/client/src/layers/shared/lib/transport/{http-transport,index}.ts
apps/client/src/layers/shared/lib/embedded-mode-stubs.ts         #   + the two stubs
apps/client/src/layers/features/profile/ui/pages/SkillsPage.tsx  # composes the new slice
apps/client/src/layers/features/profile/model/use-managed-agent-facts.ts  # a cached, never-fetching count
apps/client/src/layers/entities/marketplace/ui/SkillPacksList.tsx        # DELETED
apps/client/src/layers/entities/marketplace/index.ts                     #   - the export
apps/client/src/dev/showcases/HarnessStatusShowcases.tsx                 # NEW playground showcase
apps/client/src/dev/playground-registry.ts                               #   + its entry

packages/test-utils/src/mock-factories.ts          #   + the two Transport methods
apps/e2e/fixtures/rooms-api.ts                     #   registerAgent gains an optional pre-staged `path`;
                                                   #   `agentRoot` becomes readable (§Testing, T7)
apps/e2e/fixtures/harness-repo.ts                  # NEW — stages a repo under that root and cleans it up
apps/e2e/fixtures/index.ts                         #   + the fixture
apps/e2e/tests/harness/skills-page.spec.ts         # NEW — T7, on the default leg (§Testing, T7)
```

**FSD placement.** `entities/harness` and not `features/harness`: it is "a path in, a list out", the same
reasoning `SkillPacksList`'s own doc gives for living in `entities/marketplace`. The profile **feature**
composes it, which is the allowed direction (`features → entities → shared`). Nothing in the slice imports a
feature, and the page imports it through the barrel.

**Why the status model is in `apps/server/src/services/harness/` and not in `packages/harness`.** Two of the
eight states need the consent record. `hook-approval.ts` already answered why the engine may not hold one:
_"That package is a pure projection engine with no approval primitive and no config store, and dragging both
into it for one call site would be an architectural regression."_ Putting the assembly in the route instead
would guarantee the CLI can never share it — which is VC-01's own complaint arriving a second time. It is a
plain function over an options bag, and `planWithConsent` already accepts a `decisions` override precisely so
the CLI can pass the copy it reads off disk (DOR-678); `buildHarnessStatus` forwards it.

**Why the harness vocabulary moves down into `@dorkos/shared`.** The client needs `HarnessId` and
`HARNESS_LABELS` to draw a chip row. It cannot import them from `@dorkos/harness`, which is a Node filesystem
engine, and `@dorkos/shared` cannot depend on `@dorkos/harness` either: `harness → skills → shared` is an
existing edge, so the reverse one is a cycle. Re-declaring the six ids in shared is duplication that goes
stale on the day a seventh harness lands. So `HARNESS_IDS`, `HarnessIdSchema`, `HarnessId` and
`HARNESS_LABELS` move to `packages/shared/src/harness-schemas.ts`; `packages/harness` declares
`@dorkos/shared` as a dependency (the edge `harness → skills → shared` already implies) and
`packages/harness/src/manifest/schema.ts` re-exports all four — every existing import keeps working and there
is exactly one definition. `vendor-facts.test.ts` already asserts no id in `HARNESS_IDS` lacks a skills row,
so the move inherits a guard rather than needing a new one.

### 4. The response schema

`packages/shared/src/harness-schemas.ts`, exported at `@dorkos/shared/harness-schemas`. The two exported
types are **`HarnessStatusResponse`** and **`HarnessSyncResponse`**, and those names are used everywhere —
the schema, the route, the `Transport` signature, the client hooks and the mock factory.

```ts
export const HARNESS_IDS = ['claude-code', 'codex', 'cursor', 'gemini', 'copilot', 'opencode'] as const;
export const HarnessIdSchema = z.enum(HARNESS_IDS);
export const HARNESS_LABELS: Readonly<Record<HarnessId, string>> = { … };

export const HarnessCellStateSchema = z.enum([
  'native', 'projected', 'drifted', 'dropped', 'warned', 'conflict', 'pending-approval',
]);

/** What kind of agent file a row is about. Mirrors the engine's `ArtifactType`. */
export const HarnessArtifactKindSchema = z.enum([
  'skill', 'instruction', 'hook', 'command', 'plugin', 'agent', 'rule', 'mcp',
]);

/** Where the file came from. `harness-native` is this model's fourth value; the engine has three. */
export const HarnessProvenanceSchema = z.enum(['authored', 'installed', 'adopted', 'harness-native']);

export const HarnessCellSchema = z.object({
  state: HarnessCellStateSchema,
  reason: z.string().optional(),
  target: z.string().optional(),
  warnings: z.array(z.string()).optional(),
});

export const HarnessRowSchema = z.object({
  artifact: HarnessArtifactKindSchema,
  provenance: HarnessProvenanceSchema,
  name: z.string(),
  source: z.string().optional(),
  adoptable: z.boolean(),
  cells: z.record(HarnessIdSchema, HarnessCellSchema),
});

/**
 * A project-level entry: about no harness at all (§1.3). Shipped with four kinds
 * rather than the two drafted here — `write` for a file a sync creates that
 * reaches no column (DOR-1891), and `notice` for what is wrong with the manifest
 * itself, carried verbatim from `manifestNotices` (DOR-1906).
 */
export const HarnessProjectEntrySchema = z.object({
  kind: z.enum(['drop', 'warning', 'write', 'notice']),
  artifact: HarnessArtifactKindSchema,
  name: z.string(),
  source: z.string().optional(),
  target: z.string().optional(),
  reason: z.string(),
});

export const HarnessPendingApprovalSchema = z.object({
  packageName: z.string(),
  events: z.array(z.string()),
  commandCount: z.number().int().nonnegative(),
  reason: z.enum(['unasked', 'refused', 'unreadable-config']),
  detail: z.string().optional(),
});

export const HarnessStatusResponseSchema = z.object({
  projectPath: z.string(),
  state: z.enum(['ready', 'not-set-up', 'unreadable', 'unavailable']),
  detail: z.string().optional(),
  computedAt: z.string(),
  enabled: z.array(HarnessIdSchema),
  notEnabled: z.array(z.object({ harness: HarnessIdSchema, signal: z.string() })),
  clean: z.boolean(),
  counts: z.object({
    /** Rows whose `artifact` is `skill` — see below. */
    skills: z.number().int().nonnegative(),
    drifted: z.number().int().nonnegative(),
    conflicts: z.number().int().nonnegative(),
    orphans: z.number().int().nonnegative(),
    adoptable: z.number().int().nonnegative(),
    pendingApproval: z.number().int().nonnegative(),
  }),
  /**
   * Every path a sync would delete — the union of all six sweeps, equal to the
   * next `swept`, never a subset of it (§2.2.1, and Slice 2b, which is what
   * makes the engine able to answer it).
   */
  sweepPreview: z.array(z.string()),
  rows: z.array(HarnessRowSchema),
  projectLevel: z.array(HarnessProjectEntrySchema),
  pendingApproval: z.array(HarnessPendingApprovalSchema),
});

export const HarnessSyncResponseSchema = z.object({
  status: HarnessStatusResponseSchema,
  applied: z.number().int().nonnegative(),
  swept: z.array(z.string()),
  conflicts: z.number().int().nonnegative(),
  askedAbout: z.array(z.string()),
});
```

**`counts.skills` is a count of ROWS, not of inventory entries.** A skill present in both `.agents/skills` and
`.claude/skills` is two files and two rows (§1.5), and it counts twice — because the number under the profile
row has to match the number of rows the page draws. Measured: 6 on J-01, 31 on this repository.

**There is no `drops` map.** An earlier draft carried `drops: Record<HarnessId, Drop[]>` beside `rows`, which
is pure duplication once the row key is right: every non-agnostic drop is a cell of some row, so the "Not
shared with `<harness>`" panel is a client-side grouping over `rows` in `lib/harness-status.ts`. Measured on
this repository, that duplication cost **46,244 bytes versus 32,415** — 30% of the payload, for the same
facts twice. `projectLevel` stays, because a harness-agnostic entry is a cell of nothing (§1.3).

**Two vocabularies, one compiler check.** `HarnessArtifactKindSchema` and `HarnessProvenanceSchema` restate
the engine's `ArtifactType` and `Provenance` rather than moving them, because the second has a fourth value
the engine's does not (`harness-native`) and the first is documented as _what the projector plans_, which is a
different subject from _what the page draws_. Drift is caught at compile time: `status.ts` maps between them
through a `satisfies Record<ArtifactType, z.infer<typeof HarnessArtifactKindSchema>>` table — the same
technique `plan/source-artifacts.ts` uses so "the compiler names the gap" when a kind is added.

`adopted` never occurs in v1: nothing produces an adopted projection yet (SRC-10). It is in the enum because
the engine's `Provenance` has it and dropping it would make the mapping table lie.

### 5. `Transport`

```ts
/** Read what DorkOS shares with each agent tool for one project. Never writes. */
getHarnessStatus(projectPath: string): Promise<HarnessStatusResponse>;

/** Apply the projection plan for one project and answer with the recomputed status. */
syncHarness(projectPath: string): Promise<HarnessSyncResponse>;
```

- `HttpTransport` — `apps/client/src/layers/shared/lib/transport/harness-methods.ts`, following
  `marketplace-methods.ts`: `fetchJSON` + `buildQueryString`, no path segments to encode.
- `DirectTransport` (Obsidian) — `embedded-mode-stubs.ts`. `getHarnessStatus` resolves
  `{ state: 'unavailable', detail: 'Agent file sharing runs in the DorkOS app.', … }`; `syncHarness`
  throws `'Agent file sharing is not supported in embedded mode'`, matching the file's stated convention
  ("empty arrays for list operations, descriptive errors for write/mutation operations"). **The read returns
  `unavailable` rather than an empty list on purpose**: an empty list would tell an Obsidian user they have no
  skills, which is the same lie this whole spec is fixing.
- `packages/test-utils/src/mock-factories.ts` gains both, defaulting to a clean `ready` status.

## User Experience

### The Skills page

Route: the agent profile's existing **Skills** page (`?profilePage=skills`), reachable from the `skills` row
in the Toolkit section, in the docked panel, the sheet and the full-page profile alike. No new route.

Top to bottom:

1. **The "What changed" summary** — after a sync, in place of the banner, until dismissed or navigated away.
2. **The banner** — at most one, only when the tree is not clean.
3. **The not-enabled notice** — its own row, when `notEnabled` is non-empty.
4. **The skills list** — one row per skill.
5. **A "Not shared with `<harness>`" panel per enabled harness**, collapsed by default, each row an artifact
   and its reason.
6. **A "Project-level notices" panel**, when `projectLevel` is non-empty.
7. **"Browse skill-packs"** — the existing marketplace link, unchanged, still at the foot.

#### The banner

One condition, one message, one action — and the action only when it does something.

| Condition (first match wins)                      | Message                                                             | Action     |
| ------------------------------------------------- | ------------------------------------------------------------------- | ---------- |
| `counts.drifted > 0 \|\| sweepPreview.length > 0` | "Some agent files are out of date." **+ the removal warning below** | "Sync now" |
| `counts.conflicts > 0`                            | "DorkOS can't update some files. Something else is in the way."     | none       |
| `counts.adoptable > 0`                            | "Some skills live where only a few of your agents look."            | none       |
| otherwise                                         | — nothing is drawn —                                                | —          |

**The removal warning is not optional.** When `sweepPreview` is non-empty the banner carries a `details`
disclosure — the collapsible region the `Banner` component already supports — headed
**"Syncing also removes 2 files DorkOS put here"** and listing every path. The heading counts FILES and not
links: since Slice 2b (DOR-1889) `sweepPreview` is every one of the six sweeps, so the list holds command
wrappers, generated hooks files and their sidecars as well as skill links. One path in it is not a deletion —
`.claude/settings.local.json` keeps every key the person owns and loses only the hook entries DorkOS merged
in — and the row for it says so, exactly as the terminal's does. A person is told what a click deletes
**before** the click, which is what the terminal has always done (`reportCheck`'s "Orphaned projections —
what they came from is gone (N):"). A banner with a destructive action and no manifest of it is the
failure §2.2.1 reproduces.

- **Not the app-wide `AppBannerSlot`.** That slot ranks one banner for the whole app; this condition is about
  one project on one page, and a project-scoped fact in a global slot would follow the person to every route.
  It is an inline notice at the top of the page, using the same `Banner` component and the same `info` /
  `warning` tones.
- **No red, and no count in the nav.** Drift is not an error — it is a file that has not been written yet.
  `info` tone for drift and adoptable, `warning` for a conflict and for the removal disclosure, `critical`
  never. The profile's `skills` row grows no badge: a number in the nav is a second alarm about a fact the
  page already states, which is the failure the design system names for banners.
- **It clears by being recomputed, not by being dismissed.** After a successful sync the returned status
  replaces the cached one (§2.2.6) and the banner re-renders from it. There is no `onDismiss`.

#### The "What changed" summary

Rendered from the POST's response, in the banner's place:

> **Agent files updated.** 4 files written.
> **Removed 2 links whose skill is gone:** `.claude/skills/beta` · `.claude/skills/gamma`

Dismissible, and gone on the next navigation. A toast fires beside it for the "it worked" moment
("Agent files updated."), because that is what a toast is for — but the list of deleted paths lives in the
page, not in something that fades. When cards were raised the summary adds one line:
"One package is waiting for your approval."

#### A skill row

Two lines, plus a third when the skill is adoptable.

```
release                                              .claude/skills/release
[Claude Code reads it]  [Cursor reads it]  [Codex can’t see it]
Lives in .claude/skills. Move it to .agents/skills so every agent can read it.
```

- **Line 1** — the skill name, and its source path muted and right-aligned, truncated from the left with the
  full path in `title`.
- **Line 2** — the chip row. One chip per **enabled** harness, in manifest order, wrapping with `flex-wrap`.
- **Line 3** — present only when `adoptable`, muted, one sentence. No button (§16 D3).

**One layout, no breakpoint.** The chips wrap. That is the whole mobile answer: a docked panel at its
narrowest, a phone sheet and a full-page profile all get the same rows with the chips falling onto a second
line. A second layout would be a second thing to keep true, and the alternative — a sideways-scrolling chip
strip — hides state behind a gesture on the one surface whose job is to show state.

**The healthy row collapses.** When every enabled harness is `native` or `projected`, the row draws one chip —
"Shared with all 3" — instead of three identical ones. Any exception expands the row to the full chip row
automatically. A page-level "Show every agent tool" toggle expands them all (component `useState`; this is a
view preference for one visit, not app state). The reason is the 31-skill case: a wall of identical chips is
what a person has to read _past_ to find the one row that matters. The collapsed chip is a button and its
`title` names the harnesses, so nothing is unreachable.

**Chip words**, one per state, plain:

| State              | Chip                        | Tone    |
| ------------------ | --------------------------- | ------- |
| `native`           | "`<harness>` reads it"      | neutral |
| `projected`        | "`<harness>` shared"        | neutral |
| `drifted`          | "`<harness>` out of date"   | info    |
| `dropped`          | "`<harness>` can’t see it"  | muted   |
| `warned`           | "`<harness>` may not work"  | warning |
| `conflict`         | "`<harness>` blocked"       | warning |
| `pending-approval` | "`<harness>` needs your OK" | warning |

Every chip carries its `reason` as its accessible description and its `title`; a chip with no reason (a plain
`projected`) carries its target path instead. A cell with `warnings` keeps its state chip and gains a small
marker whose description is the warning text. Nothing that has a reason hides it — the panel below repeats it
in full, so the tooltip is a convenience, never the only copy.

#### The not-enabled notice

> **Cursor files are in this folder, but DorkOS isn't sharing to it.**
> Run `dorkos harness sync --fix --enable cursor` in this folder to turn it on.

**Decision: copy only, no button in v1.** `enableHarnessInManifest` writes `.agents/harness.manifest.json` —
a committed, team-shared file — as a deliberately minimal key-add that preserves key order and formatting,
argued against ADR-0302 in DOR-1851's own amendment. A button in a side panel that edits a committed file with
no diff and no undo is a bigger promise than the fact it fixes. Exposing it from the app is its own change with
its own review; the follow-up is listed below.

#### "Not shared with `<harness>`" and the project-level panel

One collapsed panel per enabled harness that has `dropped` cells, headed with the harness label, each row
`<kind> <name>` and the reason **verbatim** — grouped on the client from `rows`, so there is one copy of each
sentence in the response. This is Priya's honesty gate, and the reason it is verbatim is that the CLI prints
the same string: if the page paraphrased, two surfaces would describe one fact in two voices and a person
could not tell which one was current. Measured on J-01: 16 rows under Codex, 9 under Cursor, 1 under Claude
Code.

Beneath them, **"Project-level notices"** renders `projectLevel` — the `harnessAgnostic` entries of §1.3,
which are about a package rather than about any harness. It mirrors the CLI's `plugin layers:` heading and
exists so that a project running only Codex is never shown a notice filed under Claude Code.

**Reasons, verbatim — with one copy fix in the same PR.** One engine string reads
`plugin layer "adapters" is not a portable harness asset — messaging adapters run inside DorkOS, not in a
harness` (`installed-projector.ts`). The quoted layer name is what a package author writes and is the
Connections ADR's own carve-out, but the prose half is a retired user-facing noun. It becomes
`— Messaging runs inside DorkOS, not in a harness`. Neither vocabulary gate can see `packages/harness`
(`check-vocab-gate.ts:165` scans three `apps/*/src` roots; `check-banned-words.sh:83-94` scans a literal file
list plus `docs/` and `blog/`), so a hand sweep would rot. Slice 7 adds a small guard test in the package
instead (§Testing, "Reason vocabulary").

#### States

| State                | What is drawn                                                                                                                               |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| loading              | three skeleton rows, no spinner                                                                                                             |
| error                | "Couldn't load skills." + a **Retry**                                                                                                       |
| `not-set-up`         | "DorkOS isn't sharing agent files for this folder yet." + "Run `dorkos harness sync --fix` in this folder to set it up." + a docs link      |
| `unreadable`         | "DorkOS can't read this folder's agent file settings." + `detail`                                                                           |
| `unavailable`        | "Agent file sharing runs in the DorkOS app."                                                                                                |
| no project path      | unchanged: "This agent's folder isn't known here."                                                                                          |
| `ready`, zero skills | "No skills here yet." + the marketplace link (honest: it means zero, and it is now measured over every source rather than over skill-packs) |

#### The profile row's count

`useManagedAgentFacts` currently counts installed `skill-pack` packages, which is why the row says "Skills 0"
about an agent with 31.

**It does not fire the status query.** `buildHarnessStatus` is three synchronous filesystem walks (§Performance),
and the profile opens on every `/session`; making the row's number cost a ~22 ms event-loop stall on every
profile open would be paying for a number nobody asked for yet. The row instead reads whatever
`harnessKeys.status(projectPath)` already holds — `use-harness-status-cached.ts`, a `useQuery` with
`enabled: false`, which subscribes to the cached entry and never fetches — and renders **nothing** when it is
empty. `countValue(null)` already draws no value rather than inventing a zero (`lib/profile-rows.ts`), so the
row goes from "Skills 0" (a lie) to "Skills" (silence) to "Skills 31" (the truth) once the page has been
opened. Silence is the correct middle state and it is the one the module was already designed for.

## Testing Strategy

Every new test carries its contract row id in its title (T8's census reads titles), and every one names the
mutation that reds it — the plan's §0 bar, adapted: for a surface that does not exist on `main`, "fails on
main" is trivially true and therefore proves nothing, so each case states the **seeded defect** that makes it
meaningful.

### Unit — the derivation table

`apps/server/src/services/harness/__tests__/status-model.test.ts`, over the real J-01 fixture staged the way
`packages/harness/src/__tests__/journeys/j01-claude-project-nothing-silent.test.ts:60-135` stages it — three
rules, two MCP servers, real `mkdtempSync` temp dirs, no `node:fs` mocks — plus three small trees for the
cases J-01 cannot produce.

| Case (title carries `VC-01`)                                                                                    | Seeded defect that reds it                                   |
| --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| J-01 derives **17 rows and 51 cells, with no enabled harness missing a cell**, before anything else is asserted | a `rows: []` early return still passes every other case      |
| the two MCP servers stay two rows, and the two settings-file hook groups stay two rows                          | drop `name` (or `source`) from the row key                   |
| the unparseable rule's warning rides the `claude-code` cell it already had, and forks no row                    | key the warning by `(artifact, source, name)`                |
| a `.claude/skills` skill is `native` for Claude Code and Cursor, `dropped` for Codex, with the reasons verbatim | paraphrase one reason                                        |
| all six J-01 skills are `adoptable`; on a tree whose skills are declared, `counts.adoptable` is 0               | drop the `listed` exclusion                                  |
| a skill in both roots is not adoptable, and **both rows appear**                                                | drop the `alsoCanonical` exclusion, or dedupe by name        |
| a harness-agnostic drop and a harness-agnostic warning both land in `projectLevel` and in no cell               | key project-level on `source === undefined`                  |
| a real directory at a symlink target is `conflict` on a **read**                                                | revert §1.4's prerequisite; `blocked` is 0 and the case reds |
| a withheld package's hooks are `pending-approval`, and no command text is in the response                       | pass `request.hooks` through                                 |
| an unreadable plugin `hooks/hooks.json` produces a `warned` cell (row 8), the one shape J-01 cannot make        | make every warning an annotation                             |
| `clean` is false when only orphans exist, and `sweepPreview` names them                                         | read `clean` off `DriftResult` while filtering orphans out   |
| an uninstalled plugin alone makes `clean` false, and `sweepPreview` names all nine of its paths                 | revert Slice 2b: `clean` is `true` and the preview is empty  |

### Route — supertest

`apps/server/src/routes/__tests__/harness.test.ts`.

| Case                                                                                                                                            | Seeded defect                                                                |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `AP-03 / DOR-678`: a GET on a manifest-less repo answers `not-set-up` **and a whole-tree path-set snapshot is byte-identical before and after** | call `scaffoldManifest` in the route                                         |
| a GET on an agent home under `{dorkHome}/agents/*` answers `200`                                                                                | swap `validateBoundaryOrDorkHome` for `validateBoundary` → `403`             |
| a GET outside the boundary answers `403`                                                                                                        | drop the validator                                                           |
| a GET on a path inside the boundary that does not exist answers `404`, not `200 not-set-up`                                                     | drop the `stat`; the validator returns the path and the model reads `ENOENT` |
| a GET on a path that is a file answers `400`                                                                                                    | drop the `isDirectory` check; `200 unreadable` carries a raw `ENOTDIR`       |
| a GET with a relative `projectPath` answers `400`                                                                                               | drop the `isAbsolute` refinement; it resolves against the server's cwd       |
| a GET whose dependency throws answers `500` with `{ error: 'Internal server error' }` and nothing of the failure, and logs it                   | echo `err.message` into the body                                             |
| a POST on a manifest-less repo answers `409 harness_not_set_up` and writes nothing                                                              | let `loadManifest` throw → a `500` and a stack in the log                    |
| `VC-05`: a POST presenting an agent identity answers `403`; the same call without one, `200`                                                    | drop the `resolveDecisionAuthority` bar                                      |
| `TR-08`: a POST repairs a deleted link, and the **returned** status is `clean`                                                                  | return the pre-apply status                                                  |
| `AP-07`: a POST sweeps an uninstalled package's projections — exact before/after tree diff — and `swept` names every path it deleted            | pass `sweepOrphans: false`; the swept paths survive                          |
| the GET's `sweepPreview` **equals** the next POST's `swept` — set equality, on the ten-path fixture of §2.2.1                                   | revert Slice 2b's union: the preview is 1 path and the sweep is 10           |
| `HK-11`: a hand-written `.codex/hooks.json` with no sidecar survives the POST and is reported as a conflict                                     | widen the sweep past sidecar-matched files                                   |
| `VC-02`: the POST raises one card per unapproved package and returns without awaiting it                                                        | `await` the cards; the test times out                                        |
| `runAutoProjection`'s existing suite passes unchanged after the asking half is extracted                                                        | drop `reproject` from the extracted signature                                |

**No `FakeAgentRuntime`.** These routes touch no runtime; the fixture is a temp repo plus a fake
`HookApprovalGateway` (the narrow interface `hook-approval.ts` exports for exactly this). Wiring a runtime in
would be a prop the test never reads.

### Reason vocabulary — `packages/harness`

`packages/harness/src/__tests__/reason-vocabulary.test.ts`. Every `reason` string the engine can emit is now
rendered to a person by the app, and neither vocabulary gate can reach this package. The test builds a plan
over a fixture that exercises each reason family and fails on any retired user-facing term outside a quoted
package-layer name.

**It reads the term list from `scripts/vocab-gate/banned-terms.json` rather than restating it**, so a wave
added there reaches this package on the same day it reaches the app, and so this file never becomes a second
list to keep in step. Two floors keep it from passing on nothing, in the repo's own "nothing zero-subject"
shape: it asserts it parsed at least as many waves and terms as the file holds today, and at least as many
reason strings as the fixture produces, before it asserts anything about either. Seeded defect: restore the
retired noun in `NON_PORTABLE_LAYER_REASONS` and the test reds; point the loader at a missing path and the
floor reds instead of the suite going quietly green.

### Client — React Testing Library, mock `Transport` via `TransportProvider`

`apps/client/src/layers/entities/harness/ui/__tests__/`.

- The list draws one row per skill and one chip per enabled harness — counted first.
- A healthy row draws one collapsed chip; a row with one exception draws the full chip row.
- The banner appears for drift with its action, for a conflict without one, for adoptable without one, and
  not at all when clean — four cases, one per branch of the table.
- **A status with a non-empty `sweepPreview` draws the removal disclosure naming every path**, and the action
  is still offered. Seeded defect: render the banner without the disclosure and the case reds.
- Clicking "Sync now" calls `syncHarness` once, disables while pending, and the returned status — not a
  refetch — is what the banner re-renders from. Seeded defect: invalidate instead of `setQueryData`, and a
  post-write `conflict` cell reverts to `drifted`.
- The "What changed" summary lists every path in `swept`.
- Each of the six page states renders its own copy.
- The profile row's cached hook renders nothing on a cold cache and the count on a warm one, and **fires no
  request either way**. Seeded defect: drop `enabled: false` and a request is made.

### Browser — T7

`apps/e2e/tests/harness/skills-page.spec.ts`.

**Which leg: the default `chromium` project, not a test-mode one.** The ticket and the test plan both say
"against the test-mode runtime", and that is not what this spec needs. The test-mode legs exist because a spec
would otherwise start a real, billable turn; the seven `testIgnore` entries on the `chromium` project each say
so. **This spec starts no turn** — it registers an agent, opens a profile page, reads chips and clicks Sync —
which is exactly why `tests/profile/profile-pushin.spec.ts` runs on the default leg and says so in its header.
Putting it on a test-mode leg would mean a new `playwright.config.ts` project, a new `testIgnore` entry and a
second Vite/Express pair booted for no reason. **No `playwright.config.ts` change is needed**; the default
project's `**/*.spec.ts` match reaches `tests/harness/` already.

**The fixture change it does need.** `RoomsApi.registerAgent(name, emoji, color, options)` builds its own path
under a private `agentRoot` (`fixtures/rooms-api.ts:189-195`) and takes no path, so a spec cannot stage files
before registration. Two edits, both named:

- `registerAgent` gains `options.path?: string` — an already-staged directory. It must sit under this run's
  `agentRoot` so `scanRoot: FIXTURE_AGENT_ROOT` still derives the `run-<runId>` namespace, and `agentRoot`
  becomes a readonly public field so a sibling fixture can build paths under it.
- A new `apps/e2e/fixtures/harness-repo.ts` stages the tree there and removes it in teardown, registered in
  `fixtures/index.ts` beside `roomsApi`.

Seeded defect for the pair: stage the tree at a path outside `agentRoot` and the registration lands in the
wrong namespace, which the spec's own assertion on the agent's `projectPath` reds.

The spec itself:

1. Stage a repo at `<agentRoot>/harness-<n>/`: a manifest enabling `claude-code, codex`, one
   `.agents/skills/<a>/SKILL.md`, one real `.claude/skills/<b>/` directory.
2. Register an agent at that path, then `rightPanel.openProfilePage('skills', agent.projectPath)`.
3. Assert the list has at least two rows; `<a>` shows Codex "reads it" and Claude Code "shared"; `<b>` carries
   the adoptable line; the "Not shared with Codex" panel names `<b>` with its reason verbatim.
4. Delete `.claude/skills/<a>` on disk, reload: the banner is there, and its disclosure names the path.
   Click "Sync now": the banner goes, the "What changed" summary names what was written, and the link is back
   on disk.
5. Seeded defect: render the banner unconditionally and step 4's final assertion reds.

**One caveat the spec states rather than discovers.** Registering an agent runs `projectAgentWorkspace`
(TR-03), which seeds the operating-skills pack — so the staged repo will hold more skills than the two the
spec put there. Assertions name their skills and assert a **floor** on the row count, never an exact total.

### Contract and census

`meta/harness-sync-capabilities.md` is edited in the same PR (§17: "A harness feature adds its rows here in
the same PR"): VC-01 `partial → built` citing the derivation test, VC-02 gains its app half, TR-08
`not built → built`, §11's opening "None of it exists" and §12 J-06's "Today" cell both updated, §16 D6 gains
a "shipped as" line. VC-05 stays **partial** — its app half is out of scope and saying otherwise would be the
kind of false row the census exists to catch.

## Performance Considerations

**All three engine calls are synchronous.** `project()`, `checkPlan()` and `inventorySourceTree()` use
`node:fs`'s blocking API throughout — `readdirSync`, `lstatSync`, `readFileSync` — so on Express they block
the event loop for their whole duration. That is the fact the budget is set against, and it is why the profile
row does not fire this query (§User Experience) and why nothing here is called in a loop.

**Measured, not estimated**, against this repository at `87d893503` (31 skills, 51 commands, 13 rules, 7
subagents, 3 MCP servers; three enabled harnesses; 109 plan actions, 62 drops), five runs, medians:

| Call                                                  | Median  |
| ----------------------------------------------------- | ------- |
| `inventorySourceTree()`                               | 13.4 ms |
| `project()`                                           | 16.8 ms |
| `checkPlan()`                                         | 0.6 ms  |
| the three together, as `buildHarnessStatus` runs them | 22.1 ms |

The derived model on that tree: **57 rows, 171 cells, 32,415 bytes** — and 46,244 bytes with the duplicated
`drops` map an earlier draft carried, which is why §4 removed it.

**The budget: p50 ≤ 150 ms of event-loop time, and ≤ 250 KB, for a repo of that size.** Roughly seven times
the measured wall clock, so an implementation that accidentally walks the tree three more times has somewhere
to fail. The implementer records a fresh measurement in the PR.

**The extrapolation, and where it runs out.** At ~190 bytes per cell, a large repo — 200 skills across six
enabled harnesses, ~1,200 cells — lands near **228 KB**, inside the budget but not by much; with the
duplicated `drops` map it would have been ~325 KB and over it. So the payload budget is met by the schema
being right, not by luck. If a real repo is measured past it, the answer is pagination or a summary-first
response, not a cache — and that is a follow-up with a measurement attached, not a guess made now.

Three further notes:

- **The tree is walked twice.** `project()` reads the inventory internally and does not hand it back, so
  `buildHarnessStatus` calls `inventorySourceTree` again — about 13 ms of the 22. Accepted for v1; the cheap
  fix (have the plan carry the inventory it read) is a follow-up and not a condition of shipping.
- **No caching, server side.** Recomputed per call. A cache would need invalidating on every filesystem write
  any agent makes, which is a correctness problem traded for 22 ms.
- **Client side:** `staleTime: 30_000`, matched to the marketplace hook beside it; the mutation writes the
  returned status into the cache rather than invalidating (§2.2.6); `approval_resolved` invalidates.

## Security Considerations

**Boundary: `validateBoundaryOrDorkHome`, not `validateBoundary`.** The page's whole subject is an agent, and
a DorkOS-managed agent lives at `{dorkHome}/agents/<slug>` — the exact subtree `validateBoundary` refuses.
Using it would 403 the surface this is built for. `boundary.ts`'s own rule admits read-only **listing** to the
wider validator ("safe here specifically because it is NAMES ONLY — no file contents, no writes") and refuses
it to "raw file/content surfaces". This route is on the listing side of that line, and stays there by
construction:

- the response carries artifact names, repo-relative paths and reasons — never file bytes;
- withheld hook **commands** are deliberately excluded (§1.6), which is the one place file content could have
  leaked in;
- the narrowing still excludes every dork-home sibling of `agents/`, `extension-secrets/` included.

**The write is the person's.** `POST /api/harness/sync` refuses any caller presenting an agent identity or an
approval token (§2.2.4). The read is not gated, deliberately: it is the same information `dorkos harness sync
--check` prints to anyone with a shell.

**Consent is not weakened.** The button installs no hook a person has not allowed: the projection runs through
the same seam, the same digest-keyed store, and the same card. `refused` still beats `approved`, because
`planWithConsent` tests refusal first and this route changes nothing about that.

**The sweep deletes only what the engine can prove it wrote** — the sidecar rule (DOR-1842), scoped to enabled
harnesses, held by `apply-ownership.property.test.ts` — **and it says so before and after** (§2.2.1). Two
route tests pin the deletion; two client tests pin the telling.

**Path handling.** `projectPath` is resolved and canonicalized by the validator before it reaches the engine;
the engine is handed an absolute canonical path and no user string is ever concatenated into one.

## Documentation

- `contributing/harness-sync.md` — a new §7, _The status model and its two readers_: the eight states, the
  derivation table, the row-key rule and the harness-agnostic rule, why the model lives in the server rather
  than the engine, and the rule that a wrong chip is a plan bug.
- `meta/harness-sync-capabilities.md` — the row updates listed under §Testing Strategy.
- `docs/getting-started/configuration.mdx` §Harness Sync — one paragraph: the agent profile's Skills page
  shows what is shared with which tool, and the Sync action re-runs the projection and says what it removed.
- `docs/api/openapi.json` — regenerated by `pnpm docs:export-api` after the two `registerPath` calls. Route
  descriptions are read against the retired-word list first; this file is a `check-banned-words.sh` scan
  target.
- `changelog/unreleased/<id>-every-skill-you-have-in-one-list.md` — a fragment written to the
  `writing-for-humans` bar.
- `docs/guides/action-approvals.mdx:123` — **unchanged.** It says `harness.autoSync` has "no screen yet",
  which is still true: that switch is the DOR-144 half this spec cuts.
- `plans/harness-sync-test-plan.md` §11 line 9 — marked done, with T7's leg correction noted (§Testing).

## Implementation Phases

Nine slices. Each is independently reviewable, each is sized to land under about 800 changed lines, and the
sweeping POST does not become reachable until the surface that warns about it ships in the same slice.

**Two are engine work, and both are gates rather than niceties.** Slice 2 makes `conflict` reachable from a
read; without it the banner loops (§1.4). Slice 2b makes `checkPlan` able to say what a sync would delete;
without it the banner undercounts a destructive click by nine paths out of ten (§2.2.1). **Slice 7 may not
ship before either of them.**

### Slice 1 — the harness vocabulary moves down (~200 lines)

`packages/shared/src/harness-schemas.ts` holding `HARNESS_IDS`, `HarnessIdSchema`, `HarnessId` and
`HARNESS_LABELS`; the `./harness-schemas` export-map entry; `packages/harness/package.json` gains
`@dorkos/shared`; `packages/harness/src/manifest/schema.ts` re-exports all four.

**Bar:** not one import anywhere changes; `pnpm typecheck` and `pnpm test -- --run` green across the
monorepo; `vendor-facts.test.ts` still asserts a skills row for every id.

### Slice 2 — `conflict` becomes reachable on a read (~150 lines, or zero)

Only if DOR-1855 has not landed: `findBlockedSymlinkTargets` folded into `checkPlan().blocked`, `isDrifted`'s
symlink branch answering `false` for a `file`/`directory` occupant, with the reasons from
`apply/symlink-occupants.ts` (or, if that module is DOR-1855's alone, three local constants it later replaces).

**Bar:** §1.4's reproduction inverts — READ reports `blocked=1`, APPLY reports the same action as a conflict
with the same reason, and the second READ is unchanged rather than pretending a re-run would help. Reverting
the change reds the case. If DOR-1855 has landed, this slice is a no-op and the bar is its test still passing.

### Slice 2b — `checkPlan` can say what a sync would delete (~300 lines)

Engine only, and its own slice rather than folded into Slice 2: the two changes touch different modules for
different reasons and each deserves its own seeded defect and its own review.

Split the five sweeps that still enumerate-and-delete in one pass into a `find*` and a `sweep*` that calls it,
the way `authored-orphans.ts` already is — `sweepInstalledOrphans`, `sweepGeneratedCommandOrphans`,
`sweepOpencodeCommandOrphans` (all in `apply/apply.ts`), `sweepGeneratedOrphans`
(`apply/generated-targets.ts`) and `sweepSettingsHooksOrphan` (via `apply/settings-hooks.ts`). Then
`checkPlan().orphans` returns the **union** of all six finders, sorted and de-duplicated, and `clean` is false
whenever any is non-empty. The harness-filter guard moves with the widened set (§2.2.1).

**Bar:** the two reproductions in §2.2.1 invert. On the ten-path fixture, `checkPlan().orphans` **equals**
the next `applyPlan().swept` — set equality asserted both ways, with the count asserted before the contents.
On the plugin-only fixture, `clean` is `false` and the nine paths are named where the tree previously read
clean. Reverting the union reds both, and the CLI's own suite gains the `--check` case that now exits
non-zero, plus one asserting `--harness <id>` still reports no orphans.

### Slice 3 — the status model and its contract (~700 lines)

`apps/server/src/services/harness/status.ts`; the rest of `harness-schemas.ts` (the response types);
the derivation unit test over the real J-01 fixture plus the three small trees.

**Bar:** J-01 derives 17 rows and 51 cells with no missing cell; every one of the eight states is produced by
a named case; each of the eleven seeded defects reds its case.

### Slice 4 — `GET /api/harness/status` (~500 lines)

`apps/server/src/routes/harness.ts` with the GET only; the mount; the OpenAPI entry and the regenerated
`docs/api/openapi.json`.

**Bar:** the never-writes path-set snapshot reds when a scaffold is seeded; both boundary cases green;
`docs-openapi-check` green. Nothing on this route can write, so nothing about it is reachable-but-unguarded.

### Slice 5 — the read-only client (~750 lines)

`getHarnessStatus` on `Transport` with its HTTP, embedded and mock implementations; `entities/harness` minus
the banner and the sync hook — query keys, `use-harness-status`, `use-harness-status-cached`,
`lib/harness-status.ts`, the chip, the row, the list, the two panels; their component tests.

**Bar:** the list, the chip row, the collapse and the six page states each have a case; the cached hook fires
no request; `pnpm --filter @dorkos/client test` and `typecheck` green.

### Slice 6 — the page (~450 lines)

`SkillsPage.tsx` composes the list, the panels and the not-enabled notice; `use-managed-agent-facts.ts` reads
the cached count; `SkillPacksList.tsx` and its barrel export deleted; the Dev Playground showcase.

**Bar:** on this repo, the page lists 31 skills and the profile row says 31 after the page has been opened and
nothing before it; `pnpm knip` reports no new dead export; a screenshot of the page at the docked panel's
narrowest width is in the PR.

### Slice 7 — the sync: route, banner, and everything that tells the person (~800 lines)

**Gated on Slices 2 and 2b.** `POST /api/harness/sync` with its person-only bar, its `409`, and
`sweepOrphans: true`; `ask-withheld-hooks.ts` extracted from `auto-project.ts` with the `reproject` callback;
`HarnessDriftBanner` with its four branches and its removal disclosure; `HarnessSyncSummary`;
`use-harness-sync` with `setQueryData` and the `approval_resolved` subscription; the route tests and the
client tests for all of it.

**Bar:** the sweep is named before the click **completely** — `sweepPreview` equals the next `swept` on the
ten-path fixture — and listed after it; the returned status is what the banner re-renders from (invalidating
instead reds the post-write `conflict` case); `project-seam-guard.test.ts` passes with an unchanged allowlist;
`runAutoProjection`'s existing tests pass untouched.

### Slice 8 — T7, the contract and the docs (~500 lines)

The `registerAgent` path option and the `harness-repo` fixture; the Playwright spec; the contract row flips;
`contributing/harness-sync.md` §7; the configuration-doc paragraph; the changelog fragment; the
`NON_PORTABLE_LAYER_REASONS` copy fix and the `reason-vocabulary.test.ts` guard.

**Bar:** the T7 spec passes on the default `chromium` leg and its seeded defect reds;
`bash scripts/check-banned-words.sh`, `pnpm check:vocab-gate` and the new reason guard all clean; no contract
row claims a surface this PR did not build.

## Decisions

Every open question the design surfaced, resolved here with its reason. The operator delegated; nothing below
is waiting on an answer.

| #   | Decision                                                                                                               | Why                                                                                                                                                                                                                                                                                                                                                                                 |
| --- | ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | The model is assembled in `apps/server/src/services/harness/status.ts`, not in `packages/harness` and not in the route | Two of the eight states need the consent record, which `hook-approval.ts` says the engine may not hold. In the route, the CLI could never share it — VC-01's complaint, a second time.                                                                                                                                                                                              |
| 2   | Precedence: `conflict` > `pending-approval` > `drifted` > `dropped` > `native`/`projected` > `warned`                  | The first two change what the person does next; "re-run fixes it" and "re-running never fixes it" cannot share a chip.                                                                                                                                                                                                                                                              |
| 3   | `warned` is the state of last resort and an annotation everywhere else                                                 | A `ProjectionWarning` has two shapes and only one has no cell of its own. One rule covers both without either hiding the other. J-01 exercises the annotation shape; a separate tree exercises row 8.                                                                                                                                                                               |
| 4   | `unmanaged` is a row-level fact, not a per-harness chip                                                                | The plan already answers per-harness for a `.claude/skills` skill. A third drawing of one fact is the "two alarms" failure the design system names.                                                                                                                                                                                                                                 |
| 5   | `unmanaged` excludes declared and already-canonical skills                                                             | A `claudeOnlySkills` entry is a written-down decision. An `alsoCanonical` copy is a **blocker** whose fix is a deletion, in the projector's own words — offering to move it would offer the one action that makes it worse. Both rows still appear.                                                                                                                                 |
| 6   | `unmanaged` is scoped to `.claude/skills` in v1                                                                        | The inventory reads two roots and SRC-07 names `.claude/skills`. Widening it is a change to the inventory, with its own tests, and is a follow-up rather than a silent extra.                                                                                                                                                                                                       |
| 7   | The status model does not call `harnessCoverage()`                                                                     | It is the test oracle by its own module doc; running it in the read path puts a second model of six vendors on screen where it can disagree with the first.                                                                                                                                                                                                                         |
| 8   | A missing manifest is `200 state: 'not-set-up'` on the GET                                                             | It is a state of the project the page renders, not an absent endpoint; a `404` makes every caller re-derive the difference.                                                                                                                                                                                                                                                         |
| 9   | The GET is ungated; the POST is person-only, through `resolveDecisionAuthority`                                        | The read is what `--check` prints to anyone with a shell. The write touches the person's project, including a sweep. `trustedCaller` would demand a cookie DOR-502 showed locks out a person's own terminal.                                                                                                                                                                        |
| 10  | The POST sweeps (`sweepOrphans: true`) **and says so before and after**                                                | A button is the full-plan case, and orphans are half of what the banner reports — a sync that does not sweep leaves the banner up after the click. Safe because the sidecar (DOR-1842) makes "only delete what we wrote" provable; **honest** because `sweepPreview` names the paths before the click and the summary names them after, which is what the terminal has always done. |
| 11  | The asking half is extracted to `ask-withheld-hooks.ts` with a `reproject` callback; no `syncWithConsent`              | A second `*WithConsent` is what the seam guard exists to prevent. Asking is not projection, so the extraction moves nothing across the guarded line. The callback is how the re-projection stays the caller's, with its own package name, action and sweep decision.                                                                                                                |
| 12  | The POST returns without awaiting approval cards; the page learns through `approval_resolved`                          | `runAutoProjection`'s promise stays unresolved while a card waits, which is why the install route fires and forgets. The global stream already carries the event and `use-pending-approvals.ts` already subscribes to it, so the refetch has a named mechanism rather than a hope.                                                                                                  |
| 13  | The POST is not a registered capability; if surfaced, `act`, never `destructive`                                       | No agent caller needs it. `destructive` would put a card in front of every routine re-sync — the harm DOR-504 and DOR-506 refused twice. The card that matters is already on the content, and Decision 10 supplies the disclosure a card would stand in for.                                                                                                                        |
| 14  | The server reads consent through `storedHookDecisions()`                                                               | DOR-678's "do not open the store" is about a separate process creating the file. The server's store is already open; using the CLI's disk reader here would read a staler copy for no benefit.                                                                                                                                                                                      |
| 15  | Withheld hook **commands** never reach the response                                                                    | The approval card is the surface built to show them, with redaction, a length cap, escaping and a plain-words event. It also keeps file content off a route that uses the wider boundary validator.                                                                                                                                                                                 |
| 16  | Boundary: `validateBoundaryOrDorkHome`                                                                                 | The page's subject is an agent, and DorkOS-managed agents live under `{dorkHome}/agents/*`. The response is names and reasons, which is the listing side of `boundary.ts`'s own line.                                                                                                                                                                                               |
| 17  | `HARNESS_IDS` / `HARNESS_LABELS` move into `@dorkos/shared`; the harness package re-exports them and declares the dep  | The client cannot import a Node filesystem engine, and shared cannot depend on harness without a cycle. Re-declaring six ids goes stale the day a seventh lands.                                                                                                                                                                                                                    |
| 18  | The status schema restates `ArtifactType` / `Provenance` rather than moving them                                       | Provenance needs a fourth value the engine's does not have. Drift is caught by a `satisfies Record<ArtifactType, …>` mapping table, the technique the projector already uses so "the compiler names the gap".                                                                                                                                                                       |
| 19  | The Skills page, not a `/harnesses` route                                                                              | People ask this about an agent, and the profile is where they already are. The target toggles that justified a page of its own are the DOR-144 half being cut.                                                                                                                                                                                                                      |
| 20  | The banner's action appears when a sync would **change the tree** — drift or a pending sweep — and never otherwise     | A sync fixes drift and orphans and fixes neither a conflict nor an adoptable skill. The predicate is `counts.drifted > 0 \|\| sweepPreview.length > 0`, which is exactly what `applyPlan` would act on; the earlier `drifted`-only predicate left a click that removed files with no banner and a banner that a click could not clear (§1.4, §2.2.1).                               |
| 21  | The banner is inline on the page, not `AppBannerSlot`                                                                  | The slot ranks one banner for the whole app; a project-scoped fact there would follow the person to every route.                                                                                                                                                                                                                                                                    |
| 22  | Chips wrap; there is no mobile layout                                                                                  | One layout is one thing to keep true. A sideways-scrolling chip strip hides state behind a gesture on the surface whose job is to show state.                                                                                                                                                                                                                                       |
| 23  | A healthy row collapses to one chip                                                                                    | With 31 skills, a wall of identical chips is what a person reads past to find the row that matters. The collapsed chip is a button and its title names the harnesses, so nothing is unreachable.                                                                                                                                                                                    |
| 24  | The not-enabled notice is copy, not a button                                                                           | `--enable` writes a committed, team-shared file. A side-panel button with no diff and no undo promises more than it fixes.                                                                                                                                                                                                                                                          |
| 25  | Reasons are shown verbatim, and a guard test in `packages/harness` keeps them clean                                    | The CLI prints the same strings; a paraphrase makes two surfaces describe one fact in two voices. Neither vocabulary gate can see that package, so a hand sweep would rot — the guard is the only version of this promise that stays true.                                                                                                                                          |
| 26  | The Obsidian transport answers `unavailable`, not an empty list                                                        | An empty list would tell an Obsidian user they have no skills, which is the lie this spec exists to fix.                                                                                                                                                                                                                                                                            |
| 27  | The Skills page draws only skills as rows, while the **API is deliberately wider than the page**                       | A person opened a page called Skills to see skills. But the response carries every kind because three other consumers need them — the drop panels (16 Codex drops on J-01, most of them not skills), the counts, and the CLI port the ADR commits to. A response shaped to one page is a response the next surface forks.                                                           |
| 28  | The profile row reads the status **from cache only** and never fires the query                                         | Three synchronous filesystem walks (~22 ms of blocked event loop) on every profile open is a real cost for a number nobody has asked for yet. `countValue(null)` already draws nothing rather than a zero, so silence before the page is opened is honest and is what the module was designed for.                                                                                  |
| 29  | No server-side cache; recompute per call                                                                               | 22 ms measured on this repo. A cache needs invalidating on every filesystem write any agent makes: a correctness problem traded for 22 ms.                                                                                                                                                                                                                                          |
| 30  | The tree is walked twice in v1                                                                                         | `project()` does not hand back the inventory it read. ~13 ms of the 22, measured. The fix is small and is a follow-up, not a condition of shipping.                                                                                                                                                                                                                                 |
| 31  | The row key is `(artifact, source, name)`; harness-agnostic entries are project-level, keyed on the flag               | Each component has a measured counter-example on J-01 (§1.3). `harnessAgnostic` is the flag DOR-1849 added for exactly this; `source` absence is not a proxy for it, because the unreadable-hook warning carries one.                                                                                                                                                               |
| 32  | The response carries no `drops` map; the panels group `rows` on the client                                             | Measured duplication: 46,244 bytes against 32,415 for the same facts. It is also what keeps a 200-skill repo inside the payload budget (§Performance).                                                                                                                                                                                                                              |
| 33  | A POST on a project with no manifest answers `409 harness_not_set_up`                                                  | `loadManifest` throws `ENOENT` there. A sync against a project that syncs nothing is not a success with zero work done, and the page never offers the button in that state, so the code is only reachable by a caller that ignored the status.                                                                                                                                      |
| 34  | The POST's returned status replaces the cached one; the mutation does not invalidate                                   | An invalidation throws away the one answer that knows about `applyPlan().conflicts` — the only place row 1 is produced — and replaces it with a read that has forgotten. Freshness comes from `staleTime` and from `approval_resolved`.                                                                                                                                             |
| 35  | T7 runs on the default `chromium` leg, not a test-mode one                                                             | The test-mode legs exist so a spec does not start a billable turn; this spec starts none, exactly like `profile-pushin.spec.ts`. A new leg would be a second server pair booted for nothing, and a `playwright.config.ts` change nobody needs.                                                                                                                                      |
| 36  | `sweepPreview` is **equality** with the next `swept`, and the engine is widened (Slice 2b) to make that possible       | `checkPlan().orphans` is one of six sweeps. Measured: preview 1 path, the click deletes 10 — and with only a plugin uninstalled, `clean` is `true` while a sync deletes 9. "Most of what will be deleted" is a warning with a hole in it, and the hole is where the surprise lives. Weakening the claim to "a subset" would undo the whole of finding 5.                            |
| 37  | Slice 2b is its own slice, and Slice 7 is gated on it                                                                  | Two engine changes for two different reasons, each with its own seeded defect, is two reviews. And a banner that undercounts a destructive click is worse than no banner: it teaches a person that the list is the whole list.                                                                                                                                                      |

## Deviations from the brief and from earlier documents

Recorded because the code disagreed with the paperwork in ten places.

1. **`DriftResult` has five fields, not three.** The ticket and the test plan both say
   `checkPlan → { clean, drifted, blocked }`. It also returns `orphans` and `leftAlone`, and `orphans` is
   half of what the banner reports.
2. **`checkPlan().blocked` is generate-only on `main`**, so the ticket's `conflict` state is unreachable on a
   read and the banner loops. Fixed by DOR-1855, or by slice 2 (§1.4).
3. **`checkPlan().orphans` is one sweep of six**, so nothing outside an apply can say what a sync would
   delete. Measured: a preview of 1 path against a click that removes 10, and a tree the engine calls `clean`
   while a sync removes 9. Fixed by slice 2b (§2.2.1) — the one place this work changes the engine for a
   reason that is not its own bug.
4. **The response shape is not `{ plan, drift, conflicts, unmanaged }`.** That is the four inputs, not a
   model. Handing the client a raw `ProjectionPlan` would make the client derive the eight states — the
   duplication §1.2 exists to prevent.
5. **`.claude/skills` skills are already in the plan.** The ticket's framing implies the inventory is what
   makes them visible. Since DOR-1845 the projector names each one per harness. The inventory is what makes
   _adoptable_ computable, which is a smaller and more precise claim.
6. **A Skills page already exists** (`features/profile/ui/pages/SkillsPage.tsx`, registered in the profile's
   page registry). This changes it; it does not create it. `SkillPacksList` is deleted rather than left beside
   the new list.
7. **The ADR is `proposed`, not `draft`.** The flow template says `status: draft`; this repo's `/adr:from-spec`
   is explicit that "no ADR is ever created with `status: draft`" and that an unshipped decision is
   `proposed`. The repo convention wins.
8. **Route tests use no `FakeAgentRuntime`.** These routes touch no runtime.
9. **T7 runs on the default browser leg, not "against the test-mode runtime"** as the ticket and
   `plans/harness-sync-test-plan.md` §9 both say. It starts no turn, so the leg the test-mode projects exist
   to avoid is not a hazard here (Decision 35). The plan's line is corrected in the same PR.
10. **The original spec's `/harnesses` route is superseded, not deferred** (§Non-Goals).

## Open Questions

None. Every question this design raised is resolved in §Decisions with its reason.

Two facts are dated rather than open, and both are recorded so a reader knows what they rest on:

- **DOR-1851, DOR-1854 and DOR-1855 are in review, not on `main`.** §Technical Dependencies states what each
  contributes and what to do if it is late. Only DOR-1855 changes a behaviour this spec depends on, and slice
  2 is the named fallback.
- **Every measurement is this repository, or the J-01 fixture, at `87d893503`.** The implementer re-measures
  in the PR; the budget, not the measurement, is the contract.

## Follow-ups to file

Four gaps this spec names and does not own. None has a ticket today.

1. **Seeing and revoking allowed hooks in the app** — VC-05's app half. The CLI has
   `dorkos harness hooks --list | --revoke`; the app has the card and nothing after it.
2. **Turning a harness on from the app** — the button behind the not-enabled notice, with the diff and the
   undo that a committed-file write deserves.
3. **The DOR-144 global half** — a per-harness projection default, the `harness.autoSync` toggle, target
   selection. DOR-144 is canceled and nothing inherited it.
4. **Teaching the CLI to read `buildHarnessStatus`** — so `reportCheck` and `reportFix` render the same model
   the page does, and the "one model, two renderers" claim becomes structural rather than aspirational.

Two smaller ones: widening the inventory to `.opencode/skills` and `.cursor/skills` so `unmanaged` covers
J-03's case; and having `project()` return the inventory it already read, so the status model stops walking
the tree twice.

**And one that is filed whether or not slice 2b ships here**, because the gap is the engine's and it outlives
this spec: _`checkPlan` cannot say what a sync would delete — five of six sweeps have no `find` half_. Slice
2b is this work's version of it; if slice 2b slips, the ticket is what keeps it from being forgotten, and
Slice 7 stays blocked either way.

## Related ADRs

- **`260908-085032` — One status model answers for the app and the terminal** (proposed, extracted from this
  spec).
- **ADR-0301** — canonical `.agents/` + hybrid projection: the engine this reads.
- **ADR-0302** — instructions are scaffolded, never generated; DOR-1851's `--enable` amendment is why the
  not-enabled notice is copy.
- **ADR-0303** — Harness Sync multi-source projection: the `authored / installed / adopted` vocabulary, and
  the adopt half DOR-1853 amends.
- **`260706-192819`** — harness-native plugin delivery: why an installed plugin's skills are files rather than
  SDK injection, which is why they show on this page at all.
- **`260804-021140`** — the Connections vocabulary, and the carve-out that governs the one reason string this
  PR rewords.

## References

- Ticket: **DOR-1852**. Re-scopes the canceled **DOR-144**. Blocks **DOR-1853** (§16 D3: the status surface
  before the flag). Depends for one behaviour on **DOR-1855**.
- Contract: `meta/harness-sync-capabilities.md` — §10 TR-08, §11 VC-01…VC-06, §12 J-01/J-03/J-06/J-09,
  §14, §16 D3 and D6.
- Plan: `plans/harness-sync-test-plan.md` — §9 (T7), §10 (T8 census), §11 line 9.
- Parent spec: `specs/harness-sync/` — §"The Harnesses UI surface (DOR-137)".
- Ideation: `specs/harness-sync-status/01-ideation.md`.
- Engine: `packages/harness/src/plan/types.ts`, `plan/source-artifacts.ts`, `plan/unreadable-hooks.ts`,
  `plan/installed-projector.ts`, `apply/apply.ts`, `apply/link-state.ts`, `apply/generated-targets.ts`,
  `inventory/`, `vendor-facts/coverage.ts`; and DOR-1855's `apply/symlink-occupants.ts`.
- Seam: `apps/server/src/services/harness/project-with-consent.ts`,
  `__tests__/project-seam-guard.test.ts`, `hook-approval.ts`, `hook-consent.ts`, `auto-project.ts`.
- Boundary and caller identity: `apps/server/src/lib/boundary.ts`, `apps/server/src/lib/caller-authority.ts`,
  `apps/server/src/routes/marketplace.ts`.
- Client: `contributing/design-system.md` (§Banners), `contributing/state-management.md`,
  `.claude/rules/fsd-layers.md`, `apps/client/src/layers/entities/attention/model/use-pending-approvals.ts`,
  `apps/e2e/playwright.config.ts`, `apps/e2e/fixtures/rooms-api.ts`, `apps/e2e/pages/RightPanelPage.ts`.
