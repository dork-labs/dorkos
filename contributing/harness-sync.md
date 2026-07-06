# Harness Sync

The cross-agent file-projection engine (`@dorkos/harness`) — how DorkOS projects skills, instructions, hooks, and commands from one canonical source into every agent harness (Claude Code, Codex CLI, Cursor, GitHub Copilot, Gemini CLI, OpenCode, ...), and how to keep its translation tables current.

Pair this guide with:

- [`packages/harness/src/vendor/rulesync-maps.ts`](../packages/harness/src/vendor/rulesync-maps.ts) — the vendored, MIT-licensed snapshot of rulesync's cross-agent hook-event maps and per-tool path constants.
- [`packages/harness/src/vendor/gemini-maps.ts`](../packages/harness/src/vendor/gemini-maps.ts) — the in-repo Gemini CLI maps (rulesync ships none).

## 1. Overview

Every coding agent stores the same five kinds of project config under a different name in a different place: instructions (`CLAUDE.md` / `AGENTS.md` / `GEMINI.md` / `copilot-instructions.md`), skills, hooks, and commands. Harness Sync keeps a single canonical source and **projects** it into each harness's on-disk layout, so one edit reaches every agent.

Two pieces of static data make that possible:

1. **Hook-event maps** — each tool names the same lifecycle event differently (`PreToolUse` vs `BeforeTool` vs `preToolUse`). We translate through a canonical camelCase vocabulary (`HookEvent`): `CANONICAL_TO_<TOOL>_EVENT_NAMES` projects out, the derived reverse map reads back in.
2. **Path constants** — where each tool reads its skills / rules / hooks / commands (`claudecodePaths`, `codexcliPaths`, `copilotPaths`, `cursorPaths`, `geminiPaths`).

## 2. Where the data comes from

| Tool           | Source              | File                      |
| -------------- | ------------------- | ------------------------- |
| Claude Code    | vendored (rulesync) | `vendor/rulesync-maps.ts` |
| Codex CLI      | vendored (rulesync) | `vendor/rulesync-maps.ts` |
| Cursor         | vendored (rulesync) | `vendor/rulesync-maps.ts` |
| GitHub Copilot | vendored (rulesync) | `vendor/rulesync-maps.ts` |
| Gemini CLI     | **hand-authored**   | `vendor/gemini-maps.ts`   |

`vendor/rulesync-maps.ts` is **vendored static data**, transcribed verbatim from [rulesync](https://github.com/dyoshikawa/rulesync) (MIT, © 2024 dyoshikawa) at the pinned commit recorded in its header. We copy it in — rather than depend on the npm package — so the engine has a stable, audited snapshot. The MIT attribution block at the top of that file must survive any edit.

**Gemini is hand-authored.** rulesync ships no Gemini hook map and no Gemini path constants (Gemini appears upstream only as a config enum value and in passing comments), so `vendor/gemini-maps.ts` is original DorkOS source. Its event names (`BeforeTool`, `AfterTool`, `BeforeAgent`, `AfterAgent`, `SessionStart`, `SessionEnd`) are confirmed against the [official Gemini CLI hooks reference](https://geminicli.com/docs/hooks/reference/); two are documented equivalences rather than exact 1:1 names (`beforeSubmitPrompt → BeforeAgent`, `stop → AfterAgent`). See the `TODO(B9/DOR-143)` notes in that file for the open config-format verification.

## 3. Re-vendor checklist

Run this when bumping the pinned rulesync snapshot (new tool, renamed event, changed path layout). Keep the diff surgical — only the four vendored tables (Claude / Codex / Cursor / Copilot) and the attribution header change.

1. **Fetch the new upstream.** Check out the target rulesync commit locally and note its full SHA and the npm version it corresponds to.
2. **Bump the pinned SHA.** Update the `Pinned: commit <sha>` line in the header of `vendor/rulesync-maps.ts` to the new short SHA (and the `rulesync@<x.y.z>` version). The attribution test asserts this header still contains `dyoshikawa`, the pinned SHA, and `MIT`.
3. **Diff the four target tables** against the new upstream — for each of Claude, Codex, Cursor, and Copilot, compare:
   - the `*_HOOK_EVENTS` array (`src/types/hooks.ts`),
   - the `CANONICAL_TO_*_EVENT_NAMES` map (`src/types/hooks.ts`),
   - the path constants (`src/constants/{claudecode,codexcli,copilot,cursor}-paths.ts`).
     Apply only the deltas. Do not re-vendor tools we do not project.
4. **Leave Gemini alone.** `vendor/gemini-maps.ts` is hand-authored and is NOT part of the rulesync snapshot — never overwrite it from upstream. If Gemini's own docs change, update it independently and clear the relevant `TODO(B9/DOR-143)`.
5. **Re-derive reverse maps for free.** Every `*_TO_CANONICAL_EVENT_NAMES` map is `Object.fromEntries(Object.entries(forward).map(([k, v]) => [v, k]))` — never hand-edit a reverse map. If a forward map gains two canonical keys with the same tool spelling, the reverse collapses and the round-trip test will fail; that is the signal to reconcile.
6. **Run the tests.** From `packages/harness`: `pnpm exec vitest run src/vendor` (round-trip, non-empty, attribution) and `pnpm exec tsc --noEmit`.
7. **Run the engine self-check.** `dorkos harness sync --check` — confirms the projected layout still matches every harness on disk before you commit.
8. **Confirm TSDoc.** Every exported const/type needs a `/** ... */` block; the repo's ESLint fails the build on a missing-TSDoc export.

## 4. Installed-plugin projection

A marketplace plugin installed at **project scope** (`<repo>/.dork/plugins/<pkg>/`) is delivered to every harness, including Claude Code, as harness-native files rather than through a runtime SDK plugin array ([ADR 260706-192819](../decisions/260706-192819-harness-native-plugin-delivery.md), amending ADR-0239). The point of parity: the external `claude` CLI run in the repo and a DorkOS-managed session both read the same projected files, so a plugin never works in one and silently not the other.

`scanInstalledPlugins` (`sources/installed.ts`) discovers each project-scoped plugin and enumerates its portable assets (skills, top-level `commands/*.md`, `hooks/hooks.json`). The projector (`plan/installed-projector.ts`) then emits, per plugin:

| Asset         | Claude Code                                          | Codex                                   | OpenCode                                                      | Cursor / Gemini / Copilot   |
| ------------- | ---------------------------------------------------- | --------------------------------------- | ------------------------------------------------------------- | --------------------------- |
| **skills**    | symlink `.claude/skills/<pkg>__<name>`               | symlink `.agents/skills/<pkg>__<name>`  | `native` (reads `.agents/skills` via the Codex symlink)       | whole-plugin drop           |
| **commands**  | generated wrapper `.claude/commands/<pkg>/<name>.md` | drop (no repo-local format)             | generated wrapper `.opencode/commands/<pkg>-<name>.md` (flat) | drop (no repo-local format) |
| **hooks**     | merge into `.claude/settings.local.json`             | fold into generated `.codex/hooks.json` | drop (no declarative hooks — only a code-based TS plugin API) | drop / merge per harness    |
| **AGENTS.md** | scaffold `.claude/CLAUDE.md`                         | native                                  | native                                                        | native (cursor) / scaffold  |

**OpenCode specifics** (verified against docs + `sst/opencode` source, 2026-07-06; see [research/20260706_agent_cli_command_skill_naming.md](../research/20260706_agent_cli_command_skill_naming.md)):

- Commands live in a **flat** `.opencode/commands/` dir with **no namespacing**, so a plugin command projects hyphen-joined: `/flow:capture` (Claude) becomes the file `flow-capture.md`, invoked `/flow-capture`. That invocation-name difference is expected, not a bug.
- The generated wrapper's frontmatter is **reduced to only `description`** — OpenCode documents `description`/`agent`/`model`/`subtask`/`template` and its tolerance of unknown keys is undocumented, so Claude-only keys (`allowed-tools`, `argument-hint`, `category`) are stripped rather than passed through.
- Skills are `native`: OpenCode reads `.agents/skills` (and `.claude/skills`) directly, so it relies on the Codex/Claude Code namespaced symlink already on disk rather than projecting its own.
- Hooks **drop honestly**: OpenCode has no declarative hook config, only a code-based TypeScript plugin API, so there is no on-disk hook file to project into.

Key invariants:

- **Namespacing is mandatory.** Installed skills are always `<pkg>__<name>` so they can never overwrite an authored skill; the `__` infix is also how the orphan sweep and the `.gitignore` tell managed symlinks from authored ones.
- **Skill identity differs per harness.** Claude Code keys a skill by its **directory** name, so the `<pkg>__<name>` directory namespacing fully protects it. OpenCode and Codex key a skill by its **`SKILL.md` frontmatter `name`** (source-verified: `sst/opencode` `skill/index.ts` keys its map on `md.data.name`; Codex likewise treats the frontmatter name as identity), which the directory namespacing does NOT change — so two skills sharing a frontmatter name collide there. The projector cannot rename inside a plugin's `SKILL.md`, so it emits a `ProjectionWarning` (`planSkillNameCollisions`) naming the colliding skills and the frontmatter-keyed harness. Fix collisions by renaming the frontmatter `name` at the source.
- **`${CLAUDE_PLUGIN_ROOT}` is rewritten to the absolute install dir** in every command wrapper (Claude and OpenCode), every merged Claude hook command, AND every installed-plugin hook folded into a generated hook file (`.codex/hooks.json`, `.cursor/hooks.json`, `.github/hooks/copilot-hooks.json`) — the install root is known at plan time (`rewritePluginRootInHooks`). So a folded plugin hook actually works in the target harness, and the Claude-only-token `ProjectionWarning` now fires ONLY for **authored** hooks (unknown install root) or other unresolved `${CLAUDE_*}` tokens. A projected skill whose `SKILL.md` still carries the token cannot be rewritten (it is read as-is), so the projector emits a `ProjectionWarning` instead.
- **Command wrappers carry a marker line** (`dorkos:generated-command ...`) right after the YAML frontmatter. That marker is the sole ownership predicate for the uninstall sweep, so a hand-authored command is never deleted, even one sharing a wrapper directory. Claude Code owns a whole per-plugin dir (`.claude/commands/<pkg>/`): if that dir already holds authored (marker-less) content, the plugin's command projection surfaces as a conflict and nothing is written into it. The OpenCode dir (`.opencode/commands/`) is instead **shared and flat**, so the block is per-**file**: only a wrapper whose exact path is already occupied by an authored (marker-less) file is a conflict; the plugin's other wrappers still project alongside authored commands.
- **Plugin hooks merge, never overwrite.** `.claude/settings.local.json` is user-owned, so the engine touches only its own managed matcher groups and leaves every user hook and other settings key intact. Ownership is explicit: each managed group carries the `_dorkosHarness: "<pkg>"` sentinel key (Claude Code tolerates the unknown key and the tagged hook still fires, validated on CLI 2.1.197). Ownership is never inferred from the command string, so a plugin hook that does not mention its install path still re-syncs idempotently and sweeps on uninstall, and a user hook that mentions `.dork/plugins/` is never misclassified. A settings file that exists but cannot be parsed (corrupt, mid-write) aborts the merge as a conflict rather than being rewritten. See `apply/settings-hooks.ts`.
- **Projections are gitignored machine-local ephemera.** Skill symlinks and the settings file are covered by `EPHEMERAL_GITIGNORE_PATTERNS` (`sources/resolve-roots.ts`) mirrored in the repo `.gitignore`; the Claude wrapper directories are covered by a self-ignoring `.gitignore` the engine writes inside each `.claude/commands/<pkg>/` (a static rule would swallow authored `.claude/commands/<ns>/` dirs). The shared flat `.opencode/commands/` dir gets one engine-owned `.gitignore` that names **each generated wrapper filename explicitly** plus itself — never a `*` wildcard, which would hide authored commands. An authored `.opencode/commands/.gitignore` (marker-less) is treated as a conflict, never overwritten.
- **Uninstall prunes everything.** `applyPlan(..., { sweepOrphans: true })` sweeps orphaned skill symlinks, Claude command wrappers (and their emptied dirs), OpenCode command wrappers and their aggregated `.gitignore` (marker-scoped, so authored files in the shared dir are never touched), and managed settings hooks. Auto-projection reruns project+apply after every install/uninstall (`apps/server/src/services/harness/auto-project.ts`).

Global installs (`~/.dork/plugins`) are still SDK-injected by the claude-code runtime as a transitional exception until global-scope projection lands (DOR-174).
