---
name: runtime-watch
description: "DorkOS runtime release watch, called from @dorkos-qa's heartbeat: compares the pinned Claude Agent SDK, Codex SDK and CLI, OpenCode SDK and Doe's Pi packages with npm, reads what changed, says whether it matters to DorkOS, and hands real drift to DorkOS Code for /app:runtime-upgrade. Reads and reports only. Use only when a heartbeat checklist or a person asks for the runtime watch."
---

# runtime-watch

A cheap, read-only check: a few `npm view` calls and, only when something is new, one read of the release notes. It changes no file, opens no PR and needs no `node_modules`, so it is safe to run every day. The bump itself is DorkOS Code's job, through `/app:runtime-upgrade` (`.claude/commands/app/runtime-upgrade.md`) and the `upgrading-runtime-dependencies` skill.

## What it watches

The packages in `.claude/config/runtime-deps.json` (`@anthropic-ai/claude-agent-sdk`, `@openai/codex-sdk`, `@openai/codex`, `@opencode-ai/sdk`) and the Pi packages Doe uses (`@earendil-works/pi-agent-core`, `pi-ai`, `pi-mcp` in `packages/doe/package.json`).

## Run

1. **Read the pins from `origin/main`, not a working tree.** `git fetch origin`, pin `BASE=$(git rev-parse origin/main)`, then read each version with `git show "${BASE}:apps/server/package.json"` (the Pi packages: `"${BASE}:packages/doe/package.json"`). Write `${BASE}` with braces: in zsh, `$BASE:a` is a path modifier. Strip a leading `~` or `^`.
2. **Read the latest.** For each package, `npm view <pkg> version` and `npm view <pkg> time --json` for the publish date. Ignore pre-release tags.
3. **Classify the drift**: `none`, `patch`, `minor` or `major`. In a `0.x` line, a minor bump (`0.154 → 0.163`) counts as a minor with breaking risk. For the Claude Agent SDK, every `0.3.x` patch ships features and fixes, so read its notes whatever the size.
4. **Stop early when nothing moved.** If every package is `none`, the report is one line and the run is over.
5. **For each package that moved, read what changed** between the pin and the latest, from the sources listed for it in `runtime-deps.json` (npm, GitHub releases, `CHANGELOG.md`). Sort it into breaking, deprecated, new and fixed. Then decide whether it matters to DorkOS:
   - **Matters now:** a breaking change or deprecation on a surface in that package's `sdk_surface_map`; a fix for something an `upgrade_notes` entry works around (for example, upstream #454 on the Claude SDK); a security fix; or a new model or model alias.
   - **Worth adopting:** a new feature a DorkOS user would notice. Name it in one plain line.
   - **Routine:** everything else.
6. **Check it is not already in hand.** Look for an open PR whose title names the package (`gh pr list --search "<short_name> in:title"`) and an open Linear ticket for the same bump. If one exists, report it as "in hand" with its title, and do not hand it off again.
7. **Hand off real drift.** A moved package that is not in hand goes to DorkOS Code (`@dorkos-2`) as one message: package, `pin → latest`, the "matters now" lines, and "run `/app:runtime-upgrade <pkg>` within 2 days". Each runtime bump is its own PR behind its adapter directory, with the runtime conformance suite passing.
8. **New frontier-model support** (a new model alias, a new model family) also gets one line to @dorkos-marketing, but only after the bump that carries it has merged.

## Report

One line per run, in #dorkos or to whoever called it:

`Runtimes (<date>): claude-agent-sdk 0.3.280 → 0.3.304 (matters: <why>), codex-sdk 0.154 → 0.163 (in hand: <PR title>), opencode 1.18 → 1.19 (routine), Pi current.`

When nothing moved: `Runtimes (<date>): all current.`

## Never

- Edit a manifest, the lockfile or `runtime-deps.json`, open a PR, or file a ticket for a bump (DorkOS Code files those).
- Install anything, run an eval, or spend money.
- Hand the same release off twice: step 6 is what keeps a daily run quiet.
