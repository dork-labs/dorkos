---
slug: unattended-session-permission-prompts
id: 260911-191243
created: 2026-09-12
status: specified
---

# Sessions with nobody to answer

**Status:** Specified
**Date:** 2026-09-12
**Ideation:** `specs/unattended-session-permission-prompts/01-ideation.md`
**Decisions taken with the operator:** 2026-09-12

## Intent

A scheduled run that needs permission at three in the morning should be told at
once that nobody is there, instead of waiting ten minutes for an answer that
cannot arrive and then refusing itself. The runtime now offers
`permissionPrompts: 'none'`, which auto-denies the runtime's own permission
prompts without touching auto mode's classifier. DorkOS sets it on exactly the
surface where an ask is a dead letter — the task scheduler's runs — and changes
nothing anywhere else.

## Framing correction

The ideation proposed extending the `unattended` flag to room turns, and asked
(open decision 2) whether a bridged Telegram or Slack sender should be treated
differently. **Both are withdrawn.**

"Unattended" already means exactly one thing in this codebase
(`messaging/interaction-wait.ts`): a pending ask refuses after ten minutes
instead of parking for four hours, and only the task scheduler sets it. A room
turn's ask **does** surface and **is** answerable from the app —
`room-turn-runner.ts` tracks each `approval_required` and its resolution — so by
the codebase's own rule, "can anybody answer this?", a room is answerable. The
same file already records the matching decision for relay: a relay-bound turn is
deliberately not unattended because its prompt is answerable from chat
(DOR-1440).

So rooms keep the wait. **The ideation doc's proposal to flag rooms is
withdrawn**, and with it the bridged-sender question, which is moot once rooms
are not flagged. This spec extends the flag to nothing; it only changes what the
flag does where it is already set.

## Resolved design

### 1. Surfaces — scheduled runs only

`permissionPrompts: 'none'` is set for sessions the task scheduler starts with
`unattended: true`. Rooms and relay keep today's wait. No surface gains the flag.

_Reason:_ the flag should mark the one surface where an ask reaches nobody, and
rooms and relay both publish their asks somewhere a person can answer.

### 2. Bridged senders — moot

No rule. A room turn raised by a bridged Telegram or Slack sender behaves
exactly like any other room turn.

_Reason:_ the question only existed if rooms were flagged, and they are not.

### 3. Independent of the operator's trust level

Whether the operator accepted full power or declined it changes nothing here.

_Reason:_ the trust level decides what gets asked; this decides what happens to
a question nobody can hear.

### 4. Auto-denials reported in the run result and the activity feed

Each auto-denied ask appears in the scheduled run's result and in the activity
feed. No push notification is sent.

_Reason:_ the morning report is where a person looks for what a night run did;
a phone buzz for a refusal nobody could have prevented is over-participation.

### 5. The ten-minute wait goes away where the flag is set

On a scheduled run the runtime's own prompts are refused at once via
`permissionPrompts: 'none'`. The ten-minute countdown no longer runs there.

_Reason:_ ten minutes on a surface with nobody watching buys a chance that is
zero by construction, and holds one of twelve session slots while it does.

### 6. The run continues, with the tool refused

A denial does not stop the run. The refusal text tells the agent that nobody was
there to approve the call and that it should report what it could not do; the
run's result names each refused ask.

_Reason:_ today's behavior already continues past a refusal, and a run that
half-finished with a named list of blocked steps is more useful than one that
stopped at the first.

### 7. DorkOS's own capability approvals are unchanged

Approvals that travel through `core/mcp-tool-gate.ts` stay on the late-verdict
path, where an answer that arrives hours later still wakes the session that
asked (ADR `260909-123910`). Only the runtime's own prompts go to instant deny.

_Reason:_ the late-verdict machinery is new, it works, and pre-empting it would
throw away the one path where a delayed answer still counts.

### 8. Global rule, no per-task override

Every scheduled run behaves this way. There is no per-task or per-room setting.

_Reason:_ a per-task exception is a setting nobody would ever set correctly for
a run they are asleep through.

## Affected files

- `apps/server/src/services/runtimes/claude-code/messaging/interaction-wait.ts` —
  the `unattended` flag on the wait options (line ~165) and the unattended
  branch that arms a single ten-minute expiry (line ~475). With the runtime
  refusing its own prompts at once, that branch stops seeing runtime prompts;
  its doc comment (lines ~381–444), which already records the relay decision,
  gains the matching record for rooms.
- `apps/server/src/services/tasks/task-scheduler-service.ts` — line ~1276, the
  one place `unattended: true` is set, and the source of the run result that
  must now name each refused ask.
- `apps/server/src/services/runtimes/claude-code/messaging/launch-resolver.ts` —
  where the launch options are assembled; `permissionPrompts: 'none'` is set
  here when the session carries the unattended flag.
- `apps/server/src/services/core/mcp-tool-gate.ts` — unchanged, and pinned as
  unchanged by a test: DorkOS capability approvals keep the late-verdict path.
- `apps/server/src/services/activity/activity-service.ts` — the record written
  for an auto-denied ask.

## Acceptance criteria

1. A scheduled run whose agent asks the runtime for permission is refused
   immediately; the run's transcript shows no ten-minute wait and no
   "waited 10m" line.
2. The refusal text tells the agent that nobody was available to approve and
   asks it to report what it could not do.
3. The run continues after the denial and finishes; the run's result lists every
   refused ask by name.
4. Each auto-denied ask appears in the activity feed. No push notification is
   sent for it.
5. A room turn that raises an ask still surfaces it, still waits, and is still
   answerable from the app — behavior identical to before this change.
6. A relay-bound turn's behavior is likewise unchanged.
7. A DorkOS capability approval raised inside a scheduled run still mints a
   durable approval and still wakes the session when a verdict arrives later.
8. Setting or clearing full power changes none of the above.
9. There is no per-task, per-agent or per-room control for this behavior
   anywhere in the API or the UI.

## Test plan

- **Unit, launch-resolver:** a session with `unattended: true` resolves options
  carrying `permissionPrompts: 'none'`; a session without it carries `'host'` or
  leaves the option unset.
- **Unit, scheduler:** a scheduled run whose fake runtime raises a permission
  prompt completes with the tool refused and the ask named in the result.
- **Unit, refusal copy:** the refusal sentence is pinned by a test.
- **Unit, rooms and relay:** a room turn and a relay-bound turn each still park
  or wait exactly as today; assert `permissionPrompts` is not `'none'` for them.
  This is the regression guard for the withdrawn proposal.
- **Unit, capability gate:** a destructive DorkOS tool called inside a scheduled
  run still returns `approval_required` and still resolves on a late verdict —
  the instant-deny path must not reach it.
- **Unit, activity:** one record per auto-denied ask, none for a normal denial.

## Out of scope

- Changing which actions need permission at all — that is the trust ladder, and
  it is settled.
- The permission mode an unattended surface runs in (ADRs `260822-235759`,
  `260822-235802`, `260908-170643`).
- Notification routing and phone delivery.
- Codex and OpenCode. The option belongs to one runtime; the classification of
  which surfaces are unattended is shared, and stays where it is.
- Extending the `unattended` flag to any new surface.

## Dependencies

- `specs/claude-agent-sdk-upgrade-0.3.268/` (PR #1798) — the option does not
  exist below 0.3.259.
- ADR `260909-123910` — a late approval verdict wakes the session that asked;
  the reason decision 7 leaves the capability path alone.
- ADR `260908-170643` — unattended surfaces follow the operator's level.
