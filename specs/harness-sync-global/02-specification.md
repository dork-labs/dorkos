---
slug: harness-sync-global
number: 260908-102701
created: 2026-09-08
status: specified
---

# Harness Sync at global scope, and Claude Code's own `/plugin` installs as a source

**Status:** Draft
**Author:** specifier-1857 (DOR-1857)
**Date:** 2026-09-08

> **Every path, signature, constant and string quoted below was read out of the tree at `ebb091f8b`**, not
> inferred from a doc comment or carried over from the ideation. Where this document disagrees with the
> ideation or with the brief that commissioned it, §Deviations says so and says which line of code decided
> it.

## Overview

Two things share one ticket because they meet in one place: a person's home directory. They are specified
here as **two independently shippable parts**, and neither blocks the other.

**Part B — Claude Code's own plugins.** A person who runs `/plugin install` inside Claude Code has plugins
DorkOS cannot see and no other agent tool can use. On the operator's own machine that is nine plugins,
working in one agent tool and nowhere else. Part B reads the public half of Claude Code's settings, says so
in plain words, and offers to install the same package through DorkOS so every agent tool in the project
gets it. It changes no plan, no apply and no sweep.

**Part A — global scope.** A marketplace package installed globally (`<dorkHome>/plugins/<pkg>`) reaches
Claude Code only when DorkOS is driving it, and reaches nothing else at all. The one line a person sees
about it names a command that does not exist. Part A makes that line honest, then gives the projection
engine a second root so a global package's skills reach the scheduler and, last, the directories five agent
tools read at user scope.

Between them they close contract rows SRC-04, SRC-08, SRC-12, SK-03's global half and J-07, flip HK-14's
user half from "unread" to "read and reported", and record IN-08 and TR-10 as deliberate refusals with
reasons rather than gaps.

## Background / Problem Statement

### Part B: nine plugins, one agent tool

Measured on the operator's machine on 2026-09-08, from `~/.claude/settings.json`, reading names and enable
state only: **16 entries in `enabledPlugins`, 9 of them `true`**, drawn from three marketplaces. Two of
those marketplaces are repositories DorkOS already seeds as default sources
(`marketplace-source-manager.ts:68-84`: `dorkos-community` → `https://github.com/dork-labs/marketplace`,
`claude-plugins-official` → `https://github.com/anthropics/claude-plugins-official`).

**Zero of the sixteen are visible to DorkOS.** `enabledPlugins` appears nowhere in `apps/server/src`,
`packages/harness/src`, `packages/cli/src` or `packages/marketplace/src`, and nothing anywhere reads
`~/.claude/settings.json`. Two module docs say so by name and cite this ticket
(`packages/harness/src/inventory/hooks.ts:11-15`, `inventory/index.ts:47-50`). Claude Code merges hooks from
three settings files; DorkOS reads two (`inventory/hooks.ts:38-41`). The third is the same file
`enabledPlugins` lives in, which is why one read answers both J-07 and HK-14's user half.

### Part A: the sentence that names a command that does not exist

`packages/harness/src/plan/projector.ts:821-827` drops every global package with one inline string:

```
global-scope install; a project sync does not project global plugins (run a global sync)
```

Four things are wrong with it, and each is its own defect:

1. **There is no global sync.** `dorkos harness sync` takes `--check`, `--fix`, `--harness`, `--strict`,
   `--allow-hooks`, `--enable` and `--write-gitignore` (`harness-sync-command.ts:134-147`). Nothing accepts
   a scope.
2. **Nothing else projects a global install either.** `runAutoProjection` returns immediately when there is
   no project path (`auto-project.ts:312-322`, "a deliberate no-op in v1").
3. **It cannot say what was lost.** `scanPluginsRoot` records identity only for a global package
   (`sources/installed.ts:497-504`: `skills: []`, `commands: []`, no `relDir`, no `hooks`), so a package
   with two skills and a slash command is reported as a name.
4. **A globally installed scheduled skill is worse than dropped: it is silent.** No action, no drop, no
   warning. `sources/installed.ts:488-496` records the reason as a known gap (DOR-1518) and states the fix:
   "giving it one means building a global sync first, not widening this scan."

The engine is repo-relative end to end. `project(repoRoot, opts)` joins every read against `repoRoot`
(`engine.ts:138-188`), `applyPlan(repoRoot, plan)` resolves every target against it (`apply/apply.ts:678`),
and the installed-orphan sweep scans two repo-relative directories (`apply/apply.ts:95-96`). `dorkHome`
enters at exactly one place, `scanInstalledPlugins`, and buys exactly one thing: the identity that makes a
global package droppable by name.

## Goals

- **G1.** A person is told, in plain words, what a globally installed package contains and which agent tools
  can see it. No sentence names a command that does not exist.
- **G2.** A scheduled skill inside a globally installed package runs.
- **G3.** A globally installed package's skills reach the user-level directory five agent tools read, and
  Claude Code's own, without DorkOS ever writing a generated file into a person's home directory.
- **G4.** A person is told which plugins they turned on in Claude Code, which of their other agent tools
  cannot see them, and how to fix that with one command they already have.
- **G5.** Every refusal in this work (user-level instructions, hooks, commands, MCP servers; a trigger on
  `/plugin install`) is recorded in `meta/harness-sync-capabilities.md` with its reason, so it reads as a
  decision rather than a gap.
- **G6.** Nothing DorkOS writes at user scope can be removed by DorkOS unless DorkOS can prove it wrote it.

## Non-Goals

| Out of scope                                                   | Why, and who owns it                                                                                                                                                         |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dorkos harness adopt` (SRC-07, SRC-10, position D3)           | A separate verb with its own ADR amendment. **DOR-1853.** `specs/harness-sync/03-tasks.json` files it under DOR-174; decision 16 corrects that.                              |
| User-level instructions (IN-08)                                | ADR-0302's mechanism needs a canonical source and user scope has none (§2.10). Recorded in the contract as refused, which is one of the two outcomes IN-08's own row allows. |
| Projecting hooks, commands or MCP servers at user scope        | §2.10. A person's private hooks are not the team's; a command wrapper is a generated file; an MCP config carries credentials.                                                |
| A trigger on `/plugin install` or `$skill-installer` (TR-10)   | Decision 12. Detection rides the surfaces that already run. TR-10 stays `not built`, reason recorded.                                                                        |
| The Skills-page half of J-07 and of the global rows            | **DOR-1852.** This spec freezes the payload shape (§3); the page that renders it is that ticket's slices.                                                                    |
| Codex's `$skill-installer` at user scope (SRC-09)              | Still unread. Named here only as a neighbour whose files the sweep must never touch.                                                                                         |
| Projecting a global install into a specific project (Option C) | Rejected: contradicts ADR-0303's scope-matching clause, multiplies the artifact, and manufactures the collision §2.11 avoids. Stays closed until Part A ships.               |
| Reading `~/.claude/plugins/` in any form                       | Position D4, treated as a constraint and not re-argued. The cache is private and versioned; the sweep's one rule is that the engine deletes only what it wrote.              |
| Changing where the marketplace installs                        | Global installs already land at `<dorkHome>/plugins/<name>`. That is the target Part B's offer reuses, unchanged.                                                            |
| Adding `version` to `InstalledPlugin`                          | Worth doing and not required here. §2.11 states the rule that must not come to depend on it. Filed as a follow-up.                                                           |

## Technical Dependencies

| Dependency                                                                   | What it contributes, and what to do if it is late                                                                                                                                                                                                                                                                                    |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **DOR-1852** (`specs/harness-sync-status`), slices 3 and 4 = DOR-1891/1892   | `GET /api/harness/status` and `HarnessStatusResponse`. §1.8 and §3 add fields to that schema. **If it is late:** every slice here still ships, because every surface this spec builds renders in `dorkos harness sync` first. The schema additions land with whichever ticket gets there second, guarded by §3's compile-time table. |
| **DOR-1852 slice 1** (the harness id vocabulary moves into `@dorkos/shared`) | `HarnessIdSchema` has to be reachable from `config-schema.ts`, and the dependency runs the wrong way today (§2.3). **If it is late:** slice A3 performs the identical move and slice 1 becomes a no-op.                                                                                                                              |
| **DOR-1856** (the H tier)                                                    | The only gate in this spec: slice A3 may not land before it reports (§Implementation Phases). **If it is late:** slices B1, A1 and A2 are unaffected.                                                                                                                                                                                |
| **DOR-1889** (`checkPlan().orphans` equals the next `swept`)                 | `plan/types.ts`'s `DriftResult.orphans` doc already pins this for the six project sweeps. Slice A2's global sweep joins the same contract from the start rather than being retro-fitted.                                                                                                                                             |
| `conf` v15.1.0 + `UserConfigSchema`                                          | §2.3's `harness.global` block and its `'0.76.0'` migration. `config-manager.ts:3772-3780` already reserves that key by name.                                                                                                                                                                                                         |
| `@dorkos/marketplace`                                                        | Unchanged. Part B's offer is a printed command into the install flow that exists.                                                                                                                                                                                                                                                    |

Vendor documentation this spec rests on, all fetched 2026-09-08 by the ideation and re-stated here:
[code.claude.com/docs/en/skills](https://code.claude.com/docs/en/skills),
[settings-reference](https://code.claude.com/docs/en/settings-reference),
[plugins-reference](https://code.claude.com/docs/en/plugins-reference),
[plugin-marketplaces](https://code.claude.com/docs/en/plugin-marketplaces),
[discover-plugins](https://code.claude.com/docs/en/discover-plugins),
[learn.chatgpt.com/docs/build-skills](https://learn.chatgpt.com/docs/build-skills),
[opencode.ai/docs/skills](https://opencode.ai/docs/skills/),
[cursor.com/docs/skills](https://cursor.com/docs/skills),
[gemini-cli `docs/cli/skills.md`](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/skills.md),
[GitHub Copilot CLI config-dir reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-config-dir-reference).

## Detailed Design

### 0. Two parts, four slices, and what each flips

The ideation named Part A's stages **B → D → A**, which collides with the part letters. This document
renames them **A1 → A2 → A3** and keeps a mapping so nothing is lost.

| This spec | Ideation | What it is                                                                                                                                                 |
| --------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **B1**    | 1857b    | Claude Code's own plugins: two file reads, a report, a printed offer. No plan, apply or sweep change.                                                      |
| **A1**    | slice B  | The honest drop: the scanner enumerates a global package, `InstalledPlugin` gains a location union, the both-scopes notice. Still no write outside a repo. |
| **A2**    | slice D  | `buildGlobalPlan` and its apply, targeting `<dorkHome>/skills` only. A global scheduled skill runs.                                                        |
| **A3**    | slice A  | The user tier: `~/.agents/skills` and `<claudeRoot>/skills`, the three-clause sweep, the ask, the retirement of SDK injection. **Gated on DOR-1856.**      |

**Ship order: B1 → A1 → A2 → A3.** B1 is first because it is smaller, entirely verified, and its outcome is
a sentence the operator's own machine can show today. A1 is next because it stops the current lie, and
because A2 cannot project what the scanner does not enumerate.

**Contract rows, per slice.** Every row that stays `not built` records the reason in the same edit.

| Slice  | Flips to built                                                          | Stays `not built`, with the reason recorded                                                                            |
| ------ | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| **B1** | SRC-08 (read and reported), J-07 (the terminal half), HK-14's user half | TR-10 (decision 12); J-07's app half (DOR-1852); §14 item 2's remaining clauses                                        |
| **A1** | SRC-12 (the both-scopes notice)                                         | SRC-04 stays `not built` for projection; its row records that the drop is now honest and names the slice that projects |
| **A2** | SK-03's global half                                                     | SRC-04 still not projected to any harness                                                                              |
| **A3** | SRC-04; §14 gap 11 struck through                                       | IN-08 refused (decision 4); SRC-09 unread; the hooks, commands and MCP refusals recorded per kind                      |

D4 is corrected in the same PR as B1 (decisions 9 and 10 below). §16's position text gains two sentences;
the position itself stands.

### 1. Part B — Claude Code's own plugins (slice B1)

#### 1.1 Which Claude root is opened, and why it is printed

**Decision: read the root a bare `claude` uses (`$CLAUDE_CONFIG_DIR`, else `~/.claude`), never
`resolveActiveClaudeRoot()`, and print it every time.**
**Why:** `resolveActiveClaudeRoot()` is `runtimes.claudeCode.defaultAccount ?? inheritedClaudeRoot()`
(`claude-config-dir.ts:140-142`), and its first rung answers a different question, namely which Claude
account DorkOS runs and bills on. J-07 asks which Claude Code the person typed `/plugin install` into, which
is the one their own shell launches. An operator who pins a default account to bill one client makes those
two answers differ on purpose.

`inheritedClaudeRoot()` (`claude-config-dir.ts:57-59`) is exactly that chain and is **private today**. Slice
B1 exports it, unchanged. It must be exported rather than re-derived: that file is the Hard Rule 3 carve-out
and the carve-out is **by filename** (`claude-config-dir.ts:27-32`), so no sibling module may call
`os.homedir()` for this.

**One call site, not two.** The CLI already reaches server modules by relative path and does it dynamically
(`harness-sync-command.ts:774`, `:817`, `:818`), so the CLI imports the same server module rather than
re-deriving the chain in `packages/cli`.

**The root is printed on every run.** `$CLAUDE_CONFIG_DIR` is the rung both resolvers share and it is
inherited, so a run started from inside an agent session can read a different root than the person's own
terminal. That is the split-brain `claude-config-dir.ts:12-20` already warns about. Measured on the
operator's machine while the ideation was written: `$CLAUDE_CONFIG_DIR` pointed at a sibling root holding 7
entries while `~/.claude` held 16. Choosing the right resolver does not by itself make the answer right;
disclosure does.

**`resolveClaudeRootSet()` is never used here.** It exists to enumerate every root for listing and search.
Reporting plugins from accounts a person is not running describes sessions they are not having.

#### 1.2 What is read, and the schema that reads it

**Three documented keys from one file, and nothing else.** Never `~/.claude/plugins/`, never
`known_marketplaces.json`, never `plugin-catalog-cache.json`.

```ts
/**
 * The slice of a Claude Code settings file DorkOS reads.
 *
 * `.passthrough()` at both levels on purpose: this is somebody else's file and
 * the vendor adds keys to it. Every field named here is documented
 * ([settings-reference], [plugin-marketplaces], both read 2026-09-08); everything
 * else is carried through untouched and never inspected.
 */
const ClaudeSettingsSliceSchema = z
  .object({
    /** `"<plugin-name>@<marketplace-name>"` → whether the person turned it on. */
    enabledPlugins: z.record(z.string(), z.boolean()).optional(),
    /** Marketplace local name → where it came from. The public half of the registry. */
    extraKnownMarketplaces: z
      .record(
        z.string(),
        z
          .object({
            source: z.object({ source: z.string(), repo: z.string().optional() }).passthrough(),
            // Documented beside `source`; unread here, and present so the schema
            // still says something when the vendor adds a sibling field.
            autoUpdate: z.boolean().optional(),
          })
          .passthrough()
      )
      .optional(),
    /**
     * Hooks, for HK-14's user half — COUNTED, never read.
     *
     * The schema deliberately never names `command`, so no shell text a person
     * wrote is ever bound to a value. Counting matcher groups and the entries
     * inside them needs array lengths and nothing more.
     */
    hooks: z
      .record(
        z.string(),
        z.array(z.object({ hooks: z.array(z.unknown()).default([]) }).passthrough())
      )
      .optional(),
  })
  .passthrough();
```

**A failure becomes a record, never a throw.** The model is `inventory/read.ts`: absent is silent,
present-and-unreadable is an `UnreadableSource`-shaped record carrying the path and the reason, and the read
keeps going. The counter-example in the tree is `loadClaudeHooks` (`engine.ts:45-51`), which does a bare
`JSON.parse` with a cast and throws. A read of somebody's home directory must not be able to crash
`dorkos harness sync`, and a torn read while Claude Code rewrites the file is the ordinary case, not the
exotic one.

**Reported entries are the ones whose merged value is `true`.** Seven of the operator's sixteen are `false`,
and a plugin somebody turned off is not something they are missing.

#### 1.3 The merge across settings scopes, and the two sentences it earns

`enabledPlugins` has settings scope "Any file"
([settings-reference](https://code.claude.com/docs/en/settings-reference), 2026-09-08), so it is legal in
four files DorkOS can reach and one it may not:

| File                                 | Read by B1 | Note                                                                                               |
| ------------------------------------ | ---------- | -------------------------------------------------------------------------------------------------- |
| `<claudeRoot>/settings.json`         | yes        | the machine-wide half                                                                              |
| `<repo>/.claude/settings.json`       | yes        | the engine already opens this exact path (`engine.ts:45-51`)                                       |
| `<repo>/.claude/settings.local.json` | yes        | the vendor's own uninstall flow writes a disable override here                                     |
| managed settings                     | **no**     | may be unreadable to DorkOS; §1.6 says the answer may be overridden, never that the file is absent |

**Reading only the user half would make the report actively wrong in the most ordinary case there is:** a
plugin a person turned off _for this repo_ would be listed as "installed in Claude Code only, install it
through DorkOS". So the read merges the three readable files under Claude Code's documented precedence,
**per key** (local over project over user), and reports the keys whose merged value is `true`.

**A project `true` with no user entry is a different case and gets its own line.** The plugin is on for this
repo only. It is still invisible to every other agent tool, so it still belongs in the report, under its own
heading, never folded into the machine-wide list. This repository's own `.claude/settings.json` carries
`"enabledPlugins": {}`, which is the empty case and not the absent one.

**`defaultEnabled` is a hole that does not close, and it is paid for in the copy.** A plugin with no entry
at any scope is not off: `defaultEnabled` "is the fallback when nothing else has decided the plugin's state"
and "defaults to `true`" ([plugins-reference](https://code.claude.com/docs/en/plugins-reference),
2026-09-08). The public half cannot enumerate installs at all, so a fourth state ("on by default, not
listed") is not computable. Therefore the report says **"plugins you turned on in Claude Code"**, never
**"plugins installed in Claude Code"**, and the count carries the same qualifier. That sentence is the price
of D4's rule and it is cheaper than the rule it would break.

#### 1.4 The repository normaliser

**Decision: match a Claude Code marketplace to a DorkOS marketplace source on the repository, never on the
marketplace name.**
**Why:** measured on the operator's machine, Claude Code's `dorkos` and DorkOS's `dorkos-community` are the
same repository under two local names, so a name match misses it, and a name match against a marketplace
somebody happened to call `dorkos-community` would be a false positive. On the repository, 15 of 16 entries
resolve with no question asked. The sixteenth is absent from the public half, and that is where asking
belongs.

**A naive comparison resolves zero, which is why this is a module and not two lines.** The two sides spell
the same fact differently: Claude Code stores `{ source: "github", repo: "anthropics/claude-plugins-official" }`,
DorkOS stores the full URL `https://github.com/anthropics/claude-plugins-official`
(`marketplace-source-manager.ts:68-84`). `"anthropics/claude-plugins-official" === "https://github.com/anthropics/claude-plugins-official"`
is false, so a direct comparison matches 0 of 16.

New pure module, `apps/server/src/services/marketplace/lib/marketplace-repo-key.ts`:

```ts
/**
 * One comparable key for "which repository is this marketplace", folded from the
 * two spellings DorkOS and Claude Code each use for it.
 *
 * Returns `null` rather than guessing when the input names a host kind with no
 * `owner/name` slug to fold — a `git` or `file` source has no key, and pretending
 * it does is how a false match is manufactured.
 */
export function marketplaceRepoKey(input: MarketplaceRepoInput): string | null;

/** Either spelling: a DorkOS source URL, or a Claude Code `source` object. */
export type MarketplaceRepoInput =
  { kind: 'url'; url: string } | { kind: 'claude-source'; source: string; repo?: string };
```

The fold, stated so a test can pin it: from a URL, strip the scheme, any `www.`, the host, a trailing
`.git`, a trailing slash; lower-case the host segment and **preserve case on the path**. From a Claude Code
source, require `source === 'github'` and take `repo` as `owner/name`. The result is `owner/name`. The two
real pairs measured on the operator's machine are the module's first fixtures.

`marketplaceRepoKey` is pure, has no filesystem access, and is unit-tested on its own. It lives beside
`locate-install.ts` because the marketplace domain owns what a source is, and the harness domain should not
learn to parse one.

#### 1.5 The offer, and the five rungs it degrades through

Every rung ends with the person knowing more than they did, and nothing is ever installed without them
asking. **Never auto-install:** the offer is a printed command into the flow that already exists, with its
existing preview and its existing approval (`cli.ts:149-222`), and it must not become a second install path.

| Rung  | Situation                                                                    | What is printed                                                         |
| ----- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| **1** | The repository resolves to a marketplace DorkOS has, and it has that package | The install command, under "DorkOS can install these for this project". |
| **2** | The repository resolves to a marketplace DorkOS does not have                | The source URL and `dorkos marketplace add`, then the install command.  |
| **3** | The marketplace name is not in `extraKnownMarketplaces`                      | "DorkOS can't tell where this one came from." No offer, no guess.       |
| **4** | The source resolves and has no package of that name                          | Said plainly, and stop. Common, and not a failure.                      |
| **5** | The source has that name, and DorkOS cannot claim it is the same thing       | "a package of the same name from the same repository", never more.      |

**Rung 5 is a copy rule, not a branch.** Neither side carries a version DorkOS can compare:
`enabledPlugins` is a name and a boolean, and `InstalledPlugin` has no `version` field
(`sources/installed.ts:117-154`). "Same name, same repository" is the strongest claim the data supports, so
rungs 1 and 2 print that phrase and never "the same plugin" or "the same version". A repository can rename,
re-scope or repoint a package between the day Claude Code cached it and the day DorkOS resolves it, and the
person is the only one who can tell.

**Decision: the offer points at project scope until slice A3 lands, then it gains the global option.**
**Why:** measured against the code, a DorkOS global install today reaches only DorkOS-driven Claude Code
sessions, through SDK injection. A person who already has that plugin in Claude Code would trade one
Claude-Code-only copy for another. A DorkOS project install reaches every enabled agent tool today, through
the projection that already works. This corrects D4, which asked for the global scope on the grounds that it
"is the same work DOR-174 needs" — true of the work, false of the outcome.

#### 1.6 The output block, frozen

Printed by the CLI **beside** `formatDropList`'s output, never inside it. Putting it inside would make
`@dorkos/harness` read a home directory, which three of its module docs forbid by name
(`inventory/index.ts:47-50`, `inventory/types.ts:22-24`, `inventory/hooks.ts:11-15`). The block is assembled
in `packages/cli/src/harness-sync-command.ts` from the server module's return value.

**Nothing is printed when there is nothing to say.** No `enabledPlugins`, or none merging to `true`, prints
zero lines. A block that always appears is a block people learn to skip.

The frozen lines. `{root}`, `{n}`, `{name}`, `{repo}`, `{marketplace}`, `{url}` and `{reason}` are the
only substitutions.

```
Installed in Claude Code only
  Read from {root}

  You turned on {n} plugins in Claude Code. Your other agent tools cannot see them.

  DorkOS can install these for this project, so every agent tool here gets them:
    - {name} (from {repo})
  Run: dorkos install {name} --project .
  DorkOS has to be running, and it asks you to approve the install first.

  DorkOS does not have these marketplaces yet:
    - {name} (from {repo})
  Add the source first: dorkos marketplace add {url}

  DorkOS has the marketplace but nothing by that name:
    - {name} (from {repo})

  DorkOS cannot tell where these came from:
    - {name} (marketplace "{marketplace}")

  On for this project only:
    - {name} (from {repo})

  A managed settings file can turn plugins on or off above all of these. DorkOS cannot read one, so
  this list may not be the whole story.
```

Singular forms: `You turned on 1 plugin in Claude Code.` A group with no members is not printed at all,
heading included.

The unreadable case replaces the whole block:

```
Installed in Claude Code only
  DorkOS could not read {root}/settings.json, so it cannot tell you what Claude Code has. ({reason})
  Nothing else in this report is affected.
```

The managed-settings sentence prints once, at the end, whenever any group printed. It is the honest form of
experiment 3's open half: DorkOS says the answer may be overridden rather than answering as if the file were
absent.

Every line above is plain, active, under twenty words, and carries no em dash, per `writing-for-humans`.
"Agent tools" is used rather than "harnesses": a person did not install a harness.

#### 1.7 HK-14's user half

One extra line, printed inside the same block, from the same read:

```
  Your personal Claude Code settings run {n} hook commands. Only Claude Code runs them.
```

Printed only when `n > 0`. `n` is the total number of entries across every matcher group in `hooks`,
computed from array lengths alone (§1.2). **Never generate from them**, never inventory them as the
project's: `inventory/hooks.ts:1-23` already states the reason, that a source inventory of a repository
which reached into a home directory would report one machine's private hooks as if they were the project's.

#### 1.8 The status payload, shape only

Slice B1 adds one optional field to `HarnessStatusResponseSchema` in
`packages/shared/src/harness-schemas.ts` and populates it in `services/harness/status.ts`. The page that
renders it is DOR-1852's.

```ts
/**
 * What Claude Code alone has: the plugins a person turned on in Claude Code's
 * own settings, and the root they were read from. The root is always present,
 * because `$CLAUDE_CONFIG_DIR` is inherited and the answer is only checkable if
 * you can see which file it came from.
 */
export const HarnessClaudeOnlySchema = z.object({
  root: z.string(),
  readAt: z.string(),
  /** Why the read failed, in words. When set, `plugins` is empty and means nothing. */
  unreadable: z.string().optional(),
  /** True when a managed settings file may exist and could not be read. Always true today. */
  mayBeOverridden: z.boolean(),
  plugins: z.array(
    z.object({
      name: z.string(),
      /** The marketplace's local name inside Claude Code's settings. */
      marketplace: z.string(),
      /** `owner/name`, when `extraKnownMarketplaces` resolved it. Absent is rung 3. */
      repo: z.string().optional(),
      /** `project` means on for this repository only. */
      settingsScope: z.enum(['user', 'project']),
      offer: z.enum(['install', 'add-source-then-install', 'unknown-source', 'no-package']),
      /** The source URL to add, for `add-source-then-install` only. */
      sourceUrl: z.string().optional(),
    })
  ),
  /** HK-14: how many hook commands the personal settings file declares. */
  personalHookCommands: z.number().int().nonnegative(),
});
```

Added to `HarnessStatusResponseSchema` as `claudeOnly: HarnessClaudeOnlySchema.optional()`. Optional because
the Obsidian transport answers `state: 'unavailable'` and has no home directory to read.

**Budget:** nine plugins is roughly 1 KB. Negligible against DOR-1852's 250 KB, and it is measured in the PR
like every other number there.

#### 1.9 Files

| File                                                                                        | Change                                                                                                                                     |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/server/src/services/runtimes/claude-code/claude-config-dir.ts`                        | Export `inheritedClaudeRoot`, unchanged, with a TSDoc line saying who else reads it and why not the active root.                           |
| `apps/server/src/services/harness/claude-enabled-plugins.ts` **(new)**                      | The read, the merge, the schema, the rung classification. Takes `claudeRoot` and `projectPath` as arguments; calls no resolver of its own. |
| `apps/server/src/services/harness/__tests__/claude-enabled-plugins.test.ts` **(new)**       | §Testing.                                                                                                                                  |
| `apps/server/src/services/marketplace/lib/marketplace-repo-key.ts` **(new)**                | The normaliser.                                                                                                                            |
| `apps/server/src/services/marketplace/lib/__tests__/marketplace-repo-key.test.ts` **(new)** | Its fixtures.                                                                                                                              |
| `packages/cli/src/harness-sync-command.ts`                                                  | One dynamic import and one print block, after `formatDropList` and before `formatNotEnabled`.                                              |
| `packages/shared/src/harness-schemas.ts`                                                    | `HarnessClaudeOnlySchema` and the optional field.                                                                                          |
| `apps/server/src/services/harness/status.ts`                                                | Populate it. If DOR-1891 has not landed, this hunk moves to whichever ticket lands second.                                                 |
| `meta/harness-sync-capabilities.md`                                                         | SRC-08, J-07, HK-14, TR-10, D4.                                                                                                            |

**Nothing in `packages/harness` changes in slice B1.** That is the claim that matters, and it is narrower
than "zero engine change": B1 touches no plan, no apply, no sweep and no target.

### 2. Part A — global scope

#### 2.1 The engine API: a second entry point, not a discriminator

**Decision: a separate `buildGlobalPlan(input)` beside `project(repoRoot, opts)`, never a root
discriminator on `project()`.**
**Why:** `buildPlan` runs every stage unconditionally, in order — skills, instructions, hooks, commands,
inventoried artifacts, installed skills, installed commands, plugin hooks, the OpenCode gitignore, the
canonical links, Claude-only skills, name collisions, then the harness-agnostic drops
(`plan/projector.ts:660-836`). A discriminator would run all of that against a home directory and rely on
each stage opting out. Decision 2 (never generate at user scope) would then be enforced by fourteen
independent omissions, and the ordinary way a rule like that is lost is a fifteenth stage added later by
somebody who never read this document. A separate entry point inverts it: a stage reaches the global plan
only if somebody puts it there.

The engine is a leaf package and cannot import a server service, so every input is handed in:

```ts
/** Where a global plan may write. An absent root is a root the plan does not target. */
export interface GlobalPlanRoots {
  /**
   * The DorkOS data directory. Always present: it is where global packages are
   * read from (`<dorkHome>/plugins/<pkg>`) and where the scheduler's own root is
   * (`<dorkHome>/skills`).
   */
  dorkHome: string;
  /**
   * The cross-tool user-level skills directory, absolute — `~/.agents/skills` on
   * an ordinary machine. Absent means the user tier is not planned at all, which
   * is how a boundary-confined deployment, an unanswered ask and a machine with
   * no enabled harness all reach the same code path.
   */
  agentsSkillsDir?: string;
  /**
   * Claude Code's user-level skills directories, absolute. Normally one; two
   * only when an operator pinned a default account that differs from the root a
   * bare `claude` opens (§2.12). Empty means no Claude Code link is planned.
   */
  claudeSkillsDirs?: readonly string[];
}

/** Everything a global plan needs. The engine reads no config and resolves no home. */
export interface GlobalPlanInput {
  roots: GlobalPlanRoots;
  /**
   * The agent tools this machine shares global packages with. Empty is legal and
   * plans the dork-home tier only, which needs no harness to be useful.
   */
  harnesses: readonly HarnessId[];
}

/**
 * Plan the projection of every globally installed package's skills.
 *
 * Pure and read-only. Never throws: an unreadable package becomes a warning and
 * the walk keeps going, following `inventory/read.ts`.
 */
export function buildGlobalPlan(input: GlobalPlanInput): ProjectionPlan;
```

It returns the **same** `ProjectionPlan` type as `project()`, so `formatDropList`, `formatWarnings` and
DOR-1852's status model read one shape. Two of that type's fields are always empty in a global plan, and
the TSDoc says so rather than leaving a reader to wonder: `notEnabled` is a per-repository detection
result and there is no repository here, and `narrowedTo` is never set because `buildGlobalPlan` takes no
narrowing parameter (§2.4). Two callers apply it:

```ts
/** Apply a global plan. `roots` is the same object the plan was built from. */
export function applyGlobalPlan(
  plan: ProjectionPlan,
  roots: GlobalPlanRoots,
  opts?: { sweepOrphans?: boolean }
): {
  applied: ProjectionAction[];
  conflicts: ProjectionAction[];
  swept: string[];
  leftAlone: string[];
};

/** What a global sync would change, without changing it. */
export function checkGlobalPlan(plan: ProjectionPlan, roots: GlobalPlanRoots): DriftResult;
```

`applyGlobalPlan` takes `roots` again rather than reading them off the plan, for the same reason
`applyPlan` takes `repoRoot`: an apply that trusts a path carried inside the thing it is applying can be
pointed anywhere by a malformed plan. Passing the roots twice means the containment check in §2.5 has an
independent second opinion to check against.

**Which packages it reads.** `scanInstalledPlugins({ dorkHome })` with no `projectRoot`. Slice A1 makes that
call return real assets (§2.2); today it returns identity only.

**Only skills are planned.** Not commands, not hooks, not instructions. §2.10 argues each refusal.

#### 2.2 The target vocabulary: a `scope` discriminator, and absolute targets

Two type changes, both in slice A1, both chosen so the compiler names every site that assumed repo-relative.

**`InstalledPlugin` gets a location union.** Today `scope: InstalledScope` sits beside an optional
`relDir?: string` documented as "Present only for project-scoped plugins"
(`sources/installed.ts:122-127`). That pairing is unenforced and it is exactly what makes a global package's
paths unresolvable:

```ts
/**
 * Where an installed package's files are.
 *
 * A project install is repo-relative because a project sync resolves against a
 * repo root; a global install has no repo, so its directory is absolute. Making
 * this a union rather than a scope tag beside an optional path is the point: the
 * compiler names every site that assumed repo-relative, which is the whole of the
 * engine before this slice.
 */
export type InstalledLocation =
  { scope: 'project'; relDir: string } | { scope: 'global'; absDir: string };
```

`InstalledPlugin.scope` and `InstalledPlugin.relDir` are replaced by `location: InstalledLocation`. Every
`InstalledSkill.sourceDir` and `InstalledCommand.sourcePath` follows its package: repo-relative under a
project location, absolute under a global one.

`unreadableHooks`'s contract changes with it. Its doc today reads "absent means the file was never read (a
global install)" (`sources/installed.ts:145-152`). After slice A1 a global package's hooks file **is** read,
to the same standard as a project one, so absent recovers its plain meaning: the file is not there. That
clause is deleted rather than reinterpreted, and the slice's test asserts the new meaning on a global
fixture with a malformed `hooks/hooks.json`.

**`ProjectionAction` gets `scope`, and a global action's `target` and `source` are absolute.**

```ts
/**
 * Which plan this action belongs to.
 *
 * A project action's `source` and `target` are repo-relative POSIX strings that
 * resolve inside `repoRoot`; a global action's are absolute POSIX paths that
 * resolve inside one of the plan's declared roots. Absent means `'project'`, so
 * every existing emitter is unchanged and the field cannot be forgotten into a
 * false global.
 */
scope?: 'project' | 'global';
```

**Why a discriminator and not a `root` field.** A `root` field would let a target stay relative and be
joined against something other than `repoRoot`. That is a second, silent way for a target to escape the repo
root, which is precisely the hazard P8 exists to catch, and every reader of `target` would have to remember
to join it first. An absolute target is self-describing: the property in §2.5 is then checkable on the
target alone, exactly as it is today.

**How DOR-1852's row key stays unique across scopes.** That spec keys a row on `(artifact, source, name)`
and argues each component from a measured counter-example. Global scope supplies the fourth: the same
package installed at both scopes projects a skill of the same name, of the same artifact kind, from sources
that differ only in whether the path happens to be absolute. Relying on that spelling would be relying on an
accident. So **`HarnessRowSchema` gains `scope: z.enum(['project','global']).default('project')` and the key
becomes `(scope, artifact, source, name)`**, added in slice A2 — the slice that produces the first global
row — and additive, so DOR-1852's slices land unchanged either way.

#### 2.3 The global manifest lives in `harness.global`

A project's enabled agent tools come from `.agents/harness.manifest.json`. Global scope has no repo.

**Decision: a `harness.global` block in `~/.dork/config.json`, not a second manifest file at
`<dorkHome>/harness.manifest.json`.**
**Why:** the two decisions this block records are the same kind of decision `harness.approvedHooks` and
`harness.refusedHooks` already are, and they belong in the same store, read by the same reader, migrated by
the same chain. A second manifest file would need its own schema, its own scaffold policy, its own
"the engine never rewrites a hand-authored file" rule from ADR-0302, and a second answer to what happens
when it will not parse. `.agents/harness.manifest.json` earns all of that by being committed and shared;
nothing at global scope is either.

```ts
      /**
       * The agent tools DorkOS shares your globally installed packages with.
       *
       * Empty means none, which is where a fresh install sits until somebody
       * answers the one-time question `dorkos harness sync --global` asks. There
       * is no separate on/off flag: an empty list IS off, so the two can never
       * disagree.
       */
      global: z
        .object({
          harnesses: z.array(HarnessIdSchema).default(() => []),
          /**
           * When the question was answered, ISO-8601. `null` means it has never
           * been asked, which is a different state from asked-and-declined:
           * declined is a timestamp with an empty list, and it is remembered.
           */
          askedAt: z.string().nullable().default(null),
        })
        .default(() => ({ harnesses: [], askedAt: null })),
```

**`HarnessIdSchema` has to be reachable from `config-schema.ts`, and today it is not.** The harness id
vocabulary lives in `packages/harness/src/manifest/schema.ts`, and `@dorkos/shared` cannot import
`@dorkos/harness` because the dependency runs the other way. DOR-1852's slice 1 moves `HARNESS_IDS`,
`HarnessIdSchema`, `HarnessId` and `HARNESS_LABELS` into `packages/shared/src/harness-schemas.ts` and
re-exports them from their old home, with the bar "not one import anywhere changes". If that has not
landed when slice A3 does, **A3 performs the same move**, unchanged, and DOR-1852's slice 1 becomes a
no-op. Either way it happens once.

**The `<dorkHome>/skills` tier is not switchable, and that is deliberate.** It writes only inside DorkOS's
own data directory, into a root DorkOS already creates on boot (`ensureGlobalSkillsRoot`,
`services/tasks/skills-roots.ts:152`) and already watches. Asking a person for permission to put a link in
a directory DorkOS made for itself teaches them to click yes without reading, which is the behaviour every
later question in this design depends on them not having.

**The migration, and the whole `adding-config-fields` checklist it drags in.** `harness` is an existing
top-level section, so `conf`'s shallow default merge does **not** reach a new nested leaf: the migration
body is the only thing that writes it.

- **Key `'0.76.0'`.** `VERSION` is `0.74.0`, `v0.74.0` is the newest tag, and `'0.75.0'` is already merged
  and pinned. `config-manager.ts:3772-3780` says so in words: "anything further opens `'0.76.0'`". A merged
  body is frozen, so `'0.75.0'` may not be extended.
- **Body**, idempotent and absence-guarded, seeding `{ harnesses: [], askedAt: null }` onto a stored
  `harness` object that has no `global` member.
- **Pin it** in `apps/server/src/services/core/__tests__/merged-migration-hashes.ts` in the same PR.
- **`CONFIG_DISCLOSURE`:** `'harness.global.harnesses'` → `expose`, `'harness.global.askedAt'` → `expose`.
  Neither is a credential nor names one, and an agent that can say "your global packages are not shared with
  Codex" is more useful than one that cannot.
- **`CONFIG_WRITE_POLICY`:** both `operator-only`. Changing `harnesses` changes how far DorkOS reaches on
  disk, which is the line that module draws.
- **Docs:** a row each in `contributing/configuration.md` and `docs/getting-started/configuration.mdx`.
- **Test:** an upgrade-path case in `config-manager.test.ts` against a stale blob whose `harness` section
  has the three existing leaves and no `global`.

#### 2.4 The sweep, and the clause the repo predicate does not have

Today's predicate is **two clauses**: a candidate under `.agents/skills` or `.claude/skills` is swept only
if its basename contains `__` **and** it is a real symlink (`apply/apply.ts:315-336`, pinned by
`installed-integration.test.ts:420` which stages a hand-authored `my__helper/` directory beside an orphaned
`gone__skill` link and asserts only the link goes).

That is sufficient in a repository, where every symlink in `.agents/skills` was put there by the engine. **It
is not sufficient in a home directory, and the operator's own machine proves it:**
`~/.claude/skills/composio-cli` and `~/.claude/skills/find-skills` are relative symlinks into
`~/.agents/skills/`, whose two targets are real hand-authored directories (re-verified with `ls -la` on
2026-09-08 while writing this spec, not carried over from the ideation). A person has hand-built the
exact projection slice A3 proposes to automate. Under the
two-clause predicate the only thing standing between those links and the sweep is the absence of `__` in
their names.

**Decision: at global scope the predicate is three clauses, all required.**

```
A candidate directly inside a directory the CURRENT global plan targets is swept only when:
  1. `lstat` says it is a symlink; and
  2. its basename contains `__`; and
  3. the link's own text, resolved LEXICALLY against the directory the link sits in, is inside
     `<dorkHome>/plugins`; and
  4. the current global plan does not name that target path.
Clauses 1-3 decide ownership. Clause 4 decides orphanhood.
```

Three details decide whether this is correct or merely careful:

- **Clause 3 reads the link text, never `realpath`.** A global uninstall removes the package directory
  first, so the links it left behind are dangling and `realpath` throws on exactly the orphans the sweep
  exists to remove. Resolving `readlinkSync(p)` against `dirname(p)` with `path.resolve` normalises `..`
  without touching the filesystem, so a dead DorkOS link is still recognisably ours.
- **Containment is a path-segment test**, `p === root || p.startsWith(root + path.sep)`. A bare
  `startsWith` matches `<dorkHome>/plugins-of-someone-else`.
- **The sweep never descends.** It reads one level of each target directory. A person's own subdirectory
  tree in `~/.agents/skills` is not walked, so nothing inside it can be a candidate.

**A target that is already occupied is a conflict, never an overwrite.** P3 ("conflict never destroys")
holds unchanged at global scope, and it is the other half of the ownership story: if
`~/.agents/skills/globex__greet` is already a real directory, or a symlink pointing somewhere other than
`<dorkHome>/plugins`, `applyGlobalPlan` leaves it exactly as it is, counts it in `conflicts`, and prints the
line that says what is in the way. A person's hand-built version of this projection is therefore safe twice
over: the sweep will not remove it, and the apply will not replace it.

**Scope.** The sweep only looks in directories the current plan targets, and the user tier is only targeted
for agent tools in `harness.global.harnesses` — the same rule AP-07 already applies to enabled harnesses at
project scope. A global plan is never narrowed to one agent tool, so the `applyPlan` guard that throws on a
narrowed sweep (`apply/apply.ts:693-698`) has no global twin; `buildGlobalPlan` has no `harness` narrowing
parameter at all, which is the stronger form of the same protection.

**Every path is printed before it is removed.** `checkGlobalPlan().orphans` equals the next
`applyGlobalPlan().swept`, asserted as set equality in both directions, joining the contract DOR-1889 sets
for the six project sweeps. The global apply prints the list first and then the receipt, in that order.

**A global uninstall must sweep the user-level links**, and that is the single riskiest line in this
feature. It is exercised in the same slice as the sweep: a staged HOME holding a hand-authored directory, a
hand-authored symlink into `~/.agents/skills` (the operator's real shape), a Codex-installed directory and a
DorkOS link; uninstall; assert exactly one thing was removed.

#### 2.5 The properties: P8 re-scoped, two new ones beside it

`plans/harness-sync-test-plan.md` line 64 today reads: **"P8 scope: no action's target escapes `repoRoot`;
a global plugin never appears in a target path."** A property that is relaxed rather than replaced is how
this kind of work goes wrong, so P8 is re-scoped and two siblings join it. Exact statements, to be written
into the plan in slice A2:

> **P8 project scope [v2]:** every action in a plan built by `project()` carries `scope` absent or
> `'project'`, its `target` and `source` are repo-relative POSIX strings, and each resolves inside
> `repoRoot`. No path built from a `dorkHome` appears in any of them. As strong as v1; only its subject is
> named.

> **P8b global roots:** every action in a plan built by `buildGlobalPlan` carries `scope: 'global'` and an
> absolute POSIX `target`, and that target resolves inside one of the plan's declared roots and inside no
> other directory. A root passed as absent produces no action beneath it, and the counterexample prints the
> offending target and the root set.

> **P8c global kinds:** no action in a global plan has `kind: 'generate'`, `kind: 'scaffold'` or
> `kind: 'merge'`. Every global action is `symlink`, `native` or `drop`. Decision 2 has no other
> enforcement, and `buildPlan` running every stage unconditionally is the ordinary way it would be lost.

P4 ("sweep touches only what it wrote") gains one global clause rather than becoming a second property: at
global scope a removal must additionally satisfy clause 3 of §2.4, and the ledger the property already keeps
is extended to the global roots.

#### 2.6 `DORKOS_BOUNDARY`

**Decision: when a boundary was configured explicitly, the user tier is skipped and says so. The dork-home
tier is unaffected. `validateBoundaryOrDorkHome` is never called here.**
**Why:** `initBoundary`'s default root is the person's home (`lib/boundary.ts:94-99`), so an ordinary
install is already inside it, but a `DORKOS_BOUNDARY`-scoped deployment is deliberately confined and writing
into `~` would defeat the point of configuring it. `validateBoundaryOrDorkHome` narrows to
`<dorkHome>/agents/*` on purpose (`boundary.ts:410-430`) and reaching for it here would either refuse the
write or invite somebody to widen a security narrowing to make a feature work.

The dork-home tier is not skipped because a boundary limits how far DorkOS reaches into a person's disk, and
`<dorkHome>` is DorkOS's own directory, which every deployment already writes to on every boot.

**This needs a predicate that does not exist.** `initBoundary(undefined)` stores the resolved home path, so
"confined to home" and "not configured" are indistinguishable downstream; there is no
`isBoundaryConfigured`-shaped export anywhere in the repo. Slice A3 adds one:

```ts
/**
 * Whether a boundary was configured explicitly, as opposed to defaulted to the
 * home directory.
 *
 * `initBoundary` records the answer because it is the only place that can: after
 * it runs, a defaulted boundary and one configured AS the home directory are the
 * same string. Read it to decide whether a write outside dork-home is something
 * this deployment was set up to refuse — never to widen the boundary itself.
 */
export function boundaryWasConfigured(): boolean;
```

Set from whether `initBoundary` received a non-null argument. Nothing else may re-derive it from
`process.env.DORKOS_BOUNDARY`: `apps/server/src/env.ts:106` is the one read of that variable on the server
and it stays that way.

Frozen line, printed by the CLI and the boot summary:

```
Packages you installed for all your projects stay inside DorkOS here, because DorkOS is limited to {root}.
```

#### 2.7 The first global projection is asked for, once, and remembered

**Decision: the CLI asks. The answer is `harness.global.harnesses` plus `harness.global.askedAt`. The boot
pass never asks; the app does not ask in this work.**
**Why:** D5 puts "changes what every future session reads" in the report-line-by-line category, and a first
write into a person's home directory is past that line. The boot pass runs unattended, which is exactly
where a question cannot be answered, and `runAutoProjection` already refuses to scaffold or ask for the same
reason (`auto-project.ts:312-331`). The app's version of this question belongs on the Skills page, which is
DOR-1852's surface and not built yet.

**The ask, and the one path that writes the answer.** `dorkos harness sync --global` with `askedAt: null`
prints the block below, writes nothing, and exits `0`. Writing the answer is a separate, named command, in
the shape ADR-0302's amendment established for `--fix --enable <harness>`: one explicit verb, one array
element, nothing round-tripped.

```
dorkos harness global --enable <tool>    # adds one agent tool, and stamps askedAt
dorkos harness global --disable <tool>   # removes one
dorkos harness global --list             # shows the answer and the directories it implies
```

`--list` also stamps nothing. A `--disable` that empties the list leaves `askedAt` set: declined is
remembered, and the question is not asked again.

The frozen ask, printed once:

```
Share your global packages with your other agent tools?

DorkOS would put links in these folders in your home directory:
  {agentsSkillsDir}   read by Codex, OpenCode, Cursor, Gemini CLI and Copilot
  {claudeSkillsDir}   read by Claude Code

It would add these links, and nothing else:
  - {linkName}

Each link points at a folder inside {dorkHome}/plugins. DorkOS only ever creates links in those two
folders, never files, and it only ever removes a link it made itself.

If you uninstall a package later, DorkOS removes its links too.
Claude Code needs a restart before it sees a skills folder that was just created.

To say yes, run this once per agent tool you want:
  dorkos harness global --enable <tool>
where <tool> is one of: claude-code, codex, cursor, gemini, copilot, opencode.
`dorkos harness global --list` shows what you chose.
```

Every link name is printed, never a count. The list is what the person is agreeing to; a number is not.

#### 2.8 The dork-home tier, and why it is its own slice

`<dorkHome>/skills/<pkg>__<name>` → `<dorkHome>/plugins/<pkg>/skills/<name>`, one link per skill, planned
whatever agent tools are enabled, carrying `harnessAgnostic: true`.

Everything downstream already works and already has tests:

- `globalSkillsRoot(dorkHome)` is `<dorkHome>/skills`, created on boot, returned by `globalTaskRoots` as a
  watched root with `scope: 'global'` (`services/tasks/skills-roots.ts:39`, `:105`, `:152`).
- `skills-root-discovery` already expects `<pkg>__<name>` links: it relaxes `parseSkillFile`'s
  name-must-match-directory default explicitly because Harness Sync projects namespaced links.
- A schedule's identity is its resolved real path, and `resolveRootPath` realpaths the root, so a symlinked
  target produces one row and not two.

**Attribution.** Every `ProjectionAction` must carry a `HarnessId` and `HarnessId` has no DorkOS member, so
these links reuse the pattern `SCHEDULE_LINK_ATTRIBUTION` already documents
(`plan/installed-projector.ts:154-165`): a placeholder harness with `harnessAgnostic: true`, and a `reason`
that says plainly why the link is there. Two frozen reasons, matching the project-scope pair:

```
skill declares a schedule; linked into the DorkOS skills folder so the scheduler can find it
linked into the DorkOS skills folder, the one place DorkOS looks for globally installed skills
```

**No per-harness fan-out.** At project scope `planCanonicalSkillLinks` returns nothing when Codex is enabled,
because the per-harness planner already wrote that link (`installed-projector.ts:529-533`). The global
planner has no per-harness stage at all: it emits **one action per target directory per skill**, deduplicated
by target path. That is simpler than the project-scope shape and it is why a global plan cannot produce two
actions racing for one path.

**Why it is a separate slice from A3.** It needs no vendor fact to be right, writes nothing outside DorkOS's
own directory, touches no file a person authored, and delivers a complete outcome on its own: a scheduled
skill in a globally installed package starts running. It is the safest possible first exercise of the
machinery every later slice depends on, and if slice A3 stalls behind the H tier, A2 still shipped something
whole.

#### 2.9 Retiring SDK injection for global scope

Global packages are injected into **every** DorkOS-driven Claude Code session unconditionally, built from
`<dorkHome>/plugins` with no scope filter (`messaging/plugin-activation.ts`,
`claude-code-runtime.ts`). The moment slice A3 writes a Claude Code link at `<claudeRoot>/skills/<pkg>__<name>`, a DorkOS-driven
session can see the same package twice: once as an SDK plugin, once as a personal skill. Claude Code
documents loading a shared target once by realpath, and the two are not the same path, so a duplicate is the
likely outcome rather than a guaranteed one.

**Decision: slice A3 ends by deleting the global SDK-injection path, not by leaving both on.** This is the
resolution ADR `260706-192819` already chose for project scope, applied one directory up: once harness-native
projection covers a scope, SDK injection for that scope is retired. Until A3 lands, the overlap does not
exist, so there is no transitional double to live with — A3 creates it and A3 removes it, inside one slice.

This also settles ADR-0305, whose decision ("merge the global activated set with `<cwd>/.dork/plugins/*`")
already describes code that has been removed. **This spec does not amend ADR-0305** — its project half was
already superseded by `260706-192819`, and its global half is deleted by slice A3 rather than re-decided.
`/adr:review` owns the status flip; the follow-up is filed in §Follow-ups.

#### 2.10 What is refused at user scope, and why each refusal is honest

**Instructions (IN-08). Refused.** ADR-0302's whole mechanism rests on there being a canonical source:
`AGENTS.md` at the repo root, with `CLAUDE.md = @../AGENTS.md` as a pointer to it. At user level there is no
canonical source and DorkOS cannot manufacture one. There is no `~/.agents/AGENTS.md` convention — the
cross-tool convergence at user scope is on the skills directory and on nothing else — and inventing one
would be DorkOS asserting a standard that does not exist, in a directory another vendor's installer also
writes to. `~/.claude/CLAUDE.md` and `~/.codex/AGENTS.md` are not two views of one thing; picking either as
the source would silently change what every session of the other tool reads, on every project on the
machine, with no `git status` and no undo. The pointer trick does not transfer either, because `@` is a
relative import inside one repo and Codex documents no import syntax at all. And the six files are not even
the same kind of thing: Cursor's user rules are `~/.cursor/rules` **plus** a second, account-synced set that
is not a file, so a projection writing the file half would be silently overridden by the half it cannot see.
IN-08's own row allows exactly two outcomes; this is the second one, recorded.

**Hooks (HK-14's write half). Refused; the read half ships in B1.** Projecting a person's private,
machine-wide shell commands into `.codex/hooks.json` inside a repository would put them in a file a teammate
clones, under the HK-11 ownership scheme, in the wrong direction: the commands are the person's, the file is
the team's. D5's floor is "ask once per exact content per project for anything that runs unattended", and
even with a card this is still the wrong direction. Note what the refusal buys the design: the hook consent
digest is keyed on `path.resolve(projectPath)` (`hook-consent.ts:133`), and a global scope has no project
path, so a global plan that projected hooks would need a scope discriminator on the consent key as well.
Refusing hooks removes that whole problem rather than solving it.

**Commands. Refused.** A command wrapper is a generated file, and HK-11's ownership scheme does not exist
yet. Its failure mode in a home directory is unrecoverable.

**MCP servers. Refused.** An MCP server config carries live credentials in its `env` block, which the
project-scope inventory is already forbidden to read.

**Every one of these is recorded in the contract with its reason**, in the same PR as the slice that
refuses it. A drop with an honest reason is a finished answer, not a gap — the model is the project-scope
drop that already reads "no AGENTS.md, nothing to read or point at".

#### 2.11 SRC-12: the same package at both scopes

**Reproduced by the ideation.** `globex@1.0.0` global and `globex@2.0.0` project: two entries with the same
name, two different versions, and not one line anywhere says they are the same package.

**The collision is not what the ticket says it is.** The two projections land in different directories
(`<repo>/.agents/skills/globex__greet` and `~/.agents/skills/globex__greet`). Nothing overwrites anything and
no sweep deletes the other's file. What collides is what an agent tool sees when it merges its user tier over
its project tier, and each one resolves that its own way:

| Agent tool                | With `globex__greet` in both tiers                                                           | State                  |
| ------------------------- | -------------------------------------------------------------------------------------------- | ---------------------- |
| Claude Code               | the personal (global) copy wins: "personal overrides project", verbatim from its skills page | verified               |
| Codex                     | both appear: "Codex doesn't merge them; both can appear in skill selectors"                  | verified               |
| Gemini CLI                | workspace beats user for skills; for commands the project one always wins                    | verified for the order |
| OpenCode, Cursor, Copilot | no user-versus-project precedence stated for skills                                          | **unknown**            |

**Decision: DorkOS resolves nothing, and says so.** Three parts, and each rules out a tempting alternative:

1. **Never refuse the install and never delete a copy.** Both scopes are legitimate. A package manager that
   removes an install to tidy a name is one nobody trusts.
2. **Never invent a DorkOS-side precedence.** It would be unenforceable, because the projection is a symlink
   in a directory the agent tool reads on its own terms, and it would be wrong for at least two agent tools
   whichever way it pointed. "Newer version wins" is also not implementable: `InstalledPlugin` carries no
   `version` (`sources/installed.ts:117-154`), so adopting it means adding one to the scanner and then still
   choosing for the tool, which part 2 says not to do.
3. **Report it once, at package level, with the per-tool consequence.** One `harnessAgnostic: true` entry,
   so by DOR-1852 §1.3 it lands in `projectLevel[]` and renders once under the heading the CLI calls
   `plugin layers:`. It never becomes a cell and never a row, which is right: it is not about one agent tool,
   and the tools disagree. The per-tool sentence lives in the notice's text rather than in a chip, precisely
   because three of six are `unknown` and a chip cannot say "unknown" honestly.

Frozen copy, printed in slice A1. It is **one string with no line breaks and no version numbers**, and
both of those are decisions. No line breaks, because the renderer prints a reason as given
(`report/drop-list.ts:52`) and would not indent a continuation; the wrapping below is presentational only.
No version numbers, because `InstalledPlugin` carries no `version`, and a notice that could only be raised
when both versions are readable is a notice that goes missing on a malformed manifest. Like every other
reason it continues a line that already names the package, so it starts with a verb:

```
is installed twice: once for all your projects, and once in this project. Claude Code uses your
all-projects copy, even here. Codex shows both. Uninstall one if you only meant to have one: run
dorkos uninstall {pkg} --project .  for this project's copy, or dorkos uninstall {pkg}  for the
all-projects copy. Both talk to a running DorkOS, and both ask you to approve first.
```

`dorkos marketplace uninstall` is not offered because it does not exist: `dorkos marketplace <sub>` manages
sources only (`add|remove|list|refresh|validate`, `commands/marketplace-dispatcher.ts:65`). The two copies
are separately addressable because `installRootCandidates` probes project roots before global ones
(`marketplace/lib/locate-install.ts:63-71`).

**This notice needs nothing slice A2 or A3 builds.** `scanInstalledPlugins({ dorkHome, projectRoot })`
already returns both scopes on every project sync, so the fact is available at the exact moment the drop is
printed. Only the sentence about what happens after A3 projects both is future tense, and it is written as
such.

**A second consequence, and it is A3's.** Cursor and OpenCode read **both** `~/.agents/skills` and
`~/.claude/skills` at user scope (`vendor-facts/index.ts:154`, `:184`). The moment A3 writes both targets,
those two see the same global skill twice. Claude Code documents loading a shared target once by realpath;
OpenCode keys on the frontmatter `name`, which would collapse the pair; Cursor is unverified. This is not a
reason to skip either target, because Claude Code needs the second and the other five need the first. It is
the reason **the Claude Code links are planned only when Claude Code is in `harness.global.harnesses`**,
exactly as `INSTALLED_SKILL_TARGET_DIRS` gates the project-scope twin
(`installed-projector.ts:125-129`).

#### 2.12 Where the target directories come from

The engine takes them injected (§2.1). The server resolves them, and Hard Rule 3 decides how.

**The Claude Code target set is `{ inheritedClaudeRoot(), resolveActiveClaudeRoot() }`, de-duplicated on
the resolved path, each with `/skills` appended.** Normally that is one directory, because the second
resolver falls through to the first when no default account is pinned
(`claude-config-dir.ts:140-142`). It is two exactly when an operator pinned an account, and both are needed
for a reason slice A3 creates: the read in §1.1 asks which Claude Code the person types into, but the
**write** has to reach every Claude Code that matters, and after A3 retires SDK injection (§2.9) a pinned
DorkOS-driven session would otherwise lose global packages outright. `resolveClaudeRootSet()` is still not
used, for the reason decision 6 gives: it enumerates every registered account, including ones nobody is
running, and writing links into accounts a person is not using is the write-side version of describing
sessions they are not having.

This is a correction to the ideation, which settled the root question for the read and did not notice that
the write needs one more root. It is the reason `GlobalPlanRoots.claudeSkillsDirs` is a list.

`<agentsSkillsDir>` is `~/.agents/skills`, and **no existing carve-out covers it**. The five listed in
`.claude/rules/dork-home.md` are `lib/dork-home.ts`, two inline-disabled call sites in `lib/boundary.ts`,
and three modules that each mirror one other program's resolution of its own directory. `~/.agents` is
exactly that shape, mirrored five times over: Codex, OpenCode, Cursor, Gemini CLI and Copilot all document
`$HOME/.agents/skills` as a user-scope read path, and the repo's own `vendor-facts/index.ts` records it for
each of them.

**Decision: slice A3 adds a sixth carve-out, `apps/server/src/services/harness/agents-user-home.ts`.** One
exported function, one line of body, mirroring the vendors' documented resolution 1:1 and resolving nothing
of DorkOS's own. The slice also edits both halves of the ESLint ban in `apps/server/eslint.config.js`, the
carve-out table in `.claude/rules/dork-home.md`, and the pin in `scripts/test-homedir-guard.sh`, in the same
PR. Landing it in A3 rather than earlier keeps the rule change inside the one slice that needs it.

**Why not take the path from config instead.** A `harness.global.userSkillsDir` field would avoid the rule
change and make the ordinary case require configuration, which is worse: nobody would set it, the feature
would appear broken, and the field would become a second place a home directory is spelled.

**One test binds the design to the facts.** `vendor-facts` gains a case asserting the invariant that
justifies exactly two directories: every harness except `claude-code` lists `~/.agents/skills` in
`skills.readPaths.user`, and `claude-code` lists `~/.claude/skills`. If a vendor-facts refresh breaks that,
the test reds and the design is revisited rather than quietly wrong. `readPaths.user` has zero readers today
(`vendor-facts/coverage.ts:49-52`: "data for humans; nothing here walks a home directory"), and this is the
first thing that reads it — as an assertion, not as a path source.

#### 2.13 The ADR, and the exact block slice A3 adds to ADR-0303

**Decision: a new ADR that `amends` ADR-0303, not an amendment section inside it.**
**Why:** the repo has both shapes and `writing-adrs` draws the line between them. An in-file
`## Amendment` section (the shape DOR-1851 added to ADR-0302) states an **exception** inside a decision that
otherwise holds unchanged: the engine still never rewrites a hand-authored file, and it may now add one array
element when a person asks. The `amends` relation is for a **partial reversal**, where a clause of the parent
stops being true. This is the second: ADR-0303's decision says an installed package's "portable subset
(skills, hooks)" projects automatically on install, scope-matched project-to-project and global-to-global.
Decision 4 refuses hooks at global scope and decision 15 makes the first global projection asked for rather
than automatic. Two clauses of an accepted decision stop holding at one scope, which is a reversal in part
and not an exception within.

Seeded at this stage as `260908-191538`, `status: proposed`, `amends: ["0303"]`, registered in
`decisions/manifest.json`. **Slice A3 flips it to `accepted`** and, in the same edit, adds this block to
ADR-0303's Status section, which is the half the `amends` protocol requires and the half nothing else
enforces:

```md
**One clause is narrowed at GLOBAL scope by**
[260908-191538](260908-191538-global-scope-projection-is-skills-only-and-symlinked.md) (Global-scope
projection is skills-only and symlinked). The clause: "its **portable subset** (skills, hooks) projects
**automatically on install** to every enabled harness … scope-matched (project↔project, global↔global)".

At global scope the portable subset is **skills only** (hooks, commands, instructions and MCP servers are
refused at user scope, each with its reason recorded in `meta/harness-sync-capabilities.md`), and the
projection is **not automatic on install**: it is asked for once and remembered in `harness.global`. The
related Negative bullet "the projector must understand … scope mapping" is now understated rather than
wrong, and reads as history.

**At project scope this clause is unchanged**, and so is everything else here: three source classes, one
engine, one drop list, a `provenance` tag on every action, projections ephemeral and gitignored, adoption
explicit. That is why this ADR stays `accepted` rather than `superseded`.
```

ADR-0303 keeps `status: accepted` and `superseded-by: null`, in the file and in the manifest.

### 3. The status API at global scope

`GET /api/harness/status?projectPath=<path>` has no global mode. Two shapes were available.

**Decision: fold global rows into every project's answer, each marked `scope: 'global'`. No
`?scope=global` variant.**
**Why:** the question a person asks is "what can this agent tool see _here_", and here always includes what
is installed for every project. A second call would make the page merge two answers and decide precedence
between them itself, which is exactly the per-tool precedence rule §2.11 says DorkOS must have no opinion
about. One answer, one merge, done once on the server, is also the only shape in which the both-scopes
notice can be a single project-level entry rather than something the client derives.

The cost is that the same global rows repeat in every project's response. That is accepted, and it is
bounded:

- **Rows appear before the tier is on.** A global package's skills are rows from slice A1 onward, with
  every cell `dropped` and carrying the reason. That is the point of A1: the honest answer is not silence.
- **`state: 'not-set-up'` still answers with global rows.** A project with no manifest can still hold a
  person who installed something globally, and telling them nothing because this folder is not set up would
  reproduce the defect §Background opens with.
- **Budget.** DOR-1852 measures 190 bytes per cell and sets ≤ 250 KB for a repo of 31 skills across three
  enabled tools (32,415 bytes measured). Global rows add `packages × skills × (tools + 1)` cells. The
  operator's machine has **zero** global packages today (`~/.dork/plugins` does not exist, checked
  2026-09-08), so the honest current number is 0 bytes. The
  planning ceiling: 20 packages of 5 skills across 6 tools is 600 cells, roughly 114 KB, which fits beside a
  32 KB project answer and eats half the remaining headroom. So the budget statement becomes
  **≤ 250 KB including global rows**, the implementer records a fresh measurement with a seeded 20-package
  fixture, and if a real machine is measured past it the answer is the one DOR-1852 already named:
  pagination or a summary-first response, filed with the measurement, never a cache.

Schema additions, all in `packages/shared/src/harness-schemas.ts`:

```ts
/** Which scope a row is about. Absent in stored data means `'project'`. */
export const HarnessScopeSchema = z.enum(['project', 'global']);
```

`HarnessRowSchema` gains `scope: HarnessScopeSchema.default('project')`, and the row key documented in
DOR-1852 §1.3 becomes **`(scope, artifact, source, name)`**. `HarnessStatusResponseSchema.counts` gains
`globalSkills: z.number().int().nonnegative()`, so the page can say "and 12 more shared with every project"
without counting rows itself.

**One compile-time guard.** `status.ts` already maps the engine's `ArtifactType` onto the schema's kind enum
through a `satisfies Record<...>` table. The global fold adds a second such table over
`InstalledLocation['scope']` onto `HarnessScopeSchema`, so a third scope cannot be added to the engine
without the compiler naming this file.

### 4. Every user-facing string this work freezes

Printed verbatim by the CLI today and by DOR-1852's Skills page later, so all of it is user-facing copy and
all of it follows `writing-for-humans`: plain, active, one idea per sentence, no em dashes, and no word the
vocabulary gates retired.

| #   | Slice | Where it appears                           | Text                      |
| --- | ----- | ------------------------------------------ | ------------------------- |
| 1   | B1    | the whole Claude-Code-only block           | §1.6, frozen line by line |
| 2   | B1    | the unreadable-settings record             | §1.6, the two-line form   |
| 3   | B1    | HK-14's line                               | §1.7                      |
| 4   | A1    | the global-install drop, replacing the lie | below                     |
| 5   | A1    | the SRC-12 both-scopes notice              | §2.11                     |
| 6   | A2    | the two dork-home link reasons             | §2.8                      |
| 7   | A3    | the ask                                    | §2.7                      |
| 8   | A3    | the boundary skip                          | §2.6                      |
| 9   | A3    | the restart caveat                         | below                     |
| 10  | A3    | the two user-tier link reasons             | below                     |

**4a. The global-install drop (slice A1), replacing
`'global-scope install; a project sync does not project global plugins (run a global sync)'`.** One entry
per package, `harnessAgnostic: true`, still through `dropWholePlugin` so it renders under the
`plugin layers:` heading. `formatDropList` prints `  - plugin "globex": <reason>`, so the reason continues a
sentence that already has its subject; that is why the text below starts lower-case and with a verb, and
why it is one string with no line breaks (the wrapping shown is presentational). `{n}` is a count and
`{names}` is the skill names, comma-separated. Two forms, because a package with nothing portable in it is
a different sentence from one that has skills nobody else can reach:

```
installed for all your projects. Only Claude Code sessions DorkOS runs can see it. Its {n} skills are not
shared with this project: {names}
```

```
installed for all your projects. Only Claude Code sessions DorkOS runs can see it. It has no skills to
share.
```

Neither names a command, because in slice A1 there is none to name. Slice A2 appends one sentence to the
first form rather than rewriting it, and slice A3 appends the second:

```
(A2 appends, only when the package has a skill that declares a schedule)
  Its scheduled skills now run on DorkOS's own schedule.
(A3 appends, only while the package is not shared yet)
  Run dorkos harness global --list to share it with your other agent tools.
```

Writing the string so later slices **append** is deliberate. The defect this replaces was a sentence that
told the truth about a command that was going to exist and never did; a form that grows by addition can
never be false at the moment it is printed.

**4b. The restart caveat (slice A3).** Printed once per run, and only when the run created a skills
directory that was not there before. The project-scope twin already exists
(`reportClaudeSkillsRestart`, `harness-sync-command.ts`), and this is its global sibling:

```
Claude Code needs a restart before it sees the new skills folder. In Gemini CLI, run /skills reload.
```

**4c. The two user-tier link reasons (slice A3).** Carried on each action so a report never looks arbitrary,
in the same shape as the project-scope pair:

```
linked into your shared skills folder, the one place Codex, OpenCode, Cursor, Gemini CLI and Copilot all
look for skills
linked into Claude Code's own skills folder, the only place it looks
```

## User Experience

### Part B: `dorkos harness sync`, unchanged except for one block

A person runs the command they already run. After the drop list and before the not-enabled notice, the block
in §1.6 appears when, and only when, they have plugins turned on in Claude Code. Nothing is installed,
nothing is written, and the person ends the run knowing three things they did not know: how many plugins are
Claude-Code-only, which repositories they came from, and the one command that shares each with the rest of
their agent tools.

J-07, written out end to end:

1. Priya runs `/plugin install code-simplifier@claude-plugins-official` inside Claude Code. It works.
2. She opens the same repository in Codex to check a build. The skill is not there and nothing says why.
3. She runs `dorkos harness sync`. Under **Installed in Claude Code only** she sees nine names, the
   repository each came from, and one sentence: her other agent tools cannot see them.
4. Beside `code-simplifier` is the install command, because DorkOS ships
   `anthropics/claude-plugins-official` as a default source and it has that package.
5. She runs it. The install goes through the transaction that already exists, with its preview and its hook
   consent card, and the auto-projection that already exists puts the skill in front of every enabled agent
   tool in that project.
6. Beside `persona-toolkit` there is no offer, and a sentence saying DorkOS cannot tell where that
   marketplace is. She adds it herself, or she does not. Nothing pretends.

### Part A: two new surfaces, both in the terminal

**`dorkos harness sync --global`.** Builds and applies the global plan. With `harness.global.askedAt` still
`null` it prints the ask (§2.7) and writes nothing. With an answer recorded it plans the dork-home tier
always and the user tier for each agent tool in the list, prints every path it will remove before removing
it, then prints what it did. `--check` narrows it to a report, as it does today.

**`dorkos harness global --enable|--disable|--list`.** The one path that writes
`harness.global.harnesses`, in the shape ADR-0302's amendment established for `--fix --enable`: an explicit
verb, one array element at a time, and a `--list` that shows the answer and the directories it implies.

**Nothing changes in `dorkos harness sync` without `--global`** except the drop reason (4a) and the
both-scopes notice (§2.11), both of which are strings it already prints in blocks it already has.

**The app half is DOR-1852's.** Every global row this work produces is in the response that spec defines, so
the Skills page gains them when its slices land, with no second design.

## Testing Strategy

Every case below carries a **seeded defect**: the one-line change to the implementation that makes it red.
A case with no such change is a case that passed throughout the life of the bug, which is the failure
`plans/harness-sync-test-plan.md` §11 line 1 warns about by name. Contract-row IDs lead the test titles, so
`capabilities-census.test.ts` can match them.

### Slice B1 — unit, `apps/server/src/services/harness/__tests__/claude-enabled-plugins.test.ts`

Every fixture is a temp directory standing in for a Claude root plus a repo; no home directory is read.

| #   | Case                                                                                                     | Seeded defect that reds it                                                                                  |
| --- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| 1   | **SRC-08: nine plugins turned on out of sixteen produce nine rows.** Seven `false` entries produce none. | Report every entry rather than the `true` ones. Sixteen rows.                                               |
| 2   | **SRC-08: a malformed settings file becomes one record and no throw.** The block is the two-line form.   | Replace the Zod parse with `JSON.parse`, matching `loadClaudeHooks`. The case throws.                       |
| 3   | **SRC-08: `$CLAUDE_CONFIG_DIR` set makes that root the one printed.**                                    | Call `resolveActiveClaudeRoot()`. With a `defaultAccount` in the fixture config, the other root is printed. |
| 4   | **SRC-08: a plugin whose repository matches a DorkOS source names the package in the offer.**            | Match on marketplace name. The `dorkos` → `dorkos-community` pair falls to rung 3.                          |
| 5   | **SRC-08: a repository with no package of that name prints the rung-4 line and no command.**             | Print the install command anyway. The case sees `dorkos install` for a package that is not there.           |
| 6   | **SRC-12 precursor: a plugin turned off in `.claude/settings.local.json` is not reported.**              | Read the user file only. It appears in the machine-wide list.                                               |
| 7   | **SRC-08: a plugin `true` only in the project file lands under "On for this project only".**             | Merge project entries into the machine-wide list. It appears under the wrong heading.                       |
| 8   | **HK-14: a settings file with three hook commands prints the count; zero prints no line.**               | Count matcher groups instead of entries. The count reads 2 where the fixture has 3.                         |
| 9   | **SRC-08: no `enabledPlugins`, or none `true`, prints nothing at all.**                                  | Print the heading unconditionally. The case sees a block with no content.                                   |

Plus `marketplace-repo-key.test.ts`: the two real pairs measured on the operator's machine as fixtures, a
`.git` suffix, a trailing slash, a `www.` host, an upper-case owner segment (preserved), and a non-`github`
`source.source` returning `null`. Seeded defect: lower-case the whole key, which makes an upper-case owner
match a lower-case one and is a false positive on a case-sensitive host.

CLI-level: one case in `packages/cli/src/__tests__/harness-sync.test.ts` asserting the block's position in
the output (after the drop list, before the not-enabled lines) and that a failing read leaves the rest of the
report intact.

### Slice A1 — unit, `packages/harness/src/sources/__tests__` and `plan/__tests__`

| #   | Case                                                                                                                         | Seeded defect                                                                          |
| --- | ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| 1   | **SRC-04: a global package with two skills, one command and a hooks file is enumerated, with absolute source paths.**        | Keep the identity-only branch. Every list is empty.                                    |
| 2   | **SRC-04: the drop names the skills that are not shared, and names no command.**                                             | Restore the old string. The case reads "run a global sync".                            |
| 3   | **SRC-04: a global package with no skills gets the second form.**                                                            | Emit the first form with an empty list. The sentence reads "Its 0 skills".             |
| 4   | **SRC-04: a global package whose `hooks/hooks.json` is malformed produces an `unreadableHooks` entry, not an absent field.** | Leave `unreadableHooks` off for global packages. Absent still means two things.        |
| 5   | **SRC-12: the same name at both scopes produces exactly one project-level notice carrying both scopes.**                     | Emit it per harness. The notice appears three times on a three-tool project.           |
| 6   | **SRC-12: the notice is still produced when one manifest will not parse**, without version numbers.                          | Gate the notice on both versions being readable. The notice goes missing.              |
| 7   | **Type: no call site treats a global package's `sourceDir` as repo-relative.**                                               | This one is the compiler, not a test: the `InstalledLocation` union is what proves it. |

### Slice A2 — unit + integration, `packages/harness/src/plan/__tests__` and `__tests__/global-integration.test.ts`

| #   | Case                                                                                                                           | Seeded defect                                                                                        |
| --- | ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| 1   | **SK-03: a global package's scheduled skill is planned into `<dorkHome>/skills/<pkg>__<name>`, carrying the schedule reason.** | Plan it only when a harness is enabled. An empty harness list produces no action.                    |
| 2   | **SK-03: applying it makes the link, and the scheduler's own discovery parses the namespaced directory.**                      | Point the link at the package root rather than the skill directory. Discovery finds no `SKILL.md`.   |
| 3   | **P8b: every action's target resolves inside `<dorkHome>`, and a plan built with no user roots produces none elsewhere.**      | Join the dork-home tier against the user root. The property counterexample prints the escaping path. |
| 4   | **P8c: no action in the plan is `generate`, `scaffold` or `merge`.**                                                           | Call `planInstructionScaffold` from `buildGlobalPlan`. Six scaffold actions appear.                  |
| 5   | **`checkGlobalPlan().orphans` equals the next `applyGlobalPlan().swept`, as set equality both ways.**                          | Return only the first sweep's finder. The count assertion reds before the contents.                  |
| 6   | **A global plan is idempotent: applying twice leaves the tree byte-identical and the second check clean.**                     | Recreate the link unconditionally. The second apply reports one applied action.                      |
| 7   | **The row key stays unique: the same skill name at both scopes derives two rows.**                                             | Drop `scope` from the key. Two rows collapse to one and a cell goes missing.                         |

### Slice A3 — unit, integration, and the one journey

| #   | Case                                                                                                                                                                                                  | Seeded defect                                                                                                                         |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **J-07/SRC-04: a staged HOME gets `~/.agents/skills/<pkg>__<name>` for five tools and a Claude link for the sixth.**                                                                                  | Plan the Claude link unconditionally. It appears with Claude Code not enabled.                                                        |
| 2   | **AP-07 global: a hand-authored real directory, a hand-authored SYMLINK into `~/.agents/skills`, a Codex-installed directory and a DorkOS link are staged; a sweep removes exactly the DorkOS link.** | Use the two-clause predicate. The hand-authored symlink is removed. **This is the case the whole three-clause predicate exists for.** |
| 3   | **A dangling DorkOS link left by a global uninstall is still swept.**                                                                                                                                 | Resolve clause 3 with `realpath`. The call throws and the orphan is stranded.                                                         |
| 4   | **A link whose text resolves to `<dorkHome>/plugins-elsewhere` is not swept.**                                                                                                                        | Use `startsWith` without the separator. The neighbour directory's link goes.                                                          |
| 5   | **The sweep does not descend: a `<pkg>__<name>` symlink two levels down is untouched.**                                                                                                               | Walk recursively. The nested link is removed.                                                                                         |
| 6   | **The ask prints every link name and writes nothing; `--enable` writes exactly one array element and stamps `askedAt`.**                                                                              | Write the config from the ask. The fixture's config changes on a read-only run.                                                       |
| 7   | **A declined answer is remembered: an empty list with `askedAt` set never asks again.**                                                                                                               | Treat an empty list as unasked. The block prints on every run.                                                                        |
| 8   | **`boundaryWasConfigured()` true skips the user tier, names the root, and still plans the dork-home tier.**                                                                                           | Skip both tiers. The scheduled skill stops running on a confined deployment.                                                          |
| 9   | **Config: an upgrade from a stored `harness` section with three leaves gains `global` and nothing else.**                                                                                             | Key the migration `'0.75.0'`. The guard reds before the test runs.                                                                    |
| 10  | **The global SDK-injection path is gone**, asserted on `refreshActivatedPlugins` returning no global entries.                                                                                         | Leave it in. A DorkOS-driven session sees the package twice.                                                                          |
| 11  | **P3 global: a hand-authored real directory at a target is a conflict, not an overwrite.** Its bytes are identical after the apply and it is counted in `conflicts`.                                  | Replace an occupied target. The person's own skill is gone and the byte comparison reds.                                              |

**The journey.** `J-07` joins `__tests__/journeys/` in the shape DOR-1848 established: `stageRepo` plus a
staged HOME, an exact tree diff around the two user directories proving the run added the links it named and
touched nothing else, and the uninstall half proving it removed exactly them.

### The H-tier gate (DOR-1856), and what it must show before slice A3 lands

**The bar is not "five of five pass". The bar is that the answer exists for all five.** For each of Codex,
OpenCode, Cursor, Gemini CLI and Copilot, the H run stages one `<pkg>__<name>` symlinked directory in
`~/.agents/skills` inside a throwaway HOME, runs the binary, and asks it to list its skills. The oracle is
the tool's own output, never a model's say-so. It runs a control with a plain `<name>` directory too, so a
refusal is attributed to the name rather than to the symlink.

Slice A3 then plans the `~/.agents/skills` link **for the tools the run confirmed**, and records a drop for
the rest naming the run's date and its result. Two of the five are documented to refuse: OpenCode and Cursor
both require a lowercase-alphanumeric-with-single-hyphens `name` that matches the directory, and
`<pkg>__<name>` breaks that twice over (SK-09, SK-12). A three-of-five result is the expected floor and it
still delivers Codex, Gemini CLI and Copilot through the shared directory plus Claude Code through its own.
The fix for a refusal is a naming change, which is its own decision and not this spec's.

The same run answers experiment 2's cheap half: whether Claude Code reads `~/.agents/skills`. If it does,
the Claude Code links are dropped from the plan as redundant, and slice A3 gets smaller.

## Performance Considerations

Every engine call here is synchronous `node:fs`, like the ones DOR-1852 measured, so the numbers that matter
are event-loop time on the status route and wall clock in the CLI.

- **Slice B1 reads at most three small JSON files** and does no directory walking. On the operator's
  machine `~/.claude/settings.json` is a few kilobytes. It joins the status route's existing budget; the
  implementer records the measurement in the PR beside DOR-1852's.
- **`buildGlobalPlan` walks `<dorkHome>/plugins` once**, the same walk `scanInstalledPlugins` already does
  on every project sync when a dork home is passed. Slice A1 makes that walk deeper (it now enumerates
  skills, commands and hooks per package), which is the same depth the project walk has always had.
- **The status route now walks two trees instead of one.** DOR-1852 already accepts walking the project
  tree twice; this adds the dork-home plugins walk. Budget unchanged at **p50 ≤ 150 ms of event-loop time**
  for a repo of DOR-1852's size **plus** a dork home of 20 global packages, and the implementer re-measures.
  If the global walk is what puts a real machine over, the fix is the same follow-up DOR-1852 named: have
  the plan carry what it read, rather than a cache.
- **The sweep reads one level of at most three directories** and calls `readlink` per candidate. It never
  calls `realpath` (§2.4), which is also why it cannot block on a dead network mount behind a symlink.

## Security Considerations

**The read half.** Part B opens a file in a person's home directory. Three rules bound it: only the three
documented keys of §1.2 are named by the schema; the hooks schema never names `command`, so no shell text a
person wrote is ever bound to a value; and nothing read from that file is written anywhere, echoed into a
projection, or sent off the machine. The status payload carries plugin names, marketplace names, repository
slugs and a hook **count**, and no file bytes. That is the same line DOR-1852 draws for withheld hook
commands and this stays on the same side of it.

**The write half.** Everything slice A3 writes is a symlink into `<dorkHome>/plugins`. No file is generated,
no file is merged, and no file a person authored is read, moved or rewritten. The three-clause ownership
predicate means DorkOS can only remove something it can prove it created, and the proof is structural
(a link whose own text points into DorkOS's package directory), not a naming convention.

**The boundary.** A configured `DORKOS_BOUNDARY` means this deployment was set up to refuse writes outside
one root. The user tier is skipped and named rather than widened, and `validateBoundaryOrDorkHome` is never
called here: it narrows to `<dorkHome>/agents/*` for a reason, and using it to make a home-directory write
pass would be borrowing a security narrowing for a feature.

**What this work does not make reachable over HTTP.** The global pass is a CLI and boot capability.
`GET /api/harness/status` gains global **rows** and no ability to write them; there is no
`POST /api/harness/sync?scope=global` in this spec, and adding one is a separate decision with its own
person-only bar.

**Two things a person's home directory holds that this must never touch.** Codex's `$skill-installer`
writes real directories into `~/.agents/skills` (SRC-09), and people hand-author skills in both candidate
directories. Clause 1 of the predicate (symlink) protects the first; clause 3 (target inside
`<dorkHome>/plugins`) protects a person's own symlinks, which clause 1 alone does not, and which the
operator's own machine has two of.

## Documentation

- `meta/harness-sync-capabilities.md`: rows SRC-04, SRC-08, SRC-12, SK-03, IN-08, HK-14, TR-10, J-07, §14
  gap 11, and position D4, each edited in the slice that changes it (§0's table).
  `capabilities-census.test.ts` fails until each row's coverage cell names a real test.
- `plans/harness-sync-test-plan.md`: line 64's P8 re-scoped, P8b and P8c added, row 14 of §11 split into the
  four slices.
- `contributing/harness-sync.md`: a new section on global scope covering the two tiers, the three-clause
  predicate, and the one sentence that says what a `DORKOS_BOUNDARY` deployment does instead.
- `contributing/configuration.md` and `docs/getting-started/configuration.mdx`: a row each for
  `harness.global.harnesses` and `harness.global.askedAt`.
- `docs/`: one user-facing page paragraph explaining, in plain words, that installing a package for all your
  projects shares it with your other agent tools once you say yes, and what `dorkos harness global` does.
- `.claude/rules/dork-home.md`: the sixth carve-out row (slice A3 only).
- A changelog fragment per slice in `changelog/unreleased/`.

## Implementation Phases

Four slices, each PR-sized, each independently reviewable, each shipping something a person can see. DECOMPOSE
files one child per slice. **Order: B1 → A1 → A2 → A3.**

### Slice B1 — Claude Code's own plugins (~600 lines)

**Files:** §1.9's table. Export `inheritedClaudeRoot`; new `claude-enabled-plugins.ts` and
`marketplace-repo-key.ts` with their tests; one print block in `harness-sync-command.ts`;
`HarnessClaudeOnlySchema`; the five contract rows.

**Bar.** On the operator's own machine, `dorkos harness sync` prints nine plugins with their repositories,
the install command beside every one DorkOS can resolve, and the root it read. All nine of §Testing's B1
cases pass and each one's seeded defect reds it. `pnpm --filter @dorkos/server test` and
`pnpm --filter dorkos test` green. **Not one file under `packages/harness` is touched**, asserted by the
PR's own diff. `bash scripts/check-banned-words.sh` and `pnpm check:vocab-gate` clean.

### Slice A1 — the honest drop, the location union, the both-scopes notice (~700 lines)

**Files:** `sources/installed.ts` (the location union, the global enumeration branch,
`unreadableHooks`'s contract); every call site the compiler names; `plan/projector.ts` (the two drop forms);
`plan/installed-projector.ts` (the both-scopes notice); their tests; contract rows SRC-04 and SRC-12.

**Bar.** The four defects in §Background invert on a fixture that stages a global package with two skills, a
command and a hooks file: the scan returns them, the drop names the two skills, no sentence names a command,
and the second form appears for a package with no skills. The SRC-12 notice appears exactly once on a
three-tool project and survives a malformed manifest. Reverting the location union does not compile, which
is the point of it. Seven cases, seven seeded defects. **Nothing writes outside a repository in this
slice**, asserted by a tree-diff snapshot of a staged HOME across the whole test file.

### Slice A2 — `buildGlobalPlan`, its apply, and the scheduler's global half (~800 lines)

**Files:** `packages/harness/src/plan/global-projector.ts` and `apply/global-apply.ts` (new);
`plan/types.ts` (`scope` on `ProjectionAction`); `packages/shared/src/harness-schemas.ts`
(`HarnessScopeSchema`, the row field, `counts.globalSkills`); `apps/server/src/services/harness/status.ts`
(the fold); `packages/cli/src/harness-sync-command.ts` (`--global`); the property statements in
`plans/harness-sync-test-plan.md`; contract row SK-03.

**Bar.** A scheduled skill in a globally installed package **runs**: the link exists at
`<dorkHome>/skills/<pkg>__<name>`, the scheduler's own discovery parses it, and a row appears. P8's re-scoped
statement, P8b and P8c all pass, and each reds on its seeded defect. `checkGlobalPlan().orphans` equals the
next `swept` as set equality both ways. A second `--global` run applies nothing and reports clean. **No path
outside `<dorkHome>` appears anywhere in the plan**, because no user root is passed in this slice.

### Slice A3 — the user tier, gated on DOR-1856 (~900 lines)

**Gate:** may not open until the H run has reported per §Testing. The plan links `~/.agents/skills` for the
tools it confirmed and records a dated drop for the rest.

**Files:** `services/harness/agents-user-home.ts` (the sixth carve-out) plus
`apps/server/eslint.config.js`, `.claude/rules/dork-home.md` and `scripts/test-homedir-guard.sh`;
`lib/boundary.ts` (`boundaryWasConfigured`); the three-clause predicate in `apply/global-apply.ts`;
`packages/shared/src/config-schema.ts` and `config-manager.ts` (`harness.global` and the `'0.76.0'`
migration) with `merged-migration-hashes.ts`, `CONFIG_DISCLOSURE` and `CONFIG_WRITE_POLICY`;
`packages/cli/src/commands/harness-dispatcher.ts` and a new `harness-global-command.ts`; deletion of the
global SDK-injection path in `messaging/plugin-activation.ts` and `claude-code-runtime.ts`; the J-07
journey; contract rows SRC-04, IN-08, HK-14's refusal half, §14 gap 11; ADR `260908-191538` flipped to
`accepted` and §2.13's block added to ADR-0303's Status section.

**Bar.** The AP-07 global case is the one that decides this slice: a staged HOME holding a hand-authored
directory, a hand-authored symlink into `~/.agents/skills`, a Codex-installed directory and a DorkOS link
survives a sweep with **exactly one** removal, and reverting to the two-clause predicate removes the
person's own symlink. The ask prints every link name and writes nothing. `--enable` changes one array
element. A `DORKOS_BOUNDARY` deployment skips the user tier, names the root, and still runs its scheduled
global skills. A DorkOS-driven Claude Code session sees each global package once, not twice. Config guards
green (`migration-safety`, `migration-append-only`, `config-disclosure`, `config-write-policy`).
`scripts/test-homedir-guard.sh` green with the sixth carve-out. The J-07 journey's tree diff is exactly the
links the run named.

## Decisions

Every open question this work raised, resolved with its reason. The operator delegated; nothing below waits
on an answer. Decisions 1 to 16 carry forward the ideation's numbering, so a reader can hold both documents
open; decisions 17 to 26 are this stage's.

| #   | Decision                                         | Choice                                                                                               | Why                                                                                                                                                                                                                                                                                                                                                                           |
| --- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Which option                                     | **A, narrowed to skills, staged A1 → A2 → A3**                                                       | A is the only option that makes "installed globally" true, and the per-tool table shrinks it to at most two user directories. A1 and A2 are its first slices and each ships alone.                                                                                                                                                                                            |
| 2   | A generated file at user scope                   | **Never**                                                                                            | HK-11's ownership scheme does not exist yet and its failure mode in a home directory is unrecoverable. Held by property P8c (§2.5), not by discipline.                                                                                                                                                                                                                        |
| 3   | Which user directories                           | **`~/.agents/skills` and the Claude Code roots' `skills`, nothing else**                             | Five tools read the first and Claude Code reads the second, per the repo's own `vendor-facts`. Every other user directory belongs to a kind decision 4 refuses. Bound to the facts by one test (§2.12).                                                                                                                                                                       |
| 4   | Instructions, hooks, commands, MCP at user scope | **Out of scope, each reason recorded in the contract**                                               | §2.10. ADR-0302's mechanism needs a canonical source and user scope has none; a person's hooks are not the team's; a command wrapper is generated; an MCP config holds credentials.                                                                                                                                                                                           |
| 5   | `~/.claude/settings.json`                        | **Read, report, never write or project from**                                                        | One read answers J-07 and HK-14's user half. Zod-parsed, failure becomes a record. Never the private cache (D4).                                                                                                                                                                                                                                                              |
| 6   | Which Claude root the J-07 **read** opens        | **`$CLAUDE_CONFIG_DIR`, else `~/.claude`, and always printed**                                       | `resolveActiveClaudeRoot()`'s first rung answers which account DorkOS bills, not which Claude Code the person types into. The shared rung is inherited and can differ from their shell, so disclosure, not cleverness, is the mitigation.                                                                                                                                     |
| 7   | SRC-12 precedence                                | **DorkOS resolves nothing; it reports once, at package level**                                       | The tools disagree, a symlink cannot be given a DorkOS precedence, and "newer wins" is unimplementable because `InstalledPlugin` has no `version`.                                                                                                                                                                                                                            |
| 8   | SK-03's global half                              | **In this feature, as slice A2, the first that writes anything**                                     | It reuses A3's machinery, needs no vendor fact, writes only inside `<dorkHome>`, and delivers a whole outcome alone.                                                                                                                                                                                                                                                          |
| 9   | The scope of the J-07 offer                      | **Project scope until slice A3 lands, then global too**                                              | A DorkOS global install today reaches only DorkOS-driven Claude Code sessions, so offering it to somebody who already has the plugin in Claude Code buys them nothing. Corrects D4.                                                                                                                                                                                           |
| 10  | Marketplace resolution for the offer             | **Match on the repository, never the marketplace name**                                              | 15 of 16 resolve; a name match misses `dorkos` → `dorkos-community`, the same repository. The normaliser is its own pure module because a naive comparison matches 0 of 16 (§1.4).                                                                                                                                                                                            |
| 11  | Auto-install from the offer                      | **Never**                                                                                            | The offer is a printed command into the existing flow, with its existing preview and consent.                                                                                                                                                                                                                                                                                 |
| 12  | A trigger on `/plugin install` (TR-10)           | **No trigger; detect on the surfaces that already run**                                              | A watcher on a file in a home directory that another program rewrites is not worth what it buys. TR-10 stays `not built`, reason recorded.                                                                                                                                                                                                                                    |
| 13  | The properties that hold decisions 2 and 3       | **P8 re-scoped, P8b and P8c added, P4 gains a global clause**                                        | Exact statements in §2.5. P8 is re-scoped rather than relaxed, because a relaxed property is how this class of work goes wrong.                                                                                                                                                                                                                                               |
| 14  | Behaviour under `DORKOS_BOUNDARY`                | **Skip the user tier and say so; keep the dork-home tier**                                           | A boundary limits how far DorkOS reaches into a person's disk, and `<dorkHome>` is DorkOS's own. Needs a new `boundaryWasConfigured()` because `initBoundary(undefined)` collapses the distinction (§2.6).                                                                                                                                                                    |
| 15  | Whether the first global projection is asked for | **Asked once by the CLI, remembered in `harness.global`**                                            | D5 puts "changes what every future session reads" past the line. The boot pass cannot ask and does not; the app's version is DOR-1852's surface.                                                                                                                                                                                                                              |
| 16  | Ticket scoping                                   | **DOR-1857 is the global-scope ticket; `adopt` stays with DOR-1853**                                 | `specs/harness-sync/03-tasks.json` files `adopt` under DOR-174 while the contract treats DOR-174 as global projection. Both stop citing DOR-174; §Follow-ups files the task-file correction.                                                                                                                                                                                  |
| 17  | The engine API                                   | **`buildGlobalPlan(input)` beside `project()`, never a root discriminator**                          | `buildPlan` runs fourteen stages unconditionally; a discriminator would make decision 2 depend on fourteen omissions and a fifteenth stage added later. A separate entry point inverts the default (§2.1).                                                                                                                                                                    |
| 18  | The target vocabulary                            | **A `scope` discriminator on `ProjectionAction`, and absolute targets in a global plan**             | A `root` field would be a second silent way for a target to escape `repoRoot`, which is the hazard P8 exists to catch, and every reader of `target` would have to remember to join it (§2.2).                                                                                                                                                                                 |
| 19  | How DOR-1852's row key stays unique              | **`(scope, artifact, source, name)`, added in slice A2**                                             | Without `scope`, two rows differ only in whether a path is spelled absolutely, which is an accident and not a key. Additive and defaulted, so DOR-1852's slices land unchanged (§2.2).                                                                                                                                                                                        |
| 20  | Where the global manifest lives                  | **A `harness.global` block in `~/.dork/config.json`, migration key `'0.76.0'`**                      | Same store, same reader, same migration chain as the hook decisions it sits beside. A second manifest file would need a scaffold policy, a parse-failure answer and an ADR-0302 rule, all of which `.agents/harness.manifest.json` earns by being committed.                                                                                                                  |
| 21  | The shape of that block                          | **`harnesses: HarnessId[]` and `askedAt: string \| null`, and no `enabled` flag**                    | An empty list is off, so a flag and a list can never disagree. `askedAt` is what makes declined durable and distinguishable from never-asked (§2.3).                                                                                                                                                                                                                          |
| 22  | Whether the dork-home tier is switchable         | **No**                                                                                               | It writes only into a directory DorkOS creates on boot and already watches. Asking permission for that teaches people to click yes without reading, which every later question depends on them not having done (§2.3).                                                                                                                                                        |
| 23  | The sweep's third clause, evaluated how          | **On the link's own text, resolved lexically; never `realpath`**                                     | A global uninstall removes the package first, so its leftover links dangle and `realpath` throws on exactly the orphans the sweep exists for. Containment is a path-segment test, and the sweep never descends (§2.4).                                                                                                                                                        |
| 24  | Which Claude roots the **write** targets         | **`inheritedClaudeRoot()` and `resolveActiveClaudeRoot()`, de-duplicated; never the whole root set** | Normally one directory. Two only when an operator pinned an account, and both are needed because slice A3 retires SDK injection and a pinned session would otherwise lose global packages outright (§2.12). A correction to the ideation, which settled the read only.                                                                                                        |
| 25  | How the status API answers for global scope      | **Fold global rows into every project answer, marked `scope: 'global'`; no `?scope=global`**         | The person's question is "what can this tool see here". A second call would make the page decide precedence between two answers, which is the opinion §2.11 says DorkOS must not have. Budget restated as ≤ 250 KB including global rows (§3).                                                                                                                                |
| 26  | Whether Option A needs a new ADR or an amendment | **A new ADR that `amends` ADR-0303** (`260908-191538`)                                               | ADR-0303's decision includes hooks in the portable subset that projects "scope-matched (project↔project, global↔global)". Decision 4 refuses hooks at user scope, which reverses part of an accepted decision. `writing-adrs` reserves the in-file amendment section for a stated exception and the `amends` relation for a partial reversal, and this is the second (§2.13). |

## Deviations from the brief, the ideation and earlier documents

Where the code disagreed with a document, the code decided. Each row names the line that did.

| #   | The document said                                                                                       | The code says                                                                                                                                                                                  | What this spec does                                                                                                                        |
| --- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Ideation: the aspirational CLI comment is at `harness-sync-command.ts:527`                              | It is at **`:771`**                                                                                                                                                                            | Cites `:771`.                                                                                                                              |
| 2   | Ideation: the global drop is at `plan/projector.ts:678, 809-816`                                        | The partition is at **`:682-690`** and the drop at **`:821-827`**, with the reason an **inline literal**, not a named constant                                                                 | Cites the real lines and notes that slice A1 must introduce the constant it replaces the literal with.                                     |
| 3   | Ideation: the CLI's server imports are at `:530` and `:573`                                             | They are **dynamic** imports at **`:774`, `:817`, `:818`**, by relative path (`../server/...`), never `@dorkos/server`                                                                         | §1.1 states the real mechanism, which matters because the B1 import must be dynamic too.                                                   |
| 4   | Ideation: the DOR-1518 gap comment is at `sources/installed.ts:466-500` (contract says `:451`)          | It is at **`:488-496`**                                                                                                                                                                        | Cites `:488-496`.                                                                                                                          |
| 5   | Brief: "the Zod schema for the slice of `~/.claude/settings.json` that is read (`enabledPlugins` only)" | The same brief requires the repository normaliser, which reads `extraKnownMarketplaces`, and the ticket carries HK-14, whose user half is `hooks` in the same file                             | Reads **three** documented keys in one pass (§1.2). Reading one and returning for the others would be two reads of the same file.          |
| 6   | Brief: "seed it as a **draft**"                                                                         | `writing-adrs`: "There is no `draft` status: significance is judged at extraction time"                                                                                                        | Seeds it `proposed`, which is what the repo's other spec-extracted ADRs carry (`260908-085032`).                                           |
| 7   | Ideation decision 6 settles one Claude root, for the read                                               | The **write** has a second requirement the read does not: slice A3 retires SDK injection, so a pinned `defaultAccount` session would lose global packages if only the inherited root is linked | §2.12 and decision 24: the write targets both roots, de-duplicated. Never the whole root set.                                              |
| 8   | Ideation: a global plan "must go through a carve-out or take an injected root"                          | Both are needed. The engine takes it injected **and** somebody has to resolve `~/.agents` for it, which no existing carve-out covers                                                           | §2.12: a sixth carve-out in slice A3, with the ESLint, rule-file and guard-script edits it drags in, named.                                |
| 9   | Ideation: the sweep's third clause is "the link target resolves inside `<dorkHome>/plugins`"            | `realpath` throws on a dangling link, which is exactly what a global uninstall leaves                                                                                                          | §2.4 and decision 23: resolve the link **text** lexically. Without this correction the sweep strands the orphans it exists for.            |
| 10  | Ideation: the boundary answer is "skip and say so"                                                      | There is no way to ask. `initBoundary(undefined)` stores the home path, and no `isBoundaryConfigured`-shaped export exists anywhere                                                            | §2.6 specifies `boundaryWasConfigured()` and where its answer is recorded.                                                                 |
| 11  | Ideation: `harness.global` "would need a semver-keyed migration"                                        | `'0.75.0'` is already merged and pinned, and `config-manager.ts:3772-3780` says "anything further opens `'0.76.0'`"                                                                            | Decision 20 names `'0.76.0'` and §2.3 lists the seven other files `adding-config-fields` requires.                                         |
| 12  | Ideation: SRC-12's notice can carry "both versions once the scanner grows it"                           | `InstalledPlugin` has no `version` and this spec does not add one                                                                                                                              | §2.11's frozen copy carries no version numbers, and the case that proves the notice survives a malformed manifest is seeded.               |
| 13  | Ideation: ADR-0305 should be amended by `/adr:review`                                                   | Its project half is already superseded by `260706-192819`, and its global half is **deleted** by slice A3                                                                                      | §2.9 declines to amend it here and §Follow-ups files the status flip, so this spec does not leave a second live claim about the same code. |

## Open Questions

**None.** Every question this design raised is answered in §Decisions with its reason.

Three things are **dated or gated** rather than open, and each is recorded so a reader knows what it rests
on:

- **Slice A3 is gated on DOR-1856**, and the gate's bar is "the answer exists for all five", not "all five
  pass" (§Testing). A three-of-five result changes what A3 plans, not whether it ships.
- **Managed settings are unreadable to DorkOS.** The report says the answer may be overridden rather than
  answering as if the file were absent (§1.6). That is experiment 3's open half, paid for in one sentence.
- **Every measurement here is the operator's machine or a temp-dir fixture, on 2026-09-08, against
  `ebb091f8b`.** The implementer re-measures in the PR; the budget, not the measurement, is the contract.

## Follow-ups to file

Six, none owned here.

1. **`InstalledPlugin` has no `version`.** Worth adding for the both-scopes notice's text and for the update
   flow. §2.11's rule must not come to depend on it.
2. **ADR-0305's status.** Its decision describes code that is already gone and it is still `accepted` with
   `superseded-by: null`. `/adr:review` owns the flip; slice A3 deletes the last code it describes.
3. **`specs/harness-sync/03-tasks.json` files `adopt` under DOR-174** while the contract treats DOR-174 as
   global projection. Decision 16 says which is which; the task file still needs the edit.
4. **`readPaths.user` has one reader after §2.12, and it is a test.** A later pass could make
   `harnessCoverage()` walk it, which would let the coverage oracle answer at user scope too.
5. **Cursor's `~/.claude/skills` compatibility path** means a Claude Code link is reachable twice for Cursor
   and OpenCode, the user-level twin of SK-09/SK-12. Worth a re-read on the next vendor-facts refresh.
6. **A global `POST /api/harness/sync`.** Deliberately not in this spec (§Security). If the app ever needs
   to run a global sync, it needs its own person-only bar and its own removal disclosure.

## Related ADRs

- **`260908-191538` — Global-scope projection is skills-only, symlinked, and proves what it owns** (proposed,
  extracted from this spec). `amends` ADR-0303.
- **ADR-0303** — Harness Sync is a multi-source projector. Its scope-matching clause is what this work
  implements, and its "portable subset (skills, hooks)" clause is the half decision 4 narrows.
- **ADR-0302** — instructions are scaffolded, never generated. §2.10 is the argument for why its mechanism
  does not transfer to user scope, and its DOR-1851 amendment is the shape `dorkos harness global --enable`
  copies.
- **ADR-0301** — canonical `.agents/` and hybrid projection: the engine this extends.
- **`260706-192819`** — harness-native plugin delivery: why an installed plugin's skills are files rather
  than SDK injection, and therefore why slice A3 ends by deleting the global injection path.
- **ADR-0305** — per-cwd plugin activation: stale, and §Follow-ups item 2 owns it.
- **`260908-085032`** — one status model answers for the app and the terminal (DOR-1852): the response §3
  adds to.

## References

- Ticket: **DOR-1857**. Splits into **1857b** (slice B1) and **1857a** (slices A1, A2, A3). Gated for A3 on
  **DOR-1856**. Shares a schema with **DOR-1852** (slices DOR-1891, DOR-1892). Leaves `adopt` to
  **DOR-1853**.
- Ideation: `specs/harness-sync-global/01-ideation.md` — its §5.2 per-tool tables and §5.7 measurements are
  carried forward here rather than repeated in full.
- Contract: `meta/harness-sync-capabilities.md` — §3 SRC-04/08/12, §4 SK-03, §5 IN-08, §6 HK-14, §10 TR-10,
  §12 J-07, §14 gap 11, §16 D1/D3/D4/D5/D6.
- Plan: `plans/harness-sync-test-plan.md` — §3 line 64 (P8), §11 row 14.
- Parent spec: `specs/harness-sync/02-specification.md` lines 217-219 ("Scope maps to scope … Never cross
  global→project") and `03-tasks.json` task 2.2.
- Sibling spec: `specs/harness-sync-status/02-specification.md` — §1.3 the row key, §4 the schema,
  §Performance the budget.
- Engine: `packages/harness/src/sources/installed.ts`, `engine.ts`, `plan/types.ts`, `plan/projector.ts`,
  `plan/installed-projector.ts`, `apply/apply.ts`, `inventory/{index,types,hooks,read}.ts`,
  `vendor-facts/{index,types,coverage}.ts`, `report/drop-list.ts`.
- Server: `services/harness/{auto-project,project-with-consent,project-agent-workspace,hook-consent}.ts`,
  `services/runtimes/claude-code/claude-config-dir.ts`,
  `services/runtimes/claude-code/messaging/plugin-activation.ts`,
  `services/marketplace/{marketplace-source-manager.ts,lib/locate-install.ts}`,
  `services/tasks/skills-roots.ts`, `services/core/config-manager.ts`, `lib/{boundary,dork-home}.ts`.
- CLI: `packages/cli/src/harness-sync-command.ts`, `cli.ts`, `commands/{install,uninstall,marketplace-dispatcher}.ts`.
- Rules and skills: `.claude/rules/dork-home.md`, `.claude/skills/adding-config-fields`,
  `.agents/skills/writing-for-humans`, `.agents/skills/writing-adrs`.
- Research: `research/20260705_harness-audit-opus-optimization.md` (user-scope plugin sprawl — cited for the
  shape of the problem, never for its numbers), `research/20260329_claude_code_plugin_marketplace_extensibility.md`.
