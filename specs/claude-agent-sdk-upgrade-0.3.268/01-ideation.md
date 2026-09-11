# Claude Agent SDK Upgrade: 0.3.224 → 0.3.268

## Problem Statement

We are running `@anthropic-ai/claude-agent-sdk` at 0.3.224. 0.3.268 is 35
published releases ahead, with 25 breaking changes (15 type/contract, 10
behavioral), zero deprecations, 42 new features and 19 fixes — five of which
resolve failure modes DorkOS is exposed to today.

Zero of the breaking changes break the build. That is the problem, not the
reassurance: this range contains the worst shape of change for a host like
DorkOS, where a tool the model used to have by default is now absent unless
asked for and **nothing anywhere reports it**. The task and todo tools left the
default surface on every model newer than Opus 4.7 / Sonnet 4.6 / Haiku 4.5, and
DorkOS builds its entire Tasks and to-do surface by watching those exact tool
names go past. Left alone, the bump would empty a whole product surface in
silence — no error, no log line, and no failing test, because every fixture keeps
feeding the blocks a real model would have stopped sending.

Three more silent gaps ride with it: three new assistant-error values that a
hand-maintained set drops on the floor, a documented invariant in the turn
correlation subsystem that just flipped, and an unbounded plugin command line
that Windows refuses past a certain plugin count.

## Research

- Changelog: `research/runtime-upgrades/claude-agent-sdk/0.3.224-to-0.3.268/changelog.md`
- Impact assessment: `research/runtime-upgrades/claude-agent-sdk/0.3.224-to-0.3.268/impact-assessment.md`
- Triage decisions: `research/runtime-upgrades/claude-agent-sdk/0.3.224-to-0.3.268/triage-decisions.md`
- Abort-predicate re-derivation: `research/20260903_claude-cli-aborted-refusal-shapes.md`
- Predecessor: `specs/claude-agent-sdk-upgrade-0.3.224/`

## Scope

### Must Do

- Bump 0.3.224 → 0.3.268 across **all seven** pin sites. The previous spec's table
  listed six; `CLAUDE_SDK_VERSION` in `claude-code/tooling/provision.ts` is the
  seventh and its own test goes red when it drifts
- Set `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` in the turn env, and record the decision
  beside the subagent-depth one. Neither `allowedTools` (an auto-approval list —
  DOR-519) nor `tools` (a base tool set this codebase has never taken a position
  on) is an acceptable substitute
- Add `account_on_hold`, `verification_required` and `cloud_credential_error` to
  `SURFACED_ASSISTANT_ERRORS` with plain-language copy for each. Absent from that
  set, all three end the turn with no card at all
- Correct the `session-turn-windows.ts` passages that state `SDKResultError`
  carries no `user_message_uuid`. The code reads the field defensively and is
  fine; the recorded reasoning is now false, and the next person to edit that
  module would edit it against a false premise
- Decide and record the two behavioral changes with no code: multi-turn cwd
  persistence (0.3.265) and `interrupt()`'s stop scope (0.3.246)
- Re-derive all five non-import couplings against the 0.3.268 bundle, and re-run
  the two-server 401 harness behind `mcp-revocation.ts` — unverified live for two
  bumps, and its committed fixture passes no matter how stale it gets
- Verify by **one live turn on a current model**, not by the suite. The task/todo
  regression is invisible to every test in the repo

### Should Do

- `pluginDelivery: 'initialize'` (0.3.261) — upstream ships it as the fix for
  Windows start failures with many plugins, which is exactly the failure ADR-0239's
  design creates: an argv that grows with a person-controlled plugin count, on the
  one platform whose desktop build has no confirmed end-user install to notice
- `SDKContextUsageCategory.kind` (0.3.268) replacing the CLI display-string match in
  `sdk/context-usage.ts`, with a deliberate ruling on the compaction buffer
- Replace every `sdk.d.ts:LINE` citation with a symbol name. `sdk.d.ts` grew
  7429 → 8978 lines in this range alone and every citation now points at unrelated
  text — the second bump in a row to invalidate all of them
- Rebuild `.claude/config/runtime-deps.json`'s surface map from a parse of the real
  imports rather than patching it

### Nice to Have

- Nothing. Everything else this range offers is either its own PR (turn
  correlation, usage fields) or its own spec (see below)

## Out of Scope

- **PR B — turn correlation.** `user_message_uuids`, `queued_turn_count`,
  `resume_reason` / `local_command` / `result_index`, and the `user_message_uuid` on
  `thinking_tokens` system messages. One subsystem, one set of tests, and materially
  better correlation than the inference it replaces — which is exactly why it should
  not ride in on a version bump
- **PR C — usage and context.** `ModelUsage.thinkingTokens` and `costBasis`, an
  evaluation of `getContextUsage({ detail: 'summary' })` against `'full'`, and
  `createSdkMcpServer({ timeout })`
- **Separate specs**, each a product question rather than an adoption:
  `Query.reloadPlugins({ holdOnCacheImpact })`; `permissionPrompts: 'none'`;
  `classifierContext` on `PostToolUse` hooks; `ambient` / `spawn_depth` on task
  events
- The 29 low-relevance items enumerated in the impact assessment

## Risk Assessment

**Medium–high**, and the risk is entirely in what no compiler and no suite can
see. The type surface is additive and the peer deps, `engines.node`, `exports` map
and the eight platform packages are all unchanged. What makes this bump different
from the last one is that its behavioral changes are not "decide and document" —
one of them is "fix or lose a feature", on a surface that fails quietly.

Second-order risk: this range moves the bundled CLI binary 44 times, and four of
the five non-import couplings read that binary. None of their tests can go red on
a stale anchor, so the only protection is re-deriving them by hand on every bump.

## Rollback Criteria

Revert to 0.3.224 if any of:

- the conformance suite fails and the cause is not a test-mock update;
- the todo/task surface stays empty after the env var is set;
- sessions fail to resume (implicates `resumeSessionAt` or the project-slug mapping);
- the persistent pump strands a turn window open (implicates the `user_message_uuid`
  cadence change);
- MCP servers fail to connect, or report a status shape `mcp-revocation.ts` cannot
  read;
- plugin activation stops loading commands or skills under
  `pluginDelivery: 'initialize'`;
- the desktop app cannot spawn its bundled binary.

The pin is the whole migration, so a revert is one commit and nothing is one-way.
