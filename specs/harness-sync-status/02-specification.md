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
3. **A drift banner** with one action (`POST /api/harness/sync`) that clears when the tree is clean, and the
   drop list as a **"Not shared with `<harness>`"** panel with every reason spelled out.

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
them already know every fact this page needs. VC-01's verdict is precise: _"nothing assembles the eight into
one answer."_

## Goals

- One read-only call that answers, per artifact and per harness, which of eight states it is in — with the
  derivation stated as a table a test can walk.
- A Skills page that lists **every** skill a person has, whatever its source, and says for each which agent
  tools can see it.
- The drop list, verbatim and per harness, so nothing DorkOS cannot share is silently omitted.
- A banner that appears when the tree is not clean, offers exactly one action when that action helps, and
  disappears when it stops being true.
- **One model, two renderers.** Whatever the page says, the CLI must be able to say about the same artifact
  — so the assembly lives in one module rather than in the route.
- A projection stays the person's decision: the read is open, the write is not.

## Non-Goals

Each carries the ticket that owns it, or a note that nothing does yet.

| Cut                                                                                                                                          | Owner                                                                            |
| -------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| **Adopt by move** — `dorkos harness adopt`, `harness.autoAdopt`. The page reports an adoptable skill; it never moves one.                    | **DOR-1853** (contract §16 D3, which requires the status surface to exist first) |
| **Global scope** — `~/.dork/plugins`, `~/.claude/skills`, Claude Code's own `enabledPlugins`                                                 | **DOR-1857**                                                                     |
| **Seeing and revoking allowed hooks in the app** (VC-05's app half). `dorkos harness hooks --list \| --revoke` stays the only surface.       | **unowned** — file a follow-up; see §Follow-ups to file                          |
| **Turning a harness on from the app** (`--enable`). The not-enabled notice is copy only.                                                     | **unowned** — see §Follow-ups to file; the CLI half is DOR-1851                  |
| **The DOR-144 global half** — a per-harness projection default, a `harness.autoSync` toggle, a target matrix in Settings                     | **unowned** (DOR-144 is canceled) — see §Follow-ups to file                      |
| **A `/harnesses` route.** Superseded by the profile's Skills page, not deferred.                                                             | — (deviation from `specs/harness-sync`, recorded in §Deviations)                 |
| **Widening the inventory past `.claude/skills`** — `.opencode/skills`, `.cursor/skills`. So `unmanaged` is scoped to `.claude/skills` in v1. | **unowned** — see §Follow-ups to file; SRC-07 is `.claude/skills` by definition  |
| **Teaching the CLI to read the status model.** The direction is in the ADR; the port is later.                                               | **unowned** — see §Follow-ups to file                                            |
| **Server-side caching, or pushing status changes over SSE.** Recomputed per call.                                                            | — (see §Performance Considerations for the measured budget that makes this fine) |
| **Non-skill artifacts as rows.** Rules, subagents, commands, hooks and MCP servers appear in the drop panels and nowhere else.               | — (see §User Experience)                                                         |

## Technical Dependencies

Nothing new is installed. The work rests on:

- `@dorkos/harness` (workspace) — `project`, `checkPlan`, `applyPlan`, `inventorySourceTree`, `loadManifest`,
  `HARNESS_LABELS`.
- **DOR-1851 — landing, not on `main`.** Adds `ProjectionPlan.notEnabled: DetectedHarness[]`
  (`{ harness, signal }`), `enableHarnessInManifest`, `missingGitignoreLines`, `canonicalLayerIgnoredBy`. This
  spec consumes `notEnabled` only. **If DOR-1851 has not landed when slice 1 starts, ship `notEnabled` as an
  empty array behind a `?? []` and drop the not-enabled row from the page; nothing else in this spec depends
  on it.**
- **DOR-1854 — landing, not on `main`.** Either a per-`projectPath` lock (`withProjectLock`) or a proof that
  the apply already converges. `POST /api/harness/sync` takes the lock if there is one and needs no change if
  the answer was the proof. **Neither outcome blocks this work**; see §Detailed Design 2.4.
- Zod 4 (already a dependency of `@dorkos/shared`), TanStack Query, shadcn/ui, `@asteasolutions/zod-to-openapi`
  for the `/api/docs` entry.

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

#### 1.3 Row identity

A row is `(artifact, provenance, name, source)`. All four are load-bearing: on a J-01-shaped repo the plan
emits **two** `claude-code` actions named `hooks`, one sourced from `.claude/settings.json` and one from
`.claude/settings.local.json`. Keying on `name` alone collapses them into a lie.

`source` is absent only for a harness-agnostic plugin-layer drop, which is not a row (see §User Experience).

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

**Why `conflict` outranks `drifted`.** They can both be true of one action, and they mean opposite things to
a person. `checkPlan` files a blocked _generate_ target under `blocked`, but a symlink whose target is
occupied by a real directory reads as `drifted` on a check and comes back as a `conflict` from the apply.
"Re-run and it fixes itself" and "re-running will never fix this" cannot both be on one chip, and the second
is the one that changes what the person does next.

**Why `pending-approval` outranks everything but `conflict`.** A withheld package's hooks are filtered out of
the plan _before_ it is built, so no action or drop names them at all — the state fills a hole rather than
overriding anything. It is placed above `drifted` so that if a future engine change ever puts a withheld hook
in the plan as well, the answer stays "a person has to decide", which is the loud, safe reading the seam
already chose when it tests refusal before approval.

**`warned` is the state of last resort and an annotation everywhere else.** A `ProjectionWarning` has two
shapes (`plan/types.ts`): _projected-but-suspect_, where the artifact **is** in `actions`, and
_read-but-unusable_, where it reached no harness at all. The first rides the cell it belongs to as
`warnings: string[]` beside whatever state row 6 or 7 gave it; the second has no action or drop to ride, so
row 8 makes `warned` its state. One rule, both shapes, and neither one hides the other.

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

The two exclusions are the definition, not an optimisation:

- **also canonical** — the same name is in `.agents/skills`, so the file is already where every harness
  looks. Nothing to adopt.
- **declared** — a `manifest.claudeOnlySkills` entry is a person saying "this placement is deliberate". The
  plan's drop reason already says so in those words. Calling it adoptable would be arguing with a decision
  that was written down.

**`unmanaged` is not a chip.** The plan already answers per-harness for a `.claude/skills` skill —
`native` where the harness reads that directory, `dropped` with the "move it to `.agents/skills` to share it"
reason where it does not (verified on the J-01 fixture, §1.7). Drawing the same fact a third time in every
harness column is the "two alarms about one fact" failure the design system names for banners. It is a
row-level boolean, rendered as one line of advice under the skill's name.

**Scope limit, stated.** `.opencode/skills` and `.cursor/skills` are not inventoried, so a skill living there
is not reported as adoptable. That is SRC-07's own scope (it names `.claude/skills`), and widening the
inventory is a follow-up.

#### 1.6 `pending-approval`, and what it may say

`planWithConsent` returns `withheld: WithheldHooks[]`, each carrying a `WithheldReason` and the full
`HookProjectionRequest` — **including every command string**. The status response carries the package name,
the events, and the count. **It never carries the commands.**

| `WithheldReason`    | What the page says                                                                          |
| ------------------- | ------------------------------------------------------------------------------------------- |
| `unasked`           | "`<package>` wants to run commands. Approve it to share its hooks."                         |
| `refused`           | "You turned down `<package>`'s commands. Run `dorkos harness hooks --revoke` to undo that." |
| `unreadable-config` | "DorkOS couldn't read your settings, so nothing was installed on a guess." + the reason     |

**Decision: the commands stay off this route.** Why: the approval card is the surface built to show them —
secret-redacted, capped at 200 characters, quoted and escaped, with the event said in plain words
(`hook-approval.ts`). Reproducing that on a status page means reproducing four safety properties in a second
place. It also keeps the response free of file **content**, which is what lets the route use the wider
boundary validator (§Security Considerations).

#### 1.7 A worked example — a J-01-shaped repo

The tree: a root `CLAUDE.md`; six skills as real directories in `.claude/skills/`; two commands; one subagent;
two rules; hooks in both `.claude/settings.json` and `.claude/settings.local.json`; one skill declaring hooks
in its own frontmatter; a `.mcp.json`. No `.agents/`, no `AGENTS.md`. The manifest enables
`claude-code, codex, cursor`.

The plan and drift below were produced by running the engine at `87d893503` on exactly that tree — 24 actions,
21 drops, 0 warnings, 2 drifted. The response is that data, reshaped:

```jsonc
{
  "projectPath": "/Users/x/acme",
  "state": "ready",
  "computedAt": "2026-09-08T08:42:00.000Z",
  "enabled": ["claude-code", "codex", "cursor"],
  "notEnabled": [{ "harness": "opencode", "signal": ".opencode/" }],
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
  "rows": [
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
    },
    // …five more skills, identical in shape
  ],
  "drops": {
    "codex": [
      {
        "artifact": "instruction",
        "name": "AGENTS.md",
        "reason": "no AGENTS.md — nothing to read or point at",
      },
      {
        "artifact": "command",
        "name": "commands",
        "reason": "no repo-local slash-command format (custom prompts are deprecated in favour of skills)",
      },
      {
        "artifact": "rule",
        "name": "api",
        "reason": "Codex has no path-scoped rules format — its only per-directory mechanism is a nested AGENTS.md (vendor docs, 2026-09-07)",
      },
      {
        "artifact": "agent",
        "name": "reviewer",
        "reason": "not projected yet — Codex keeps project subagents in .codex/agents/*.toml, one TOML file per agent (vendor docs, 2026-09-07)",
      },
      {
        "artifact": "mcp",
        "name": "linear",
        "reason": "not projected yet — Codex keeps MCP servers in .codex/config.toml under [mcp_servers.<name>] (vendor docs, 2026-09-07)",
      },
      {
        "artifact": "hook",
        "name": "hooks",
        "source": ".claude/settings.local.json",
        "reason": "hooks in .claude/settings.local.json are yours alone and stay in Claude Code; move them to .claude/settings.json to project them to Codex",
      },
      // …the six skill drops shown above, plus the skill-frontmatter hook drop
    ],
    "cursor": [/* … */],
    "claude-code": [
      {
        "artifact": "instruction",
        "name": "AGENTS.md",
        "reason": "no AGENTS.md — nothing to read or point at",
      },
    ],
  },
  "pluginLayers": [],
  "pendingApproval": [],
  "warnings": [],
}
```

Two things this example is meant to make undeniable:

- **The six `.claude/skills` skills are not invisible.** Since DOR-1845 the plan names each one for each
  harness. What was missing was somewhere to draw it.
- **`adoptable: true` on all six** is what a person with a Claude-first repo actually has, and it is the fact
  DOR-1853 needs a screen for.

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

**Failures that are still failures:** a missing or blank `projectPath` is `400`; a path outside the boundary
is `403`; an unexpected throw is `500` with the message logged, not echoed.

#### 2.2 `POST /api/harness/sync`

Body `{ projectPath: string }`. Answers `200 HarnessSyncResponse`:

```ts
{
  status: HarnessStatusResponse;       // recomputed after the apply
  applied: number;
  swept: string[];                     // repo-relative paths pruned
  conflicts: number;
  askedAbout: string[];                // package names a card was raised for
}
```

**It goes through `projectWithConsent(projectPath, { dorkHome, sweepOrphans: true })`** — the one seam. Never
`project()`; `__tests__/project-seam-guard.test.ts` refuses it, and the refusal is the point.

##### 2.2.1 `sweepOrphans: true` — the decision, and why it is safe now

**Decision: yes.** Two reasons and one guard.

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
`blocked` and the tree stays unclean until the person moves it. That is the right answer, and on this page it
is a `conflict` chip with the reason attached, which is more than the terminal gave them.

**Two guards this PR adds on top**, both as tests rather than as prose: an exact before/after tree diff over a
sync that sweeps an uninstalled package's projections and touches nothing authored; and an assertion that a
hand-written hooks file with no sidecar survives the button.

##### 2.2.2 Who asks about withheld hooks

**Decision: the route asks, through an extracted asking half — not a new `syncWithConsent`.**

`runAutoProjection` already owns this sequence: project with the unapproved packages' hooks withheld; filter
the withheld list through `mayAskAboutHooks` (skipping what is already refused or already on screen); raise
one card per package, all before any is awaited; on a yes, `recordHookApproval` **then** re-project.

That whole sequence is lifted into `askAboutWithheldHooks(withheld, { approvals, projectPath, dorkHome })` in
a new `apps/server/src/services/harness/ask-withheld-hooks.ts`, and both `runAutoProjection` and the route
call it. Two reasons for this shape:

- **A second `*WithConsent` function is exactly what the seam guard exists to prevent.** `project-with-consent.ts`
  is "the only non-test module allowed to call `project(`", and the reason given is that every new trigger
  reaching for its own projection is how hooks nobody allowed get installed. Adding `syncWithConsent` beside
  it would either duplicate the seam or route around it.
- **The asking half is not projection.** It raises cards and records answers; it builds no plan and writes no
  projection. Extracting it therefore moves nothing across the guarded line, and the guard's allowlist does
  not grow.

**The POST does not wait for the cards.** `runAutoProjection`'s promise "stays unresolved while an approval is
pending, which is why the install route treats this as fire-and-forget". A button that hangs on a modal is
worse than one that returns and says what is waiting: the response carries `askedAbout` and the recomputed
status carries `pendingApproval`, the page says "One package is waiting for your approval", and the client
refetches when the approval stream reports a decision. Pass two runs on its own and the next status read shows
its result.

##### 2.2.3 The capability tier

**Decision: `POST /api/harness/sync` is not registered as a capability in v1**, and if it is ever surfaced to
agents it is **`act`**, never `destructive`.

- _Not registered_ because it has no agent-facing surface: an agent that installs a package already gets
  projection through `runAutoProjection`, and DOR-1850's watcher will cover the rest. A capability nobody
  invokes is a tool description and a tier gate maintained for no caller.
- _`act`, not `destructive`_, for the reason `hook-approval.ts` states about its sibling: promoting
  `marketplace.install` to `destructive` "would put an approval card in front of every ordinary install, which
  is the routine-card harm this repo has refused twice (DOR-504, DOR-506)". A re-sync is the routine action
  here; the parts of it that deserve a card already have one, on the content rather than on the verb — a
  package's hooks are held until a person allows those exact commands. The sweep is the destructive-shaped
  half and it removes only files the engine can prove it wrote.
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
the apply already converges, the route needs no change and the spec's assumption is discharged. **Neither
outcome blocks this work**, which is why it is stated here rather than made a dependency.

### 3. Code structure

```
packages/shared/src/harness-schemas.ts             # NEW — the response contract + the harness vocabulary
packages/shared/package.json                       #   + "./harness-schemas" in the exports map
packages/shared/src/transport.ts                   #   + getHarnessStatus / syncHarness

packages/harness/src/manifest/schema.ts            # HARNESS_IDS / HarnessIdSchema / HarnessId /
                                                   #   HARNESS_LABELS become re-exports from @dorkos/shared
packages/harness/src/plan/installed-projector.ts   # one copy fix (see §User Experience, "Reasons, verbatim")

apps/server/src/services/harness/status.ts         # NEW — buildHarnessStatus(); the derivation table
apps/server/src/services/harness/ask-withheld-hooks.ts  # NEW — the asking half, lifted from auto-project.ts
apps/server/src/services/harness/auto-project.ts   # now calls ask-withheld-hooks.ts
apps/server/src/routes/harness.ts                  # NEW — GET /status, POST /sync
apps/server/src/index.ts                           #   + app.use('/api/harness', createHarnessRouter(...))
apps/server/src/services/core/openapi-registry.ts  #   + two registerPath calls

apps/client/src/layers/entities/harness/           # NEW slice
  index.ts
  model/query-keys.ts                              #   harnessKeys.status(projectPath)
  model/use-harness-status.ts
  model/use-harness-sync.ts
  lib/harness-status.ts                            #   pure display helpers (chip word, chip tone, grouping)
  ui/HarnessStateChip.tsx
  ui/SkillHarnessRow.tsx
  ui/SkillsWithHarnessesList.tsx
  ui/NotSharedPanel.tsx
  ui/HarnessDriftBanner.tsx
apps/client/src/layers/shared/lib/transport/harness-methods.ts   # NEW — HttpTransport half
apps/client/src/layers/shared/lib/transport/{http-transport,index}.ts
apps/client/src/layers/shared/lib/embedded-mode-stubs.ts         #   + the two stubs
apps/client/src/layers/features/profile/ui/pages/SkillsPage.tsx  # composes the new slice
apps/client/src/layers/features/profile/model/use-managed-agent-facts.ts  # an honest skill count
apps/client/src/layers/entities/marketplace/ui/SkillPacksList.tsx        # DELETED
apps/client/src/layers/entities/marketplace/index.ts                     #   - the export
apps/client/src/dev/showcases/HarnessStatusShowcases.tsx                 # NEW playground showcase
apps/client/src/dev/playground-registry.ts                               #   + its entry

packages/test-utils/src/mock-factories.ts          #   + the two Transport methods
apps/e2e/tests/harness/skills-page.spec.ts         # NEW — T7
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
`HARNESS_LABELS` move to `packages/shared/src/harness-schemas.ts`, and
`packages/harness/src/manifest/schema.ts` re-exports all four — every existing import keeps working and there
is exactly one definition. `vendor-facts.test.ts` already asserts no id in `HARNESS_IDS` lacks a skills row,
so the move inherits a guard rather than needing a new one.

### 4. The response schema

`packages/shared/src/harness-schemas.ts`, exported at `@dorkos/shared/harness-schemas`:

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

export const HarnessDropSchema = z.object({
  artifact: HarnessArtifactKindSchema,
  name: z.string(),
  source: z.string().optional(),
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
    skills: z.number().int().nonnegative(),
    drifted: z.number().int().nonnegative(),
    conflicts: z.number().int().nonnegative(),
    orphans: z.number().int().nonnegative(),
    adoptable: z.number().int().nonnegative(),
    pendingApproval: z.number().int().nonnegative(),
  }),
  orphans: z.array(z.string()),
  rows: z.array(HarnessRowSchema),
  drops: z.record(HarnessIdSchema, z.array(HarnessDropSchema)),
  pluginLayers: z.array(HarnessDropSchema),
  pendingApproval: z.array(HarnessPendingApprovalSchema),
  warnings: z.array(HarnessDropSchema),
});
```

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
getHarnessStatus(projectPath: string): Promise<HarnessStatus>;

/** Apply the projection plan for one project and answer with the recomputed status. */
syncHarness(projectPath: string): Promise<HarnessSyncResult>;
```

- `HttpTransport` — `apps/client/src/layers/shared/lib/transport/harness-methods.ts`, following
  `marketplace-methods.ts`: `fetchJSON` + `buildQueryString`, no path segments to encode.
- `DirectTransport` (Obsidian) — `embedded-mode-stubs.ts`. `getHarnessStatus` resolves
  `{ state: 'unavailable', detail: 'Agent file sharing runs in the DorkOS app.' , … }`; `syncHarness`
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

1. **The banner** — at most one, only when the tree is not clean.
2. **The not-enabled notice** — its own row, when `notEnabled` is non-empty.
3. **The skills list** — one row per skill.
4. **A "Not shared with `<harness>`" panel per enabled harness**, collapsed by default, each row an
   artifact and its reason.
5. **A "Plugin layers" panel**, when `pluginLayers` is non-empty.
6. **"Browse skill-packs"** — the existing marketplace link, unchanged, still at the foot.

#### The banner

One condition, one message, one action — and the action only when it does something.

| Condition (first match wins)                 | Message                                                          | Action     |
| -------------------------------------------- | ---------------------------------------------------------------- | ---------- |
| `counts.drifted > 0 \|\| counts.orphans > 0` | "Some agent files are out of date."                              | "Sync now" |
| `counts.conflicts > 0`                       | "DorkOS can't update some files — something else is in the way." | none       |
| `counts.adoptable > 0`                       | "Some skills live where only a few of your agents look."         | none       |
| otherwise                                    | — nothing is drawn —                                             | —          |

- **Not the app-wide `AppBannerSlot`.** That slot ranks one banner for the whole app; this condition is about
  one project on one page, and a project-scoped fact in a global slot would follow the person to every route.
  It is an inline notice at the top of the page, using the same `Banner` component and the same `info` /
  `warning` tones.
- **No red, and no count in the nav.** Drift is not an error — it is a file that has not been written yet.
  `info` tone for drift and adoptable, `warning` for a conflict, `critical` never. The profile's `skills` row
  keeps showing a plain skill count and grows no badge: a number in the nav is a second alarm about a fact the
  page already states, which is the failure the design system names for banners.
- **It clears by being recomputed, not by being dismissed.** After a successful sync the query is invalidated
  and the banner re-renders from the new status. There is no `onDismiss`.

#### A skill row

Two lines.

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
view preference for one visit, not app state). The reason is the 31-skill case: a wall of identical green
chips is what a person has to read _past_ to find the one row that matters. The collapsed chip is a button and
its `title` names the harnesses, so nothing is unreachable.

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
`projected`) carries its target path instead. Nothing that has a reason hides it — the reason panel below
repeats it in full, so the tooltip is a convenience, never the only copy.

#### The not-enabled notice

> **Cursor files are in this folder, but DorkOS isn't sharing to it.**
> Run `dorkos harness sync --fix --enable cursor` in this folder to turn it on.

**Decision: copy only, no button in v1.** `enableHarnessInManifest` writes `.agents/harness.manifest.json` —
a committed, team-shared file — as a deliberately minimal key-add that preserves key order and formatting,
argued against ADR-0302 in DOR-1851's own amendment. A button in a side panel that edits a committed file with
no diff and no undo is a bigger promise than the fact it fixes. Exposing it from the app is its own change with
its own review; the follow-up is listed below.

#### "Not shared with `<harness>`"

One collapsed panel per enabled harness that has drops, headed with the harness label, each row
`<kind> <name>` and the reason **verbatim**. This is Priya's honesty gate and the reason it is verbatim is
that the CLI prints the same string: if the page paraphrased, two surfaces would describe one fact in two
voices and a person could not tell which one was current.

**Reasons, verbatim — with one copy fix in the same PR.** One engine string reads
`plugin layer "adapters" is not a portable harness asset — messaging adapters run inside DorkOS, not in a
harness` (`installed-projector.ts`). The quoted layer name is what a package author writes and is the ADR's
own carve-out, but the prose half is a retired user-facing noun. It becomes `— Messaging runs inside DorkOS,
not in a harness`. Neither vocabulary gate scans `packages/harness`, so this is a hand sweep: the whole of
`NON_PORTABLE_LAYER_REASONS` and every `reason` string the page renders gets read once against the retired
list before slice 5 closes.

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

After a successful sync: a toast, not a banner — "Agent files updated." A moment that just happened is a
toast; the banner is for the condition, and the condition is now false. When cards were raised, the toast is
"Agent files updated. One package is waiting for your approval."

#### The profile row's count

`useManagedAgentFacts` currently counts installed `skill-pack` packages. It reads `counts.skills` from the
status query instead, gated exactly like every other read there (`enabled: projectPath !== null`), so a
person's profile still asks for nothing. The row goes from "Skills 0" to "Skills 31" on this repo, and the
page the row opens is a cache hit — which is the module's own stated reason for reading facts at the profile
root.

## Testing Strategy

Every new test carries its contract row id in its title (T8's census reads titles), and every one names the
mutation that reds it — the plan's §0 bar, adapted: for a surface that does not exist on `main`, "fails on
main" is trivially true and therefore proves nothing, so each case states the **seeded defect** that makes it
meaningful.

### Unit — the derivation table

`apps/server/src/services/harness/__tests__/status-model.test.ts`, over the J-01 fixture staged the way
`packages/harness/src/__tests__/journeys/j01-claude-project-nothing-silent.test.ts` stages it (real
`mkdtempSync` temp dirs, no `node:fs` mocks).

| Case (title carries `VC-01`)                                                                                    | Seeded defect that reds it                                 |
| --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| counts the rows and the cells before asserting anything about them                                              | a `rows: []` early return still passes every other case    |
| a `.claude/skills` skill is `native` for Claude Code and Cursor, `dropped` for Codex, with the reasons verbatim | paraphrase one reason                                      |
| all six `.claude/skills` skills are `adoptable`; a `claudeOnlySkills`-declared one is not                       | drop the `listed` exclusion                                |
| a skill in both `.agents/skills` and `.claude/skills` is not adoptable                                          | drop the `alsoCanonical` exclusion                         |
| the two `claude-code` `hooks` rows stay two rows                                                                | key the row on `name` alone                                |
| a blocked generate target is `conflict`, not `drifted`                                                          | swap rows 2 and 4 of the derivation table                  |
| a withheld package's hooks are `pending-approval`, and no command text is in the response                       | pass `request.hooks` through                               |
| a read-but-unusable warning becomes `warned`; a projected-but-suspect one rides its cell                        | make every warning a `warned` state                        |
| `clean` is false when only orphans exist                                                                        | read `clean` off `DriftResult` while filtering orphans out |

### Route — supertest

`apps/server/src/routes/__tests__/harness.test.ts`.

| Case                                                                                                                                            | Seeded defect                                                    |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `AP-03 / DOR-678`: a GET on a manifest-less repo answers `not-set-up` **and a whole-tree path-set snapshot is byte-identical before and after** | call `scaffoldManifest` in the route                             |
| a GET on an agent home under `{dorkHome}/agents/*` answers `200`                                                                                | swap `validateBoundaryOrDorkHome` for `validateBoundary` → `403` |
| a GET outside the boundary answers `403`                                                                                                        | drop the validator                                               |
| `VC-05`: a POST presenting an agent identity answers `403`; the same call without one, `200`                                                    | drop the `resolveDecisionAuthority` bar                          |
| `TR-08`: a POST repairs a deleted link, and the recomputed status is `clean`                                                                    | return the pre-apply status                                      |
| `AP-07`: a POST sweeps an uninstalled package's projections — exact before/after tree diff — and leaves every authored file untouched           | pass `sweepOrphans: false`; the swept paths survive              |
| `HK-11`: a hand-written `.codex/hooks.json` with no sidecar survives the POST and is reported as a conflict                                     | widen the sweep past sidecar-matched files                       |
| `VC-02`: the POST raises one card per unapproved package and returns without awaiting it                                                        | `await` the cards; the test times out                            |

**No `FakeAgentRuntime`.** These routes touch no runtime; the fixture is a temp repo plus a fake
`HookApprovalGateway` (the narrow interface `hook-approval.ts` exports for exactly this). Wiring a runtime in
would be a prop the test never reads.

### Client — React Testing Library, mock `Transport` via `TransportProvider`

`apps/client/src/layers/entities/harness/ui/__tests__/`.

- The list draws one row per skill and one chip per enabled harness — counted first.
- A healthy row draws one collapsed chip; a row with one exception draws the full chip row.
- The banner appears for drift with its action, for a conflict without one, for adoptable without one, and
  not at all when clean — four cases, one per branch of the table.
- Clicking "Sync now" calls `syncHarness` once, disables while pending, and the banner is gone once the query
  resolves clean. Seeded defect: render the banner off a local flag instead of off the refetched status, and
  the last assertion still passes while the real bug (a stale banner after a failed sync) ships.
- Each of the six page states renders its own copy.

### Browser — T7

`apps/e2e/tests/harness/skills-page.spec.ts`, on the default leg against the test-mode runtime, free.

1. Stage a repo under `apps/e2e/.temp/harness/run-<runId>/` (inside `DORKOS_BOUNDARY`, which the config pins
   to the repo root): a manifest enabling `claude-code, codex`, one `.agents/skills/<a>/SKILL.md`, one real
   `.claude/skills/<b>/` directory.
2. Register an agent at that path (the `roomsApi.registerAgent` shape), then
   `rightPanel.openProfilePage('skills', agent.projectPath)`.
3. Assert the list has at least two rows; `<a>` shows Codex "reads it" and Claude Code "shared"; `<b>` carries
   the adoptable line; the "Not shared with Codex" panel names `<b>` with its reason verbatim.
4. Delete `.claude/skills/<a>` on disk, reload: the banner is there. Click "Sync now": the banner goes and the
   link is back on disk.
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

**Measured, not estimated.** Timing the three engine calls against this repository at `87d893503` (31 skills,
51 commands, 13 rules, 7 subagents, 109 plan actions, 62 drops), five runs, median:

| Call                    | Median  |
| ----------------------- | ------- |
| `inventorySourceTree()` | 13.4 ms |
| `project()`             | 16.8 ms |
| `checkPlan()`           | 0.6 ms  |
| **total**               | ~31 ms  |

Serialized `{ plan, drift }` is **45 KB**; the reshaped response is the same data and lands in the same range.

**The budget: p50 ≤ 150 ms and ≤ 250 KB for a repo of that size.** Roughly five times the measured cost, so
an implementation that accidentally walks the tree three more times has somewhere to fail. The implementer
records a fresh measurement in the PR.

Three notes:

- **The tree is walked twice.** `project()` reads the inventory internally and does not hand it back, so
  `buildHarnessStatus` calls `inventorySourceTree` again — about 13 ms. Accepted for v1; the cheap fix (have
  the plan carry the inventory it read) is a follow-up and not a condition of shipping.
- **No caching, server side.** Recomputed per call. A cache would need invalidating on every filesystem write
  any agent makes, which is a correctness problem traded for 31 ms.
- **Client side:** `staleTime: 30_000`, matched to the marketplace hook beside it; the mutation invalidates
  `harnessKeys.status(projectPath)` on settle. The profile root and the page share one query, so opening the
  page is a cache hit.

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
harnesses, held by `apply-ownership.property.test.ts`. §2.2.1 states the case; two route tests pin it.

**Path handling.** `projectPath` is resolved and canonicalized by the validator before it reaches the engine;
the engine is handed an absolute canonical path and no user string is ever concatenated into one.

## Documentation

- `contributing/harness-sync.md` — a new §7, _The status model and its two readers_: the eight states, the
  derivation table, why the model lives in the server rather than the engine, and the rule that a wrong chip
  is a plan bug.
- `meta/harness-sync-capabilities.md` — the row updates listed under §Testing Strategy.
- `docs/getting-started/configuration.mdx` §Harness Sync — one paragraph: the agent profile's Skills page
  shows what is shared with which tool, and the Sync action re-runs the projection.
- `docs/api/openapi.json` — regenerated by `pnpm docs:export-api` after the two `registerPath` calls. Route
  descriptions are read against the retired-word list first; this file is a `check-banned-words.sh` scan
  target.
- `changelog/unreleased/<id>-every-skill-you-have-in-one-list.md` — a fragment written to the
  `writing-for-humans` bar.
- `docs/guides/action-approvals.mdx:123` — **unchanged.** It says `harness.autoSync` has "no screen yet",
  which is still true: that switch is the DOR-144 half this spec cuts.
- `plans/harness-sync-test-plan.md` §11 line 9 — marked done.

## Implementation Phases

Five PR-sized slices. Each is independently reviewable and each names the bar that says it is finished.

### Slice 1 — the status model and its contract

`packages/shared/src/harness-schemas.ts` (with the `HARNESS_IDS` / `HARNESS_LABELS` move and the re-export
from `packages/harness/src/manifest/schema.ts`); `apps/server/src/services/harness/status.ts`; the derivation
unit test over the J-01 fixture.

**Bar:** every one of the eight states is produced by a named case, each case counts before it asserts, and
each of the nine seeded defects in the table reds its case. `pnpm --filter @dorkos/server test` and
`pnpm --filter @dorkos/harness test` green; no existing `HarnessId` import changed.

### Slice 2 — the two routes

`apps/server/src/routes/harness.ts`; the mount; `ask-withheld-hooks.ts` extracted from `auto-project.ts` with
`auto-project.ts` calling it; the OpenAPI entries and the regenerated `docs/api/openapi.json`.

**Bar:** every route case in §Testing Strategy green; the never-writes path-set snapshot reds when a scaffold
is seeded; `project-seam-guard.test.ts` still passes with an unchanged allowlist; `runAutoProjection`'s
existing tests pass untouched (the extraction is behaviour-preserving); `docs-openapi-check` green.

### Slice 3 — the transport and the entity slice

The two `Transport` methods with their HTTP, embedded and mock implementations; `entities/harness` with its
query keys, hooks, display helpers and five components; the component tests.

**Bar:** the list, the chip row, the collapse, the four banner branches and the six page states each have a
case; the stale-banner seeded defect reds; `pnpm --filter @dorkos/client test` and `typecheck` green.

### Slice 4 — the page

`SkillsPage.tsx` composes the banner, the notice, the list and the panels; `use-managed-agent-facts.ts` counts
honestly; `SkillPacksList.tsx` and its barrel export deleted; the Dev Playground showcase.

**Bar:** on this repo, the page lists 31 skills and the profile row says 31; `pnpm knip` reports no new dead
export; the deleted component has no remaining reference; a screenshot of the page at the docked panel's
narrowest width is in the PR.

### Slice 5 — T7, the contract and the docs

The Playwright spec; the contract row flips; `contributing/harness-sync.md` §7; the configuration-doc
paragraph; the changelog fragment; the `NON_PORTABLE_LAYER_REASONS` copy fix and the retired-word read-through
of every rendered reason.

**Bar:** the T7 spec passes on the default leg and its seeded defect reds; `bash scripts/check-banned-words.sh`
and `pnpm check:vocab-gate` clean; no contract row claims a surface this PR did not build.

## Decisions

Every open question the design surfaced, resolved here with its reason. The operator delegated; nothing below
is waiting on an answer.

| #   | Decision                                                                                                               | Why                                                                                                                                                                                                                                                    |
| --- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | The model is assembled in `apps/server/src/services/harness/status.ts`, not in `packages/harness` and not in the route | Two of the eight states need the consent record, which `hook-approval.ts` says the engine may not hold. In the route, the CLI could never share it — VC-01's complaint, a second time.                                                                 |
| 2   | Precedence: `conflict` > `pending-approval` > `drifted` > `dropped` > `native`/`projected` > `warned`                  | The first two change what the person does next; "re-run fixes it" and "re-running never fixes it" cannot share a chip.                                                                                                                                 |
| 3   | `warned` is the state of last resort and an annotation everywhere else                                                 | A `ProjectionWarning` has two shapes and only one of them has no cell of its own. One rule covers both without either hiding the other.                                                                                                                |
| 4   | `unmanaged` is a row-level fact, not a per-harness chip                                                                | The plan already answers per-harness for a `.claude/skills` skill. A third drawing of one fact is the "two alarms" failure the design system names.                                                                                                    |
| 5   | `unmanaged` excludes declared and already-canonical skills                                                             | A `claudeOnlySkills` entry is a written-down decision; a name already in `.agents/skills` is already everywhere. Both are the projector's own two flags.                                                                                               |
| 6   | `unmanaged` is scoped to `.claude/skills` in v1                                                                        | The inventory reads two roots and SRC-07 names `.claude/skills`. Widening it is a change to the inventory, with its own tests, and is a follow-up rather than a silent extra.                                                                          |
| 7   | The status model does not call `harnessCoverage()`                                                                     | It is the test oracle by its own module doc; running it in the read path puts a second model of six vendors on screen where it can disagree with the first.                                                                                            |
| 8   | A missing manifest is `200 state: 'not-set-up'`, not `404`                                                             | It is a state of the project the page renders, not an absent endpoint; a `404` makes every caller re-derive the difference.                                                                                                                            |
| 9   | The GET is ungated; the POST is person-only, through `resolveDecisionAuthority`                                        | The read is what `--check` prints to anyone with a shell. The write touches the person's project, including a sweep. `trustedCaller` would demand a cookie DOR-502 showed locks out a person's own terminal.                                           |
| 10  | The POST sweeps (`sweepOrphans: true`)                                                                                 | A button is the full-plan case, and orphans are half of what the banner reports — a sync that does not sweep leaves the banner up after the click. Safe now because the sidecar (DOR-1842) makes "only delete what we wrote" provable; AP-07 holds it. |
| 11  | The asking half is extracted to `ask-withheld-hooks.ts`; no `syncWithConsent`                                          | A second `*WithConsent` is exactly what the seam guard exists to prevent. Asking is not projection, so the extraction moves nothing across the guarded line and the allowlist does not grow.                                                           |
| 12  | The POST returns without awaiting approval cards                                                                       | `runAutoProjection`'s promise stays unresolved while a card waits, which is why the install route fires and forgets. A button that hangs on a modal is worse than one that says what is waiting.                                                       |
| 13  | The POST is not a registered capability; if surfaced, `act`, never `destructive`                                       | No agent caller needs it. `destructive` would put a card in front of every routine re-sync — the harm DOR-504 and DOR-506 refused twice. The card that matters is already on the content: a package's hooks.                                           |
| 14  | The server reads consent through `storedHookDecisions()`                                                               | DOR-678's "do not open the store" is about a separate process creating the file. The server's store is already open; using the CLI's disk reader here would read a staler copy for no benefit.                                                         |
| 15  | Withheld hook **commands** never reach the response                                                                    | The approval card is the surface built to show them, with redaction, a length cap, escaping and a plain-words event. It also keeps file content off a route that uses the wider boundary validator.                                                    |
| 16  | Boundary: `validateBoundaryOrDorkHome`                                                                                 | The page's subject is an agent, and DorkOS-managed agents live under `{dorkHome}/agents/*`. The response is names and reasons, which is the listing side of `boundary.ts`'s own line.                                                                  |
| 17  | `HARNESS_IDS` / `HARNESS_LABELS` move into `@dorkos/shared`; the harness package re-exports them                       | The client cannot import a Node filesystem engine, and shared cannot depend on harness without a cycle. Re-declaring six ids goes stale the day a seventh lands.                                                                                       |
| 18  | The status schema restates `ArtifactType` / `Provenance` rather than moving them                                       | Provenance needs a fourth value the engine's does not have. Drift is caught by a `satisfies Record<ArtifactType, …>` mapping table, the technique the projector already uses so "the compiler names the gap".                                          |
| 19  | The Skills page, not a `/harnesses` route                                                                              | People ask this about an agent, and the profile is where they already are. The target toggles that justified a page of its own are the DOR-144 half being cut.                                                                                         |
| 20  | The banner shows its action only when the action changes something                                                     | A sync fixes drift and orphans and fixes neither a conflict nor an adoptable skill. Always offering "Sync now" is a promise the person discovers is false by clicking it.                                                                              |
| 21  | The banner is inline on the page, not `AppBannerSlot`                                                                  | The slot ranks one banner for the whole app; a project-scoped fact there would follow the person to every route.                                                                                                                                       |
| 22  | Chips wrap; there is no mobile layout                                                                                  | One layout is one thing to keep true. A sideways-scrolling chip strip hides state behind a gesture on the surface whose job is to show state.                                                                                                          |
| 23  | A healthy row collapses to one chip                                                                                    | With 31 skills, a wall of identical chips is what a person reads past to find the row that matters. The collapsed chip is a button and its title names the harnesses, so nothing is unreachable.                                                       |
| 24  | The not-enabled notice is copy, not a button                                                                           | `--enable` writes a committed, team-shared file. A side-panel button with no diff and no undo promises more than it fixes.                                                                                                                             |
| 25  | Reasons are shown verbatim                                                                                             | The CLI prints the same strings. A paraphrase makes two surfaces describe one fact in two voices, and nothing says which is current. The one retired word inside them gets fixed at the source instead.                                                |
| 26  | The Obsidian transport answers `unavailable`, not an empty list                                                        | An empty list would tell an Obsidian user they have no skills, which is the lie this spec exists to fix.                                                                                                                                               |
| 27  | The Skills page shows only skills as rows; other kinds appear in the drop panels                                       | The page is called Skills and a person opened it to see skills. The honesty gate still covers every kind, which is what it is for.                                                                                                                     |
| 28  | The profile row's skill count comes from the same status query                                                         | It is the fact the row is claiming to state, and the page it opens becomes a cache hit — the module's own stated design.                                                                                                                               |
| 29  | No server-side cache; recompute per call                                                                               | 31 ms measured on this repo. A cache needs invalidating on every filesystem write any agent makes: a correctness problem traded for 31 ms.                                                                                                             |
| 30  | The tree is walked twice in v1                                                                                         | `project()` does not hand back the inventory it read. 13 ms, measured. The fix is small and is a follow-up, not a condition of shipping.                                                                                                               |

## Deviations from the brief and from earlier documents

Recorded because the code disagreed with the paperwork in seven places.

1. **`DriftResult` has five fields, not three.** The ticket and the test plan both say
   `checkPlan → { clean, drifted, blocked }`. It also returns `orphans` and `leftAlone`, and `orphans` is
   half of what the banner reports. The response carries both.
2. **The response shape is not `{ plan, drift, conflicts, unmanaged }`.** That is the four inputs, not a
   model. Handing the client a raw `ProjectionPlan` would make the client derive the eight states — the
   duplication §Detailed Design 1.2 exists to prevent. The response is the derived model plus the counts.
3. **`.claude/skills` skills are already in the plan.** The ticket's framing implies the inventory is what
   makes them visible. Since DOR-1845 the projector names each one per harness. The inventory is what makes
   _adoptable_ computable, which is a smaller and more precise claim.
4. **A Skills page already exists** (`features/profile/ui/pages/SkillsPage.tsx`, registered in the profile's
   page registry). This changes it; it does not create it. `SkillPacksList` is deleted rather than left beside
   the new list.
5. **The ADR is `proposed`, not `draft`.** The flow template says `status: draft`; this repo's `/adr:from-spec`
   is explicit that "no ADR is ever created with `status: draft`" and that an unshipped decision is
   `proposed`. The repo convention wins.
6. **Route tests use no `FakeAgentRuntime`.** These routes touch no runtime.
7. **The original spec's `/harnesses` route is superseded, not deferred** (§Non-Goals).

## Open Questions

None. Every question this design raised is resolved in §Decisions with its reason.

Two facts are dated rather than open, and both are recorded so a reader knows what they rest on:

- **DOR-1851 and DOR-1854 are in review, not on `main`.** §Technical Dependencies states what each contributes
  and what to do if either is late. Neither blocks slice 1.
- **The performance numbers are this repository at `87d893503`.** The implementer re-measures in the PR; the
  budget, not the measurement, is the contract.

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

A fifth, smaller: widening the inventory to `.opencode/skills` and `.cursor/skills` so `unmanaged` covers
J-03's case.

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
  before the flag).
- Contract: `meta/harness-sync-capabilities.md` — §10 TR-08, §11 VC-01…VC-06, §12 J-01/J-03/J-06/J-09,
  §14, §16 D3 and D6.
- Plan: `plans/harness-sync-test-plan.md` — §9 (T7), §10 (T8 census), §11 line 9.
- Parent spec: `specs/harness-sync/` — §"The Harnesses UI surface (DOR-137)".
- Ideation: `specs/harness-sync-status/01-ideation.md`.
- Engine: `packages/harness/src/plan/types.ts`, `apply/apply.ts`, `inventory/`, `plan/source-artifacts.ts`,
  `vendor-facts/coverage.ts`.
- Seam: `apps/server/src/services/harness/project-with-consent.ts`,
  `__tests__/project-seam-guard.test.ts`, `hook-approval.ts`, `hook-consent.ts`, `auto-project.ts`.
- Boundary and caller identity: `apps/server/src/lib/boundary.ts`, `apps/server/src/lib/caller-authority.ts`,
  `apps/server/src/routes/marketplace.ts`.
- Client: `contributing/design-system.md` (§Banners), `contributing/state-management.md`,
  `.claude/rules/fsd-layers.md`, `apps/e2e/pages/RightPanelPage.ts`.
