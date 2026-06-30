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
