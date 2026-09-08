---
slug: harness-sync-global
number: 260908-102701
created: 2026-09-08
status: ideation
---

# Harness Sync at global scope, and Claude Code's own `/plugin` installs as a source

**Slug:** harness-sync-global
**Author:** Claude (IDEATE stage, DOR-1857)
**Date:** 2026-09-08
**Tracker:** DOR-1857 · **Parent:** `specs/harness-sync` · **Contract:** `meta/harness-sync-capabilities.md` (SRC-04, SRC-08, SRC-12, SK-03 global half, IN-08, HK-14, TR-10, J-07, §14 gap 11, §16 D4)
**Plan position:** `plans/harness-sync-test-plan.md` §11 order-of-work row **14** — last of fourteen, on purpose.

---

## 1) Intent & Assumptions

### Task brief

Two things share one ticket because they meet in one place — a person's home directory.

1. **Global scope.** A marketplace package installed at global scope (`~/.dork/plugins/<pkg>`) reaches
   Claude Code only when Claude Code is driven by DorkOS, through SDK injection. Every other harness
   gets nothing, and the plan says so with a sentence that names a command that does not exist. The
   projection engine is repo-relative end to end, so a global plan is a design, not a widening.
2. **Claude Code's own `/plugin` installs.** A person who runs `/plugin install` inside Claude Code
   has plugins DorkOS cannot see and no other agent can use. Position D4 (settled in review) says:
   read the public half — `enabledPlugins` in `~/.claude/settings.json` — report it honestly, offer to
   install the same package through DorkOS's own marketplace, and never project out of Claude Code's
   private versioned cache.

### What IDEATE owes

A measured problem statement, a per-harness user-level path table with a verification state per cell,
at least three options with a recommendation, a stated rule for the both-scopes collision, a decision
on the scheduler's global half and on user-level instructions, a design for the `enabledPlugins`
detection and its honest offer, the open questions with the experiment that settles each, and a
recommendation on whether to split.

### Assumptions

- **D4 is a constraint, not a question.** The private cache under `~/.claude/plugins/` is never read
  and never projected from. Everything below obeys that without re-arguing it.
- **`dorkHome` is the one data directory.** `lib/dork-home.ts` resolves it; `os.homedir()` stays banned
  in `apps/server/src` outside the five carve-outs in `.claude/rules/dork-home.md`.
- **`~/.claude` is resolved only through `claude-config-dir.ts`.** That file is the carve-out; a
  sibling module may not call `os.homedir()` either.
- **The status surface is specified, not built.** `specs/harness-sync-status` (DOR-1852) landed as a
  merged SPEC on 2026-09-08 — the eight-state model, `GET /api/harness/status?projectPath=…` and the
  Skills page are all designed and **none of them exists yet** (its own nine slices are the build).
  So: everything this document proposes to _show_ renders in `dorkos harness sync` today, through
  `formatDropList` and the CLI's report, and gains its app half when DOR-1852's slices 4-7 land.
  Nothing here may assume a route or a page it can call.
- **HK-11 is not fixed yet.** The generated-file ownership sidecar is order-of-work row 1 and is not on
  `main`. Nothing here may depend on it, and nothing here may make its blast radius bigger.
- **The engine stays a leaf package.** `@dorkos/harness` reads documented on-disk layouts itself; it
  cannot import server services.

### Out of scope

- **`dorkos harness adopt`** (SRC-07/SRC-10, position D3, DOR-1853). A separate verb with a separate
  ADR amendment. Note the ticket-scoping problem in §3.5: `specs/harness-sync/03-tasks.json` files
  `adopt` under DOR-174 while the capabilities contract treats DOR-174 as the global-projection ticket.
  SPECIFY should make DOR-1857 the global-scope ticket and leave `adopt` where DOR-1853 has it.
- **Codex's `$skill-installer` at user scope** (SRC-09). It writes real directories into
  `~/.agents/skills`, which is a directory this feature proposes to write into — so it is named here as
  a neighbour whose files must never be touched, not as work.
- **Projecting hooks, commands or MCP servers at user scope.** Argued and refused in §5.6.
- **Any change to where the marketplace installs.** Global installs already land at
  `<dorkHome>/plugins/<name>` through the transaction in `services/marketplace/`. That is the install
  target D4's offer reuses.

---

## 2) Pre-reading Log

| Source                                                                                                                                                                     | Takeaway                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `meta/harness-sync-capabilities.md` §1.1, §3 (SRC-04/08/12), §5 (IN-08), §6 (HK-14), §10 (TR-10), §12 (J-07), §14 gap 11, §16 D1/D3/D4/D5/D6                               | The contract. §1.1's user-scope column is the seed of §5.2's table; D4 is settled; §14 ranks this gap eleventh by pain.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `plans/harness-sync-test-plan.md` §11 row 14, and line 64                                                                                                                  | The ticket's origin, and the standing property this work must change: **"P8 scope: no action's target escapes `repoRoot`; a global plugin never appears in a target path."**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `specs/harness-sync/02-specification.md` lines 217-219, 369-371                                                                                                            | The parent spec **already decided** the shape: "**Scope maps to scope:** … global installs (`~/.dork/plugins`) → the harness _global_ layers (`~/.claude`, `~/.agents/skills`, `~/.codex`). Never cross global→project." What DECOMPOSE deferred was narrower: whether a global install should _additionally_ reach a specific project.                                                                                                                                                                                                                                                                                                                                                                              |
| `specs/harness-sync/03-tasks.json` (task 2.2, DOR-173)                                                                                                                     | Its acceptance criterion already reads "a global install projects into the global layers; never cross". Only the project→project half shipped.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `specs/harness-sync-status/02-specification.md` (DOR-1852, PR #1691)                                                                                                       | Non-Goals table: "**Global scope** — `~/.dork/plugins`, `~/.claude/skills`, Claude Code's own `enabledPlugins` → **DOR-1857**". Row key `(artifact, source, name)`; `harnessAgnostic` entries render in `projectLevel[]`; drop reasons are printed **verbatim**, so any string this feature adds is user-facing copy.                                                                                                                                                                                                                                                                                                                                                                                                |
| `decisions/0303-harness-sync-multi-source-projection.md`                                                                                                                   | "projections **ephemeral/gitignored**, scope-matched (project↔project, global↔global)". The global half of an accepted ADR that was never built.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `decisions/0302-instructions-scaffolded-not-generated.md`                                                                                                                  | "scaffold per-harness pointers only … **never overwrites a hand-authored instruction file's body**". Silent on user level — which is IN-08.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `decisions/0305-per-cwd-plugin-activation-for-project-scoped-installs.md`                                                                                                  | **Stale.** Its decision — merge the global activated set with `<cwd>/.dork/plugins/*`, "deduplicated by directory basename with the project-scoped copy winning" — describes an implementation that has been removed: `messaging/plugin-activation.ts`'s module doc says SDK injection is now "reserved for DorkOS-specific runtime concerns and this transitional GLOBAL plugin path. PROJECT-scoped installs … are no longer injected here", citing ADR 260706-192819 amending ADR-0239. `decisions/manifest.json` lists that same file as 0305's only `affects`. The ADR is still `accepted` with `superseded-by: null`. Flagged in §5.8 row 8; not cited here as precedent, because the code it decided is gone. |
| `packages/harness/src/sources/installed.ts`                                                                                                                                | `scanInstalledPlugins({ dorkHome, projectRoot })`; `scanPluginsRoot` records **identity only** for `scope: 'global'` (lines 466-500), with the DOR-1518 known-gap comment explaining why the scheduler never sees a global schedule.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `packages/harness/src/engine.ts`                                                                                                                                           | `project(repoRoot, { dorkHome, allowPluginHooks })` — every read is `join(repoRoot, …)`. There is no second root.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `packages/harness/src/plan/projector.ts:678, 809-816`                                                                                                                      | Where global installs are dropped, and the exact string.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `packages/harness/src/plan/installed-projector.ts`                                                                                                                         | `planCanonicalSkillLinks`, `SCHEDULE_LINK_ATTRIBUTION`, `CANONICAL_LINK_REASON`, `dropWholePlugin`, `INSTALLED_SKILL_TARGET_DIRS`, `FRONTMATTER_KEYED_HARNESSES`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `packages/harness/src/vendor-facts/index.ts` + `coverage.ts:49-52`                                                                                                         | Every skills row already carries `readPaths.user`, dated `2026-09-07` and quoted — and **nothing reads it**: "Project scope only. `readPaths.user` is data for humans; nothing here walks a home directory."                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `packages/harness/src/inventory/{index,types,hooks}.ts`                                                                                                                    | Three separate module docs say user-scope roots are DOR-1857's, by name. `inventory/read.ts` is the failure model to copy: unreadable becomes a record, never an exception.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `apps/server/src/services/harness/project-agent-workspace.ts`                                                                                                              | The one place a non-repo `project()` already runs: `<dorkHome>/agents/<id>` as `repoRoot`, no `dorkHome` passed, **no sweep**, best-effort, claude-code only. The precedent for a second root, and for additive-only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `apps/server/src/services/harness/auto-project.ts:219-228`                                                                                                                 | A global install is a **deliberate no-op**: `if (!projectPath) return`. Nothing projects on a global install today.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `apps/server/src/services/runtimes/claude-code/messaging/plugin-activation.ts` + `claude-code-runtime.ts:565-610`                                                          | SDK injection reads `<dorkHome>/plugins` and applies to **every** session; `listEnabledPluginNames` treats every installed package as enabled ("DorkOS does not currently model plugin enable/disable state").                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `apps/server/src/services/runtimes/claude-code/claude-config-dir.ts`                                                                                                       | `resolveActiveClaudeRoot()` / `resolveClaudeRootSet()` — the only sanctioned way to find `~/.claude`. A person can have several Claude roots; that is a real question for a settings read.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `apps/server/src/services/marketplace/lib/locate-install.ts`                                                                                                               | `installRootCandidates` probes project roots **before** global: "a project install shadows a global package of the same name for that project". A global install is `install()` with no `projectPath`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `apps/server/src/services/marketplace/marketplace-source-manager.ts:55-85`                                                                                                 | DorkOS seeds **two** default marketplace sources: `dorkos-community` → `dork-labs/marketplace`, and `claude-plugins-official` → `anthropics/claude-plugins-official`. Load-bearing for §5.7.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `apps/server/src/services/tasks/skills-roots.ts`, `skills-root-discovery.ts`                                                                                               | `globalSkillsRoot(dorkHome)` = `<dorkHome>/skills`, created on boot, watched. Discovery deliberately relaxes name-must-match-dir **because Harness Sync projects `<pkg>__<name>` links**.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `apps/server/src/lib/boundary.ts`                                                                                                                                          | Default boundary root is the person's home; `validateBoundaryOrDorkHome` narrows to `<dorkHome>/agents/*`. A `DORKOS_BOUNDARY`-scoped deployment would refuse a write to `~/.agents/skills`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `research/20260705_harness-audit-opus-optimization.md` §Deferred item 1                                                                                                    | "**User-scope plugin sprawl** — ~16 plugins enabled globally (posthog alone injects ~100 skill descriptions into every session in every repo; vercel ~40). This is the single largest remaining context tax and lives in `~/.claude/settings.json`, outside the repo." Also: "Per-project disabling via `enabledPlugins: false` overrides is not confirmed to work."                                                                                                                                                                                                                                                                                                                                                 |
| `research/20260329_claude_code_plugin_marketplace_extensibility.md`                                                                                                        | The `user`/`project`/`local`/`managed` scope model and the `enabledPlugins` shape, from 2026-03.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `research/20260329_ai_coding_agent_plugin_marketplaces.md`, `20260315_slash_command_storage_formats_competitive.md`, `20260328_ai_agent_instruction_template_libraries.md` | Prior art for `~/.agents/skills` as the cross-tool user-level convention, and for `~/.codex/AGENTS.md`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

---

## 3) Codebase Map

### 3.1 The single-root engine

`project(repoRoot, opts)` is the whole entry point. Every source read is `join(repoRoot, …)`; every
action's `target` is a repo-relative POSIX string; `applyPlan` and all five sweeps resolve against
`repoRoot`. `dorkHome` enters at exactly one place — `scanInstalledPlugins` — and buys exactly one
thing: identity of the global packages, so the plan can drop them by name.

That is why the ticket calls a global plan "a design, not a widening". Anything at user scope needs a
second root and a second target vocabulary, and both are new.

### 3.2 The one non-repo root that already works

`projectAgentWorkspace` (`apps/server/src/services/harness/project-agent-workspace.ts`) already calls
`project()` with `<dorkHome>/agents/<id>` as the `repoRoot`. Four properties of that call are the
template for anything this feature builds:

- **Best-effort** — a failure never blocks boot, which also makes it survivable on Windows where
  symlink creation can fail with `EPERM`.
- **Narrow** — no `dorkHome` is passed, so global installs are not fanned into every agent home.
- **Additive** — `sweepOrphans` is off, because the pass runs unattended in a directory a person may
  also be editing by hand. "The visible cost is that a projection this pass made is never withdrawn by
  it."
- **Claude-code only** — because enabling another harness would turn an unattended pass into a writer
  of shell commands.

Every one of those reasons applies with more force in a person's home directory.

### 3.3 Where a global install goes today

| Path                                                                  | What happens                                                                                                                                                              |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dorkos harness sync` in a repo                                       | `scanInstalledPlugins` returns the package with `skills: []`, `commands: []`, no `hooks`. The projector filters `scope === 'global'` and emits **one** `dropWholePlugin`. |
| A global marketplace install                                          | `runAutoProjection` returns immediately (`if (!projectPath)`). No projection, no report.                                                                                  |
| A DorkOS-driven Claude Code session                                   | `refreshActivatedPlugins` builds `{ type: 'local', path }` entries from `<dorkHome>/plugins` and passes them to the SDK for **every** session, in every project.          |
| A bare `claude`, `codex`, `opencode`, `cursor`, `gemini` or `copilot` | Nothing. The package does not exist for them.                                                                                                                             |

### 3.4 What already knows about user scope, and is unread

- `HARNESS_VENDOR_FACTS[*].skills.readPaths.user` — six rows, dated, quoted, cited. `harnessCoverage()`
  walks `readPaths.project` only.
- `inventory/` — three module docs name `~/.claude/settings.json` and `~/.claude/skills` as DOR-1857's.
- `HK-14` — `~/.claude/settings.json` hooks are a documented Claude Code source that DorkOS has never
  read. Same file as `enabledPlugins`.

### 3.5 Blast radius, named

Anything that writes at user scope touches directories shared with the person, with other tools, and
with no `git status` to show what changed. On the machine this was measured on:

```
~/.claude/skills   → composio-cli, find-skills   (real directories, hand-authored)
~/.agents/skills   → composio-cli, find-skills   (real directories, hand-authored)
~/.dork/plugins    → does not exist
~/.dork/skills     → templates                   (created on boot, `globalSkillsRoot`)
```

Both candidate target directories already exist and already hold a person's own files, under the same
two names in both places. `~/.agents/skills` is also where Codex's `$skill-installer` writes (SRC-09).
This is the HK-11 shape — the engine owning a path by path alone — moved somewhere strictly less
recoverable.

---

## 4) Root Cause Analysis

Omitted — this is a feature, not a bug fix. Section numbering follows the `/flow` ideation template, so
the number is kept and the section is empty rather than renumbering every cross-reference below.

## 5) Research

### 5.1 What a global install does today, measured

**Fixture.** A scratch `DORK_HOME` with one global package, and a repo with one authored skill and one
project package, run against the built engine (`packages/harness/dist`) at `dc03b4b16`:

```
dorkhome/plugins/globex/.dork/manifest.json      (type: plugin, layers: skills, commands, hooks)
dorkhome/plugins/globex/skills/greet/SKILL.md
dorkhome/plugins/globex/skills/nightly/SKILL.md  (declares `schedule: cron "0 3 * * *"`)
dorkhome/plugins/globex/commands/hi.md
dorkhome/plugins/globex/hooks/hooks.json         (Stop → echo from-global-plugin)
repo/.agents/harness.manifest.json               (all six harnesses enabled)
repo/.agents/skills/authored-one/SKILL.md
repo/.dork/plugins/localpkg/skills/localskill/SKILL.md
```

**`scanInstalledPlugins({ dorkHome, projectRoot })` returns, for the global package:**

```json
{
  "name": "globex",
  "type": "plugin",
  "scope": "global",
  "skills": [],
  "commands": [],
  "layers": ["skills", "commands", "hooks"]
}
```

Two skills, one command and one hooks file on disk; four empty fields in the scan. The scanner cannot
name what it is dropping because it never looked.

**The plan, in full, for that package — one line:**

```
- [codex | agnostic] plugin "globex" — global-scope install; a project sync does not project
  global plugins (run a global sync)
```

**What a person sees** (`formatDropList`, the same renderer the CLI and the Skills page both use):

```
Dropped artifacts (no home in the target harness):

plugin layers:
  - plugin "globex": global-scope install; a project sync does not project global plugins (run a global sync)
```

Four things are wrong with that eighty-eight-character sentence, and each is its own defect:

1. **It names a command that does not exist.** There is no global sync. `dorkos harness --help` lists
   `sync` and `hooks`, and `sync` takes `--check`, `--fix`, `--harness`, `--strict`, `--allow-hooks`.
   Nothing accepts a scope.
2. **It says "a project sync does not project global plugins" as if something else would.** Nothing
   does. `runAutoProjection` is a no-op for a global install; no boot pass, no trigger, no route.
3. **It cannot say what was lost.** `greet`, `nightly` and `/hi` are never named, because the scan
   returned identity only. A person is told a package did not travel, not that two skills and a slash
   command did not.
4. **It is filed under `codex`** in the raw action (`DROP_ATTRIBUTION`), rescued only by
   `harnessAgnostic: true` moving it under the `plugin layers:` heading. Correct today; worth knowing
   that the heading, not the harness field, is what makes it honest.

**The scheduled skill is worse than dropped — it is silent.** `nightly` declares a `schedule:`. At
project scope `planCanonicalSkillLinks` would link it into `.agents/skills`, which is the one root the
scheduler watches. At global scope there is no line at all: not an action, not a drop, not a warning.
`<dorkHome>/skills` stayed empty through the run. A person who installs a scheduled skill globally gets
a schedule that does not exist and no sentence anywhere saying so.

**The comment that describes the CLI is aspirational.** `packages/cli/src/harness-sync-command.ts:527`
reads "resolved dork home additionally projects global-scope installs." It does not; it makes them
droppable by name.

### 5.2 What "global scope" would mean, per harness — the core artifact

Two tables. The first is **skills**, which is what this feature would actually project. The second is
every other kind, which is what it would deliberately not.

Verification states are the discipline of `packages/harness/src/vendor-facts/index.ts`:
**`verified`** = the vendor's own page states the path; **`unknown`** = the page is silent (never
inferred from the project-scope path); **`none`** = the vendor documents that there is no user-level
location. Every `verified` cell carries its URL and the date it was read.

#### 5.2.1 Skills at user scope

| Harness     | User-scope skills read paths                                                                                         | Reads `~/.agents/skills`? | State                 | Source (fetched)                                                                                                                                                                                                                      |
| ----------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code | `~/.claude/skills/<name>/SKILL.md`                                                                                   | **unknown** (see below)   | verified for the path | [code.claude.com/docs/en/skills](https://code.claude.com/docs/en/skills) — 2026-09-08 (re-read; matches the repo's 2026-09-07 row)                                                                                                    |
| Codex       | `$HOME/.agents/skills` (the page's `USER` scope; `/etc/codex/skills` is its separate `ADMIN` scope, not a user path) | **yes**                   | verified              | [learn.chatgpt.com/docs/build-skills](https://learn.chatgpt.com/docs/build-skills) — 2026-09-08                                                                                                                                       |
| OpenCode    | `~/.config/opencode/skills/*/SKILL.md`, `~/.claude/skills/*/SKILL.md`, `~/.agents/skills/*/SKILL.md`                 | **yes**                   | verified              | [opencode.ai/docs/skills](https://opencode.ai/docs/skills/) — 2026-09-08, quoted: "Global definitions are also loaded from `~/.config/opencode/skills/*/SKILL.md`, `~/.claude/skills/*/SKILL.md`, and `~/.agents/skills/*/SKILL.md`." |
| Cursor      | `~/.agents/skills/`, `~/.cursor/skills/`, plus compatibility `~/.claude/skills/`, `~/.codex/skills/`                 | **yes**                   | verified              | [cursor.com/docs/skills](https://cursor.com/docs/skills) — 2026-09-08                                                                                                                                                                 |
| Gemini CLI  | `~/.gemini/skills/`, `~/.agents/skills/` (the alias **outranks** `.gemini/skills` within a tier)                     | **yes**                   | verified              | [google-gemini/gemini-cli `docs/cli/skills.md`](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/skills.md) — 2026-09-08 (the vendor repo; `geminicli.com` mirrors it verbatim)                                         |
| Copilot     | `~/.copilot/skills`, `~/.agents/skills`                                                                              | **yes**                   | verified              | [docs.github.com … cli-config-dir-reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-config-dir-reference) — 2026-09-08 (the CLI's own directory table; the `add-skills` page is cloud-agent scoped)   |

**The user-level picture is the project-level picture, near enough.** Five of six harnesses read one
shared canonical directory — `~/.agents/skills` — and Claude Code is the only one that does not name
it, reading `~/.claude/skills` instead. That is the same single fact the whole skills half of the
engine is built on, one directory up.

**One honest weakening.** "Claude Code does not read `~/.agents/skills`" is an argument from silence:
its skills page lists four locations and `~/.agents/skills` is not among them, but the page never says
it is _not_ read. The repo's own table records the project-scope twin as a flat `no`, which is the
same inference. So the cell above says `unknown`, and the design says **at least two** targets rather
than exactly two. It survives either way: if Claude Code turns out to read `~/.agents/skills`, the
`~/.claude/skills` link becomes redundant rather than wrong, and the plan drops one action. Confirming
it is experiment 2's cheapest half.

So global-scope skill projection is **two target directories at most** — one certainly needed, one
needed unless experiment 2 says otherwise:

```
~/.agents/skills/<pkg>__<name>   →  <dorkHome>/plugins/<pkg>/skills/<name>     (codex, opencode, cursor, gemini, copilot)
~/.claude/skills/<pkg>__<name>   →  <dorkHome>/plugins/<pkg>/skills/<name>     (claude-code)
```

**And one precedence fact that changes the design.** From
[Claude Code's skills page](https://code.claude.com/docs/en/skills) (2026-09-08), which states it as a
lead-in and two nested list items:

> When skills share the same name, Claude Code resolves the conflict by source:
>
> - Across levels, enterprise overrides personal, and personal overrides project.
>   - For example, with a `deploy` skill in both `~/.claude/skills/` and your project's
>     `.claude/skills/`, `/deploy` runs the personal one.

**Personal wins.** That is the opposite of the precedence DorkOS applies internally —
`installRootCandidates` probes project roots first, "so a project install shadows a global package of
the same name for that project" — and the opposite of what Gemini CLI does for commands ("If a command
in the project directory has the same name as a command in the user directory, the project command
will always be used", [custom-commands](https://geminicli.com/docs/cli/custom-commands/), 2026-09-08).
§5.4 is where that lands.

#### 5.2.2 Every other kind at user scope

Recorded so the drops in §5.6 are honest ones, not gaps we forgot to look at. All fetched 2026-09-08.

| Kind            | Claude Code                                                                                                                                                                                     | Codex                                                                                                                                                                                                                                                                                     | OpenCode                                                                                                          | Cursor                                                                                                                                                                              | Gemini CLI                                                                         | Copilot                                                                                                                                                    |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Instructions    | `~/.claude/CLAUDE.md` (+ `~/.claude/rules/*.md`) — verified                                                                                                                                     | `~/.codex/AGENTS.override.md`, else `~/.codex/AGENTS.md` — verified                                                                                                                                                                                                                       | `~/.config/opencode/AGENTS.md`, falling back to `~/.claude/CLAUDE.md` — verified                                  | `~/.cursor/rules` — verified: "User rule files in `~/.cursor/rules` … stay on the machine and do not sync"; a second, account-synced set lives in Cursor Settings and is not a file | `~/.gemini/GEMINI.md` — verified                                                   | `~/.copilot/copilot-instructions.md`, `~/.copilot/instructions/**/*.instructions.md` — verified                                                            |
| Hooks           | `~/.claude/settings.json` (`hooks` key) — verified; **none** for a separate `~/.claude/hooks.json`                                                                                              | `~/.codex/hooks.json`, `[hooks]` in `~/.codex/config.toml` — verified                                                                                                                                                                                                                     | **unknown** — the docs have no hooks page (404 on 2026-09-08); plugins are the documented event mechanism         | `~/.cursor/hooks.json` — verified                                                                                                                                                   | `~/.gemini/settings.json` (`hooks`) — verified                                     | `~/.copilot/hooks/*.json` — verified                                                                                                                       |
| Commands        | `~/.claude/commands/*.md` — verified (docs steer new work to skills)                                                                                                                            | `~/.codex/prompts/*.md`, top level only — verified, **deprecated** in favour of skills                                                                                                                                                                                                    | `~/.config/opencode/commands/` — verified                                                                         | **unknown** — the vendor index (`cursor.com/docs/llms.txt`) lists no custom-commands page, and `cli/reference/slash-commands` documents built-ins only                              | `~/.gemini/commands/` — verified                                                   | **unknown** — the `~/.copilot` directory reference lists no prompts or commands entry                                                                      |
| Subagents       | `~/.claude/agents/` — verified; **project wins** here, the reverse of skills                                                                                                                    | `~/.codex/agents/` (TOML) — verified                                                                                                                                                                                                                                                      | `~/.config/opencode/agents/` — verified                                                                           | `~/.cursor/agents/` (+ `~/.claude/agents/`, `~/.codex/agents/`) — verified                                                                                                          | `~/.gemini/agents/*.md` — verified                                                 | `~/.copilot/agents/` — verified                                                                                                                            |
| Plugins (whole) | cache `~/.claude/plugins/cache`, registry `~/.claude/plugins/known_marketplaces.json`, data `~/.claude/plugins/data/{id}/`; enablement `enabledPlugins` in `~/.claude/settings.json` — verified | cache `~/.codex/plugins/cache/$MARKETPLACE/$PLUGIN/$VERSION/`, personal marketplace `~/.agents/plugins/marketplace.json` — verified; on/off state is in `~/.codex/config.toml`, but only the `plugins.<name>.mcp_servers.<server>` shape is documented, so the general key is **unknown** | `~/.config/opencode/plugins/` — verified; enablement via the `plugin` array in `~/.config/opencode/opencode.json` | local-testing path `~/.cursor/plugins/local/<name>` — verified; **unknown** for the normal install location and for how enablement is recorded                                      | `<home>/.gemini/extensions` — verified; **unknown** for how enable state is stored | `~/.copilot/extensions/`, `~/.copilot/installed-plugins/` — verified; enablement recorded in `~/.copilot/config.json`, documented as automatically managed |

Three cells are `unknown` outright (OpenCode hooks, Cursor commands, Copilot commands), three more are
verified for a path but `unknown` for how enablement is recorded (Codex, Cursor, Gemini plugins), and
one is a documented `none` (there is no separate `~/.claude/hooks.json`). Those are honest drops, not
gaps to invent — and all three outright unknowns sit in kinds §5.6 refuses anyway. Sources beyond
those already cited, all fetched 2026-09-08:
[cursor.com/help/customization/rules](https://cursor.com/help/customization/rules),
[cursor.com/docs/llms.txt](https://cursor.com/docs/llms.txt) →
[cli/reference/slash-commands](https://cursor.com/docs/cli/reference/slash-commands),
[developers.openai.com/plugins/build/plugins](https://developers.openai.com/plugins/build/plugins).

**One correction to carry back to the contract.** `meta/harness-sync-capabilities.md` §1.1 lists
Codex's user scope as `~/.agents/skills`, `/etc/codex/skills`, bundled — and the vendor page names
`$REPO_ROOT/.agents/skills` alongside `$CWD/../.agents/skills`, which the contract's "cwd, then every
ancestor up to the repo root" already covers. No change needed there. The cell that **is** worth a
re-read on the H tier is Cursor's `~/.claude/skills` compatibility path, because it means a
`~/.claude/skills/<pkg>__<name>` link written for Claude Code is reachable twice for Cursor and
OpenCode — the user-level twin of SK-09/SK-12, with the same unverified `pkg__name` name rule.

### 5.3 Options

Weighed against D1 (first contact safe, honest, re-runnable), D5 (ask vs do), HK-11 (blast radius),
AP-07 (sweep scoped to what the engine owns and to enabled harnesses), and the two operator
constraints: `os.homedir()` banned outside the carve-outs, `dorkHome` as the one data directory.

#### Option A — a global plan with its own root, targeting each harness's user directory

`buildGlobalPlan(dorkHome)` produces actions whose targets are absolute user-level paths, applied by a
second apply pass.

- **Reach:** all six harnesses, in every project, for a bare CLI as well as a DorkOS session. This is
  what a person means by "install it globally".
- **It is what the spec already decided.** `specs/harness-sync/02-specification.md` line 218 and
  DOR-173's own acceptance criterion.
- **Blast radius, stated plainly.** Two directories in a person's home, both of which already exist
  and hold hand-authored skills on the machine measured (§3.5), one of which is also written by
  another vendor's installer (SRC-09). No `git status`, no review, and — if the pass ever runs
  unattended — no reader.
- **Ownership proof required, and it is NEW work.** What exists today is a **two-clause** predicate —
  a candidate is swept only if it is a **symlink** and its basename contains `__`
  (`packages/harness/src/__tests__/installed-integration.test.ts:420`, which stages a hand-authored
  real directory called `my__helper` beside an orphaned managed symlink and asserts only the symlink
  goes). That is sufficient in a repo, where every symlink in `.agents/skills` was put there by the
  engine. It is **not** sufficient in a home directory, and this machine proves it:
  `~/.claude/skills/composio-cli` and `~/.claude/skills/find-skills` are _relative symlinks into
  `~/.agents/skills/`_ — a person has hand-built, by hand, the exact projection Option A proposes to
  automate. Under the two-clause predicate only the absence of `__` in their names stands between them
  and the sweep. So A needs a **three-clause** predicate, stated here as new work rather than reused:
  **symlink AND `__` in the basename AND the link target resolves inside `<dorkHome>/plugins`.** The
  third clause is the one that makes the predicate about DorkOS rather than about a naming habit.
  For anything **generated** no predicate exists at all — that is HK-11, order-of-work row 1, and §5.6
  is why this option never generates at user scope.
- **Two of the five may refuse the name, and that is likelier than it sounds.** OpenCode documents a
  skill `name` of 1–64 lowercase alphanumerics with single hyphens that **must match the directory**;
  Cursor documents lowercase/digits/hyphens that **must match the folder**. `<pkg>__<name>` breaks
  both rules twice over — underscores are outside the charset, and the frontmatter `name` is
  `<name>`, which cannot match a `<pkg>__<name>` folder. That is SK-09/SK-12 at project scope,
  unchanged at user scope, and it is why experiment 1 is a real risk rather than a formality. If
  OpenCode and Cursor both refuse, A still delivers Codex, Gemini and Copilot through
  `~/.agents/skills` plus Claude Code through `~/.claude/skills` — four of six — and the fix is a
  naming change (a per-package subdirectory, or the frontmatter rewritten on projection) that is its
  own decision and does not belong in this ideation.
- **It changes a standing property.** Test-plan line 64: "no action's target escapes `repoRoot`; a
  global plugin never appears in a target path." That property must be re-scoped to "no action in a
  **project** plan escapes `repoRoot`", with a sibling property for the global plan. A property that
  is relaxed rather than replaced is how this kind of work goes wrong.
- **It has a deployment hole.** `initBoundary`'s default root is the person's home, so an ordinary
  install is fine; a `DORKOS_BOUNDARY`-scoped deployment (Docker) would refuse the write, and
  `validateBoundaryOrDorkHome` narrows to `<dorkHome>/agents/*`, not to `~`. The global pass needs an
  explicit answer — most likely: it is a CLI and boot capability, not an HTTP one, and it is skipped
  with a reported reason when a boundary is configured.

#### Option B — do less: global stays SDK injection for Claude Code, and the drop becomes honest

No new targets. `scanPluginsRoot` learns to enumerate a global package's assets, the drop becomes one
line per artifact naming what did not travel, and the report surfaces it.

**It is not free, and the cost is a type change.** `InstalledPlugin.relDir` is documented as the
"repo-relative install directory … Present only for project-scoped plugins, so their on-disk paths are
not resolved" (`sources/installed.ts:116-120`), and every skill it carries has a repo-relative
`sourceDir`. A global package has no repo, so B either gives `InstalledPlugin` a second, absolute
locator alongside `relDir` or makes the field a discriminated pair (`{ scope: 'project'; relDir }` /
`{ scope: 'global'; absDir }`). The second is better — it makes the compiler name every site that
assumed repo-relative — and it is the same shape change A needs for its targets, which is another
reason B goes first. Note also that `unreadableHooks` is documented as "absent means the file was
never read (a global install)", so enumerating a global package's hooks changes what absence means;
B has to keep that distinction or drop the field's contract deliberately.

- **Reach:** unchanged. Nothing new works.
- **Cost:** the smallest of the four, but not zero — the `InstalledPlugin` shape change above is real
  work, and it is work A needs anyway.
- **What it buys:** the four defects in §5.1 become three, then zero. A person is told `greet`,
  `nightly` and `/hi` exist and reach no other agent, and is told the one thing that _is_ true today —
  install it in a project and every harness gets it.
- **What it does not buy:** the thing the ticket is about.

#### Option C — fan out: project a global install into every registered project and agent workspace

Reuse `projectAgentWorkspace`'s shape, extended to every registered project on its next sync.

- **Reach:** every harness, but only in directories DorkOS knows about, and only after a sync there.
- **No writes outside repos**, which is the whole appeal.
- **It contradicts an accepted ADR.** ADR-0303: "scope-matched (project↔project, global↔global)".
  Parent spec: "Never cross global→project."
- **N copies.** One package becomes N symlink sets that drift as projects are added, and a global
  uninstall has to reach all of them or leave orphans that only a later sync sweeps.
- **It creates the SRC-12 collision on purpose**, in the one place §5.4 shows it is worst: inside a
  single project's `.agents/skills`, where a project install of the same name already writes
  `<pkg>__<name>`. Two sources, one target path.
- **It puts a global package's assets into a repo a teammate clones.** The projections are gitignored,
  so what a teammate gets is a working tree that behaves differently from theirs for reasons nothing
  in the repo explains.

#### Option D — the dork-home-only global plan

`<dorkHome>` is the root and the **only** targets are inside it: `<dorkHome>/skills/<pkg>__<name>`.

- **Reach:** no harness. `<dorkHome>/skills` is not on any vendor's read path.
- **But it closes SK-03's global half exactly** — that directory is `globalSkillsRoot(dorkHome)`,
  created on boot and watched by the scheduler, and `skills-root-discovery` already relaxes its
  name-must-match-dir rule _because Harness Sync projects `<pkg>__<name>` links_. A scheduled skill in
  a global package starts running.
- **Zero writes outside DorkOS's own data directory.** No home-directory sweep, no `os.homedir()`, no
  boundary question, no other tool's files.
- It is a proper subset of A's machinery: the same second root, the same target vocabulary, one target
  directory instead of two — and the one directory DorkOS already owns.

#### Recommendation

**Option A, narrowed to skills, entered in the order B → D → A, and never generating a file at user
scope.**

The reason is that A is the only option that does what the words "installed globally" promise, and the
per-harness table makes it far smaller than it looked: not six user directories, but **at most two** —
one canonical directory five harnesses already read, and one symlink for Claude Code. That is the same
shape the engine has proven at project scope for months, one directory up. It is not free, though, and
two of its costs are the ones that decide the slicing: the ownership predicate needs a third clause it
does not have (the two-clause one is not safe in a home directory where a person's own symlinks live),
and two of the five harnesses document a name rule `<pkg>__<name>` breaks.

B and D are not alternatives to A; they are the first two slices of it, and each is independently
shippable and independently useful:

- **B first**, because D1 says first contact must be honest before it is capable, and because the
  current sentence names a command that does not exist. It is also a prerequisite: A cannot project
  what the scanner does not enumerate.
- **D second**, because it is A's engine — a second root, a target vocabulary, an apply that does not
  resolve against `repoRoot` — proved inside `<dorkHome>`, where a bug costs a symlink in DorkOS's own
  directory rather than a file in someone's home. And it independently makes a global scheduled skill
  run.
- **A last**, gated on the H tier (DOR-1856) answering whether those five harnesses really do load
  `~/.agents/skills`, and asked for rather than assumed (D5: this changes what every future session in
  every project reads, which is exactly the "not harmless" category D5 reserves for line-by-line
  reporting; a first global projection should be a one-time explicit yes, remembered).

C is rejected: it contradicts an accepted ADR, multiplies the artifact, and manufactures the one
collision §5.4 wants to avoid. The one part of C worth keeping is the _option_, later, for a person to
say "also put my global packages in this project" — which is precisely the narrow question the parent
spec left open for DECOMPOSE, and it should stay closed until A exists.

**What the recommendation does not solve:**

- **Instructions at user level (IN-08).** Refused, with a reason, in §5.6 — this feature makes IN-08 an
  explicit "named as out of scope", which is one of the two outcomes its own row allows.
- **Hooks, commands and MCP servers at user level.** Refused in §5.6.
- **Claude Code's own `/plugin` installs (SRC-08 / J-07).** Separate work; §5.7, and §7 recommends a
  split.
- **Codex's `$skill-installer` at user scope (SRC-09).** Still unread; A only makes the shared
  directory more crowded.
- **A transitional double, which A creates and must retire.** Global packages are SDK-injected into
  **every** DorkOS-driven Claude Code session unconditionally (`plugins: this.activatedPlugins`,
  `claude-code-runtime.ts:448`; the set is built from `<dorkHome>/plugins` with no scope filter and
  "every installed plugin is treated as enabled", `installed-scanner.ts`). The moment A writes
  `~/.claude/skills/<pkg>__<name>`, a DorkOS-driven session sees the same package twice — once as an
  SDK plugin, once as a personal skill. Claude Code documents loading a shared target once by
  realpath, and the two are not the same path, so a duplicate is the likely outcome rather than a
  guaranteed one. The resolution is the one ADR 260706-192819 already chose for project scope: once
  harness-native projection covers a scope, SDK injection for that scope is retired. A's last slice
  therefore ends by deleting the injection path, not by leaving both on — and until it does, the
  overlap is a named, temporary state, not a surprise.
- **Reload.** Claude Code needs a restart for a skills directory created after the session started
  (§1.1 of the contract); Gemini needs `/skills reload`. A first global projection will not appear in a
  running session, and the report has to say so.
- **Uninstall symmetry.** A global uninstall must sweep the user-level links. That is A's sweep, in a
  home directory, and it is the single riskiest line of code in this feature.

### 5.4 SRC-12 — the same package at both scopes

**Reproduced.** `globex@1.0.0` at global scope, `globex@2.0.0` at project scope, same fixture:

```
scanInstalledPlugins → [ { name: "globex", scope: "global",  skills: [] },
                         { name: "globex", scope: "project", skills: [greet], relDir: ".dork/plugins/globex" } ]
plan.actions          → symlink claude-code skill "globex__greet" -> .claude/skills/globex__greet
                        symlink codex       skill "globex__greet" -> .agents/skills/globex__greet
plan.drops            → plugin "globex": global-scope install; … (run a global sync)
plan.warnings         → (none)
```

Two entries with the same `name`, two different versions, and not one line anywhere says they are the
same package.

**The collision is not what the ticket says it is, and the difference matters.**

The ticket reads "A plugin at both scopes collides on `<pkg>__` the day this lands". Measured against
the target vocabulary, the two projections land in **different directories**:

```
project copy → <repo>/.agents/skills/globex__greet   and  <repo>/.claude/skills/globex__greet
global copy  → ~/.agents/skills/globex__greet        and  ~/.claude/skills/globex__greet
```

Nothing overwrites anything. No sweep deletes the other's file. What collides is **what the harness
sees when it merges its user tier over its project tier** — and each harness resolves that its own way,
which is the actual finding:

| Harness                   | What happens with `globex__greet` in both tiers                                                                                                                                                | State                       |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| Claude Code               | **The personal (global) one wins.** "personal overrides project" — verbatim, [skills docs](https://code.claude.com/docs/en/skills), 2026-09-08                                                 | verified                    |
| Codex                     | **Both appear.** "If two skills share the same `name`, Codex doesn't merge them; both can appear in skill selectors" — [build-skills](https://learn.chatgpt.com/docs/build-skills), 2026-09-08 | verified                    |
| Gemini CLI                | Workspace beats user for skills; for commands, "the project command will always be used"                                                                                                       | verified for the tier order |
| OpenCode, Cursor, Copilot | No user-vs-project precedence stated for skills                                                                                                                                                | **unknown**                 |

So the failure a person meets is: they install v2 into their project, and in Claude Code they get v1 —
because their personal copy silently outranks it. In Codex they get two skills with the same name. In
three harnesses nobody documented what happens.

**Proposed rule: DorkOS resolves nothing, and says so.** Three parts.

1. **Never refuse the install and never delete a copy.** Both scopes are legitimate; a person who
   installed at both meant something by it, and a package manager that removes an install to tidy a
   name is a package manager nobody trusts.
2. **Never invent a DorkOS-side precedence.** It would be unenforceable — the projection is a symlink
   in a directory the harness reads on its own terms, and a `drop` line has no power over that
   (position D3's own argument, applied one directory up). It would also be wrong for at least two
   harnesses whichever way it pointed, since Claude Code and Gemini disagree.
   _Explicitly not adopted, and here is why the tempting answer is wrong:_ "newer version wins" cannot
   be implemented at all today — `InstalledPlugin` carries `name`, `type`, `scope`, `relDir`, `skills`,
   `commands`, `hooks`, `layers`, and **no `version`**. Adopting it means adding `version` to the
   scanner and then still choosing for the harness, which part 2 says not to do.
3. **Report it once, at package level, with the per-harness consequence.** One harness-agnostic entry —
   a fact about the package, not about a harness — carrying both scopes and (once the scanner grows
   it) both versions, plus the one sentence a person can act on. Draft copy:

   > **globex is installed twice** — globally (1.0.0) and in this project (2.0.0). Claude Code uses
   > your global copy, even here. Codex shows both. Uninstall one if you only meant to have one.

   The action is **`dorkos uninstall globex`** — with `--project <path>` for the project copy, without
   it for the global one (`packages/cli/src/cli.ts:189`). Not `dorkos marketplace uninstall`, which
   does not exist: `dorkos marketplace <sub>` manages marketplace **sources** only
   (`add|remove|list|refresh|validate`, `cli.ts:262`). The two copies are already addressable
   separately because `installRootCandidates` probes project roots first. Two things the copy must
   say and this draft does not yet: `dorkos uninstall` talks to a **running DorkOS server**, and it
   asks for a person's approval first — it answers with an approval id and a token that you pass back
   as `--approval` (`cli.ts:200-208`). SPECIFY writes the sentence that carries both.

**A second consequence, which is A's and not today's.** Cursor and OpenCode read **both**
`~/.agents/skills` and `~/.claude/skills` at user scope (§5.2.1). So the moment A writes both targets,
those two harnesses see the same global skill twice — the user-level twin of the project-scope fact
the contract already records ("an installed skill linked into both dirs is reachable twice there").
Claude Code documents loading a shared target once, by realpath; OpenCode keyed on the frontmatter
`name` at the 2026-07 source check, which would collapse the pair; Cursor is unverified. This is not a
reason to skip either target — Claude Code needs the second and the other five need the first — but it
is a reason the `~/.claude/skills` link should be planned **only** when Claude Code is an enabled
harness, exactly as `INSTALLED_SKILL_TARGET_DIRS` already gates the project-scope twin.

**This notice is buildable today, so it belongs to the B slice.** Nothing in it needs A's second root:
`scanInstalledPlugins({ dorkHome, projectRoot })` already returns both scopes on every project sync
(§5.1 reproduced it), so the both-scopes fact is available at the exact moment the drop is printed.
Only the per-harness sentence about what happens _after_ A projects both is future tense, and it can
be written as such.

**How the status model shows it.** The entry carries `harnessAgnostic: true`, so by DOR-1852 §1.3 it
lands in `projectLevel[]` and renders once under "Project-level notices" — the same heading the CLI
calls `plugin layers:`. It never becomes a cell and never a row, which is right: it is not about one
harness, and the harnesses disagree. The per-harness sentence lives inside the notice's text, not in a
chip, precisely because three of the six harnesses are `unknown` and a chip cannot say "unknown"
honestly.

**A note for whoever builds it:** adding `version` to `InstalledPlugin` is worth doing anyway, for the
notice's text and for the update flow, but the rule above must not come to depend on it. A notice that
can only be raised when both versions are readable is a notice that goes missing on a malformed
manifest.

### 5.5 SK-03's global half — the scheduler

**The gap, in one sentence from the code that owns it** (`sources/installed.ts:477-486`):

> KNOWN GAP (DOR-1518): this is also why a schedule-bearing skill in a GLOBALLY installed plugin
> (`<dorkHome>/plugins/<pkg>`) stays invisible to the scheduler. The scheduler's global watched root is
> `<dorkHome>/skills`, and no projection stage targets it — `buildPlan` is repo-relative end to end …
> The project-scope fix below (`planCanonicalSkillLinks`) therefore has no global twin; giving it one
> means building a global sync first, not widening this scan.

**The global equivalent is exact, and the receiving machinery is already built.**

At project scope, `planCanonicalSkillLinks` links every installed skill into `.agents/skills/<pkg>__<name>`
unconditionally, carrying `SCHEDULE_LINK_REASON` when the skill declares a schedule and
`CANONICAL_LINK_REASON` otherwise, attributed to `SCHEDULE_LINK_ATTRIBUTION` (`'codex'`, a placeholder
the module documents as such). The scheduler then finds it, because:

- `globalSkillsRoot(dorkHome)` is `<dorkHome>/skills`, `ensureGlobalSkillsRoot` creates it on boot, and
  `globalTaskRoots` returns it as a watched root with `scope: 'global'`.
- `skills-root-discovery` **already expects `<pkg>__<name>` links**: it relaxes `parseSkillFile`'s
  name-must-match-directory default explicitly because "Harness Sync projects an installed plugin's
  skill into `.agents/skills/` under a NAMESPACED link — `flow__drain` pointing at a directory whose
  SKILL.md says `name: drain`". Under the default "every projected plugin skill parsed as invalid …
  the entire symlink path below was unreachable in production (DOR-1485 review, N2)".
- A schedule's identity is its **resolved real path** (`schedule-identity.ts`), and `resolveRootPath`
  realpaths the root, so a symlinked target produces one row, not two.

So the global twin is one link set:

```
<dorkHome>/skills/<pkg>__<name>  →  <dorkHome>/plugins/<pkg>/skills/<name>
```

and everything downstream of it already works and already has tests.

**Does it belong in this feature?** Yes — as its **own slice**, the first one that writes anything, and
separable into its own ticket if global scope stalls. The argument each way:

- **For keeping it here:** it needs the same second root and the same non-`repoRoot` apply that Option
  A needs. Building it separately would build A's engine twice.
- **For separating it:** it needs no harness knowledge at all. It reads no vendor page, writes nothing
  outside `<dorkHome>`, touches no file a person authored, and delivers a complete user-visible
  outcome on its own — a scheduled skill in a global package runs. It is the safest possible first
  exercise of the machinery every later slice depends on.

That is Option D, and it is why the recommendation puts it second: it is the de-risking slice, and it
is the one piece of this feature that could ship without a single vendor fact being right.

### 5.6 IN-08 (and HK-14) — user-level instructions and hooks

**IN-08's own row allows two outcomes**: user-level instructions "are either projected at global scope
or named as out of scope". This document names them **out of scope**, and asks that the contract row be
updated to say so rather than left at "not built, unstated".

**Does ADR-0302 hold at user level?** ADR-0302 says instructions are "hand-authored and canonical" and
the projector "scaffold[s] per-harness pointers only … never overwrites a hand-authored instruction
file's body". Its whole mechanism rests on one thing being true: **there is a canonical source**.
`AGENTS.md` at the repo root is that source, and `CLAUDE.md = @../AGENTS.md` is a pointer to it.

At user level there is no canonical source, and DorkOS cannot manufacture one.

- There is no `~/.agents/AGENTS.md` convention. The cross-vendor convergence at user scope is on the
  skills directory `~/.agents/skills` — verified for five harnesses in §5.2.1 — and on nothing else.
  Inventing `~/.agents/AGENTS.md` would be DorkOS asserting a standard that does not exist, in a
  directory another vendor's installer also writes to.
- `~/.claude/CLAUDE.md` and `~/.codex/AGENTS.md` are not two views of one thing. They are two files a
  person wrote for two different tools, each already loaded by its own tool. Neither is upstream of the
  other, and picking one as the source would silently change what every session of the other tool reads
  — in every project on the machine, with no `git status` and no undo.
- The scaffolded-pointer trick does not transfer either. `CLAUDE.md = @../AGENTS.md` works because both
  files are in one repo and `@` is a relative import. A pointer from `~/.codex/AGENTS.md` to
  `~/.claude/CLAUDE.md` would be Codex reading a file written for another vendor's tool, and Codex
  documents no import syntax to make it a pointer rather than a copy.
- The vendor-facts table has **no `instructions` rows at all** (only skills, plus Codex's hooks), so a
  user-level instruction claim has no citation the repo would accept until somebody adds the rows.
- And the six user-level instruction files are not even the same **kind** of thing. Five are files a
  person edits; Cursor's user rules are two things at once — `~/.cursor/rules` on the machine, plus a
  second, account-synced set that lives in Cursor's own settings and is not a file at all
  ([cursor.com/help/customization/rules](https://cursor.com/help/customization/rules), 2026-09-08).
  A projection that writes the file half would be silently overridden or duplicated by the half it
  cannot see. There is no honest target here.

So: **out of scope, with the reason stated in the contract**, and the drop that already exists at
project scope ("no AGENTS.md — nothing to read or point at") stays the model — a drop with an honest
reason is a finished answer, not a gap.

**HK-14's user half is different, and is worth one narrow thing: read it, report it, never write it.**

`~/.claude/settings.json` is the third file Claude Code merges hooks from, and DorkOS has never read it
(`inventory/hooks.ts` says so and names this ticket). It is also, exactly, the file §5.7 has to open
for `enabledPlugins`. One read, two answers:

- **Report:** "You have N hooks in your personal Claude Code settings. Only Claude Code runs them." A
  person with a machine-wide `PreToolUse` hook currently gets no sentence about it from any DorkOS
  surface.
- **Never generate from them.** Projecting a person's private, machine-wide shell commands into
  `.codex/hooks.json` inside a repo would put them in a file a teammate clones, and would do it under
  the HK-11 ownership scheme that does not exist yet. D5's rule ("ask once per exact content per
  project for anything that runs unattended") is the floor, and even with a card this is the wrong
  direction: the commands are the person's, the file is the team's.
- **Never inventory them as the project's.** `inventory/hooks.ts` already states the reason: "A source
  inventory of a repository that reached into a home directory would report one machine's private hooks
  as if they were the project's." So this read is a **global**-scope inventory entry, not a project one
  — which is another reason the global plan needs its own root rather than a flag on the project plan.

**Commands and MCP servers at user scope are refused for the same shape of reason:** a command wrapper
is a generated file (HK-11's ownership problem, in a home directory), and an MCP server config carries
live credentials in its `env` block — a value the project-scope inventory is already forbidden to read.

### 5.7 D4 / J-07 — Claude Code's own `/plugin` installs

#### The evidence that J-07 is real

Measured on this machine, 2026-09-08, from `~/.claude/settings.json` — **names and enable state only,
nothing else read from the file**:

- **16 entries in `enabledPlugins`. 9 enabled (`true`), 7 disabled (`false`).** Of the 9 enabled: 7
  from `claude-plugins-official`, 1 from `dorkos`, 1 from `dork-labs`.
- Across three marketplaces: 14 from `claude-plugins-official`, 1 from `dorkos`, 1 from `dork-labs`.
- The count matches `research/20260705_harness-audit-opus-optimization.md` two months earlier ("~16
  plugins enabled globally … the single largest remaining context tax and lives in
  `~/.claude/settings.json`, outside the repo"), but its two named examples have since been turned
  off — `posthog` and `vercel` are both `false` today. Cite the report for the shape of the problem,
  never for its numbers; the file is the only current source.
- **Zero of them are visible to DorkOS.** `enabledPlugins` appears nowhere in `apps/server/src`,
  `packages/harness/src`, `packages/cli/src` or `packages/marketplace/src`. Nothing anywhere reads
  `~/.claude/settings.json`.

Nine plugins working in one agent and no other, on the operator's own machine, is J-07 with a number
attached.

#### The read

- **Where — and NOT the root DorkOS bills to.** The tempting answer, `resolveActiveClaudeRoot()`, is
  wrong for this scenario, and measurably so. That resolver is
  `runtimes.claudeCode.defaultAccount ?? $CLAUDE_CONFIG_DIR ?? ~/.claude`, and its first rung answers a
  different question — _which Claude account does DorkOS run and bill on_. J-07 asks _which Claude Code
  did the person type `/plugin install` into_, which is the one their own shell launches. Those are the
  same question only by accident, and an operator who pins a default account to bill one client makes
  them different on purpose.
  So: **read the chain a bare `claude` uses — `$CLAUDE_CONFIG_DIR`, else `~/.claude`.** That is
  `inheritedClaudeRoot()` inside `claude-config-dir.ts`, today a private function; SPECIFY exports it
  (the file is the Hard Rule 3 carve-out, so no other server module may resolve this itself). **One
  call site, not two:** the CLI already imports server modules — fifteen files under `packages/cli/src`
  do, `harness-sync-command.ts` among them (`:530`, `:573`) — so it imports the same export rather than
  re-deriving the chain.
  _The residual hazard, and it is the one that actually bites:_ `$CLAUDE_CONFIG_DIR` is the rung
  **both** resolvers share, and it is inherited — so a run from inside an agent session can read a
  different root than the person's own terminal, the split-brain `claude-config-dir.ts`'s own module
  doc warns about. Measured on this machine while writing this: `runtimes.claudeCode.defaultAccount` is
  **unset**, one account is registered, `$CLAUDE_CONFIG_DIR` points at a sibling root holding **7**
  entries, and `~/.claude` — what the operator's own shell opens — holds **16**. So the gap here is not
  the `defaultAccount` rung at all; it is the shared one, which means choosing the right resolver does
  not by itself make the answer right. Mitigation is not cleverness, it is disclosure: **print the root
  that was read**, every time, so the answer is checkable. Do not enumerate `resolveClaudeRootSet()`;
  reporting plugins from accounts a person is not running describes sessions they are not having.
- **What.** `enabledPlugins`, and — for HK-14 — `hooks`. Nothing else. Never `~/.claude/plugins/`,
  never `known_marketplaces.json`, never `plugin-catalog-cache.json`. (Verified on this machine: the
  catalog cache and `blocklist.json` are `0600`, exactly as D4 says; `installed_plugins.json` and
  `known_marketplaces.json` happen to be `0644` here, which is not a licence — they are still the
  private half.)
- **How.** A Zod schema, and a failure that becomes a record rather than an exception, following
  `inventory/read.ts`. Note that the engine's existing `loadClaudeHooks` does a bare `JSON.parse` with
  a cast and **throws** on malformed JSON; a read of somebody's home directory must not be able to
  crash `dorkos harness sync`. Shape, from the vendor docs
  ([plugin-marketplaces](https://code.claude.com/docs/en/plugin-marketplaces),
  [settings-reference](https://code.claude.com/docs/en/settings-reference), both 2026-09-08):

  ```ts
  z.object({
    enabledPlugins: z.record(z.string(), z.boolean()).optional(),
    extraKnownMarketplaces: z
      .record(
        z.string(),
        z
          .object({
            source: z.object({ source: z.string(), repo: z.string().optional() }).passthrough(),
            // Documented on the same page; unread here, and present so the schema
            // still says something when the vendor adds a sibling field.
            autoUpdate: z.boolean().optional(),
          })
          .passthrough()
      )
      .optional(),
  }).passthrough();
  ```

  The key is `"<plugin-name>@<marketplace-name>"`; the value is the enable state. `autoUpdate` is an
  optional boolean alongside `source` in an `extraKnownMarketplaces` entry and belongs in the schema
  even though nothing here reads it — a `.passthrough()` that silently swallows a documented field is
  a schema that stops telling you when the vendor adds one.

- **The project half is read too, and this is not optional.** `enabledPlugins` has settings scope "Any
  file" ([settings-reference](https://code.claude.com/docs/en/settings-reference), 2026-09-08), so it
  is legal in `~/.claude/settings.json` (user), `<repo>/.claude/settings.json` (project),
  `<repo>/.claude/settings.local.json` (local) and, above all of them, **managed settings** — a fifth
  file an organization deploys, which the read must at least not pretend does not exist (it may be
  unreadable, in which case say so rather than answering as if it were absent). The vendor states the
  direction operationally: uninstalling a plugin the project enables offers "disable it for you alone,
  **which writes an override to your `.claude/settings.local.json`** and leaves the plugin installed
  for the project" ([discover-plugins](https://code.claude.com/docs/en/discover-plugins), 2026-09-08)
  — i.e. a user-scope `false` is not the way to turn off what the project turned on; a local-scope one
  is. And the merge is **per key**, not whole-object: `defaultEnabled` is overridden by "an entry for
  the plugin in `enabledPlugins` **at any settings scope**"
  ([plugins-reference](https://code.claude.com/docs/en/plugins-reference), 2026-09-08), which only
  means anything if entries from different files coexist. The engine **already opens the project file** —
  `loadClaudeHooks` reads exactly that path (`engine.ts:43-50`). Reading only the user half would make
  the report actively wrong in the most ordinary case there is: a plugin a person turned **off for this
  repo** would be listed as "installed in Claude Code only — install it through DorkOS", which is the
  same class of defect §5.1 opens with. So the read merges the three files under Claude Code's
  documented settings precedence (local over project over user), per key, and reports the keys whose
  **merged** value is `true`.
  A project `true` with no user entry is a real and different case: the plugin is on for this repo
  only. It is still Claude-Code-only and still invisible to every other agent, so it still belongs in
  the report — under its own sentence ("on for this project only"), never merged into the machine-wide
  list. This repo's own `.claude/settings.json` carries `"enabledPlugins": {}`, which is the empty
  case, not the absent one.

- **Report only the `true` entries** — seven of sixteen here are `false`, and a plugin somebody turned
  off is not something they are missing.

- **`defaultEnabled` is the hole in "read the public half", and it does not close.** A plugin with no
  entry at any scope is not off: "`defaultEnabled` is the fallback when nothing else has decided the
  plugin's state", it lives in the plugin's own `plugin.json`, "it defaults to `true`", and only two
  things override it — an `enabledPlugins` entry at any scope, or a dependency requirement
  ([plugins-reference](https://code.claude.com/docs/en/plugins-reference), 2026-09-08). So a plugin
  installed and never explicitly toggled is **on and absent from `enabledPlugins`**.
  Can DorkOS see it without the private cache? **Partly, and not enough.** `defaultEnabled` "can appear
  in a plugin's marketplace entry, where it takes precedence over the value in `plugin.json`" — and a
  marketplace entry is in the marketplace repository, which DorkOS already resolves for the offer, so
  that half is readable. The `plugin.json` half is not: it sits under
  `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/`, which D4 forbids. Worse, and decisively:
  **the public half cannot enumerate installed plugins at all.** `enabledPlugins` lists only what
  somebody explicitly set; there is no public list of installs to check a default against. A fourth
  state, "on by default, not listed", is therefore not computable — you cannot report on a set you
  cannot enumerate.
  **So the gap is accepted, and paid for in the copy.** The report describes _"plugins you have turned
  on in Claude Code"_, never _"plugins installed in Claude Code"_, and the summary count carries the
  same qualifier — the 9 measured above is 9 explicitly enabled, not 9 installed. That sentence is the
  price of D4's rule, and it is cheaper than the rule it would break.

#### Resolving which marketplace a plugin came from — measured, and better than D4 assumed

D4 says: "Resolving the marketplace a plugin came from needs either `known_marketplaces.json` (private
again) or the person's answer; prefer asking." Measured, the **public** half answers most of it, and
the way it answers changes the algorithm:

`~/.claude/settings.json` also carries `extraKnownMarketplaces` — a documented, user-editable key
(scope "Any file") mapping each marketplace **name** to a `source` object with a `repo`. On this
machine it resolves two of the three names in use:

| Claude Code marketplace name | Resolves to                          | DorkOS default source               | Entries |
| ---------------------------- | ------------------------------------ | ----------------------------------- | ------- |
| `claude-plugins-official`    | `anthropics/claude-plugins-official` | seeded as `claude-plugins-official` | 14      |
| `dorkos`                     | `dork-labs/marketplace`              | seeded as **`dorkos-community`**    | 1       |
| `dork-labs`                  | not in the public half               | —                                   | 1       |

**Match on the repository, never on the marketplace name.** The `dorkos` row is the proof: Claude
Code's `dorkos` and DorkOS's `dorkos-community` are the _same repository under different local names_,
so a name match would miss it, and a name match against a marketplace a person happened to call
`dorkos-community` would be a false positive. On the repository, **15 of 16 entries resolve with no
question asked**; the sixteenth (`dork-labs`, absent from the public half) is where asking belongs.

**"On the repository" needs a normaliser, and SPECIFY owns it — a naive comparison resolves zero.**
The two sides do not spell the same fact the same way. Claude Code stores a structured source
(`{ source: "github", repo: "anthropics/claude-plugins-official" }` — a kind key and an owner/name
slug); DorkOS stores a full URL string (`https://github.com/anthropics/claude-plugins-official`,
`marketplace-source-manager.ts:55-85`). `"anthropics/claude-plugins-official" === "https://github.com/anthropics/claude-plugins-official"`
is false, so a direct comparison matches **0 of 16**. The normaliser has to fold both onto one key —
at minimum: read `source.source` to learn the host kind, take `source.repo` as `owner/name`, and from
the DorkOS side strip the scheme, any `www.`, the host, a trailing `.git`, a trailing slash, and case
on the host segment while preserving it on the path. It also has to refuse rather than guess when
`source.source` is not `github` (no `repo` slug to fold), and it should be pure and unit-tested with
the real pairs measured here as its first fixtures. This is the whole reason decision 10 is a
recommendation and not a two-line implementation note.

That also means the two marketplaces DorkOS seeds by default
(`marketplace-source-manager.ts:55-85`) are the two this machine actually uses. Combined with SRC-03 —
DorkOS installs CC-native packages carrying only `.claude-plugin/plugin.json` (DOR-264) — the offer
resolves far more often than "most Claude plugins are not DorkOS packages" suggests.

#### The offer, and how it degrades honestly

Four rungs, each with what a person is told:

1. **Repo resolves to a marketplace DorkOS already has, and it lists a package of that name.**
   Offer the install. One click / one command.
2. **Repo resolves to a marketplace DorkOS does not have.** Offer to add the source first, showing the
   URL, then install. Two steps, one decision.
3. **Marketplace name is not in `extraKnownMarketplaces`.** Say so and offer nothing:
   "DorkOS can't tell where this one came from." Never guess, never open `known_marketplaces.json`.
   Optionally ask, which is what D4 recommends and is right for exactly this rung.
4. **The source resolves but has no package of that name.** Say so and stop: "That marketplace has
   nothing by that name DorkOS can install." Honest, common, and not a failure.
5. **The source has something by that name and it is not what you have.** Neither side carries a
   version DorkOS can compare — `enabledPlugins` is a name and a boolean, and `InstalledPlugin` has no
   `version` (§5.4) — so "same name, same repository" is the strongest claim the data supports, and
   the copy must not exceed it. Say **"a package of the same name from the same repository"**, never
   "the same plugin", and never "the same version". A repository can rename, re-scope or repoint a
   package between the day Claude Code cached it and the day DorkOS resolves it, and the person is the
   only one who can tell.

Rungs 3, 4 and 5 are the honest degradation. A person ends every one of them knowing more than they did,
and nothing was installed without them asking.

#### One correction to D4, and it matters

D4 says: "offer to install the same package through the DorkOS marketplace **at global scope**, which
is the same work DOR-174 needs."

Measured against the code, a DorkOS **global** install today reaches only DorkOS-managed Claude Code
sessions, through SDK injection (§5.1). A person who already has that plugin in Claude Code would gain
nothing at all — they would trade one Claude-Code-only copy for another. A DorkOS **project** install,
by contrast, reaches every enabled harness today, through the projection that already works.

**So until Option A lands, the honest offer is project scope, not global.** Draft copy:

> **9 plugins are installed in Claude Code only.** Your other agents — Codex, OpenCode, Cursor,
> Gemini and Copilot — can't see them.
>
> - `code-simplifier` (from anthropics/claude-plugins-official)
> - `context7` (from anthropics/claude-plugins-official)
> - `code-reviewer` (from dork-labs/marketplace)
> - … 6 more
>
> Install one through DorkOS and every agent in this project gets it:
> `dorkos install code-simplifier --project .` (DorkOS has to be running)

And once A lands, the same offer gains the global option and the sentence becomes "every agent, in
every project". The report line — "installed in Claude Code, not visible to other agents" — is true and
useful **today**, which is the main reason §7 recommends splitting this from global scope.

#### J-07, written out

1. Priya runs `/plugin install code-simplifier@claude-plugins-official` inside Claude Code. It works.
2. She opens the same repo in Codex to check a build. The skill is not there. Nothing says why.
3. She runs `dorkos harness sync`, or opens the Skills page. Under **Installed in Claude Code only**
   she sees nine plugin names, each with the repository it came from, and one sentence: her other
   agents cannot see them.
4. Beside `code-simplifier` is the offer, because DorkOS ships `anthropics/claude-plugins-official`
   as a default source and it has that package. She runs the one command it prints.
5. The marketplace install goes through the existing transaction — resolve, permission preview, hook
   consent card if the package declares hooks (D5, DOR-522) — and the existing auto-projection puts
   the skill in front of every enabled harness in that project.
6. Beside `persona-toolkit@dork-labs` there is no offer, and a sentence saying DorkOS cannot tell where
   that marketplace is. She either adds it herself or does not. Nothing pretends.

**Never auto-install.** The offer is a link into the install flow that already exists, with its
existing consent; it is not a new install path and it must not become one.

#### The one thing that stays out

`TR-10` ("Claude Code's own `/plugin install` … runs") wants a **trigger**. There is none, and this
work should not invent one: watching `~/.claude/settings.json` means a watcher on a file in somebody's
home directory that another program rewrites. Detection is a read on the surfaces that already run —
`dorkos harness sync`, the status route, the boot pass — which is the same cadence TR-11's detection
re-runs use. TR-10 stays "not built", with the reason recorded.

### 5.8 Risks, unknowns, and what a spike would measure

| #   | Question                                                                                                                                                   | Why it matters                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | The experiment                                                                                                                                                                                                                                                                  |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Do Codex, OpenCode, Cursor, Gemini and Copilot really load a **symlinked** `<pkg>__<name>` directory from `~/.agents/skills`?                              | The whole of Option A, and **two of the five are documented to refuse**: OpenCode and Cursor both require a lowercase-alphanumeric-and-single-hyphen `name` that matches the directory, which `<pkg>__<name>` breaks twice over (SK-09, SK-12). So this is a real risk, not a formality; a 3-of-5 result is the expected floor and §5.3 says what A still delivers then. Nothing has ever run a binary against any of it (contract §14 gap 7).                                                                                                                                              | The H tier (DOR-1856): stage one link in `~/.agents/skills` in a throwaway HOME, run each binary, ask it to list its skills. Oracle is the harness's own output. Run it with a plain `<name>` directory too, so a refusal is attributed to the name rather than to the symlink. |
| 2   | Does Claude Code's "personal overrides project" rule apply to a **symlinked** skill directory as well as a real one?                                       | Narrowed — the symlink half is now free. The vendor states it: a skill entry "can be a symlink to a directory elsewhere on disk. Claude Code follows the symlink and reads `SKILL.md` from the target directory, and if the same target is reachable from more than one location, Claude Code loads the skill once" ([skills](https://code.claude.com/docs/en/skills), 2026-09-08). That also answers §5.4's double-read worry for Claude Code. What is left is whether precedence still resolves personal-over-project when one or both sides are links, which decides §5.4's notice text. | Stage the same skill name as a link at both tiers and ask Claude Code which one it ran.                                                                                                                                                                                         |
| 3   | Does a **managed** settings file participate, and can DorkOS read it?                                                                                      | Narrowed twice. The per-key merge is no longer open: an `enabledPlugins` entry "at any settings scope" overrides `defaultEnabled`, and the vendor's own uninstall flow writes a `settings.local.json` override to disable what the project enables — so §5.7 designs the merge on documented behaviour, not on a guess. What is open is the fifth file: managed settings sit above all three and may be unreadable to DorkOS.                                                                                                                                                               | Read the managed-settings path on a machine that has one; if it cannot be read, the report says the answer may be overridden rather than answering as if the file were absent.                                                                                                  |
| 4   | What is already in `~/.agents/skills` and `~/.claude/skills` on real machines?                                                                             | The sweep's blast radius. Measured n=1: two hand-authored directories in each, same names in both, plus Codex's `$skill-installer` writing to the first.                                                                                                                                                                                                                                                                                                                                                                                                                                    | Ask three or four people to run a one-line `ls`. Cheap, and it is the only way to know whether "two directories" is typical.                                                                                                                                                    |
| 5   | Is `~/.claude/settings.json` ever rewritten while DorkOS reads it?                                                                                         | A torn read must degrade, never throw, because it is on the `dorkos harness sync` path.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Not worth an experiment: design for it. Zod parse, `UnreadableSource` on failure, no retry.                                                                                                                                                                                     |
| 6   | Does OpenCode have user-level hooks at all?                                                                                                                | §5.2.2 cell is `unknown` — `opencode.ai/docs/hooks/` 404s. Only matters if the hooks refusal is ever revisited.                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Re-fetch on the next vendor-facts refresh; leave `unknown` until then.                                                                                                                                                                                                          |
| 7   | Does a global uninstall's sweep of `~/.agents/skills` behave under the existing ownership predicate on a directory that also holds Codex-installed skills? | The riskiest line in the feature.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | A staged HOME with a hand-authored dir, a Codex-installed dir, and a DorkOS link; uninstall; assert exactly one thing was removed. Belongs in the same PR as the sweep.                                                                                                         |
| 8   | Is ADR-0305 still true?                                                                                                                                    | Its decision ("merge the global activated set with `<cwd>/.dork/plugins/*`") is contradicted by `claude-code-runtime.ts:1320-1324` ("Only GLOBAL plugins are SDK-injected now"), yet it is `accepted` with `superseded-by: null`.                                                                                                                                                                                                                                                                                                                                                           | Not this ticket's work, but `/adr:review` should amend it — and Option A eventually retires the SDK-injection path it describes.                                                                                                                                                |

**Two risks with no experiment, only a design answer:**

- **A sweep in a home directory has no `git status` and no reader.** Position D3 made exactly this
  argument to refuse auto-adopt in agent homes: "an agent home has no `git status` and no reader … the
  one mitigation a move relies on, visibility, is weakest exactly there." A person's home is that,
  more so. The answer is the one Option A already takes: symlinks only, never generated files; the
  **three-clause** ownership predicate of §5.3 — symlink AND `__` in the basename AND a target
  resolving inside `<dorkHome>/plugins`, all three required, none of which the two-clause repo
  predicate gives you; and the global apply prints every path it will remove before it removes it.
- **A `DORKOS_BOUNDARY`-scoped deployment cannot write `~`.** Answered by scope, not by widening the
  boundary: the global pass is a CLI and boot capability, and it reports "skipped — DorkOS is confined
  to `<root>`" rather than failing or being widened. Never reach for
  `validateBoundaryOrDorkHome` here; it narrows to `<dorkHome>/agents/*` for a reason.

---

## 6) Decisions

| #   | Decision                                                    | Choice                                                                                                                                | Rationale                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Which option                                                | **A, narrowed to skills, staged B → D → A**                                                                                           | A is the only option that makes "installed globally" true. The per-harness table shrinks it to at most two target directories, and B and D are its first two slices, each shippable alone (§5.3).                                                                                                                                                                                                                                                                                                                               |
| 2   | Do we ever write a **generated** file at user scope?        | **No**                                                                                                                                | HK-11's ownership scheme does not exist yet, and its failure mode in a home directory is unrecoverable. Symlinks only — under the NEW three-clause predicate of §5.3, since the two-clause one the repo tests is not safe where a person keeps symlinks of their own. Held by the property in decision 13.                                                                                                                                                                                                                      |
| 3   | Which user directories                                      | **At most two: `~/.agents/skills` and `~/.claude/skills`, and nothing else**                                                          | Verified 2026-09-08: five harnesses read the first, Claude Code reads the second. Whether Claude Code also reads the first is `unknown` (§5.2.1), so the second may turn out to be redundant — never wrong. Every other user directory belongs to a kind decision 4 refuses.                                                                                                                                                                                                                                                    |
| 4   | Instructions, hooks, commands and MCP servers at user scope | **Out of scope, each with its reason recorded in the contract**                                                                       | ADR-0302's mechanism needs a canonical source and there is none at user level; a person's private hooks are not the team's; a command wrapper is a generated file; an MCP config holds credentials (§5.6).                                                                                                                                                                                                                                                                                                                      |
| 5   | `~/.claude/settings.json`                                   | **Read, report, never write or project from**                                                                                         | One read answers both `enabledPlugins` (J-07) and HK-14's user half. Zod-parsed, failure becomes a record. Never `~/.claude/plugins/` (D4).                                                                                                                                                                                                                                                                                                                                                                                     |
| 6   | Which Claude root the J-07 read opens                       | **The root a bare `claude` uses — `$CLAUDE_CONFIG_DIR`, else `~/.claude`** — never `resolveActiveClaudeRoot()`, and always printed    | That resolver puts `runtimes.claudeCode.defaultAccount` first, which answers which account DorkOS **bills**, not which Claude Code the person typed `/plugin install` into. `inheritedClaudeRoot()` is exported and imported by both the route and the CLI — one call site, since the CLI already imports server modules. The root is printed every time because `$CLAUDE_CONFIG_DIR`, the rung both resolvers share, is inherited and can differ from the person's own shell (§5.7). Never enumerate `resolveClaudeRootSet()`. |
| 7   | SRC-12 precedence                                           | **DorkOS resolves nothing; it reports, once, at package level, with the per-harness consequence**                                     | The harnesses disagree — Claude Code gives the personal copy the win, Codex shows both, three are undocumented — and a symlink in a directory the harness reads on its own terms cannot be given a DorkOS precedence. "Newer wins" is also unimplementable: `InstalledPlugin` carries no `version`.                                                                                                                                                                                                                             |
| 8   | SK-03's global half                                         | **In this feature, as its own slice — the first that writes anything** (B, before it, only reads and reports), separable if it stalls | It reuses A's second root, but needs no vendor fact and writes only inside `<dorkHome>`, where the machinery can be proved safely.                                                                                                                                                                                                                                                                                                                                                                                              |
| 9   | The scope of the offer in J-07                              | **Project scope until Option A lands, then global**                                                                                   | Measured: a DorkOS global install today reaches only DorkOS-managed Claude Code sessions, so offering it to somebody who already has the plugin in Claude Code buys them nothing. This corrects D4.                                                                                                                                                                                                                                                                                                                             |
| 10  | Marketplace resolution for the offer                        | **Match on repository URL from the public `extraKnownMarketplaces`, not on marketplace name**                                         | Measured 15/16 resolve; a name match resolves 14/16 and misses `dorkos` → `dorkos-community`, which is the same repository. Asking is the fallback for the residue, which is what D4 wanted it for.                                                                                                                                                                                                                                                                                                                             |
| 11  | Auto-install from the offer                                 | **Never**                                                                                                                             | The offer is a link into the existing install flow with its existing permission preview and hook consent (D5).                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 12  | A trigger on `/plugin install` (TR-10)                      | **No trigger; detect on the surfaces that already run**                                                                               | A watcher on a file in a home directory that another program rewrites is not worth what it buys. TR-10 stays "not built", with the reason recorded.                                                                                                                                                                                                                                                                                                                                                                             |
| 13  | The properties that hold decisions 2 and 3                  | **Two, both new, beside a re-scoped P8**                                                                                              | P8 is re-scoped, never relaxed: "no action in a **project** plan escapes `repoRoot`" stays as strong as it is today, and a sibling property names the global plan's permitted roots. Beside it, **"no action in a global plan has `kind: 'generate'`"** — decision 2 has no enforcement otherwise, and `buildPlan` runs every stage unconditionally (§5.1's fixture emitted six instruction drops in a repo with no `AGENTS.md`), so a later stage reaching the global plan is the ordinary way this rule would be lost.        |
| 14  | Behaviour under `DORKOS_BOUNDARY`                           | **Skip the global pass and say so**                                                                                                   | Never widen the boundary and never reach for `validateBoundaryOrDorkHome`, which narrows to `<dorkHome>/agents/*` on purpose.                                                                                                                                                                                                                                                                                                                                                                                                   |
| 15  | Whether the first global projection is asked for            | **Asked once, remembered**                                                                                                            | D5 puts "changes what every future session reads" in the report-line-by-line category; a first write into a person's home is past that line.                                                                                                                                                                                                                                                                                                                                                                                    |
| 16  | Ticket scoping                                              | **DOR-1857 is the global-scope ticket; `adopt` stays with DOR-1853**                                                                  | `specs/harness-sync/03-tasks.json` files `adopt` under DOR-174 while the contract treats DOR-174 as global projection. SPECIFY should say which is which and stop citing DOR-174 for both.                                                                                                                                                                                                                                                                                                                                      |

---

## 7) Suggested next steps

### What SPECIFY has to settle

1. **The global plan's API.** `buildGlobalPlan(dorkHome)` beside `project(repoRoot, opts)`, or one
   entry point with a root discriminator? The engine is a leaf package with no server access, so the
   global plan's inputs (dork home, the enabled-harness set, the Claude root) all have to be passed in.
2. **Where the global manifest lives.** A project's enabled harnesses come from
   `.agents/harness.manifest.json`. Global scope has no repo. Candidates: `<dorkHome>/harness.manifest.json`,
   a `harness.global` block in `~/.dork/config.json` (which would need a semver-keyed migration and the
   `adding-config-fields` skill), or "every harness DorkOS has detected". Recommend the config block —
   it is the store the hook decisions already live in.
3. **The target vocabulary.** Actions today carry repo-relative POSIX strings. A global action's target
   is absolute and outside any repo. Does `ProjectionAction` grow a `root` field, or a project/global
   `scope` discriminator? DOR-1852's row key is `(artifact, source, name)`, so whichever is chosen has
   to keep two same-named rows at two scopes distinguishable.
4. **How the status API answers for global scope.** `GET /api/harness/status?projectPath=…` has no
   global mode. Two shapes: a `scope=global` variant returning the same envelope with no `projectPath`,
   or global rows folded into every project's answer marked `scope: 'global'` — which is what a person
   actually asks ("what can this agent see _here_?") at the cost of repeating the same rows in every
   response. Recommend the second, and measure the payload against DOR-1852's ≤250 KB budget.
5. **The exact strings.** Every drop reason and notice is printed verbatim by the CLI and the Skills
   page both, so they are user-facing copy and go through `writing-for-humans`. §5.4, §5.6 and §5.7
   carry drafts; SPECIFY freezes them.
6. **The sweep's exact predicate and its report.** Symlink **and** `__` in the basename **and** the
   target resolves inside `<dorkHome>/plugins`, all three; every path printed before removal; the
   uninstall path exercised in the same PR (experiment 7).
7. **An ADR.** Option A amends ADR-0303's scope-matching clause from an unimplemented intention into a
   built one, and adds the refusals in decision 4. Draft it at SPECIFY per `/adr:from-spec`.
8. **Contract rows to update in the same PR:** SRC-04, SRC-08, SRC-12, SK-03, IN-08, HK-14, TR-10,
   J-07, §14 gap 11, and D4 (decisions 9 and 10 correct it).

### Should this be split? — Yes

**Two items, and the second can ship first.**

- **DOR-1857a — Global scope** (SRC-04, SRC-12, SK-03's global half). Needs the engine to grow a second
  root, a global manifest, a target vocabulary, and a sweep in a home directory. Slices: **B** — the
  honest drop, the scanner enumerating a global package's assets, the `InstalledPlugin` scope
  discriminator, **and the SRC-12 both-scopes notice**, which needs nothing A builds because
  `scanInstalledPlugins` already returns both scopes today → **D** — `<dorkHome>/skills` links, the
  scheduler's global half → **A** — `~/.agents/skills` plus `~/.claude/skills`, the three-clause
  ownership predicate, and the retirement of SDK injection, gated on the H tier.
- **DOR-1857b — Claude Code's own plugins** (SRC-08, J-07, HK-14's user half). Two file reads (user
  and project settings), a Zod schema, the repository normaliser, a report, and a link into an install
  flow that already exists. **No change to the plan, the apply or any sweep** — which is the claim
  that matters, and is narrower than "zero engine change". The honest reading: the CLI resolves the
  Claude root itself and assembles its own "Installed in Claude Code only" block in
  `packages/cli/src/harness-sync-command.ts`, printed beside `formatDropList`'s output rather than
  inside it. Putting it _inside_ `formatDropList` would be an engine change and, worse, would make
  `@dorkos/harness` read a home directory, which three of its module docs forbid by name. The app half
  is a panel on DOR-1852's Skills page and lands with that ticket's slices, not this one's.

They are separable because they share nothing but a home directory. 1857b touches no plan, no apply, no
sweep, and no target; 1857a touches all four and never reads `~/.claude/settings.json`.

**The one coupling, and its answer.** D4 makes 1857b's offer point at a global install, which is
1857a's work. Decision 9 removes the coupling: until 1857a lands, the offer points at **project**
scope, which reaches every harness today and is therefore the honest recommendation anyway. So 1857b
ships whole, on its own, and gains a second option later.

**Recommended order:** 1857b first — it is smaller, it is verified, and "nine plugins work in one agent
and no other" is a sentence the operator's own machine can show today. Then 1857a's B slice, which
makes the existing lie stop. Then D, then A behind the H tier.

### If this stalls

The B slice alone — enumerate a global package's assets and print an honest drop naming them — removes
every one of the four defects in §5.1 for a fraction of the cost, and leaves the ranking in
`plans/harness-sync-test-plan.md` §11 (row 14 of 14) intact and defensible. That is the minimum this
ticket should not close without.
