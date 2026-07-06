# Harness Sync

The cross-agent file-projection engine (`@dorkos/harness`) — how DorkOS projects skills, instructions, hooks, and commands from one canonical source into every agent harness (Claude Code, Codex CLI, Cursor, GitHub Copilot, Gemini CLI, ...), and how to keep its translation tables current.

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

| Asset        | Claude Code                                          | Codex                                   | Other harnesses             |
| ------------ | ---------------------------------------------------- | --------------------------------------- | --------------------------- |
| **skills**   | symlink `.claude/skills/<pkg>__<name>`               | symlink `.agents/skills/<pkg>__<name>`  | whole-plugin drop           |
| **commands** | generated wrapper `.claude/commands/<pkg>/<name>.md` | drop (no repo-local format)             | drop (no repo-local format) |
| **hooks**    | merge into `.claude/settings.local.json`             | fold into generated `.codex/hooks.json` | drop / merge per harness    |

Key invariants:

- **Namespacing is mandatory.** Installed skills are always `<pkg>__<name>` so they can never overwrite an authored skill; the `__` infix is also how the orphan sweep and the `.gitignore` tell managed symlinks from authored ones.
- **`${CLAUDE_PLUGIN_ROOT}` is rewritten to the absolute install dir** in every command wrapper and every merged hook command, because that token only resolves inside plugin (SDK) context. A projected skill whose `SKILL.md` still carries the token cannot be rewritten (it is read as-is), so the projector emits a `ProjectionWarning` instead.
- **Command wrappers carry a marker line** (`dorkos:generated-command ...`) right after the YAML frontmatter. That marker is the sole ownership predicate for the uninstall sweep, so a hand-authored command is never deleted, even one sharing a wrapper directory. And if a wrapper target dir (`.claude/commands/<pkg>/`) already exists with authored (marker-less) content, the plugin's command projection surfaces as a conflict and nothing is written into that dir: the engine never co-opts an authored namespace.
- **Plugin hooks merge, never overwrite.** `.claude/settings.local.json` is user-owned, so the engine touches only its own managed matcher groups and leaves every user hook and other settings key intact. Ownership is explicit: each managed group carries the `_dorkosHarness: "<pkg>"` sentinel key (Claude Code tolerates the unknown key and the tagged hook still fires, validated on CLI 2.1.197). Ownership is never inferred from the command string, so a plugin hook that does not mention its install path still re-syncs idempotently and sweeps on uninstall, and a user hook that mentions `.dork/plugins/` is never misclassified. A settings file that exists but cannot be parsed (corrupt, mid-write) aborts the merge as a conflict rather than being rewritten. See `apply/settings-hooks.ts`.
- **Projections are gitignored machine-local ephemera.** Skill symlinks and the settings file are covered by `EPHEMERAL_GITIGNORE_PATTERNS` (`sources/resolve-roots.ts`) mirrored in the repo `.gitignore`; command wrapper directories are covered by a self-ignoring `.gitignore` the engine writes inside each `.claude/commands/<pkg>/` (a static rule would swallow authored `.claude/commands/<ns>/` dirs).
- **Uninstall prunes everything.** `applyPlan(..., { sweepOrphans: true })` sweeps orphaned skill symlinks, command wrappers (and their emptied dirs), and managed settings hooks. Auto-projection reruns project+apply after every install/uninstall (`apps/server/src/services/harness/auto-project.ts`).

Global installs (`~/.dork/plugins`) are still SDK-injected by the claude-code runtime as a transitional exception until global-scope projection lands (DOR-174).
