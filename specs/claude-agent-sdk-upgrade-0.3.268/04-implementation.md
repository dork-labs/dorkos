# Implementation Summary: Claude Agent SDK Upgrade to 0.3.268

**Created:** 2026-09-12
**Last Updated:** 2026-09-12
**Spec:** `specs/claude-agent-sdk-upgrade-0.3.268/01-ideation.md` — this spec has no
`02-specification.md`. The research set served as the specification:
`research/runtime-upgrades/claude-agent-sdk/0.3.224-to-0.3.268/changelog.md`,
`impact-assessment.md` and `triage-decisions.md`.
**Tracker:** none — shipped directly from the ideation and the triage decisions.

## Progress

**Status:** Implemented — all tasks shipped, all PRs merged.

## What shipped

`@anthropic-ai/claude-agent-sdk` moved from 0.3.224 to 0.3.268 — 35 published
releases — in three deliberate PRs plus a follow-up, so that a version bump, a
correlation change and a usage change never rode in on each other.

| PR    | What it delivered                                                           |
| ----- | --------------------------------------------------------------------------- |
| #1798 | The bump itself, and every fix the bump needed                              |
| #1802 | Turn correlation from the SDK's full list of answered messages              |
| #1803 | Thinking tokens, the pricing basis, and the in-session tool server timeout  |
| #1806 | Two follow-ups: the conformance realpath compare, and the docs registry gap |

### #1798 — the bump and its in-bump fixes

- **Task and to-do tools** are requested explicitly with `CLAUDE_CODE_ENABLE_TODO_TOOLS=1`
  in the turn env. Newer models stopped getting them by default, and the whole Tasks
  surface is built by watching those tools — it would have gone empty in silence.
- **Three new assistant error values** get their own cards, so an account on hold, an
  account needing verification and refused cloud credentials each say what happened.
- **Plugin delivery moved to stdin**, so a session with a long plugin list no longer
  hits the command line's length limit.
- **A `kind` context filter** and a **provisioned-CLI version gate**: a `claude` copy
  DorkOS downloaded is replaced when it is older than the version DorkOS runs, instead
  of being used and failing every turn that has a plugin enabled.
- **The zod/record workaround.** From SDK 0.3.257 with zod 4.5.3+, a `z.record()`
  anywhere in an in-session tool's schema makes `tools/list` throw for the whole
  server, handing the model zero DorkOS tools with no error. Four of ninety-one tools
  carried one. Mitigated with `z.object({}).catchall(...)` in those four schemas, with
  its costs written down in `packages/shared/src/connector-schemas.ts` and an expiry
  recorded in `runtime-deps.json`: revert once upstream
  `anthropics/claude-agent-sdk-typescript#454` is fixed.

### #1802 — turn correlation

`session-turn-windows.ts` now reads the plural `user_message_uuids` as a union with the
singular field, so a reply that answered three messages closes all three windows.
`queued_turn_count` may only ever **lengthen** a wait — it is a snapshot taken as the
result is built, so a `0` is "no new reason to wait", never "close now". A failed turn
names its dispatch and takes the same short grace. `resume_reason` and `local_command`
name the two legitimate synthetic windows so they log by name instead of warning.

### #1803 — usage and context

`thinkingTokens` and `costBasis` reach `ModelUsage`; the summed total takes the weakest
claim of the set, so a figure DorkOS cannot price says it is an estimate. The in-session
tool server states its own timeout, derived from the approval hold cap and the relay
wait budget, which let the `MCP_TOOL_TIMEOUT` environment floor be removed rather than
kept beside it.

## Accepted deviations

- **`getContextUsage({ detail: 'summary' })` was measured and rejected.** It saves no
  time (the CLI keeps its counts, so the work is paid once per session) and its
  breakdown attributes the wrong rows — same total, conversation tokens banked against
  system tools. `'full'` is kept and now passed explicitly, so a later default flip
  cannot quietly decide it.
- **`queuedTurnCount` is not on the wire.** It was built as a field on the terminal
  `done` event and removed in review: every queue surface counts DorkOS's own durable
  queue, which answers the same question better, and a schema field nobody reads is the
  declared-and-unreachable shape `REVIEW.md` rejects.
- **Multi-turn shell cwd accepted** (an agent's `cd` outlives its turn) and
  **`interrupt()` scope kept at the default** (stop means stop, background subagents
  included). Neither is caught by a compiler, so both are recorded in
  `contributing/adding-a-runtime.md`.

## Follow-ups

- Check upstream #454 on the next bump and revert the `catchall` swap once it is fixed.
- The four product questions the range raised were split into their own specs and all
  four shipped the next day: `plugin-reload-cache-cost`,
  `unattended-session-permission-prompts`, `auto-mode-classifier-context`,
  `ambient-background-tasks`.
