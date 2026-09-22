# Triage Decisions

**Date**: 2026-09-22
**Decided by**: Dorian (operator), on the `/app:runtime-upgrade` analysis in
[`impact-assessment.md`](./impact-assessment.md); implemented autonomously
**Shape**: one PR for the bump and its must-fixes, four separate specs.

## The bump PR

- [x] Version bump 0.3.268 → 0.3.280 across **all seven** pin sites (root `pnpm.overrides`,
      `apps/server`, `apps/desktop` + its `-darwin-arm64` / `-win32-x64` optional deps,
      `packages/cli`, `CLAUDE_SDK_VERSION` in `claude-code/tooling/provision.ts`). Typecheck
      was clean with no code change, as the assessment predicted.
- [x] **Opus 5.5**: zero code. Moving `CLAUDE_SDK_VERSION` invalidated the model disk cache
      and the warm-up read the new catalog (see live evidence below).
- [x] **Per-turn usage (must-fix)**: `sdk/turn-usage.ts` differences each result's running
      totals against a per-session ledger (`AgentSession.usageLedger`). Details and evidence
      below.
- [x] **MCP provenance (0.3.274)**: `isHostServedOrUnattributed` in
      `mcp-tools/tool-exposure.ts`. The `canUseTool` auto-allow in
      `messaging/interactive-handlers.ts` and the classifier-context hook in
      `messaging/classifier-context.ts` now also require `source === 'sdk'` when provenance is
      present. Absent provenance (non-MCP tools, older CLIs) keeps today's behavior. Tests cover
      `sdk`, absent, and four foreign sources including an unknown one.
- [x] **Empty queued results (0.3.274)**: no code change; evidence says it is benign. One
      windower test pins the observed shape.
- [x] **Elicitation `requires_action` + cancel-on-tool-end (0.3.280)**: no code change;
      evidence below.
- [x] `.claude/config/runtime-deps.json`: surface map re-derived (27 symbols, 45 files;
      `Query` + `claude-code-runtime.ts`; `SDKMessage` + `messaging/process-quiet.ts`;
      `tool()` 11 files; `HookCallback, HookJSONOutput` added), #454 note re-dated, three new
      upgrade notes (running totals, alias-based catalog, provenance), every coupling re-stamped,
      the abort suppression set recorded as four.
- [x] Two-server 401 harness re-run live, committed as a third fixture and replayed.
- [x] Aborted-refusal research file: "Re-run on 0.3.280" section appended.
- [ ] **ADR-0261 wording: not changed.** The plan-mode claim (writes route to `canUseTool`
      under `allowDangerouslySkipPermissions`) was not demonstrated live in this PR, so the
      ADR is left as it is.

## Per-turn usage: the evidence

A two-turn streaming-input query on haiku, then a resume of the same session in a new query
(scratch probe, real turns, 2026-09-22). `modelUsage` input tokens per result:

| SDK     | warm turn 1 | warm turn 2 | resumed turn | per-turn `usage.input_tokens` |
| ------- | ----------- | ----------- | ------------ | ----------------------------- |
| 0.3.268 | 4252        | 7699        | 3535         | 3352 / 3447 / 3535            |
| 0.3.280 | 4252        | 7684        | 11196        | 3352 / 3432 / 3512            |

- **Warm multi-turn sessions already over-counted at 0.3.268.** Turn 2 reported the running
  total (7699) as one turn. The `.d.ts` had said so since before 0.3.268 ("cumulative across
  turns in streaming-input sessions"). So the gen_ai.\* per-turn figures were wrong from the
  second warm turn on, on every SDK DorkOS has shipped since the pump.
- **0.3.277 made resumes carry the totals** (11196 = all three turns). The resume-per-message
  path would have reported the whole session on every turn.
- **A transcript written by 0.3.268, resumed at 0.3.280, restarts at zero** (observed: 3616
  input tokens on a session that had spent 7699). The ledger treats any drop as a restart.
- **Unknown baseline** (a resumed session this process holds no ledger for, e.g. after a
  server restart): no turn figure is emitted for that one turn. `turnCostUsd` is also absent
  there, so the observability seam falls back to the running `costUsd` for that turn only.
- The session's running `costUsd` (the Usage & cost item) is unchanged and now continues
  across resumes instead of restarting at zero.

## Empty queued results: the evidence

Two background Bash tasks finishing together after the person's turn had closed, on 0.3.280:
the first completion produced `{subtype:'success', num_turns:0, result:'', result_index:1}`
with **no `user_message_uuid(s)`**, then the real answer (`num_turns:1`, also unnamed). With
no window open, each lands on row 2 of `session-turn-windows.ts`'s table as a runtime-origin
window, and runtime windows skip the zero-content error (`suppressEmptyTurnError`). Pinned by
`session-turn-windows.test.ts` ("gives an empty queued-completion result (SDK 0.3.274) a quiet
runtime turn of its own"). The race where a person dispatches while completions drain is the
existing DOR-2064 shape (unnamed result, empty user window, held toward the cap) and was not
changed.

## Elicitation: the evidence

- `requires_action` during an elicitation: `system-event-mapper.ts` already maps
  `session_state_changed` including `requires_action`; strictly more accurate, no change.
- Cancel-on-tool-end: in the 0.3.280 binary, aborting a pending control request (elicitation
  included) enqueues `control_cancel_request` for its `request_id`; in `sdk.mjs`,
  `handleControlCancelRequest` aborts that request's `AbortController`, which is the `signal`
  handed to `onElicitation`. DorkOS's `handleElicitation` already tears the card down on that
  abort (existing test). Read statically; not exercised live.

## Live evidence (2026-09-22)

- **Opus 5.5 row**: server from this worktree on :6391 (scratch `DORK_HOME`); disk cache
  `sdkVersion: 0.3.280`; `GET /api/models` on this account lists `default` →
  `claude-opus-5-5[1m]` ("Default (recommended)") and `opus[1m]` → `claude-opus-5-5[1m]`
  ("Opus (1M context)"), plus Fable, Sonnet, Haiku. This account's catalog has no plain `opus`
  row (it had one at 0.3.268).
- **Real turn**: a session set to `opus[1m]`, one message through `POST /messages`; the
  durable stream reported `model: claude-opus-5-5[1m]` and the reply "I'm Opus 5.5, the
  1M-context version."
- **401 harness**: see `apps/server/src/services/mesh/mcp-revocation.ts` ("Re-run live
  2026-09-22 against 0.3.280") and the third fixture. All three probe servers, the
  `.mcp.json` one included, were `failed` in the first `system/init` frame.

## Separate specs

| Spec                                                                                                    | Covers                                                            |
| ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| [`claude-structured-startup-errors`](../../../../specs/claude-structured-startup-errors/01-ideation.md) | `startup_failure_reason` + the carried-forward `api_error_status` |
| [`verbatim-delivered-prompts`](../../../../specs/verbatim-delivered-prompts/01-ideation.md)             | per-message `client_composed` for room, relay and scheduled text  |
| [`mcp-apps-read-through-cli`](../../../../specs/mcp-apps-read-through-cli/01-ideation.md)               | `readMcpResource` + `tools[]._meta` for the MCP Apps host         |
| [`worktree-project-config-root`](../../../../specs/worktree-project-config-root/01-ideation.md)         | `Options.projectConfigRoot` for agents running in worktrees       |

## Skipped

- `fireReason` + `CLAUDE_CODE_HOST_SCHEDULED_RUN`: model-visible framing change nobody asked
  for; revisit if scheduled-run prompts show framing problems.
- The 19 low-relevance items listed in the assessment.

## Carried forward to the next bump

- #454 (`z.record` / `z.json` in tool schemas) still open; keep the `catchall` swap.
- Plan-mode gating (0.3.269) and the ADR-0261 wording: one live plan-mode write attempt.
- A deferred-tool MCP server reading `pending` in the first frame is still possible by the
  release note; not observed.
