# Triage Decisions

**Date**: 2026-09-11
**Decided by**: Dorian (orchestrated `/app:runtime-upgrade` run)
**Companions**: `impact-assessment.md`, `changelog.md` in this directory

## Included in Upgrade Spec

- [x] Version bump `^1.18.15` → `^1.18.30` across `apps/server`, `apps/desktop`, `packages/cli` (all three move together — `scripts/__tests__/dependabot-lockstep-families.test.ts` enforces parity)
- [x] Bump `OPENCODE_PACKAGE_VERSION` in `apps/server/src/services/runtimes/opencode/providers/provision.ts` to `1.18.30` — the lockstep sidecar pin, load-bearing three ways (re-provisioning, the drift warning, and the `requiredVersion` the readiness check shows the user)
- [x] **B1 fix**: teach `events/subagent-mapper.ts` to read through opencode 1.18.20's new subagent failure envelope before deciding stopped-vs-failed (see below)
- [x] ADR-0308 Status line + a dated bump note
- [x] `__tests__/check-dependencies.test.ts:126`'s inline pin comment
- [x] Replacement `sdk_surface_map` for the opencode entry in `.claude/config/runtime-deps.json` (every path re-verified against the 13 production imports), plus a fourth `upgrade_note` recording that this adapter matches upstream error TEXT and no type diff can police it
- [x] A real sidecar-pin parity assertion in `scripts/__tests__/dependabot-lockstep-families.test.ts` (see "Guard that was claimed but did not exist")

## B1 — Subagent stop text: CONFIRMED changed, fixed

The impact assessment flagged this as the one item that could turn a user's own
stop into a red "failed" card. It was real.

**What changed upstream.** opencode 1.18.20 added two failure branches to the
task tool (`packages/opencode/src/tool/task.ts:213-223` at tag `v1.18.30`), both
of which fail with a new envelope:

```
Subagent failed (task_id: <child session id>): <inner message>
```

**Why a cancel reaches it.** Cancelling a child session does not interrupt the
caller. The runner catches its own `RunnerCancelled` and RETURNS the child's last
assistant message instead (`packages/opencode/src/effect/runner.ts:65`, fed the
`onInterrupt` value at `packages/opencode/src/session/prompt.ts:1346`), and that
message carries `MessageAbortedError{message: "Aborted"}` stamped by the
interrupt handler (`prompt.ts:1203-1211` → `session/message-v2.ts:612` →
`packages/core/src/v1/session.ts:50`). The task tool's first new branch turns that
into `Subagent failed (task_id: ...): Aborted`, and
`tool/task.ts:339` propagates the text verbatim to the parent's `task` part.
Before 1.18.20 the same cancel produced an empty SUCCESS — which is exactly what
the release note ("surface resumable subagent failures instead of returning an
empty result") describes.

`SUBAGENT_STOPPED_PATTERN` was fully anchored on five exact strings, so it
rejected every enveloped shape and a stop would have rendered as `failed`.

**What we changed.** The mapper now peels the envelopes — the new
`Subagent failed (task_id: ...): ` one and the older `Tool execution failed: `
one, which nest — and classifies the innermost message. `Aborted` joined the stop
shapes, with the source citation it was read from. Genuine enveloped failures
still read `failed`; upstream's own new tests pin two of those strings
(`packages/opencode/test/tool/task.test.ts`), and both are covered by fixtures.

**The five pre-existing stop strings are unchanged at `v1.18.30`**, each
re-verified in source: `Tool execution aborted`
(`packages/opencode/src/session/processor.ts:602`, still alongside
`metadata.interrupted: true`), `Tool execution interrupted`
(`packages/core/src/session/runner/llm.ts:306,314,346`), the
`Tool execution failed: <inner>` wrapper (`llm.ts:321`,
`packages/opencode/src/session/prompt.ts:419`), `Task cancelled`
(`tool/task.ts:340`), and `Cancelled` (`prompt.ts:371`).

**Live leg.** The free arm ran a real 1.18.30 sidecar against a local
`qwen2.5-coder:7b` on ollama, whole conformance suite, nothing billed: 41 passed,
9 skipped, 2 failed. The same two fail identically against a 1.18.15 sidecar —
they are a macOS `/private/var` vs `/var` tmpdir-symlink artifact in the presence
binding assertions, not a bump regression. The suite does not spawn and cancel a
subagent, so it neither confirms nor refutes B1; the source trace above is the
evidence, and a live cancel capture against 1.18.30 would still be worth folding
into `__tests__/fixtures/live-cancel.jsonl` when one is next taken.

## Guard that was claimed but did not exist

`dependabot-lockstep-families.test.ts` commented that the sidecar pin was kept in
step "by that file's own test". No such assertion existed — `provision.test.ts`
and `check-dependencies.test.ts` both derive their expectations FROM the constant,
so they pass at any value — and the comment named a path that had moved.
`provision.ts`'s own TSDoc states the coupling as equality ("pinned to match the
`@opencode-ai/sdk` already depended on by the server"), and all three of the pin's
uses treat it as truth, so equality is the repo's stated rule and the assertion
was written rather than the claim softened. It lives in the family test (which
already reads every manifest with real `fs`; `provision.test.ts` mocks `node:fs`
and cannot), reads the constant out of the source, compares it to the declared
SDK version, and fails loudly if the constant is renamed or the file moves.
Mutation-checked: setting the pin to `1.18.29` reds it.

## Recorded Behavior Change (no code change, but user-visible)

**A subagent whose last child tool ended in error now fails the parent's `task`
call.** This is the second branch 1.18.20 added
(`packages/opencode/src/tool/task.ts:220-222` at tag `v1.18.30`): upstream now
inspects the child's parts and fails on a terminal errored tool part, where
1.18.15 returned the child's last text and the call read `completed`.

Nothing in DorkOS needs changing — the mapper classifies it `failed`, which is
what it is — but it ships in the same release as the bump and it is visible: a
subagent card that used to go green after a tool error it wrote around now goes
red. It is written up as a `### Changed` bullet in this PR's changelog fragment
rather than left as an internal note, because the first person to notice will be
an operator wondering what broke.

## Features Adopted

- None. No high-relevance features in the range; the four additive items
  (Cloudflare AI Gateway passthroughs, Azure Entra ID sign-in, the Copilot
  session-ID header, Astra/`gpt-6` catalog entries) are all none/low relevance and
  flow through already-typed surfaces with no DorkOS code path.

## Watch Items (recorded, not acted on)

- **B2 — five-minute provider header and chunk timeouts (1.18.27).** Every
  provider request now has a hard ceiling on silence. Net positive: a hung
  provider fails in five minutes with an error DorkOS can render instead of
  holding a turn open forever. The new failure mode is a model that thinks for
  more than five minutes without emitting a chunk. No code change; if operators
  start reporting five-minute turn failures, `chunkTimeout: false` in the sidecar
  config is the escape hatch. It does **not** settle
  `specs/ask-parks-on-timeout` §14's open question about approval parking —
  during a park there is no provider stream in flight.
- The three hand-typed wire shapes (`EventMessagePartDelta`,
  `EventPermissionAsked`, `EventPermissionReplied`) are still pinned to the
  observed 1.18.15 wire and outside what any type diff can certify. Nothing in
  this range suggests they moved.

## Skipped

- No breaking changes on DorkOS's surface and no deprecations. The one formally
  breaking type change (`GlobalUpgradeData.body.target`) is in the `/v2` subpath
  DorkOS never imports, on a method it never calls.
- Version stamps that record LIVE verification were deliberately not swept:
  `events/event-mapper.ts:5`, `runtime-constants.ts:5`,
  `sessions/session-mapper.ts:97,115`. Rewriting them would claim verification
  this upgrade did not perform.
