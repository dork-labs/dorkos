# Harness Sync at global scope — implementation tasks

Canonical task data lives in [`03-tasks.json`](./03-tasks.json); this file is its human-readable mirror. Spec: [`02-specification.md`](./02-specification.md). Parent work item: [DOR-1857](https://linear.app/dorkspace/issue/DOR-1857).

## One sub-issue per slice — a deliberate override

The DECOMPOSE stage promotes a task to its own tracker sub-issue only when its size reaches `decomposition.subIssueThreshold` (default `xl`), and nothing here is `xl`. This programme overrides that on purpose, and the override is recorded rather than assumed: every slice runs as its own worktree, its own adversarial review and its own PR, so each one needs a tracker item the dispatch loop can pick up on its own. Four children were created, one per slice, in dependency order so each blocked-by id existed before the item that names it. The same override was taken on the sibling programme DOR-1852 and is the shape this one follows.

## Phases

| Phase | Slice | Tracker                                                 | Blocked by                                                                                                       | Tasks | Ships                                                                                                  |
| ----- | ----- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------ |
| 1     | B1    | [DOR-1921](https://linear.app/dorkspace/issue/DOR-1921) | —                                                                                                                | 4     | the plugins you turned on in Claude Code, named in the terminal, with the command that shares each one |
| 2     | A1    | [DOR-1922](https://linear.app/dorkspace/issue/DOR-1922) | —                                                                                                                | 4     | a drop that says what a globally installed package holds, and the both-scopes notice                   |
| 3     | A2    | [DOR-1923](https://linear.app/dorkspace/issue/DOR-1923) | [DOR-1922](https://linear.app/dorkspace/issue/DOR-1922)                                                          | 5     | the first global projection — a scheduled skill in a globally installed package that runs              |
| 4     | A3    | [DOR-1924](https://linear.app/dorkspace/issue/DOR-1924) | [DOR-1923](https://linear.app/dorkspace/issue/DOR-1923), [DOR-1856](https://linear.app/dorkspace/issue/DOR-1856) | 5     | a global package's skills in the two user directories, behind a one-time ask                           |

`DOR-1856` is the H-tier run. It exists already, it is not a child of this decomposition, and it gates slice A3 alone: slices B1, A1 and A2 are unaffected by it.

## Critical path

The longest chain is 2.1 → 3.1 → 3.2 → 4.2 → 4.3 → 4.4 → 4.5, seven tasks, and it runs through every slice of Part A in order. At slice level that reads A1 → A2 → A3, with A3 additionally held behind DOR-1856. Slice B1 has no dependency on any of them and no file in common with them, so it runs beside the whole chain from day one: task 1.1 and task 2.1 are the two that can start at once. Inside the phases, 1.3 and 1.4 run beside each other, 2.2 and 2.3 run beside each other, and 3.3, 3.4 and 3.5 all run beside each other once 3.2 has landed. Slice A2's two large tasks, 3.1 and 3.2, are strictly sequential: nothing can be applied before it can be planned.

## Phase 1 · Slice B1 — Claude Code's own plugins

**Tracker:** [DOR-1921](https://linear.app/dorkspace/issue/DOR-1921) · sub-issue of [DOR-1857](https://linear.app/dorkspace/issue/DOR-1857) · no blockers.

Spec: `specs/harness-sync-global/02-specification.md` — §1 (Part B, subsections 1.1 to 1.9); §Testing Strategy, slice B1; §Implementation Phases, slice B1; §4 rows 1 to 3; decisions 5, 6, 9, 10, 11, 12.

### Task 1.1: Add the marketplace repository normaliser and pin its fold

**Size:** medium · **Priority:** high · **Depends on:** — · **Runs beside:** 2.1

One comparable key for "which repository is this marketplace", folded from the two spellings DorkOS and Claude Code each use for it. Nothing else in slice B1 can resolve an offer without it.

Files:

- `apps/server/src/services/marketplace/lib/marketplace-repo-key.ts` (NEW) — `export function marketplaceRepoKey(input: MarketplaceRepoInput): string | null` and `export type MarketplaceRepoInput = { kind: 'url'; url: string } | { kind: 'claude-source'; source: string; repo?: string }`. Pure: no filesystem access.
- `apps/server/src/services/marketplace/lib/__tests__/marketplace-repo-key.test.ts` (NEW) — its fixtures.

The fold, stated so a test can pin it: from a URL, strip the scheme, any `www.`, the host, a trailing `.git`, a trailing slash; lower-case the host segment and PRESERVE CASE ON THE PATH. From a Claude Code source, require `source === 'github'` and take `repo` as `owner/name`. The result is `owner/name`. Return `null` rather than guessing when the input names a host kind with no `owner/name` slug to fold — a `git` or `file` source has no key, and pretending it does is how a false match is manufactured.

Why this is a module and not two lines: Claude Code stores `{ source: "github", repo: "anthropics/claude-plugins-official" }` while DorkOS stores the full URL `https://github.com/anthropics/claude-plugins-official` (`marketplace-source-manager.ts:68-84`). `"anthropics/claude-plugins-official" === "https://github.com/anthropics/claude-plugins-official"` is false, so a direct comparison matches 0 of the 16 entries measured on the operator's machine on 2026-09-08. It lives beside `locate-install.ts` because the marketplace domain owns what a source is, and the harness domain should not learn to parse one.

Fixtures: the two real pairs measured on the operator's machine (Claude Code's `dorkos` and DorkOS's `dorkos-community` are the same repository under two local names, and `claude-plugins-official` on both sides), a `.git` suffix, a trailing slash, a `www.` host, an upper-case owner segment that survives, and a non-`github` `source.source` returning `null`.

Seeded defect that must red first: lower-case the whole key. An upper-case owner then matches a lower-case one, which is a false positive on a case-sensitive host.

Hard rule 4 applies: every export carries a TSDoc block description, not `@param`/`@returns` tags alone.

Acceptance bar: `marketplaceRepoKey` resolves 15 of the 16 measured entries and returns `null` for the sixteenth rather than guessing. Not one file under `packages/harness` is touched.

Verification: `pnpm vitest run apps/server/src/services/marketplace/lib/__tests__/marketplace-repo-key.test.ts`; `pnpm --filter @dorkos/server typecheck`; `pnpm --filter @dorkos/server lint`. The branch faces an independent adversarial review per `REVIEW.md` before a PR opens.

### Task 1.2: Read Claude Code's own settings and classify every plugin a person turned on

**Size:** medium · **Priority:** high · **Depends on:** 1.1 · **Runs beside:** —

The read, the merge, the schema and the five-rung classification behind slice B1's report. Two file reads and no write anywhere.

Files:

- `apps/server/src/services/runtimes/claude-code/claude-config-dir.ts` — export `inheritedClaudeRoot` (`:57-59`), unchanged, with a TSDoc line saying who else reads it and why not the active root.
- `apps/server/src/services/harness/claude-enabled-plugins.ts` (NEW) — the read, the merge, `ClaudeSettingsSliceSchema`, the rung classification. Takes `claudeRoot` and `projectPath` as arguments and calls no resolver of its own.
- `apps/server/src/services/harness/__tests__/claude-enabled-plugins.test.ts` (NEW) — cases 1 to 9 below. Every fixture is a temp directory standing in for a Claude root plus a repo; no home directory is read.

Which root, and why it is exported rather than re-derived: read the root a bare `claude` uses (`$CLAUDE_CONFIG_DIR`, else `~/.claude`), never `resolveActiveClaudeRoot()`. That resolver is `runtimes.claudeCode.defaultAccount ?? inheritedClaudeRoot()` (`claude-config-dir.ts:140-142`) and its first rung answers which Claude account DorkOS runs and bills on; J-07 asks which Claude Code the person typed `/plugin install` into. `claude-config-dir.ts` is the Hard Rule 3 carve-out and the carve-out is BY FILENAME (`claude-config-dir.ts:27-32`), so no sibling module may call `os.homedir()` for this. `resolveClaudeRootSet()` is never used: reporting plugins from accounts a person is not running describes sessions they are not having.

Three documented keys from one file and nothing else — `enabledPlugins`, `extraKnownMarketplaces` and `hooks` — with `.passthrough()` at both levels because this is somebody else's file and the vendor adds keys to it. Never `~/.claude/plugins/`, never `known_marketplaces.json`, never `plugin-catalog-cache.json`. The hooks schema deliberately never names `command`, so no shell text a person wrote is ever bound to a value: counting matcher groups and the entries inside them needs array lengths and nothing more.

A failure becomes a record, never a throw. The model is `inventory/read.ts`: absent is silent, present-and-unreadable is an `UnreadableSource`-shaped record carrying the path and the reason, and the read keeps going. The counter-example in the tree is `loadClaudeHooks` (`engine.ts:45-51`), which does a bare `JSON.parse` with a cast and throws.

The merge: `enabledPlugins` has settings scope "Any file", so it is legal in `<claudeRoot>/settings.json`, `<repo>/.claude/settings.json` and `<repo>/.claude/settings.local.json`, all three read, merged PER KEY under Claude Code's documented precedence (local over project over user), and the keys whose merged value is `true` are reported. Managed settings may be unreadable to DorkOS and are not read. A project `true` with no user entry is a different case and gets its own group, never folded into the machine-wide list.

The five rungs: (1) the repository resolves to a marketplace DorkOS has and it has that package — the install command; (2) the repository resolves to a marketplace DorkOS does not have — the source URL and `dorkos marketplace add`; (3) the marketplace name is not in `extraKnownMarketplaces` — no offer and no guess; (4) the source resolves and has no package of that name — said plainly; (5) the source has that name and DorkOS cannot claim it is the same thing — "a package of the same name from the same repository", never more. Rung 5 is a copy rule and not a branch: neither side carries a version DorkOS can compare.

Nine cases, each with the seeded defect that must red it first:

1. Nine plugins turned on out of sixteen produce nine rows; seven `false` entries produce none. Defect: report every entry rather than the `true` ones — sixteen rows.
2. A malformed settings file becomes one record and no throw. Defect: replace the Zod parse with `JSON.parse`, matching `loadClaudeHooks` — the case throws.
3. `$CLAUDE_CONFIG_DIR` set makes that root the one printed. Defect: call `resolveActiveClaudeRoot()` — with a `defaultAccount` in the fixture config the other root is printed.
4. A plugin whose repository matches a DorkOS source names the package in the offer. Defect: match on marketplace name — the `dorkos` to `dorkos-community` pair falls to rung 3.
5. A repository with no package of that name prints the rung-4 line and no command. Defect: print the install command anyway.
6. A plugin turned off in `.claude/settings.local.json` is not reported. Defect: read the user file only — it appears in the machine-wide list.
7. A plugin `true` only in the project file lands under its own heading. Defect: merge project entries into the machine-wide list.
8. A settings file with three hook commands yields the count 3; zero yields no line. Defect: count matcher groups instead of entries — the count reads 2 where the fixture has 3.
9. No `enabledPlugins`, or none `true`, produces nothing at all. Defect: emit the heading unconditionally.

Acceptance bar: all nine cases pass and each one's seeded defect reds it. Nothing read from that file is written anywhere, echoed into a projection, or sent off the machine. Not one file under `packages/harness` is touched, asserted by the PR's own diff.

Verification: `pnpm vitest run apps/server/src/services/harness/__tests__/claude-enabled-plugins.test.ts`; `pnpm --filter @dorkos/server typecheck`; `pnpm --filter @dorkos/server lint`; `bash scripts/test-homedir-guard.sh` (the carve-out is unchanged and must stay silent). The branch faces an independent adversarial review per `REVIEW.md` before a PR opens.

### Task 1.3: Print the Claude-Code-only block from the CLI in its frozen wording

**Size:** medium · **Priority:** high · **Depends on:** 1.2 · **Runs beside:** 1.4

The person-facing half of slice B1: one block in `dorkos harness sync`, printed only when there is something to say.

Files:

- `packages/cli/src/harness-sync-command.ts` — one dynamic import of `../server/services/harness/claude-enabled-plugins.js` (the FOURTH such import; the three that exist are at `:774`, `:817` and `:818`, all by relative path, never `@dorkos/server`) and one print block, after `formatDropList` and before `formatNotEnabled`.
- `packages/cli/src/__tests__/harness-sync.test.ts` — one case.

The block is assembled in the CLI BESIDE `formatDropList`'s output, never inside it. Putting it inside would make `@dorkos/harness` read a home directory, which three of its module docs forbid by name (`inventory/index.ts:47-50`, `inventory/types.ts:22-24`, `inventory/hooks.ts:11-15`).

The frozen lines, with `{root}`, `{n}`, `{name}`, `{repo}`, `{marketplace}`, `{url}`, `{reason}` and `{project}` the only substitutions. **`{project}` is the project's ABSOLUTE path, never `.`**: the install command is sent to a running server, which resolves `projectPath` in ITS OWN process, so a `.` names the directory the SERVER was started in — measured as `Access denied: projectPath outside boundary` from outside the boundary, and as a silent install into the wrong project from inside it:

```
Installed in Claude Code only
  Read from {root}

  You turned on {n} plugins in Claude Code. Your other agent tools cannot see them.

  DorkOS can install these for this project, so every agent tool here gets them:
    - {name} (from {repo})
  Run: dorkos install {name} --project {project}
  DorkOS has to be running, and it asks you to approve the install first.

  DorkOS does not have these sources yet:
    - {name} (from {repo})
  Add the source first: dorkos marketplace add {url}

  DorkOS has that source but nothing by that name:
    - {name} (from {repo})

  DorkOS cannot tell where these came from:
    - {name} (from a source Claude Code calls "{marketplace}")

  On for this project only:
    - {name} (from {repo})

  Your company can also turn plugins on or off, in a settings file DorkOS cannot read. So this list may
  not be the whole story.
```

Singular forms: `You turned on 1 plugin in Claude Code.` A group with no members is not printed at all, heading included. The managed-settings sentence prints once, at the end, whenever any group printed.

The unreadable case replaces the whole block:

```
Installed in Claude Code only
  DorkOS could not read {root}/settings.json, so it cannot tell you what Claude Code has. ({reason})
  Nothing else in this report is affected.
```

HK-14's user half is one extra line inside the same block, from the same read, printed only when the count is above zero:

```
  Your personal Claude Code settings run {n} commands automatically. Only Claude Code runs them.
```

The root is printed on every run. `$CLAUDE_CONFIG_DIR` is inherited, so a run started inside an agent session can read a different root than the person's own terminal — the split-brain `claude-config-dir.ts:12-20` already warns about. Measured on the operator's machine, that variable pointed at a sibling root holding 7 entries while `~/.claude` held 16. Choosing the right resolver does not by itself make the answer right; disclosure does. The report says "plugins you turned on in Claude Code", never "plugins installed in Claude Code", because `defaultEnabled` defaults to `true` and the public half cannot enumerate installs, so a fourth state is not computable.

Never auto-install: the offer is a printed command into the flow that already exists, with its existing preview and its existing approval (`cli.ts:149-222`). It must not become a second install path. The offer points at project scope until slice A3 lands.

The CLI case and its seeded defects: assert the block's position in the output (after the drop list, before the not-enabled lines) and that a failing read leaves the rest of the report intact. Defect one: move the block above `formatDropList` — the position assertion reds. Defect two: let the read throw rather than return the unreadable record — the rest of the report is lost and the intact-report assertion reds.

On the vocabulary gates, honestly: neither reaches these strings. `scripts/check-banned-words.sh` scans a fixed list of prose files plus `docs:mdx` and `blog:mdx`; `pnpm check:vocab-gate` parses `apps/{client,site,server}/src`. This copy lives in `packages/cli/src`, which no gate reads. So the bar is a hand check listed in the PR: grep the frozen block for each retired word and paste the empty result. Both gates still run for what they do cover.

Acceptance bar: on the operator's own machine `dorkos harness sync` prints nine plugins with their repositories, the install command beside every one DorkOS can resolve, and the root it read. Every line is plain, active, under twenty words and carries no em dash, per `writing-for-humans`. "Agent tools" is used rather than "harnesses": a person did not install a harness.

Verification: `pnpm vitest run packages/cli/src/__tests__/harness-sync.test.ts`; `pnpm --filter dorkos typecheck`; `pnpm --filter dorkos lint`; `pnpm --filter dorkos test`; `pnpm --filter @dorkos/server test` (the read module lives in the server tree, and the slice's Bar names both). The branch faces an independent adversarial review per `REVIEW.md` before a PR opens.

### Task 1.4: Add the claudeOnly status payload, flip the B1 contract rows and ship the fragment

**Size:** medium · **Priority:** high · **Depends on:** 1.2 · **Runs beside:** 1.3

The shape-only half of slice B1 plus the paperwork the slice owes. The page that renders this payload is DOR-1852's and is not built here.

Files:

- `packages/shared/src/harness-schemas.ts` — `HarnessClaudeOnlySchema` with `root`, `readAt`, optional `unreadable`, `mayBeOverridden`, `plugins[]` (`name`, `marketplace`, optional `repo`, `settingsScope: 'user' | 'project'`, `offer: 'install' | 'add-source-then-install' | 'unknown-source' | 'no-package'`, optional `sourceUrl`) and `personalHookCommands`; added to `HarnessStatusResponseSchema` as `claudeOnly: HarnessClaudeOnlySchema.optional()`. Optional because the Obsidian transport answers `state: 'unavailable'` and has no home directory to read.
- `apps/server/src/services/harness/status.ts` — populate it. That file does not exist on this base: it lands with DOR-1891. If DOR-1891 has not landed when this task runs, this hunk moves to whichever of the two tickets lands second, and the task ships the schema half alone.
- `meta/harness-sync-capabilities.md` — SRC-08 flips to read and reported; J-07's terminal half flips; HK-14's user half flips from unread to read and reported; TR-10 stays `not built` with decision 12's reason recorded (a watcher on a file in a home directory that another program rewrites is not worth what it buys); position D4 gains two sentences and the position itself stands.
- `changelog/unreleased/<id>-<slug>.md` — one fragment, id minted by `.claude/scripts/id.ts`, written to the `writing-for-humans` bar. Never edit `CHANGELOG.md`.

The root is always present in the payload, because `$CLAUDE_CONFIG_DIR` is inherited and the answer is only checkable if you can see which file it came from. `unreadable`, when set, means `plugins` is empty and means nothing. `mayBeOverridden` is always true today, because a managed settings file may exist and DorkOS cannot read it.

Budget: nine plugins is roughly 1 KB, negligible against DOR-1852's 250 KB ceiling, and it is measured in the PR like every other number there.

Seeded defect that must red first: make `claudeOnly` required on `HarnessStatusResponseSchema` and the Obsidian-transport case reds, because that transport has no home directory to read and answers `state: 'unavailable'`. For the contract rows, `capabilities-census.test.ts` fails until each flipped row's coverage cell names a real test, so a row claiming a surface this PR did not build reds the census.

Acceptance bar: no row claims a surface this PR did not build. The J-07 app half stays `not built` and names DOR-1852.

Verification: `pnpm vitest run apps/server/src/services/harness/__tests__`; `pnpm --filter @dorkos/shared build`; `pnpm --filter @dorkos/shared typecheck`; `pnpm --filter @dorkos/server typecheck`; `pnpm --filter @dorkos/shared lint`; `pnpm --filter @dorkos/server lint`; `bash scripts/check-banned-words.sh`; `pnpm exec prettier --check meta changelog`. The branch faces an independent adversarial review per `REVIEW.md` before a PR opens.

## Phase 2 · Slice A1 — the honest drop, the location union, the both-scopes notice

**Tracker:** [DOR-1922](https://linear.app/dorkspace/issue/DOR-1922) · sub-issue of [DOR-1857](https://linear.app/dorkspace/issue/DOR-1857) · no blockers.

Spec: `specs/harness-sync-global/02-specification.md` — §2.2 (the location union), §2.11 (SRC-12), §4 rows 4 and 5 and §4a; §Testing Strategy, slice A1; §Implementation Phases, slice A1; decisions 7 and 18.

### Task 2.1: Give InstalledPlugin a location union and make the global scan enumerate the package

**Size:** medium · **Priority:** high · **Depends on:** — · **Runs beside:** 1.1

Today a global package is recorded as a name. `scanPluginsRoot` records identity only (`packages/harness/src/sources/installed.ts:497-504`: `skills: []`, `commands: []`, no `relDir`, no `hooks`), so a package with two skills and a slash command is reported as a name and nothing else. This task makes the scan enumerate it, and changes the type so the compiler names every site that assumed repo-relative.

Files:

- `packages/harness/src/sources/installed.ts` — the location union, the global enumeration branch replacing the identity-only one at `:497-504`, and `unreadableHooks`'s contract at `:145-152`.
- Every call site the compiler names. The union is what finds them; there is no list to write by hand.
- `packages/harness/src/sources/__tests__/` — cases 1, 4 and 7.

The union, replacing `scope: InstalledScope` at `:124` beside an optional `relDir?: string` at `:130` documented as "Present only for project-scoped plugins":

```ts
export type InstalledLocation =
  { scope: 'project'; relDir: string } | { scope: 'global'; absDir: string };
```

`InstalledPlugin.scope` and `InstalledPlugin.relDir` are replaced by `location: InstalledLocation`. Every `InstalledSkill.sourceDir` and `InstalledCommand.sourcePath` follows its package: repo-relative under a project location, absolute under a global one. Making this a union rather than a scope tag beside an optional path is the point — that pairing is unenforced and it is exactly what makes a global package's paths unresolvable.

`unreadableHooks`'s contract changes with it. Its doc today reads "absent means the file was never read (a global install)". After this slice a global package's hooks file IS read, to the same standard as a project one, so absent recovers its plain meaning: the file is not there. That clause is DELETED rather than reinterpreted.

Three cases, with the seeded defect that must red each first:

1. A global package with two skills, one command and a hooks file is enumerated, with absolute source paths. Defect: keep the identity-only branch — every list is empty.
2. A global package whose `hooks/hooks.json` is malformed produces an `unreadableHooks` entry, not an absent field. Defect: leave `unreadableHooks` off for global packages — absent still means two things.
3. No call site treats a global package's `sourceDir` as repo-relative. This one is the compiler and not a test: reverting the union must not compile, which is the proof.

Acceptance bar: on a fixture staging a global package with two skills, a command and a hooks file, the scan returns them with absolute paths. Reverting the location union does not compile. `ProjectionAction.scope` is deliberately NOT added here — it has no producer and no reader until slice A2 builds the global plan — so `packages/harness/src/plan/types.ts` is not touched by this task.

Verification: `pnpm vitest run packages/harness/src/sources/__tests__`; `pnpm --filter @dorkos/harness typecheck` (this is case 7's evidence, run on the branch and on a tree with the union reverted); `pnpm --filter @dorkos/harness lint`; `pnpm typecheck` across the monorepo, because the union names call sites outside the package. The branch faces an independent adversarial review per `REVIEW.md` before a PR opens.

### Task 2.2: Replace the global-install drop with the two honest forms

**Size:** medium · **Priority:** high · **Depends on:** 2.1 · **Runs beside:** 2.3

`packages/harness/src/plan/projector.ts:821-827` drops every global package with one inline string: `global-scope install; a project sync does not project global plugins (run a global sync)`. There is no global sync — `dorkos harness sync` takes `--check`, `--fix`, `--harness`, `--strict`, `--allow-hooks`, `--enable` and `--write-gitignore` (`harness-sync-command.ts:134-147`) and nothing accepts a scope. This task replaces the sentence with two that are true when they print.

Files:

- `packages/harness/src/plan/projector.ts` — the partition at `:682-690` and the drop at `:821-827`, where the reason is an inline literal today. Introduce the named constant it replaces; the inline literal is part of why nothing pinned it.
- `packages/harness/src/plan/__tests__/` — cases 2 and 3.

Two frozen forms, one entry per package, `harnessAgnostic: true`, still through `dropWholePlugin` so each renders under the `plugin layers:` heading. `formatDropList` prints `  - plugin "globex": <reason>`, so the reason continues a sentence that already has its subject: the text starts lower-case, starts with a verb, and is one string with no line breaks. `{n}` is a count and `{names}` is the skill names, comma-separated.

```
installed for all your projects. Only the Claude Code sessions DorkOS runs can see it. Its {n} skills are
not shared with this project: {names}
```

```
installed for all your projects. Only the Claude Code sessions DorkOS runs can see it. It has no skills
to share.
```

Neither names a command, because in slice A1 there is none to name. Writing the string so later slices APPEND is deliberate: the defect this replaces was a sentence that told the truth about a command that was going to exist and never did, and a form that grows by addition can never be false at the moment it is printed. Slice A2 appends `Its skills that run on a timer now work.` to the first form, only when the package has a skill that declares a schedule; slice A3 appends `Run dorkos harness global --enable <tool> to share it with your other agent tools.`, only while the package is not shared yet. Neither append is written here.

Two cases, with the seeded defect that must red each first:

2. The drop names the skills that are not shared, and names no command. Defect: restore the old string — the case reads "run a global sync".
3. A global package with no skills gets the second form. Defect: emit the first form with an empty list — the sentence reads "Its 0 skills".

Acceptance bar: two of the four defects §Background opens with invert on a fixture staging a global package with two skills, a command and a hooks file. No sentence anywhere in the output names a command that does not exist. The copy is plain, active, under twenty words per sentence, and carries no em dash, per `writing-for-humans`.

Verification: `pnpm vitest run packages/harness/src/plan/__tests__`; `pnpm --filter @dorkos/harness typecheck`; `pnpm --filter @dorkos/harness lint`. The branch faces an independent adversarial review per `REVIEW.md` before a PR opens.

### Task 2.3: Raise the both-scopes notice once, at package level, with no version numbers

**Size:** medium · **Priority:** high · **Depends on:** 2.1 · **Runs beside:** 2.2

SRC-12 is the same package installed at both scopes — `~/.dork/plugins/globex` and `<repo>/.dork/plugins/globex`, possibly different versions — and not one line anywhere says they are the same package. The two projections land in different directories, so nothing overwrites anything and no sweep deletes the other's file. What collides is what an agent tool sees when it merges its user tier over its project tier, and the tools disagree: Claude Code lets the personal copy win, Codex shows both, Gemini CLI puts workspace before user, and OpenCode, Cursor and Copilot state no precedence for skills at all.

DorkOS resolves nothing and says so. It never refuses the install, never deletes a copy, and never invents a DorkOS-side precedence — that would be unenforceable, because the projection is a symlink in a directory the agent tool reads on its own terms, and it would be wrong for at least two agent tools whichever way it pointed.

Files:

- `packages/harness/src/plan/installed-projector.ts` — one `harnessAgnostic: true` entry per affected package, so by DOR-1852's row rules it lands in `projectLevel[]` and renders once under the heading the CLI calls `plugin layers:`. It never becomes a cell and never a row.
- `packages/harness/src/plan/__tests__/` — cases 5 and 6.

Frozen copy, ONE STRING with no line breaks and no version numbers (the wrapping below is presentational). No line breaks, because the renderer prints a reason as given (`report/drop-list.ts:54`) and would not indent a continuation. No version numbers, because `InstalledPlugin` carries no `version` (`sources/installed.ts:117-154`), and a notice that could only be raised when both versions are readable is a notice that goes missing on a malformed manifest:

```
is installed twice: once for all your projects, and once in this project. Claude Code uses the
all-projects copy, even here. Codex shows both. Uninstall one if you only meant to have one. Run
dorkos uninstall {pkg} --project .  to remove this project's copy. Run dorkos uninstall {pkg}  to remove
the all-projects copy. Both need DorkOS running, and both ask you first.
```

`dorkos marketplace uninstall` is not offered because it does not exist: `dorkos marketplace <sub>` manages sources only (`add|remove|list|refresh|validate`, `commands/marketplace-dispatcher.ts:102`). The two copies are separately addressable because `installRootCandidates` probes project roots before global ones (`marketplace/lib/locate-install.ts:63-71`).

This notice needs nothing slice A2 or A3 builds: `scanInstalledPlugins({ dorkHome, projectRoot })` already returns both scopes on every project sync, so the fact is available at the exact moment the drop is printed.

Two cases, with the seeded defect that must red each first:

5. The same name at both scopes produces exactly one project-level notice carrying both scopes. Defect: emit it per harness — the notice appears three times on a three-tool project.
6. The notice is still produced when one manifest will not parse, and still carries no version numbers. Defect: gate the notice on both versions being readable — the notice goes missing.

Acceptance bar: exactly one notice on a three-tool project, surviving a malformed manifest, with no version number anywhere in the string.

Verification: `pnpm vitest run packages/harness/src/plan/__tests__`; `pnpm --filter @dorkos/harness typecheck`; `pnpm --filter @dorkos/harness lint`. The branch faces an independent adversarial review per `REVIEW.md` before a PR opens.

### Task 2.4: Prove slice A1 writes nothing outside a repository, flip SRC-04 and SRC-12, ship the fragment

**Size:** medium · **Priority:** high · **Depends on:** 2.2, 2.3 · **Runs beside:** —

Slice A1 makes the drop honest and enumerates a global package. It must still write nothing outside a repository, and that is a claim measured rather than assumed.

Files:

- `packages/harness/src/sources/__tests__/` and `packages/harness/src/plan/__tests__/` — a tree-diff snapshot of a staged HOME taken across the WHOLE test file, before and after, asserting the two trees are identical. It is the slice-wide guard, not a per-case assertion, because the failure it catches is a write nobody expected from a case nobody suspected.
- `meta/harness-sync-capabilities.md` — SRC-12 flips to built, citing the notice's test. SRC-04 stays `not built` for projection and its row records that the drop is now honest and names slice A2 as the one that projects the dork-home tier and slice A3 as the one that reaches the user tier. Saying otherwise would be exactly the kind of false row the census exists to catch.
- `changelog/unreleased/<id>-<slug>.md` — one fragment, id minted by `.claude/scripts/id.ts`, plain enough for a smart 9th grader who doesn't code, per `writing-for-humans`. Never edit `CHANGELOG.md`.

Seeded defect that must red first: make the global enumeration branch write a marker file into the staged HOME and the tree-diff assertion reds naming the path. That proves the snapshot compares what it claims to compare, which a snapshot taken only after the run would not.

Acceptance bar: the staged HOME is byte-identical across the whole A1 test file. `capabilities-census.test.ts` is green with SRC-12's coverage cell naming a real test and SRC-04 still honest about not projecting. The fragment names what a person gets: a drop that says what a globally installed package holds and which tools can see it.

Verification: `pnpm vitest run packages/harness/src/sources/__tests__`; `pnpm vitest run packages/harness/src/plan/__tests__`; `pnpm vitest run packages/harness/src/__tests__/capabilities-census.test.ts`; `pnpm --filter @dorkos/harness typecheck`; `pnpm --filter @dorkos/harness lint`; `bash scripts/check-banned-words.sh`; `pnpm exec prettier --check meta changelog`. The branch faces an independent adversarial review per `REVIEW.md` before a PR opens.

## Phase 3 · Slice A2 — buildGlobalPlan, its apply, and the scheduler's global half

**Tracker:** [DOR-1923](https://linear.app/dorkspace/issue/DOR-1923) · sub-issue of [DOR-1857](https://linear.app/dorkspace/issue/DOR-1857) · blocked by [DOR-1922](https://linear.app/dorkspace/issue/DOR-1922).

Spec: `specs/harness-sync-global/02-specification.md` — §2.1, §2.2, §2.4, §2.5, §2.8, §3; §4 row 6; §Testing Strategy, slice A2; §Implementation Phases, slice A2; decisions 8, 13, 17, 18, 19, 22, 23, 25.

### Task 3.1: Build buildGlobalPlan and projectGlobal, and plan the dork-home tier

**Size:** large · **Priority:** high · **Depends on:** 2.1 · **Runs beside:** —

A second entry point beside `project(repoRoot, opts)`, never a root discriminator on it. `buildPlan` runs fourteen stages unconditionally, in order (`plan/projector.ts:660-836`), so a discriminator would run all of that against a home directory and rely on each stage opting out — the rule "never generate at user scope" would then be enforced by fourteen independent omissions, and the ordinary way a rule like that is lost is a fifteenth stage added later by somebody who never read this design. A separate entry point inverts it: a stage reaches the global plan only if somebody puts it there.

Files:

- `packages/harness/src/plan/global-projector.ts` (NEW) — `GlobalPlanRoots`, `GlobalPlanInput`, `buildGlobalPlan(input): ProjectionPlan` and `projectGlobal(input: Omit<GlobalPlanInput, 'packages'>): ProjectionPlan`.
- `packages/harness/src/plan/types.ts` — `scope?: 'project' | 'global'` on `ProjectionAction`, plus the `DriftResult.orphans` (`:236`) and `DriftResult.leftAlone` (`:255`) TSDoc edits.
- `packages/harness/src/plan/__tests__/` — case 1.

`GlobalPlanRoots` carries `dorkHome` (always present: it is where global packages are read from at `<dorkHome>/plugins/<pkg>` and where the scheduler's own root is at `<dorkHome>/skills`), optional `agentsSkillsDir` and optional `claudeSkillsDir`. An absent root is a root the plan does not target, which is how a boundary-confined deployment, an unanswered ask and a machine with no enabled harness all reach the same code path. In THIS slice both optional roots are always absent; slice A3 passes them.

`GlobalPlanInput` carries `roots`, `packages: readonly InstalledPlugin[]` and `harnesses: readonly HarnessId[]`. Empty harnesses is legal and plans the dork-home tier only, which needs no harness to be useful. The engine is a leaf package and cannot import a server service, so every input is handed in: it reads no config and resolves no home.

`buildGlobalPlan` is PURE — no filesystem access at all — which is what makes the properties in task 3.3 checkable on a hand-built input. `projectGlobal` is the only half that touches a disk: it calls `scanInstalledPlugins({ dorkHome })` with no `projectRoot`, hands the result in as `input.packages`, and never throws — an unreadable package becomes a warning and the walk keeps going, following `inventory/read.ts`.

It returns the SAME `ProjectionPlan` type as `project()`, so `formatDropList`, `formatWarnings` and DOR-1852's status model read one shape. Two of that type's fields are always empty in a global plan and the TSDoc says so: `notEnabled` is a per-repository detection result and there is no repository here, and `narrowedTo` is never set because `buildGlobalPlan` takes no narrowing parameter at all.

`ProjectionAction.scope` is optional and absent means `'project'`, so every existing emitter is unchanged and the field cannot be forgotten into a false global. A global action's `target` and `source` are ABSOLUTE POSIX paths. A `root` field was rejected: it would let a target stay relative and be joined against something other than `repoRoot`, which is a second silent way for a target to escape, and every reader of `target` would have to remember to join it first. An absolute target is self-describing.

The dork-home tier, the only tier this slice plans: `<dorkHome>/skills/<pkg>__<name>` links to `<dorkHome>/plugins/<pkg>/skills/<name>`, one link per skill, planned whatever agent tools are enabled, carrying `harnessAgnostic: true`. Everything downstream already works: `globalSkillsRoot(dorkHome)` is `<dorkHome>/skills`, created on boot and returned by `globalTaskRoots` as a watched root with `scope: 'global'` (`services/tasks/skills-roots.ts:39`, `:105`, `:152`); `skills-root-discovery` already expects `<pkg>__<name>` links; a schedule's identity is its resolved real path and `resolveRootPath` realpaths the root, so a symlinked target produces one row and not two.

Attribution: every `ProjectionAction` must carry a `HarnessId` and `HarnessId` has no DorkOS member, so these links reuse the pattern `SCHEDULE_LINK_ATTRIBUTION` already documents (`plan/installed-projector.ts:154-165`) — a placeholder harness with `harnessAgnostic: true` and a reason that says plainly why the link is there. Two frozen reasons:

```
skill runs on a timer; linked into the DorkOS skills folder, the one place DorkOS looks for timed skills
linked into the DorkOS skills folder, so a package you installed for all your projects is reachable there
```

No per-harness fan-out: the global planner emits ONE action per target directory per skill, deduplicated by target path, which is why a global plan cannot produce two actions racing for one path. Only skills are planned — not commands, not hooks, not instructions.

Case 1 and its seeded defect, which must red first: a global package's scheduled skill is planned into `<dorkHome>/skills/<pkg>__<name>` carrying the schedule reason. Defect: plan it only when a harness is enabled — an empty harness list then produces no action.

Acceptance bar: `buildGlobalPlan` touches no disk, provably, because it takes its packages as an argument. `notEnabled` and `narrowedTo` are empty in every plan it returns. No path outside `<dorkHome>` appears anywhere in the plan, because no user root is passed in this slice. Hard rule 4 applies to every new export.

Verification: `pnpm vitest run packages/harness/src/plan/__tests__`; `pnpm --filter @dorkos/harness typecheck`; `pnpm --filter @dorkos/harness lint`. The branch faces an independent adversarial review per `REVIEW.md` before a PR opens.

### Task 3.2: Apply and check a global plan behind the three-clause ownership predicate

**Size:** large · **Priority:** high · **Depends on:** 3.1 · **Runs beside:** —

The half that writes, and the predicate that decides what it may remove. Today's project-scope predicate is TWO clauses — a candidate under `.agents/skills` or `.claude/skills` is swept only if its basename contains `__` AND it is a real symlink (`apply/apply.ts:315-336`, pinned by `installed-integration.test.ts:420`). That is sufficient in a repository, where every symlink in `.agents/skills` was put there by the engine. It is NOT sufficient in a home directory, and the operator's own machine proves it: `~/.claude/skills/composio-cli` and `~/.claude/skills/find-skills` are relative symlinks into `~/.agents/skills/`, whose targets are hand-authored directories. Under the two-clause predicate the only thing standing between those links and the sweep is the absence of `__` in their names.

Files:

- `packages/harness/src/apply/global-apply.ts` (NEW) — `applyGlobalPlan(plan, roots, opts?)` returning `{ applied, conflicts, swept, leftAlone }`, `checkGlobalPlan(plan, roots): DriftResult`, and the three-clause ownership predicate, which lands here with the module that owns it and is SCOPED IN THIS SLICE to `<dorkHome>/skills`.
- `packages/harness/src/__tests__/global-integration.test.ts` (NEW) — cases 2, 5 and 6.

The predicate, all clauses required:

```
A candidate directly inside a directory the CURRENT global plan targets is swept only when:
  1. `lstat` says it is a symlink; and
  2. its basename contains `__`; and
  3. the link's own text, resolved LEXICALLY against the directory the link sits in, is inside
     `<dorkHome>/plugins`; and
  4. the current global plan does not name that target path.
Clauses 1-3 decide ownership. Clause 4 decides orphanhood.
```

Three details decide whether this is correct or merely careful. Clause 3 reads the link text, NEVER `realpath`: a global uninstall removes the package directory first, so the links it left behind are dangling and `realpath` throws on exactly the orphans the sweep exists to remove; resolving `readlinkSync(p)` against `dirname(p)` with `path.resolve` normalises `..` without touching the filesystem. Containment is a path-segment test, `p === root || p.startsWith(root + path.sep)`, because a bare `startsWith` matches `<dorkHome>/plugins-of-someone-else`. And the sweep NEVER DESCENDS: it reads one level of each target directory, so a person's own subdirectory tree is not walked and nothing inside it can be a candidate.

A target that is already occupied is a conflict, never an overwrite. P3 holds unchanged at global scope: if a target is already a real directory, or a symlink pointing somewhere other than `<dorkHome>/plugins`, the apply leaves it exactly as it is, counts it in `conflicts`, and prints the line that says what is in the way.

`applyGlobalPlan` takes `roots` again rather than reading them off the plan, for the same reason `applyPlan` takes `repoRoot`: an apply that trusts a path carried inside the thing it is applying can be pointed anywhere by a malformed plan. Passing the roots twice gives the containment check an independent second opinion. A global plan is never narrowed to one agent tool, so the `applyPlan` guard that throws on a narrowed sweep (`apply/apply.ts:693-698`) has no global twin; `buildGlobalPlan` has no `harness` narrowing parameter at all, which is the stronger form of the same protection.

Every path is printed before it is removed. `checkGlobalPlan().orphans` equals the next `applyGlobalPlan().swept`, asserted as SET EQUALITY IN BOTH DIRECTIONS, joining the contract DOR-1889 sets for the six project sweeps rather than being retro-fitted to it later. The global apply prints the list first and then the receipt, in that order.

Three cases, with the seeded defect that must red each first:

2. Applying the plan makes the link, and the scheduler's own discovery parses the namespaced directory. Defect: point the link at the package root rather than the skill directory — discovery finds no `SKILL.md`.
3. `checkGlobalPlan().orphans` equals the next `applyGlobalPlan().swept` as set equality both ways. Defect: return only the first sweep's finder — the count assertion reds before the contents.
4. A global plan is idempotent: applying twice leaves the tree byte-identical and the second check clean. Defect: recreate the link unconditionally — the second apply reports one applied action.

Acceptance bar: a scheduled skill in a globally installed package RUNS — the link exists at `<dorkHome>/skills/<pkg>__<name>`, the scheduler's own discovery parses it, and a row appears. A second run applies nothing and reports clean. No path outside `<dorkHome>` is touched, because no user root is passed in this slice. Hard rule 4 applies to every new export.

Verification: `pnpm vitest run packages/harness/src/__tests__/global-integration.test.ts`; `pnpm vitest run packages/harness/src/apply/__tests__`; `pnpm --filter @dorkos/harness typecheck`; `pnpm --filter @dorkos/harness lint`. The branch faces an independent adversarial review per `REVIEW.md` before a PR opens.

### Task 3.3: Write P8 for the first time, add P8b and P8c beside it, and give P4 its global clause

**Size:** medium · **Priority:** high · **Depends on:** 3.2 · **Runs beside:** 3.4, 3.5

`plans/harness-sync-test-plan.md` line 64 reads "P8 scope: no action's target escapes `repoRoot`; a global plugin never appears in a target path." **P8 is a line in a plan and nothing else: there is no test named P8.** `packages/harness/src/__tests__/properties/` holds eight files covering P2, P3, P4, P6, P7, P9a and P9b, and no P8. So this task does not re-scope a property; it WRITES THE FIRST P8 THERE HAS EVER BEEN, in its narrowed form, alongside two new siblings. A property that is narrowed on paper and never executed is worth nothing.

Files:

- `packages/harness/src/__tests__/properties/plan-root-scope.property.test.ts` (NEW) — P8, P8b and P8c, all three in one file.
- `packages/harness/src/__tests__/properties/apply-ownership.property.test.ts` — P4 gains a global clause rather than becoming a fourth property: at global scope a removal must additionally satisfy clause 3 of the ownership predicate, and the ledger the property already keeps extends to the global roots.
- `plans/harness-sync-test-plan.md` — line 64's P8 restated in its narrowed form, P8b and P8c added, and row 14 of §11 split into the four slices of this programme.

The three statements, written into the plan and into the test:

P8 project scope [v2]: every action in a plan built by `project()` carries `scope` absent or `'project'`, its `target` and `source` are repo-relative POSIX strings, and each resolves inside `repoRoot`. No path built from a `dorkHome` appears in any of them. As strong as v1; only its subject is named.

P8b global roots: every action in a plan built by `buildGlobalPlan` carries `scope: 'global'` and an absolute POSIX `target`, and that target resolves inside one of the plan's declared roots and inside no other directory. A root passed as absent produces no action beneath it, and the counterexample prints the offending target and the root set.

P8c global kinds: no action in a global plan has `kind: 'generate'`, `kind: 'scaffold'` or `kind: 'merge'`. Every global action is `symlink`, `native` or `drop`. The rule "never generate at user scope" has no other enforcement, and `buildPlan` running every stage unconditionally is the ordinary way it would be lost.

Three seeded defects, one per property, each of which must red its case first: for P8, let `planCanonicalSkillLinks` emit an absolute target and the project property reds; for P8b, join the dork-home tier against a user root and the counterexample prints the escaping path; for P8c, call `planInstructionScaffold` from `buildGlobalPlan` and six scaffold actions appear.

Acceptance bar: all three properties pass on the branch and each reds on its own seeded defect, with the counterexample naming the offending path. The count is three new property statements and one amended one — an earlier draft of this design said "two new properties beside a re-scoped P8", which is the wrong count once you find there is no P8 to re-scope.

Verification: `pnpm vitest run packages/harness/src/__tests__/properties/plan-root-scope.property.test.ts`; `pnpm vitest run packages/harness/src/__tests__/properties/apply-ownership.property.test.ts`; `pnpm --filter @dorkos/harness typecheck`; `pnpm --filter @dorkos/harness lint`; `pnpm exec prettier --check plans`. The branch faces an independent adversarial review per `REVIEW.md` before a PR opens.

### Task 3.4: Fold global rows into the status answer and keep the row key unique across scopes

**Size:** medium · **Priority:** high · **Depends on:** 3.1 · **Runs beside:** 3.3, 3.5

`GET /api/harness/status?projectPath=<path>` has no global mode. Global rows fold into EVERY project's answer, each marked `scope: 'global'`; there is no `?scope=global` variant. The question a person asks is "what can this agent tool see here", and here always includes what is installed for every project. A second call would make the page merge two answers and decide precedence between them itself, which is exactly the per-tool precedence DorkOS must have no opinion about.

Files:

- `packages/shared/src/harness-schemas.ts` — `export const HarnessScopeSchema = z.enum(['project', 'global']);` with the TSDoc "Absent in stored data means `'project'`"; `HarnessRowSchema` gains `scope: HarnessScopeSchema.default('project')`; `HarnessStatusResponseSchema.counts` gains `globalSkills: z.number().int().nonnegative()`.
- `apps/server/src/services/harness/status.ts` — the fold, plus a second `satisfies Record<...>` table over `InstalledLocation['scope']` onto `HarnessScopeSchema`, so a third scope cannot be added to the engine without the compiler naming this file. That file lands with DOR-1891; if it has not landed when this task runs, the fold moves to whichever ticket lands second and the schema half ships alone.
- The row-derivation tests — case 7.

The row key becomes `(scope, artifact, source, name)`. Global scope supplies the counter-example the fourth component needs: the same package installed at both scopes projects a skill of the same name, of the same artifact kind, from sources that differ only in whether the path happens to be absolute, and relying on that spelling would be relying on an accident. The addition is additive, so DOR-1852's slices land unchanged either way.

The two counts are disjoint by definition, stated because "skills" could otherwise mean either: `counts.skills` counts rows whose `artifact` is `skill` AND whose `scope` is `'project'`, which is exactly what DOR-1852 counts today, so the number under the profile row does not move when this ships; `counts.globalSkills` counts rows whose `artifact` is `skill` and whose `scope` is `'global'`. Their sum is every skill row the page draws and neither ever includes a row the other does.

Rows appear before the tier is on: a global package's skills are rows from slice A1 onward, with every cell `dropped` and carrying the reason. A project answering `state: 'not-set-up'` still answers with global rows, because a project with no manifest can still hold a person who installed something globally.

Budget: DOR-1852 measures 190 bytes per cell and sets 250 KB for a repo of 31 skills across three enabled tools. Global rows add `packages x skills x (tools + 1)` cells; 20 packages of 5 skills is 100 global rows and roughly 133 KB, about 165 KB in total, inside the budget with roughly a third left. The budget statement becomes 250 KB INCLUDING global rows, and this task records a fresh measurement with a seeded 20-package fixture. If a real machine is measured past it, the answer is pagination or a summary-first response, filed with the measurement, never a cache.

Case 7 and its seeded defect, which must red first: the row key stays unique — the same skill name at both scopes derives two rows. Defect: drop `scope` from the key — two rows collapse to one and a cell goes missing.

Acceptance bar: `counts.skills` is unchanged for a repo with no global packages. The compile-time table names `status.ts` when a scope is added to the engine. The measurement is in the PR beside DOR-1852's.

Verification: `pnpm vitest run apps/server/src/services/harness/__tests__`; `pnpm --filter @dorkos/shared build`; `pnpm --filter @dorkos/shared typecheck`; `pnpm --filter @dorkos/server typecheck`; `pnpm --filter @dorkos/shared lint`; `pnpm --filter @dorkos/server lint`. The branch faces an independent adversarial review per `REVIEW.md` before a PR opens.

### Task 3.5: Add dorkos harness sync --global, append the A2 sentence, and flip SK-03

**Size:** medium · **Priority:** high · **Depends on:** 3.2 · **Runs beside:** 3.3, 3.4

The terminal surface for slice A2, plus the paperwork the slice owes.

Files:

- `packages/cli/src/harness-sync-command.ts` — `--global`. It builds the global plan through `projectGlobal`, prints every path it will remove BEFORE removing it, then prints what it did. `--check` narrows it to a report, as it does today. The flag list it joins is `--check`, `--fix`, `--harness`, `--strict`, `--allow-hooks`, `--enable` and `--write-gitignore` (`:134-147`).
- `packages/harness/src/plan/projector.ts` — the A2 append to the global-install drop, added to the first form only when the package has a skill that declares a schedule, and never rewriting the sentence slice A1 froze: `Its skills that run on a timer now work.`
- `meta/harness-sync-capabilities.md` — SK-03's global half flips to built, citing the integration test. SRC-04 stays `not built` for projection to a harness, because slice A2 reaches only `<dorkHome>/skills` and no agent tool reads that directory.
- `changelog/unreleased/<id>-<slug>.md` — one fragment, id minted by `.claude/scripts/id.ts`, plain enough for a smart 9th grader who doesn't code, per `writing-for-humans`. Never edit `CHANGELOG.md`.
- `packages/cli/src/__tests__/harness-sync.test.ts` — one case for the flag.

Nothing changes in `dorkos harness sync` WITHOUT `--global` in this slice except the appended sentence, which is a string it already prints in a block it already has.

Seeded defects that must red first: for the CLI case, make `--global` apply before printing the removals — the assertion that every path is named before it goes reds. For the appended sentence, append it unconditionally — a package with no scheduled skill then claims its timers work.

Acceptance bar: `dorkos harness sync --global` on a staged dork home links a global package's scheduled skill, names every removal before it happens, and a second run applies nothing and reports clean. `--check` writes nothing. `capabilities-census.test.ts` is green with SK-03's coverage cell naming a real test and no row claiming a surface this PR did not build.

Verification: `pnpm vitest run packages/cli/src/__tests__/harness-sync.test.ts`; `pnpm vitest run packages/harness/src/__tests__/capabilities-census.test.ts`; `pnpm --filter dorkos typecheck`; `pnpm --filter dorkos lint`; `pnpm --filter dorkos test`; `bash scripts/check-banned-words.sh`; `pnpm exec prettier --check meta changelog`. The branch faces an independent adversarial review per `REVIEW.md` before a PR opens.

## Phase 4 · Slice A3 — the user tier, gated on DOR-1856

**Tracker:** [DOR-1924](https://linear.app/dorkspace/issue/DOR-1924) · sub-issue of [DOR-1857](https://linear.app/dorkspace/issue/DOR-1857) · blocked by [DOR-1923](https://linear.app/dorkspace/issue/DOR-1923), [DOR-1856](https://linear.app/dorkspace/issue/DOR-1856).

Spec: `specs/harness-sync-global/02-specification.md` — §2.3, §2.6, §2.7, §2.9, §2.10, §2.12, §2.13; §4 rows 7 to 10 and §4b, §4c; §Testing Strategy, slice A3 and the H-tier gate; §Implementation Phases, slice A3; decisions 2, 3, 4, 14, 15, 20, 21, 24, 26, 27, 28.

### Task 4.1: Add the sixth os.homedir() carve-out for ~/.agents and pin the vendor invariant

**Size:** medium · **Priority:** high · **Depends on:** 3.2 · **Runs beside:** 4.2

`<agentsSkillsDir>` is `~/.agents/skills`, and no existing carve-out covers it. The five listed in `.claude/rules/dork-home.md` are `lib/dork-home.ts`, two inline-disabled call sites in `lib/boundary.ts`, and three modules that each mirror one other program's resolution of its own directory. `~/.agents` is exactly that shape, mirrored five times over: Codex, OpenCode, Cursor, Gemini CLI and Copilot all document `$HOME/.agents/skills` as a user-scope read path, and the repo's own `vendor-facts/index.ts` records it for each of them.

Files:

- `apps/server/src/services/harness/agents-user-home.ts` (NEW) — one exported function, one line of body, mirroring the vendors' documented resolution 1:1 and resolving nothing of DorkOS's own.
- `apps/server/eslint.config.js` — BOTH halves of the `os.homedir()` ban.
- `.claude/rules/dork-home.md` — the sixth row in the carve-out table, with its reason.
- `scripts/test-homedir-guard.sh` — its own block, in the shape the `claude-config-dir`, `codex-home` and `opencode-data-dir` blocks already have (a declared carve-out stays silent, and the carve-out is per FILE, not per directory).
- `AGENTS.md` — Hard Rule 3 (line ~165) says "Five carve-outs beyond tests" and enumerates them by name, and the Key conventions bullet (line ~118) says "outside the five carve-outs in Hard Rule 3". A sixth carve-out makes both sentences wrong, so the count and the list are edited in BOTH places in the same PR; `REVIEW.md` ("Five carve-outs are declared", line ~113) gets the same one-word edit, for the same reason. This file is NOT in the specification's own file list for this slice; it is added here because the rule text and the rule's enforcement must not disagree, and `scripts/check-banned-words.sh` scans `AGENTS.md`, so the edit is gated.
- `packages/harness/src/vendor-facts/__tests__/vendor-facts.test.ts` — one case asserting the invariant that justifies exactly two user directories: every harness except `claude-code` lists `~/.agents/skills` in `skills.readPaths.user`, and `claude-code` lists `~/.claude/skills`.

Why a carve-out and not a config field: a `harness.global.userSkillsDir` field would avoid the rule change and make the ordinary case require configuration, which is worse — nobody would set it, the feature would appear broken, and the field would become a second place a home directory is spelled.

`readPaths.user` has zero readers today (`vendor-facts/coverage.ts:49-52`: "data for humans; nothing here walks a home directory"), and this case is the first thing that reads it — as an assertion, not as a path source. If a vendor-facts refresh breaks the invariant, the case reds and the design is revisited rather than quietly wrong.

Seeded defects that must red first: remove the new file from either half of the ESLint carve-out and `pnpm --filter @dorkos/server lint` reds on `agents-user-home.ts`; change one harness's `skills.readPaths.user` in `vendor-facts` and the invariant case reds; delete the new block from `scripts/test-homedir-guard.sh` and the guard no longer proves the carve-out is silent, which is the regression that script exists to catch.

Acceptance bar: `bash scripts/test-homedir-guard.sh` green with the sixth carve-out declared and pinned. The carve-out is per file, not a whole-file exemption for the directory. `AGENTS.md`, `.claude/rules/dork-home.md` and the ESLint config all say six, and none of them says five.

Verification: `bash scripts/test-homedir-guard.sh`; `pnpm vitest run packages/harness/src/vendor-facts/__tests__/vendor-facts.test.ts`; `pnpm --filter @dorkos/server lint`; `pnpm --filter @dorkos/server typecheck`; `bash scripts/check-banned-words.sh`; `pnpm lint:root`. The branch faces an independent adversarial review per `REVIEW.md` before a PR opens.

### Task 4.2: Add the harness.global config block with its 0.76.0 migration and four guards

**Size:** medium · **Priority:** high · **Depends on:** 3.2 · **Runs beside:** 4.1

A project's enabled agent tools come from `.agents/harness.manifest.json`. Global scope has no repo, so the two decisions it records live in a `harness.global` block in `~/.dork/config.json`, not in a second manifest file at `<dorkHome>/harness.manifest.json`. They are the same kind of decision `harness.approvedHooks` and `harness.refusedHooks` already are and belong in the same store, read by the same reader, migrated by the same chain. A second manifest file would need its own schema, its own scaffold policy, its own "the engine never rewrites a hand-authored file" rule, and a second answer to what happens when it will not parse.

The block, added inside the existing `harness` section:

```ts
global: z
  .object({
    harnesses: z.array(HarnessIdSchema).default(() => []),
    askedAt: z.string().nullable().default(null),
  })
  .default(() => ({ harnesses: [], askedAt: null })),
```

There is no separate on/off flag: an empty list IS off, so the two can never disagree. `askedAt` `null` means the question has never been asked, which is a different state from asked-and-declined — declined is a timestamp with an empty list, and it is remembered.

The whole `adding-config-fields` checklist this drags in, because `harness` is an EXISTING top-level section and two separate things have to happen:

- `packages/shared/src/config-schema.ts:2373` — add the leaf to the enclosing `.default(...)` factory, which today reads `.default(() => ({ autoSync: true, approvedHooks: [], refusedHooks: [] }))`. `USER_CONFIG_DEFAULTS` is computed from `UserConfigSchema.parse({ version: 1 })` at import time, so a field the factory does not list is `undefined` there on a fresh install. THIS STEP, NOT THE MIGRATION, is what makes `harness.global` exist for new installs.
- `apps/server/src/services/core/config-manager.ts` — a migration keyed `'0.76.0'`, idempotent and absence-guarded, seeding `{ harnesses: [], askedAt: null }` onto a stored `harness` object that has no `global` member. `projectVersion` is `SERVER_VERSION`, which is `0.0.0` in a raw dev tree and below `0.76.0` in every build until that release ships, so this key runs for nobody until then. That is correct and not a defect: the factory covers fresh installs and every in-memory parse, and the migration exists to write the leaf into the config files of people who already have a stored `harness` section. `conf`'s shallow merge does not reach a nested leaf inside a section the file already carries, which is why the body is load-bearing rather than dead code. `VERSION` is `0.74.0`, `'0.75.0'` is already merged and pinned, and `config-manager.ts:3772-3780` says in words that anything further opens `'0.76.0'`. A merged body is frozen, so `'0.75.0'` may not be extended.
- `apps/server/src/services/core/__tests__/merged-migration-hashes.ts` — pin the new migration in the same PR.
- `CONFIG_DISCLOSURE` — `'harness.global.harnesses'` and `'harness.global.askedAt'` both `expose`. Neither is a credential nor names one, and an agent that can say "your global packages are not shared with Codex" is more useful than one that cannot.
- `CONFIG_WRITE_POLICY` — both `operator-only`. Changing `harnesses` changes how far DorkOS reaches on disk, which is the line that module draws.
- `contributing/configuration.md` and `docs/getting-started/configuration.mdx` — a row each.
- `apps/server/src/services/core/__tests__/config-manager.test.ts` — the upgrade-path case against a stale blob whose `harness` section has the three existing leaves and no `global`.

`HarnessIdSchema` already lives in `@dorkos/shared/harness-schemas`, a sibling module of `config-schema.ts`, so no move is needed.

Case 9 and its seeded defect, which must red first: an upgrade from a stored `harness` section with three leaves gains `global` and nothing else. Defect: key the migration `'0.75.0'` — the append-only guard reds before the test even runs, because a merged body is frozen.

Acceptance bar: all four config guards green — `migration-safety`, `migration-append-only`, `config-disclosure`, `config-write-policy`. A fresh install parses `harness.global` from the factory with no migration having run. The docs rows exist in both files.

Verification: `pnpm vitest run apps/server/src/services/core/__tests__/config-manager.test.ts`; `pnpm vitest run apps/server/src/services/core/__tests__`; `pnpm --filter @dorkos/shared build`; `pnpm --filter @dorkos/shared typecheck`; `pnpm --filter @dorkos/server typecheck`; `pnpm --filter @dorkos/server lint`; `bash scripts/check-banned-words.sh`; `pnpm exec prettier --check contributing docs`. The branch faces an independent adversarial review per `REVIEW.md` before a PR opens.

### Task 4.3: Plan and apply the user tier, with the boundary predicate and the widened sweep

**Size:** large · **Priority:** high · **Depends on:** 4.1, 4.2 · **Runs beside:** —

The slice's centre: a globally installed package's skills reach the user-level directory five agent tools read, and Claude Code's own, without DorkOS ever writing a generated file into a person's home directory.

Files:

- `apps/server/src/lib/boundary.ts` — `export function boundaryWasConfigured(env: NodeJS.ProcessEnv, config: ConfigReader): boolean`, pure, both arguments injected, beside the validators.
- `packages/harness/src/plan/global-projector.ts` — the two user roots are now passed and planned: `agentsSkillsDir` for the tools the DOR-1856 run confirmed, and `claudeSkillsDir` only when `claude-code` is in `harness.global.harnesses`. A dated drop is recorded for every tool the run did not confirm, naming the run's date and its result.
- `apps/server/src/services/harness/agents-user-home.ts` and `claude-config-dir.ts` — the server resolves both roots and hands them in. The Claude target is `path.join(inheritedClaudeRoot(), 'skills')`, ONE directory: that is the root a bare `claude` opens, and a bare `claude` is the only Claude Code the user tier has to serve, because a DorkOS-driven session is served whole by SDK injection. `resolveActiveClaudeRoot()` answers which account DorkOS bills and is not used; `resolveClaudeRootSet()` would put files in accounts nobody is running and is not used either.
- `packages/harness/src/apply/global-apply.ts` — the predicate's REACH widens from `<dorkHome>/skills` to the two user directories. The predicate's LOGIC is slice A2's and does not change here.
- The A3 test files — cases 1, 2, 3, 4, 5, 8 and 11.

Under `DORKOS_BOUNDARY`, the user tier is skipped and says so; the dork-home tier is unaffected; `validateBoundaryOrDorkHome` is NEVER called here. `initBoundary`'s default root is the person's home (`lib/boundary.ts:94-99`), so an ordinary install is already inside it, but a boundary-scoped deployment is deliberately confined and writing into `~` would defeat the point. `validateBoundaryOrDorkHome` narrows to `<dorkHome>/agents/*` on purpose (`boundary.ts:410-430`) and reaching for it here would either refuse the write or invite somebody to widen a security narrowing to make a feature work.

The predicate must not be derived from `initBoundary`'s argument, and the reasons are measured, not guessed. `initBoundary` has exactly two callers and the CLI is neither: `apps/server/src/index.ts:914` and `apps/server/src/harness-boot.ts:86`. `dorkos harness sync` runs in the CLI process, so it would read "not configured" on a confined deployment and write into the home directory anyway — fail-open, in the one place this rule exists to close. And `harness-boot.ts:86` passes `path.dirname(dorkHome)`, a non-null argument, where nothing was configured at all, so the eval harness would read "configured" and skip the user tier — fail-closed, in the other direction, for a deployment nobody confined. So the predicate reads the two places a boundary can actually be configured and nothing else: the `DORKOS_BOUNDARY` environment variable (`apps/server/src/env.ts:106`, and what `packages/cli/src/cli.ts:796-805` writes from `--boundary`) and the `server.boundary` config field (`config-schema.ts:1425`, `null` by default).

The frozen boundary line, printed by the CLI and the boot summary:

```
Packages you installed for all your projects stay inside DorkOS on this machine. DorkOS is limited to
{root}, so it will not add links in your home folder.
```

The two frozen user-tier link reasons, carried on each action so a report never looks arbitrary:

```
linked into your shared skills folder, the one place Codex, OpenCode, Cursor, Gemini CLI and Copilot all
look for skills
linked into Claude Code's own skills folder, the only place it looks
```

The restart caveat, printed once per run and only when the run created a skills directory that was not there before, the global sibling of `reportClaudeSkillsRestart`:

```
Claude Code needs a restart before it sees the new skills folder. In Gemini CLI, run /skills reload.
```

Seven cases, with the seeded defect that must red each first:

1. A staged HOME gets `~/.agents/skills/<pkg>__<name>` for five tools and a Claude link for the sixth. Defect: plan the Claude link unconditionally — it appears with Claude Code not enabled.
2. A hand-authored real directory, a hand-authored SYMLINK into `~/.agents/skills`, a Codex-installed directory and a DorkOS link are staged; a sweep removes exactly the DorkOS link. Defect: use the two-clause predicate — the hand-authored symlink is removed. This is the case the whole three-clause predicate exists for, and the operator's own machine has two such symlinks.
3. A dangling DorkOS link left by a global uninstall is still swept. Defect: resolve clause 3 with `realpath` — the call throws and the orphan is stranded.
4. A link whose text resolves to `<dorkHome>/plugins-elsewhere` is not swept. Defect: use `startsWith` without the separator — the neighbour directory's link goes.
5. The sweep does not descend: a `<pkg>__<name>` symlink two levels down is untouched. Defect: walk recursively — the nested link is removed.
6. `boundaryWasConfigured()` true skips the user tier, names the root, and still plans the dork-home tier. Defect: skip both tiers — the scheduled skill stops running on a confined deployment.
7. A hand-authored real directory at a target is a conflict, not an overwrite: its bytes are identical after the apply and it is counted in `conflicts`. Defect: replace an occupied target — the person's own skill is gone and the byte comparison reds.

One test case per process for the boundary, because one call site passing is not evidence for the other: a CLI run with `DORKOS_BOUNDARY` set (defect: derive from `initBoundary` and the CLI writes the links); a CLI run with `server.boundary` set in config and no environment variable (defect: read the environment variable only, which is what `cli.ts` populates AFTER the harness subcommand is intercepted at `cli.ts:131`, so the config-only case would silently write); and a server boot with neither set, which plans the user tier (defect: treat `harness-boot.ts`'s argument as configuration and the eval harness stops projecting).

Everything this task writes is a symlink into `<dorkHome>/plugins`. No file is generated, no file is merged, and no file a person authored is read, moved or rewritten.

Acceptance bar: the AP-07 global case is the one that decides this slice — exactly one removal from a HOME holding four staged shapes, and reverting to the two-clause predicate removes the person's own symlink. A `DORKOS_BOUNDARY` deployment skips the user tier, names the root, and still runs its scheduled global skills. Nothing in `messaging/plugin-activation.ts` or `claude-code-runtime.ts` changes.

Verification: `pnpm vitest run packages/harness/src/__tests__/global-integration.test.ts`; `pnpm vitest run packages/harness/src/apply/__tests__`; `pnpm vitest run apps/server/src/lib/__tests__`; `pnpm --filter @dorkos/harness typecheck`; `pnpm --filter @dorkos/server typecheck`; `pnpm --filter @dorkos/harness lint`; `pnpm --filter @dorkos/server lint`; `bash scripts/test-homedir-guard.sh`. The branch faces an independent adversarial review per `REVIEW.md` before a PR opens.

### Task 4.4: Ask once, remember the answer, and make --disable sweep the difference before it forgets

**Size:** large · **Priority:** high · **Depends on:** 4.2, 4.3 · **Runs beside:** —

A first write into a person's home directory is past the line where an agent proceeds on its own judgement, so the CLI asks, once, and remembers. The boot pass never asks — it runs unattended, which is exactly where a question cannot be answered, and `runAutoProjection` already refuses to scaffold or ask for the same reason (`auto-project.ts:312-331`). The app's version of this question belongs on the Skills page, which is DOR-1852's surface and is not built here.

Files:

- `packages/cli/src/harness-global-command.ts` (NEW) — `--enable <tool>`, `--disable <tool>`, `--list`.
- `packages/cli/src/commands/harness-dispatcher.ts` — route the new subcommand.
- `packages/cli/src/harness-sync-command.ts` — `dorkos harness sync --global` with `askedAt: null` prints the ask, writes nothing, and exits `0`.
- The A3 test files — cases 6, 7 and 12.

`dorkos harness global --enable <tool>` adds one agent tool and stamps `askedAt`; `--disable <tool>` removes one; `--list` shows the answer and the directories it implies. `--list` stamps nothing. A `--disable` that empties the list leaves `askedAt` set: declined is remembered, and the question is not asked again. This is the shape the `--fix --enable <harness>` amendment established: one explicit verb, one array element, nothing round-tripped.

`--disable` sweeps BEFORE it forgets, and the order is the whole of it. The sweep only looks in directories the CURRENT plan targets, so removing an agent tool from `harnesses` first would make its directory untargeted and strand every link DorkOS put there. So `--disable <tool>`:

1. builds the global plan as it stands, with the tool still enabled;
2. computes the plan the list would have WITHOUT that tool, and sweeps every link the three-clause predicate owns that the first plan named and the second does not, printing each path before removing it;
3. only then removes the tool from `harness.global.harnesses`.

Step 2 is a DIFFERENCE, not a directory wipe, and that is the whole subtlety. `~/.agents/skills` is shared by five agent tools, so disabling Cursor while Codex is still enabled must remove NOTHING: the same links serve Codex. Only disabling the last tool that reads a directory empties it. Disabling Claude Code is the one case that always removes something, because `<claudeRoot>/skills` has exactly one reader. A failure at step 2 leaves the config untouched, so the command is re-runnable and never half-done.

The frozen ask, printed once:

```
Share the packages you installed for all your projects with your other agent tools?

DorkOS would put links in these folders in your home directory:
  {agentsSkillsDir}   read by Codex, OpenCode, Cursor, Gemini CLI and Copilot
  {claudeSkillsDir}   read by Claude Code

It would add these links, and nothing else:
  - {linkName}

Each link points at a folder inside {dorkHome}/plugins. DorkOS only ever creates links in those two
folders, never files, and it only ever removes a link it made itself.

If you uninstall a package later, DorkOS removes its links too.
Claude Code needs a restart before it sees the new skills folder. In Gemini CLI, run /skills reload.

To say yes, run this once per agent tool you want:
  dorkos harness global --enable <tool>
where <tool> is one of: claude-code, codex, cursor, gemini (Gemini CLI), copilot, opencode.
Run dorkos harness global --list to see what you chose.
```

Every link name is printed, never a count. The list is what the person is agreeing to; a number is not.

Three cases, with the seeded defect that must red each first:

6. The ask prints every link name and writes nothing; `--enable` writes exactly one array element and stamps `askedAt`. Defect: write the config from the ask — the fixture's config changes on a read-only run.
7. A declined answer is remembered: an empty list with `askedAt` set never asks again. Defect: treat an empty list as unasked — the block prints on every run.
8. `--disable <tool>` sweeps the DIFFERENCE before it forgets the tool. Enable Codex and Cursor, apply, disable Cursor: `~/.agents/skills` is UNCHANGED. Then disable Codex: it is empty of DorkOS links and the person's own files are untouched. Two cases, because one would pass while the other was broken. Defect one: write the config first — links are stranded and the second case reds. Defect two: sweep the whole directory rather than the difference — Codex loses its skills when Cursor is disabled and the first case reds.

Acceptance bar: the ask prints every link name and writes nothing. `--enable` changes exactly one array element. Disabling one of two tools that share a directory removes nothing. The copy is plain, active, under twenty words per sentence and carries no em dash, per `writing-for-humans`; the vocabulary hand check runs on it, because `packages/cli/src` is read by neither gate.

Verification: `pnpm vitest run packages/cli/src/__tests__`; `pnpm vitest run packages/harness/src/__tests__/global-integration.test.ts`; `pnpm --filter dorkos typecheck`; `pnpm --filter dorkos lint`; `pnpm --filter dorkos test`; `pnpm --filter @dorkos/harness typecheck`. The branch faces an independent adversarial review per `REVIEW.md` before a PR opens.

### Task 4.5: Land the J-07 journey and the no-loss case, accept the ADR, and finish the contract and docs

**Size:** medium · **Priority:** high · **Depends on:** 4.3, 4.4 · **Runs beside:** —

The slice's closing task: the end-to-end proof, the one case that guards what SDK injection still delivers, and every document this work owes.

Files:

- `packages/harness/src/__tests__/journeys/` — the J-07 journey in the shape DOR-1848 established: `stageRepo` plus a staged HOME, an exact tree diff around the two user directories proving the run added the links it named and touched nothing else, and the uninstall half proving it removed exactly them.
- The A3 test files — case 10, the no-loss case.
- `decisions/260908-191538-global-scope-projection-is-skills-only-and-symlinked.md` — flip `status: proposed` to `accepted`, in the file and in `decisions/manifest.json`.
- `decisions/0303-harness-sync-multi-source-projection.md` — replace the one-line proposed-amendment note in its Status section with the full retirement block, which speaks in the past tense. ADR-0303 keeps `status: accepted` and `superseded-by: null`, in the file and in the manifest, because at PROJECT scope the clause is unchanged and so is everything else it decides.
- `meta/harness-sync-capabilities.md` — SRC-04 flips to built; §14 gap 11 is struck through; IN-08 is recorded as REFUSED with its reason (ADR-0302's mechanism needs a canonical source and user scope has none; there is no `~/.agents/AGENTS.md` convention, `@` is a relative import inside one repo, Codex documents no import syntax, and Cursor's user rules have an account-synced half that is not a file at all); the hooks, commands and MCP refusals are recorded per kind, each with its own reason; HK-14's refusal half joins the read half slice B1 flipped.
- `contributing/harness-sync.md` — a new section on global scope: the two tiers, the three-clause predicate, and the one sentence that says what a `DORKOS_BOUNDARY` deployment does instead.
- `docs/` — one user-facing page paragraph explaining, in plain words, that installing a package for all your projects shares it with your other agent tools once you say yes, and what `dorkos harness global` does.
- `changelog/unreleased/<id>-<slug>.md` — one fragment, id minted by `.claude/scripts/id.ts`, plain enough for a smart 9th grader who doesn't code, per `writing-for-humans`. Never edit `CHANGELOG.md`.

The retirement block ADR-0303 gains, verbatim:

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

Case 10 and its seeded defect, which must red first: a DorkOS-driven Claude Code session still gets a global package's commands, agents, hooks and MCP servers after this slice — `refreshActivatedPlugins` returns the package and the SDK options carry it, unchanged from before the slice. Defect: delete the global injection path, which an earlier draft of this design planned — the session loses the package's commands, and the case names all four kinds that went with them. Global SDK injection STAYS: `plugin-activation.ts:5-7` says injection delivers skills, commands, agents, hooks and MCP servers, five kinds, while the user tier delivers one, so deleting it would be a loss and not a migration. The retirement of injection at PROJECT scope does not transfer, because there harness-native projection covers every kind injection did.

The honest consequence this task records: a DorkOS-driven Claude Code session may see a global package's skill twice, once through the plugin and once through `<claudeRoot>/skills/<pkg>__<name>`. Claude Code documents loading a skill once when the same target is reachable from more than one location, and both routes resolve to the same realpath. What is not verified is whether the plugin loader and the personal-skills loader count as "more than one location" in that sentence's sense. The DOR-1856 run answers it: stage a global package that is both SDK-injected and user-tier linked, start a DorkOS-driven session, and ask Claude Code to list its skills. One entry means the design stands. Two entries flip a single switch — one new per-package input `sdkInjected: readonly string[]` on `GlobalPlanInput`, filled in by `projectGlobal` from the list `refreshActivatedPlugins` reads, and one condition in the Claude Code planner that skips those names — and bare-`claude` coverage for those packages becomes its own follow-up.

Six follow-ups this task files rather than fixes, each with its reason: `InstalledPlugin` has no `version`; ADR-0305's status is stale about its project half only; `specs/harness-sync/03-tasks.json` files `adopt` under DOR-174 while the contract treats DOR-174 as global projection; `readPaths.user` has one reader and it is a test; Cursor's `~/.claude/skills` compatibility path makes a Claude link reachable twice for Cursor and OpenCode; and a global `POST /api/harness/sync`, which needs its own person-only bar and its own removal disclosure.

Acceptance bar: the J-07 journey's tree diff is exactly the links the run named, and its uninstall half removes exactly them. Case 10 reds when the injection path is deleted. `adr-drift-check` sees a complete relation in both directions. `capabilities-census.test.ts` green, with no row claiming a surface this PR did not build.

Verification: `pnpm vitest run packages/harness/src/__tests__/journeys`; `pnpm vitest run packages/harness/src/__tests__/capabilities-census.test.ts`; `pnpm vitest run apps/server/src/services/runtimes/claude-code/__tests__`; `node .claude/scripts/adr-drift-check.mjs`; `pnpm --filter @dorkos/harness typecheck`; `pnpm --filter @dorkos/server typecheck`; `bash scripts/check-banned-words.sh`; `pnpm check:vocab-gate`; `pnpm exec prettier --check meta docs contributing changelog decisions`. The branch faces an independent adversarial review per `REVIEW.md` before a PR opens.
