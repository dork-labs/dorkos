---
slug: ask-parks-on-timeout
id: 260819-023725
created: 2026-08-18
status: specified
tracker: DOR-1350
project: Unified Conversation Surfaces
---

# An Ask that times out parks the agent instead of refusing for it

**Status:** Draft
**Author:** Claude (IDEATE+SPECIFY author, DOR-1350)
**Date:** 2026-08-18

## Overview

An unanswered agent prompt stops being a refusal and becomes a wait. At ten
minutes the countdown ends, the agent says it is waiting, and the turn stays
open. At four hours it gives up, and says how long it waited.

Nothing about the first ten minutes changes: the same card, the same countdown,
the same urgency colours. What changes is what happens after them.

## Background / Problem Statement

`SESSIONS.INTERACTION_TIMEOUT_MS` is 10 minutes (`config/constants.ts:171`).
Three `setTimeout`s in `services/runtimes/claude-code/messaging/interactive-handlers.ts`
(`:686`, `:766`, `:1022`) and one in `services/runtimes/opencode/approvals.ts:116-122`
enforce it. When one fires, the model is handed a denial it did not earn, the
agent carries on and either gives no answer or a bad one, and the only record
that survives is a `warn` line with `visibility: 'silent'`
(`interactive-handlers.ts:530-549`).

The cost is measured. In DOR-784 two agents hit this twice each, invisibly,
inside one forty-one minute silence; reconstructing it afterwards took the SDK
transcripts, because the server log had nothing. Ten minutes is a lunch, a
meeting, or a school run.

The `unified-conversation` programme made the prompt findable on five surfaces
plus the room lane and the header pill (ADR `260818-002803`) and left it
impatient on purpose. Its closing record calls this "the single most valuable
follow-on" (`specs/unified-conversation/04-implementation.md:745, 770`).

**The belief the ten minutes rested on is false.** The Claude Agent SDK
documents an indefinite hold on a permission decision as a supported, recoverable
state of its own loop — see Technical Dependencies. Nothing in the SDK forces a
deadline; the deadline is entirely DorkOS's.

## Goals

- An unanswered prompt waits for the person instead of guessing for them.
- The wait is visible: a card that says the agent is waiting, not a card that
  counted to zero and vanished.
- Every DorkOS bound that a park could make immortal stays bounded.
- Parity across the runtimes that have an approval channel at all, from one
  change rather than two.
- No change to the first ten minutes, which are already right.

## Non-Goals

- **Notification actions.** Nothing new reaches you when the cockpit is closed.
- **Scope options.** "Allow and don't ask again" still keeps its slot and does
  nothing.
- **Codex parity.** Codex has no approval channel to park
  (`services/runtimes/codex/NOTES.md` Verdict 1). DOR-803 is untouched.
- **A durable receipt for a prompt that did expire.** DOR-1158's live notice
  stays best-effort. Parking removes almost every occasion for it.
- **A park that survives a server restart.** Impossible while the held decision
  lives in a child process of this server.
- **Parking an unattended run.** A scheduled task has nobody coming back to it;
  it keeps today's ten-minute refusal (see Detailed Design §7).

## Technical Dependencies

- `@anthropic-ai/claude-agent-sdk@0.3.224`. Two facts, quoted from its own
  `sdk.d.ts`, are what make this possible:
  - `CanUseTool` (`sdk.d.ts:196-205`): "Fail-closed: an accidental null means no
    control_response is sent and the tool stays blocked indefinitely —
    **permission prompts have no park deadline**."
  - `Query.reinitialize()` (`sdk.d.ts:2436-2450`): after a transport gap "the
    CLI's response carries any `can_use_tool` / `request_user_dialog` control
    requests **the loop is still blocked on**, and the SDK redelivers them."
    Every other `timeout` in that file is an MCP tool-call timeout, a hook timeout
    or a session-store load timeout. None reaches `canUseTool`.
- `@opencode-ai/sdk` 1.18.15 sidecar, for the OpenCode half. Whether the sidecar
  applies an expiry of its own to an unanswered `Permission` is **unverified**
  and is the one live check this spec owes (see Open Questions).
- No new packages.

## Detailed Design

### 1. The shape of the change: parked is derived, never announced

A prompt is **parked** when it has been pending longer than the budget it
declared. That is a function of two numbers the system already carries —
`startedAt` and `timeoutMs` — so it is computed, not stored, not broadcast, and
not folded.

This is the decision that keeps the change to one pull request. The alternative,
an `interaction_parked` event flowing runtime → normalizer → projector →
fan-out, would need a new session-stream member, a normalizer arm, a projector
arm, an entry mutation, and an injection seam OpenCode's generator-shaped
approval pass does not have. Deriving it costs one expression in the one selector
that already owns this question, and OpenCode gets parity from a constant.

Two invariants make the derivation safe on both sides of the wire:

- **The server never lists an expired interaction.** `listPendingInteractions`
  drops any entry at `remainingMs <= 0` (`pending-interactions.ts:78`). So on the
  client, an Ask it was given whose local countdown has run out is parked, by
  definition. No clock agreement is required.
- **The budget the remainder is measured against is the budget that ships.**
  That rule is already written into the selector's TSDoc (`:69-73`) and is what
  DOR-810 and DOR-1330 cost. Parking changes the budget, so it changes it there
  and only there.

### 2. The constant

`apps/server/src/config/constants.ts`, in `SESSIONS`, immediately after
`INTERACTION_TIMEOUT_MS`:

```ts
  /**
   * How long a prompt nobody answered waits before it is finally refused
   * (spec `ask-parks-on-timeout`).
   *
   * `INTERACTION_TIMEOUT_MS` above is no longer when the agent gives up; it is
   * when the agent stops counting down and starts waiting. This is when it
   * gives up. The first ten minutes look exactly as they did — a live
   * countdown, the urgency bands, "answer this now" — and past them the card
   * says the agent is waiting and the turn stays open.
   *
   * **Why there is a ceiling at all, when the SDK has none.** A held permission
   * decision is indefinite as far as the Claude Agent SDK is concerned
   * (`sdk.d.ts:196-205`). Three DorkOS bounds are not:
   *
   * 1. `SessionStateProjector.hasPendingInteractions` bounds a pending entry on
   *    purpose, because an entry CAN strand and a stranded entry read as "still
   *    waiting" would make the stall watchdog and the session write-lock
   *    immortal (DOR-782).
   * 2. A session RECORD is evicted at `TIMEOUT_MS`, which a park has to be
   *    exempt from, and an unbounded exemption is an unbounded map.
   * 3. A session parked on a person declines every warm reap
   *    (`session-pump.ts:461`) and only WARM pumps are reclaim candidates, so N
   *    parked sessions shrink the twelve-slot ceiling by N. At twelve, every new
   *    agent launch on the machine is refused — and the person who hits that
   *    refusal is not the person who walked away.
   *
   * **Why four hours.** Twenty-four times the countdown. It covers every failure
   * on record with a wide margin — DOR-784's forty-one minutes, a lunch, a
   * meeting, a school run — and it keeps a machine abandoned at six in the
   * evening from still holding twelve subprocesses at midnight. A number in days
   * would trade a real resource ceiling for a case nobody has reported.
   */
  INTERACTION_PARK_CEILING_MS: 4 * 60 * 60 * 1000,
```

`INTERACTION_TIMEOUT_MS`'s own comment changes from "Interactive tool
approval/question timeout (ms)." to name what it now is: the countdown, after
which the prompt parks.

### 3. The selector — `services/session/pending-interactions.ts`

The only change to how "what is pending" is computed. Inside the loop, replacing
lines 76-86:

```ts
// Parked is DERIVED, never stored: a prompt that has outlived the budget it
// declared is one nobody answered in time, which is exactly the condition
// the runtime's own park timer fires on. Computing it here rather than
// folding a broadcast event means every runtime that can raise a prompt
// parks, and there is no second copy of the rule to drift (spec
// `ask-parks-on-timeout` §1).
const declaredMs = dto.timeoutMs ?? SESSIONS.INTERACTION_TIMEOUT_MS;
const elapsedMs = now - pending.startedAt;
const parked = elapsedMs >= declaredMs;
const budgetMs = parked ? SESSIONS.INTERACTION_PARK_CEILING_MS : declaredMs;
const remainingMs = Math.max(0, budgetMs - elapsedMs);
if (remainingMs <= 0) continue;
if (parked) {
  // `timeoutMs` is deliberately DROPPED rather than set to the ceiling. It
  // is what the card draws its draining bar against, and a four-hour bar is
  // a siren for a non-event. The ceiling is real and `remainingMs` still
  // carries it, which is what the stall watchdog and the write-lock read;
  // it is simply not a countdown anybody should be made to watch.
  const { timeoutMs: _budgetNotShown, ...rest } = dto;
  out.push({ ...rest, parked: true, remainingMs });
  continue;
}
out.push({ ...dto, timeoutMs: budgetMs, remainingMs });
```

The module TSDoc gains a paragraph naming its second consumer explicitly: this
function decides the budget for the WIRE and for
`SessionStateProjector.hasPendingInteractions`, so raising the budget here raises
the window the stall watchdog and the session write-lock tolerate. That is
intended and it is bounded; it is not a side effect to be discovered later.

**`hasPendingInteractions` needs no change at all** and that is the point: it
delegates to this selector (`session-state-projector.ts:1488`), so a parked entry
keeps a turn's silence legitimate for four hours and a stranded one is shot at
four hours instead of ten minutes. The window widens; it does not open.

### 4. The wire — `packages/shared/src/schemas.ts`

`PendingInteractionDTOSchema` gains one optional field on **all three** members,
beside `timeoutMs`:

```ts
      /**
       * True once nobody answered inside the budget and the agent is simply
       * waiting (spec `ask-parks-on-timeout`). Stamped by
       * `listPendingInteractions`, never stored and never broadcast as its own
       * event: it is a function of `startedAt` and the budget, and a second copy
       * would be a second answer free to disagree.
       *
       * A parked interaction ships NO `timeoutMs`, so a card draws no bar for
       * it. `remainingMs` still counts down to the park ceiling, which is what
       * the server reads; it is not what the person is shown.
       */
      parked: z.boolean().optional(),
```

No change to `interaction-events.ts`: `InteractionPendingEvent` embeds
`PendingInteractionDTOSchema` verbatim, so the field arrives on the fleet-wide
stream, in `GET /api/sessions/pending-interactions`, and in the per-session
recovery snapshot from one edit.

No new `StreamEventType`, no new `SessionEvent` member, no normalizer arm, no
projector arm.

### 5. The runtime — `services/runtimes/claude-code/messaging/interactive-handlers.ts`

#### 5.1 One timer, two stages

Each of the three handlers currently arms one `setTimeout` that denies. Each now
arms one that parks and re-arms itself to refuse.

A new module-level helper, placed beside `notifyInteractionTimeoutNotice`:

```ts
/**
 * Arm the two-stage wait for one prompt: park at
 * {@link SESSIONS.INTERACTION_TIMEOUT_MS}, refuse at
 * {@link SESSIONS.INTERACTION_PARK_CEILING_MS}.
 *
 * Parking is not a resolution. Nothing is handed to the model, the tool call
 * stays held, and the SDK holds its loop open for as long as the promise stays
 * unresolved (`sdk.d.ts:196-205`). What happens at ten minutes is a sentence to
 * the operator, a log line, and a second timer.
 *
 * **The returned timer is the FIRST one.** It is stored on the pending entry as
 * `timeout` and REPLACED there when it fires, so anything that cancels the wait
 * must read the entry rather than close over this value — see
 * {@link clearInteractionTimer}. Closing over it was the shape that let a
 * cancelled prompt leave its ceiling timer armed to refuse an interaction that
 * had already been answered.
 *
 * **An unattended session never parks.** A scheduled run has nobody coming back
 * to it, so waiting four hours would only stall the run; it refuses at the
 * countdown exactly as it does today (§7).
 *
 * @param session - The session holding the prompt.
 * @param interactionId - The pending entry's key.
 * @param notices - What to say to the operator at each stage.
 * @param log - How to record each stage.
 * @param refuse - Hands the model its refusal and settles the prompt.
 */
function armInteractionWait(
  session: InteractiveSession,
  interactionId: string,
  notices: { parked: string; expired: string },
  log: { kind: 'approval' | 'question' | 'elicitation'; toolName?: string },
  refuse: () => void
): ReturnType<typeof setTimeout>;
```

Its body, in order:

1. `setTimeout(park, SESSIONS.INTERACTION_TIMEOUT_MS)`.
2. `park()`:
   - `const entry = session.pendingInteractions.get(interactionId); if (entry === undefined) return;`
     (answered inside the same tick the timer fired; nothing to say).
   - `logInteractionParked(session, log)`.
   - `notifyInteractionTimeoutNotice(session, notices.parked)` — the existing
     `system_status` push, unchanged in mechanism.
   - `entry.timeout = setTimeout(expire, SESSIONS.INTERACTION_PARK_CEILING_MS - SESSIONS.INTERACTION_TIMEOUT_MS)`.
     The remainder, not a fresh ceiling, so the deadline is
     `startedAt + INTERACTION_PARK_CEILING_MS` — the same instant the selector
     measures against, which is what stops the card and the server disagreeing.
   - **No `interaction_cancelled`, no resolution, no `deny`.** The entry stays in
     `session.pendingInteractions` and the promise stays unresolved.
3. `expire()`: today's timeout branch verbatim — remove the abort listener,
   delete the entry, `logInteractionTimeout`, `notifyInteractionCancelled(…, 'timeout')`,
   `notifyInteractionTimeoutNotice(session, notices.expired)`, `refuse()`.
   The ordering rule in `notifyInteractionTimeoutNotice`'s TSDoc (cancel first,
   notice second) is preserved.

`park` and `expire` are both `unref`'d, for the reason `PendingApprovalStore`
already gives: a wait must never hold the event loop open.

#### 5.2 Cancelling the wait

New helper, and the one correctness trap in the change:

```ts
/**
 * Cancel whichever stage of a prompt's wait is currently armed.
 *
 * Reads the timer off the entry rather than a captured local, because
 * {@link armInteractionWait} REPLACES it when the prompt parks. A closure over
 * the first timer clears a timer that has already fired and leaves the ceiling
 * armed on an interaction nobody is waiting for.
 *
 * @param session - The session holding the prompt.
 * @param interactionId - The pending entry's key.
 */
function clearInteractionTimer(session: InteractiveSession, interactionId: string): void {
  const entry = session.pendingInteractions.get(interactionId);
  if (entry !== undefined) clearTimeout(entry.timeout);
}
```

Every `clearTimeout(timeout)` in the three handlers' `onAbort`, `resolve` and
`reject` closures becomes `clearInteractionTimer(session, id)`, called **before**
`session.pendingInteractions.delete(id)`.

`checkSessionHealth` (`session-store.ts:704-706`) already reads
`interaction.timeout` off the entry, so it clears whichever stage is armed with
no change.

#### 5.3 The log

`logInteractionTimeout` keeps its name and its `logRefusal` call, with two edits:
`waitedMs` becomes `SESSIONS.INTERACTION_PARK_CEILING_MS`, and the message
becomes `'[claude-code] nobody answered in four hours, so this was denied'`
derived from the constant rather than hard-coded.

A sibling is added:

```ts
/**
 * Say that the countdown ran out and the agent is now waiting.
 *
 * `info`, not `warn`: nothing was thrown away. This is the line that makes a
 * long silence explainable to somebody reading the log later — the durability
 * gap DOR-1158 named — and unlike {@link logInteractionTimeout} it reports a
 * state rather than a loss. Nothing from the prompt's INPUT is logged, for the
 * reason its sibling gives.
 */
function logInteractionParked(
  session: InteractiveSession,
  interaction: { kind: 'approval' | 'question' | 'elicitation'; toolName?: string }
): void;
```

It uses `createTaggedLogger('claude-code')` from `lib/logger.js` rather than
`logRefusal`, because nothing was refused. This is the file's first `logger`
import; it goes beside the existing `logRefusal` import at `:11`.

#### 5.4 What the person is told

All copy is plain, in the agent's own voice, and carries no em dashes.

`INTERACTION_TIMEOUT_MINUTES` (`:576`) stays. A sibling is added:

```ts
/** The park ceiling in whole hours, for prose that names the wait. */
const PARK_CEILING_HOURS = Math.round(SESSIONS.INTERACTION_PARK_CEILING_MS / 3_600_000);
```

Six sentences replace three. The park lines (`system_status`, pushed at ten
minutes):

| Kind        | Line                                                                                                                                                                                                                                                            |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| approval    | `I asked to run ${toolLabel} and nobody has answered yet, so I am waiting here until somebody does.`                                                                                                                                                            |
| question    | `I asked you something ${INTERACTION_TIMEOUT_MINUTES} minutes ago and nobody has answered, so I am waiting here. The question was: "${excerpt}"` (the excerpt clause is dropped when there is no first question, exactly as `questionTimeoutNotice` does today) |
| elicitation | `${serverName} asked you something and nobody has answered yet, so I am waiting here until somebody does.`                                                                                                                                                      |

The ceiling lines, replacing today's three:

| Kind        | Line                                                                                                                     |
| ----------- | ------------------------------------------------------------------------------------------------------------------------ |
| approval    | `I waited ${PARK_CEILING_HOURS} hours for an answer about ${toolLabel} and nobody came, so I treated it as declined.`    |
| question    | `I waited ${PARK_CEILING_HOURS} hours for an answer and nobody came, so I moved on.`                                     |
| elicitation | `${serverName} asked you something. I waited ${PARK_CEILING_HOURS} hours and nobody came, so I declined on your behalf.` |

`truncateForNotice` and `toolLabelFor` are reused unchanged.

#### 5.5 What the model is told

`services/runtimes/claude-code/sessions/tool-result-outcome.ts`. The two denial
builders change unit:

```ts
export function questionTimeoutDenial(hours: number): string {
  return `User did not respond within ${hours} hours`;
}
export function approvalTimeoutDenial(hours: number): string {
  return `Tool approval timed out after ${hours} hours`;
}
```

**`TIMEOUT_PATTERNS` (`:110-113`) must be widened in the same commit**, or
`classifyToolResult` stops returning `expired` for a timed-out call and returns
`errored` instead, which is what the transcript's receipt is built from. The
minute forms stay so historical transcripts still classify:

```ts
/** DorkOS's timeout denials, unit-agnostic so a changed budget still reads. */
const TIMEOUT_PATTERNS = [
  /^User did not respond within \d+ (?:minutes?|hours?)$/,
  /^Tool approval timed out after \d+ (?:minutes?|hours?)$/,
];
```

Call sites pass `PARK_CEILING_HOURS`.

### 6. OpenCode — `services/runtimes/opencode/approvals.ts`

One constant, one comment, one TSDoc. `PendingApprovalStore.register`'s timer
(`:116-122`) fires at `SESSIONS.INTERACTION_PARK_CEILING_MS` instead of
`SESSIONS.INTERACTION_TIMEOUT_MS`. Nothing else moves: the store still marks the
id `expired`, the echo is still told apart from a person's refusal, and
`clearSession` still disarms.

The card parks on the client from the same derivation as claude-code's, because
`session-event-mapper.ts:236` advertises `timeoutMs: SESSIONS.INTERACTION_TIMEOUT_MS`
on `approval_required` and that is the budget the selector measures against. It
is left at the countdown deliberately, and the module TSDoc says so: it is the
number a person is counting down against, not the number the sidecar is answered
at.

The module's opening TSDoc (`:13-18`) is rewritten to describe the two stages and
to state honestly what OpenCode does NOT get: **no park notice.** claude-code
pushes a `system_status` line at ten minutes through its own event queue;
OpenCode's approval pass is a generator over the sidecar's stream with no seam to
inject a DorkOS-authored event. The card and the lane park identically; the
transcript line is claude-code's only. Named here rather than discovered later.

### 7. Unattended runs do not park

A scheduled task has nobody coming back to it. Parking one would stall the run
for four hours per ask instead of ten minutes, replacing "quietly spent ten
minutes per ask" (`packages/skills/src/task-schema.ts:77-83`) with something far
worse.

- `SessionOpts` (`services/runtimes/claude-code/sessions/session-store.ts`) and
  `AgentSession` (`services/runtimes/claude-code/agent-types.ts`) gain
  `unattended?: boolean`, defaulting to absent.
- `InteractiveSession` (`interactive-handlers.ts:477-500`) gains the same
  optional field, with a TSDoc saying what it is for: a session nobody is
  watching refuses at the countdown, because a park is a promise that somebody
  will come back and there is nobody to keep it.
- `TaskSchedulerService`'s `ensureSession` call (`task-scheduler-service.ts:633-637`)
  passes `unattended: true`; `SchedulerAgentManager.ensureSession`'s inline
  option type (`:58-61`) gains the field.
- `armInteractionWait` reads it: when `session.unattended === true` it arms one
  timer at `INTERACTION_TIMEOUT_MS` that runs `expire()` directly. Today's
  behaviour, byte for byte.

`packages/skills/src/task-schema.ts:77-83`'s TSDoc gains one sentence saying an
unattended run is the exception, and why.

### 8. Session-record eviction

`services/runtimes/claude-code/sessions/session-store.ts`, `checkSessionHealth`
(`:699-721`). Today a session is deleted at 30 minutes of `lastActivity`
inactivity with no exemption, and `lastActivity` is stamped at creation, at
`message-sender.ts:119` and at `persistent-dispatch.ts:314` — never during a
wait. So today's real ceiling on any wait is 30 minutes from **turn start**, and
a four-hour park without this change would be a lie.

Inside the loop, before the eviction body:

```ts
if (now - session.lastActivity <= this.SESSION_TIMEOUT_MS) continue;
// A session parked on a person is not idle, it is waiting, and evicting it
// throws away the very tool call the person is coming back to answer.
// Bounded by the park ceiling rather than by the interaction, so a
// STRANDED entry cannot make a record immortal: it ages out on the same
// clock the selector and the stall watchdog use. `startedAt`, not a
// parked flag, because the exemption is right for the whole wait, not
// only its second half.
if (isWaitingOnPerson(session, now)) continue;
```

with, beside it:

```ts
/**
 * Is this session holding a prompt somebody could still come back and answer?
 *
 * The one bounded answer for the whole runtime: record eviction here, and the
 * dispatch refusal and warm reap in `persistent-dispatch.ts`, which used the
 * pending map's raw size and so would have refused messages into a session with
 * a STRANDED entry forever.
 *
 * The bound is the wait THIS session actually allows — the park ceiling for a
 * session a person may come back to, the plain countdown for an unattended run,
 * whose prompts never park (§7). So a stranded entry ages out on exactly the
 * clock its own runtime would have refused it on.
 *
 * @param session - The session to weigh.
 * @param now - Server epoch ms.
 */
export function isWaitingOnPerson(session: AgentSession, now: number): boolean {
  const ceilingMs =
    session.unattended === true
      ? SESSIONS.INTERACTION_TIMEOUT_MS
      : SESSIONS.INTERACTION_PARK_CEILING_MS;
  for (const pending of session.pendingInteractions.values()) {
    if (now - pending.startedAt < ceilingMs) return true;
  }
  return false;
}
```

### 9. The client

Three files, all additive.

**`features/ask/lib/format-time-left.ts`.** `formatAskTimeLeft`'s `<= 0` branch
returns the parked words rather than `expired`, and the reason goes in the
TSDoc: the server drops an interaction at `remainingMs <= 0`, so an Ask the
client is still holding whose local countdown has run out is one that parked, not
one that died. A card that says "expired" while the agent is still waiting is the
exact lie this item removes.

```ts
/** What a parked Ask says where its countdown used to be. */
export const ASK_PARKED_LABEL = 'waiting for you';
```

**`features/ask/ui/AskCard.tsx`.** `AskUrgency` (`:50`) loses `'expired'` and
gains `'parked'`; `askUrgency` (`:67-72`) returns `'parked'` at or below zero and
for a `null` `secondsLeft`. `'parked'` renders in `text-muted-foreground`, the
same neutral treatment `'neutral'` already has, because a wait is not an alarm.
The draining bar disappears on its own: it renders only when
`timeoutMs !== undefined` (`:272`), and a parked DTO carries none.

Whichever host computes `secondsLeft` passes `null` when
`interaction.parked === true`, so a card that ARRIVES parked and one that parks
while open read identically.

**`features/conversation/model/lane-state.ts`.** The `ask` rung's shape and
headline are unchanged; the lane's leaf renders `ASK_PARKED_LABEL` where the
countdown was. Rung 1 already outranks `stalled`, and the TSDoc's reasoning for
that (`:255-258`) is now stronger, not weaker: a parked Ask has no deadline to
outrun at all.

### 10. The room

`services/rooms/notices/notice-copy.ts`, `WAITING_LINES` (`:206-213`). One clause
in each of three sentences. The notice stays vague, late, damped and singular;
`WAITING_NOTICE_GRACE_MS` is untouched; nothing new is written when a prompt
parks, because a parked prompt is the same fact the notice already reported and a
second line is the over-participation `meta/agent-etiquette.md` §9 damps.

```ts
const WAITING_LINES: Record<WaitingKind, (agentName: string) => string> = {
  approval: (agentName) =>
    `${agentName} is waiting for you to approve something before it can carry on. Open ${agentName}'s session to answer. It will wait, but not forever.`,
  question: (agentName) =>
    `${agentName} has a question for you before it can carry on. Open ${agentName}'s session to answer. It will wait, but not forever.`,
  elicitation: (agentName) =>
    `${agentName} needs something from you before it can carry on. Open ${agentName}'s session to answer. It will wait, but not forever.`,
};
```

The TSDoc above them keeps its "no countdown, deliberately" paragraph verbatim
and gains one sentence: the earlier "it gives up if nobody does" promised an
impatience the code no longer has, and a room log read an hour later must not
claim a prompt is gone when the agent is still holding it.

### 11. Test mode

`services/runtimes/test-mode/interactive-scenarios.ts` gains one scenario beside
`questionExpires` (`:510-552`), reaching the park through the same step barrier:

```ts
/**
 * I-08 — a prompt nobody answers, which PARKS rather than expiring.
 *
 * The state a browser test cannot reach by pressing buttons or by waiting: in
 * production the park is ten minutes away and the refusal four hours after
 * that. This reaches the visible half of it through the same shape `questionExpires`
 * uses, released by the test's own step barrier rather than by a clock nothing
 * can wait out.
 *
 * The prompt is raised with `timeoutMs: 0`, so the projector's own selector
 * derives `parked: true` on the very first read. That is deliberate: the test
 * exercises the REAL derivation in `listPendingInteractions` rather than a
 * scenario-authored flag, so a regression in the rule goes red here.
 */
```

Steps: raise an `approval_required` carrying `timeoutMs: 0`; `await ctx.awaitStep()`;
then either resolve normally (the park is answerable) or emit the ceiling's
`interaction_cancelled` with `reason: 'timeout'` and a `MOVED-ON` marker.

### 12. API changes

None. `GET /api/sessions/pending-interactions` and the two fan-out events gain
one optional boolean inside a DTO they already embed. The six answer routes,
`requirePersonToAnswer`, and the OpenAPI document's shape are otherwise
untouched.

### 13. Data model changes

None. No table, no column, no config field, no migration.

## User Experience

**Nothing changes for the first ten minutes.** The card appears wherever it
appears today — the transcript, the header pill, the sidebar, the home triage
header, the room lane — with its countdown, its amber at 120 seconds and its red
at 60.

**At ten minutes the countdown ends and the agent says so.** The bar disappears.
Where the timer was, the card reads `waiting for you`. The lane's line is
unchanged except for that phrase. In the session's transcript the agent says, in
its own words, that it asked to run something, nobody answered, and it is waiting
here until somebody does. The Allow and Deny buttons still work and still do
exactly what they did.

**Answering resumes the turn.** There is no resume step and nothing to click
twice: the decision the agent has been holding is the thing your click settles,
and the tool runs. The agent's process was never given back while it waited
(`session-pump.ts:461` declines the reap), so the answer is as fast as it would
have been at minute one.

**At four hours it gives up**, and says how long it waited. The transcript, the
receipt and the log all say the same thing, and the receipt says `expired` rather
than pretending you refused.

**Error and exit paths.** Stop, a mid-turn steer, or an SDK abort withdraws the
prompt exactly as today and the card becomes "no longer needed" rather than a
button that does nothing. If the server restarts while a prompt is parked, the
park is gone with the process, and the session's next read shows a turn that
ended without the tool call; nothing claims the agent is still waiting.

**A scheduled task is the exception** and behaves as it always has: nobody is
coming back, so it refuses at ten minutes and carries on.

## Testing Strategy

Named per `.claude/rules/testing.md`, colocated in `__tests__/`.

### Unit

`apps/server/src/services/session/__tests__/pending-interactions.test.ts`

- _a prompt inside its budget is not parked and ships its `timeoutMs`_ — the
  existing assertions, unchanged, proving nothing about the first ten minutes
  moved.
- _a prompt past its budget is parked, ships no `timeoutMs`, and counts down to
  the ceiling_ — `startedAt` at `now - 11 min`; expects `parked: true`,
  `timeoutMs` absent, `remainingMs` within a millisecond of
  `4h - 11min`.
- _a prompt past the ceiling is dropped_ — `startedAt` at `now - 4h 1min`;
  expects an empty list. This is the bound that stops a stranded entry pausing
  the stall watchdog forever.
- _a prompt that declared its own shorter budget parks against that budget, not
  the server default_ — `timeoutMs: 120_000`, `startedAt` at `now - 3 min`;
  expects `parked: true`. Guards the DOR-810 regression from the other side.
- **Seeded defect:** measure `parked` against `SESSIONS.INTERACTION_TIMEOUT_MS`
  instead of the declared budget. Test four goes red.

`apps/server/src/services/session/__tests__/session-state-projector.test.ts`

- _`hasPendingInteractions` is still true eleven minutes into a prompt_ — the
  turn's silence is legitimate while parked, so the write-lock is not dropped and
  the watchdog does not fire.
- _`hasPendingInteractions` is false four hours and one minute in_ — the bound
  DOR-782 relies on still exists at a wider setting.

`apps/server/src/services/runtimes/claude-code/messaging/__tests__/interactive-handlers.test.ts`
(fake timers throughout)

- _ten minutes with no answer leaves the promise unsettled_ — the sharpest
  assertion in the suite: advance past `INTERACTION_TIMEOUT_MS` and assert the
  `canUseTool` promise has NOT resolved, and that the entry is still in
  `session.pendingInteractions`.
- _ten minutes pushes a `system_status` saying the agent is waiting, and no
  `interaction_cancelled`_ — the event queue is asserted for both the presence of
  one and the absence of the other.
- _four hours resolves a denial naming hours_ — expects
  `{ behavior: 'deny', message: 'Tool approval timed out after 4 hours' }` and an
  `interaction_cancelled` with `reason: 'timeout'`.
- _answering a parked prompt clears the ceiling timer_ — answer at eleven
  minutes, advance past four hours, assert no further event was pushed and the
  promise settled exactly once. **This is the seeded-defect test for §5.2:**
  revert `clearInteractionTimer` to a closure over the first timer and it goes
  red, because the ceiling stays armed on an interaction that was answered.
- _an SDK abort at eleven minutes clears the ceiling timer_ — same shape through
  `context.signal`.
- _an unattended session refuses at ten minutes and never parks_ — with
  `unattended: true`, expects the resolved denial at `INTERACTION_TIMEOUT_MS` and
  no park notice.
- The same six shapes for `handleAskUserQuestion` and `handleElicitation`, which
  share the helper.

`apps/server/src/services/runtimes/claude-code/sessions/__tests__/tool-result-outcome.test.ts`

- _an hours-shaped timeout denial classifies as `expired`_ — both sentences.
- _a minutes-shaped timeout denial still classifies as `expired`_ — historical
  transcripts keep their receipts.
- **Seeded defect:** change the copy to hours without widening
  `TIMEOUT_PATTERNS`. The first test goes red with `errored`.

`apps/server/src/services/runtimes/claude-code/sessions/__tests__/session-store.test.ts`

- _a session holding a prompt is not evicted at 31 minutes_ — the exemption.
- _a session holding a prompt IS evicted at four hours and one minute_ — the
  exemption's bound, so nothing becomes immortal.
- _a session with no pending interactions is still evicted at 31 minutes_ — the
  exemption did not widen into a general reprieve.

`apps/server/src/services/runtimes/opencode/__tests__/approvals.test.ts`

- _the auto-deny timer fires at the ceiling, not at the countdown_ — advance to
  eleven minutes, assert `respondPermission` was not called; advance past four
  hours, assert one `reject`.
- _the expired mark still lets the echo be told apart from a person's refusal_ —
  the existing assertion at the new deadline.

`apps/client/src/layers/features/ask/__tests__/format-time-left.test.ts`

- _a countdown at or below zero reads as waiting, never as expired._

`apps/client/src/layers/features/ask/__tests__/AskCard.test.tsx`

- _a parked Ask renders no draining bar and reads `waiting for you`._
- _a parked Ask keeps its Allow and Deny buttons_ — the failure mode is a card
  that looks finished, and it is not.
- _an Ask with two minutes left is unchanged_ — the first ten minutes did not
  move.

`apps/client/src/layers/features/conversation/model/__tests__/lane-state.test.ts`

- _the `ask` rung still wins over `stalled` for a parked Ask._

`apps/server/src/services/rooms/notices/__tests__/notice-copy.test.ts`

- _no waiting line claims the agent gives up in ten minutes_ — asserts the three
  sentences against the removed clause, which is the check that catches a copy
  edit reintroducing a promise the code does not keep.

### Server route tests

`apps/server/src/routes/__tests__/sessions.test.ts`

- _`GET /api/sessions/pending-interactions` reports a parked prompt with
  `parked: true` and no `timeoutMs`._

### Browser (`apps/e2e`)

One spec, because the park is a visual state that spans the SSE fan-out, the
store, the card and the lane, and no unit test sees all four.

`apps/e2e/tests/chat/ask-parks.spec.ts` — drives the new `I-08` scenario:

1. Raise the prompt. The Ask card appears with Allow and Deny.
2. Assert the countdown text reads `waiting for you` and no
   `[data-slot="ask-countdown"] [aria-hidden]` bar is present.
3. Assert the lane's `ask` rung is showing.
4. Click Allow. Assert the receipt, and the `MOVED-ON` marker never appears.

### Mocking strategy

`vi.useFakeTimers()` for every server timer test; the SDK is not involved, since
`canUseTool` is called by DorkOS's own harness in these suites. The browser leg
uses test-mode's step barrier rather than a clock, exactly as `questionExpires`
does. No `@anthropic-ai/claude-agent-sdk` mock is added.

## Performance Considerations

- **Timers.** One extra `setTimeout` per prompt that reaches ten minutes, both
  `unref`'d. Negligible.
- **Warm processes.** The real cost. A parked session declines every reap for up
  to four hours instead of ten minutes, so a machine with several abandoned
  prompts holds their subprocesses (and their MCP children) longer. Bounded at
  twelve by `MAX_WARM_SESSIONS`, and the thirteenth launch is refused with the
  reason already spelled out (`PumpRefusedError('warm-ceiling')`). Named in "What
  is not done" so it is not rediscovered as a bug.
- **Session records.** The eviction exemption keeps a parked record for up to
  four hours instead of thirty minutes. Bounded by `MAX_SESSIONS` (50) and by the
  ceiling itself.
- **The stall watchdog.** Pauses for up to four hours on a parked turn instead of
  ten minutes. Intended: the turn is not stalled, it is waiting. A STRANDED entry
  now pauses it for up to four hours too, which is the one genuine widening and
  is why the ceiling is a number rather than absent.

## Security Considerations

- **No change to who may answer.** `requirePersonToAnswer` guards all six answer
  routes unchanged; the bridged approver allowlist
  (`packages/relay/src/adapters/approver-allowlist.ts:75-80`) is untouched and
  not widened.
- **No new detail crosses a room boundary.** The room notice loses a clause and
  gains none; it still carries no tool name, no path and no countdown.
- **No tool input in any new line.** The park notices are built from names and
  question text only, the rule `notifyInteractionTimeoutNotice`'s TSDoc states.
- **A longer hold is a longer window on an unanswered prompt**, which is a
  smaller exposure than the alternative it replaces: today the system answers on
  the person's behalf, and it answers wrong. A held prompt runs nothing.

## Documentation

- `docs/concepts/answering-agents.mdx:50-60` — "The ten-minute window" is
  rewritten as "When nobody answers": the ten minutes are the countdown, past
  them the agent waits, four hours later it gives up. The paragraph about a
  record surviving is unchanged and becomes more true. Follows
  `writing-for-humans`.
- `changelog/unreleased/<id>-ask-parks-on-timeout.md` — one fragment, in a
  person's words: your agent waits for you instead of guessing.
- `packages/skills/src/task-schema.ts:77-83` — one sentence: an unattended run is
  the exception and refuses at ten minutes, because nobody is coming back.
- `apps/server/src/services/tasks/run-stream.ts:5-8` — the module TSDoc names
  `INTERACTION_TIMEOUT_MS` as how long a parked turn can yield nothing. It stays
  correct for the unattended path it describes and gains a clause saying so.
- `contributing/` needs no new guide; the constants' own TSDoc carries the
  reasoning.

## Implementation Phases

**One phase, one pull request.** The runtime change, the selector change, the
eviction exemption, the wire field and the copy are one behaviour and share one
set of tests. Splitting them ships either a parked state nothing renders, or a
card that says "waiting for you" over a prompt that still dies at ten minutes.
Both are worse than either half alone.

Order within the PR, so each step is green before the next:

1. The constant, the selector, and the DTO field, with their unit tests. The
   server now derives and reports `parked` while every timer still denies at ten
   minutes, which is a coherent (if invisible) state.
2. The runtime: `armInteractionWait`, `clearInteractionTimer`, the two logs, the
   six sentences, the denial unit change plus the widened patterns, and the
   OpenCode constant.
3. The eviction exemption and the `unattended` seam.
4. The client: the label, the card's band, the lane's leaf.
5. The room copy, the test-mode scenario, the browser spec, and the docs.

## What is not done

Named so a cold reader does not improve a deliberate gap back into a bug.

1. **No notification actions.** Nothing new reaches you when the cockpit is
   closed. Slack and Telegram already have Allow and Deny buttons
   (`packages/relay/src/adapters/slack/approval.ts:136-247`,
   `adapters/telegram/outbound.ts:479-506, 765-810`), but for the OLDER relay
   `approval_required` envelope, not the fleet-wide Ask; the desktop shell
   constructs no `Notification` anywhere and ADR-0009 excludes the Browser
   Notification API on purpose. **Follow-on to file: "Notification actions for
   the fleet-wide Ask"** — three integration surfaces plus one deliberate design
   exception, none of which parking depends on.
2. **No scope options.** "Allow and don't ask again" still keeps its slot in the
   action row and still does nothing. The standing-permission store is keyed
   `(agentPath, capabilityId)`, lives in SQLite, and has exactly one consumer,
   the capability tier gate (`tier-enforcement.ts:656-674`); nothing in
   `createCanUseTool` reads it. The SDK's own `PermissionUpdate` mechanism ships
   end to end already (`session-store.ts:499-501`) but DorkOS never inspects the
   `destination`, so its scope is CLI-decided and invisible to the Settings panel
   and to ADR `260801-035912`'s audit overlay. **Follow-on to file: "Scope
   options for SDK tool prompts"** — choosing between a new store and owning the
   SDK's destination is the real decision, and it is not this one.
3. **A parked session holds a warm process until it is answered or the ceiling
   fires.** Twelve of them refuse every new agent launch on the machine with
   `PumpRefusedError('warm-ceiling')`. This is why the ceiling is four hours and
   not four days. Giving the process back is impossible while the SDK query holds
   the unresolved promise.
4. **A park does not survive a server restart.** The held decision lives in a
   child process of this server. On restart the card is gone and the turn ended
   without the tool call. Nothing pretends otherwise.
5. **OpenCode parks without a transcript line.** Its approval pass is a generator
   over the sidecar's stream with no seam for a DorkOS-authored event, so the
   card and the lane park identically but the "I am waiting here" sentence is
   claude-code's only.
6. **Codex does not park**, because it has no approval channel to park
   (`NOTES.md` Verdict 1). DOR-803 is unchanged.
7. **The expired prompt's durable receipt is still the log line.** DOR-1158's
   live notice still clears with the next turn event. Parking removes almost
   every occasion for it, which is why closing the gap is still not urgent.
8. **The room notice is still late, vague and damped**, and a park writes no
   second line. The one clause that changed is the one that had stopped being
   true.
9. **The park ceiling is a constant, not a setting.** Every `SESSIONS.*` sibling
   is, and there is no evidence yet of somebody who hits four hours and minds.
10. **A relay-bound turn parks, and its Ask reaches the cockpit only.**
    `core/unattended-autonomy` counts a binding as an unattended driver, and this
    item deliberately does not: a bridged agent's prompt is listed fleet-wide and
    the person the room is talking to can answer it in the cockpit, which is not
    true of a scheduled run. So a Slack- or Telegram-bound agent parks for four
    hours and says nothing on the surface that asked — the notification gap named
    in #1 — while holding a warm slot. Refusing it fast instead would answer for
    somebody who can, in fact, still answer.
    **Corrected (2026-08-23, DOR-1440).** The park is unchanged; "cockpit only"
    is not, and it was already too broad when written. There are two relay paths:
    - **Direct-bound** — an agent addressed over the relay publishes its
      `approval_required` to the envelope's `replyTo`
      (`relay/adapters/claude-code/publish.ts`) and Slack/Telegram render real
      Approve/Deny buttons for it, in any chat shape including a group channel.
      The approver allowlist is checked at the click, not at the send. So such an
      agent does NOT "say nothing on the surface that asked".
    - **Room-bound** — `ask-entitlement` §5.2, which shipped after this item,
      sends the same card through a bridge under much tighter rules: an
      `approval` only, only into a live one-to-one DM whose single outside member
      arrived through that adapter instance and is on its approver allowlist.
      Everything outside that narrow case is still cockpit-only, which is the
      half of this item that survives.
11. **A room turn is still given up after `rooms.lateReplyCeilingMinutes`**
    (60 by default). Before the park every prompt settled inside ten minutes, so
    that bound was unreachable; now a room-raised Ask answered after an hour runs
    its tool and lands in the session's transcript, but no reply is posted back
    to the room. The two are deliberately not tied: one is how long an agent
    waits for a person, the other how long a room waits for an agent, and the
    second is a setting somebody may have tuned. **Follow-on to file: "a room
    turn that outlived its ceiling still says something when the answer lands."**
12. **The PROJECTOR's `hasPendingInteractions` does not know about `unattended`.**
    `isWaitingOnPerson` bounds the runtime's own three answers by the wait a
    session can actually use; the projector's selector bounds everything by the
    park ceiling, so an unattended session with a STRANDED entry pauses the stall
    watchdog for four hours rather than ten minutes. Unreachable in practice: an
    unattended prompt is refused and its entry removed at the countdown, so only
    a stranded one could reach this, and a stranded entry is already the case the
    ceiling exists to bound.
13. **A NEW server with an OLD client still shows the long countdown on a
    recovered park.** `parked` is read by client code shipped with this change; a
    stale tab, an older desktop build or an older Obsidian bundle sees a DTO with
    no `timeoutMs` and a four-hour `remainingMs` and draws the countdown it knows
    how to draw. The card stays answerable and answering still works — the lie is
    cosmetic and ends on reload.
14. **Whether the OpenCode sidecar expires an unanswered `Permission` is still
    unverified**, and the module says so rather than claiming a parity it has not
    earned (`services/runtimes/opencode/approvals.ts`). It needs one live
    OpenCode turn held past ten minutes; nothing in the SDK surface settles it.
    If the sidecar does expire one, DorkOS's park outlives it and a late answer
    meets a permission that is already gone.

## Open Questions

All resolved during SPECIFY. Originals preserved as the audit trail.

- ~~Can a `canUseTool` decision be deferred indefinitely, and what does the SDK
  do to a turn whose tool decision never resolves?~~ **(RESOLVED — verified in
  the SDK's own types.)** **Answer:** yes, indefinitely, and the SDK does nothing
  to the turn. `sdk.d.ts:196-205` states "permission prompts have no park
  deadline"; `Query.reinitialize()` (`:2436-2450`) redelivers "control requests
  the loop is still blocked on" after a transport gap. **Rationale:** a held
  decision is a first-class, recoverable state of the CLI loop, not a leak, so no
  suspend-and-resume mechanism is needed and none is built.
- ~~Does the prompt stop timing out, or does the turn suspend and resume?~~
  **(RESOLVED — default chosen: it stops timing out.)** **Answer:** §5.1. The
  promise stays unresolved and the turn stays open. **Rationale:** a
  suspend/resume needs a re-issue primitive the SDK does not have and would put a
  denial the person never gave into the transcript, which is the bug.
- ~~Park forever with a visible parked state, or park for N hours then refuse?~~
  **(RESOLVED — default chosen: N hours, then refuse.)** **Answer:** §2 and
  `01-ideation.md` §5.2. **Rationale:** three DorkOS bounds turn "forever" into
  three immortal states, and the decisive one is the warm ceiling: twelve
  abandoned prompts would refuse every new agent launch on the machine, and the
  person who hits that refusal is not the person who walked away.
- ~~What is the ceiling?~~ **(RESOLVED — default chosen: 4 hours.)**
  **Rationale:** twenty-four times the countdown; covers DOR-784's forty-one
  minutes, a lunch and a school run with margin; keeps a machine abandoned at six
  in the evening from holding twelve subprocesses at midnight.
- ~~Does the parked state need its own event on the wire?~~ **(RESOLVED —
  default chosen: no, it is derived.)** **Answer:** §1. **Rationale:** it is a
  function of `startedAt` and the declared budget, both already carried; an event
  would need a session-stream member, a normalizer arm, a projector arm and an
  injection seam OpenCode does not have, and would create a second answer free to
  disagree with the first.
- ~~How does the ceiling reach the stall watchdog and the session write-lock?~~
  **(RESOLVED — default chosen: through `listPendingInteractions`, with no change
  to `hasPendingInteractions`.)** **Rationale:** that selector's own TSDoc states
  the rule the codebase already paid twice for (DOR-810, DOR-1330) — the budget
  the remainder is measured against is the budget that ships.
- ~~Does an unattended task run park?~~ **(RESOLVED — default chosen: no.)**
  **Answer:** §7. **Rationale:** a park is a promise that somebody will come back,
  and a scheduled run has nobody to keep it; parking one would stall it four hours
  per ask instead of ten minutes.
- ~~Do the notification actions and the scope options fit here?~~ **(RESOLVED —
  default chosen: no, two named follow-ons.)** **Answer:** "What is not done" #1
  and #2. **Rationale:** neither is needed for the park to be correct, and each
  carries a real unresolved design question of its own.
- ~~Does the room's durable notice gain a park line?~~ **(RESOLVED — default
  chosen: no; one clause changes in the three existing lines.)** **Rationale:** a
  parked prompt is the same fact the notice already reports, and a second line is
  the over-participation `meta/agent-etiquette.md` §9 damps. What changed is that
  "it gives up if nobody does" had stopped being true.
- **Unverified, and the one live check this spec owes:** whether the OpenCode
  sidecar applies an expiry of its own to an unanswered `Permission`. Nothing in
  `@opencode-ai/sdk`'s surface or `services/runtimes/opencode/` says either way,
  and it cannot be settled by reading. **If it does**, OpenCode's park is capped
  by whatever that is and §6's TSDoc must say so rather than claiming a parity it
  does not have. **If it does not**, §6 is complete as written. Confirm with one
  live turn before the PR is opened; it changes a comment, never the design.

## Related ADRs

- **Extracted by this spec** (proposed, `extractedFrom: ask-parks-on-timeout`):
  `260819-022636` — an unanswered prompt parks rather than refusing, and the park
  is derived and bounded.
- ADR `260818-002803` — the SDK prompt is a fleet-wide Ask. Its own Status
  section names this item's absence as a known gap; this closes it.
- ADR-0264 — message POSTs are trigger-only and all delivery rides the durable
  stream; why `startedAt`/`remainingMs` are server-authoritative.
- ADR-0310 — runtime-owned sessions; why the projector, not a runtime, answers
  "what is pending".
- ADR `260801-035912` — a permission decision is recorded for every session and
  overlaid by tool-call id; why the ceiling must still produce a resolution.
- ADR-0240 — permission modes pass through to the SDK with no local allowlist.
- ADR-0009 — layered calm-tech notifications, excluding the Browser Notification
  API; why notification actions are a deliberate exception rather than an
  extension.

## References

- `specs/ask-parks-on-timeout/01-ideation.md` — the verified pre-reading log and
  the sixteen decisions.
- `specs/unified-conversation/02-specification.md` §3 and §4 (the Ask),
  `design-decisions.md` §2 (tiers A, B and C), `04-implementation.md:741-785`
  (what tier C was left holding).
- `research/20260316_tool_approval_timeout_visibility_ux.md` — the countdown
  thresholds the first ten minutes keep.
- `specs/tool-approval-timeout-visibility/`, `specs/approvals-resume-inline/`,
  `specs/persistent-session-runtime/` (held-process semantics),
  `apps/e2e/tests/chat/held-process.ts`.
- `meta/agent-etiquette.md` §9, `.claude/rules/room-conduct.md`,
  `.claude/rules/testing.md`, `.claude/skills/writing-for-humans/SKILL.md`.
- `node_modules/@anthropic-ai/claude-agent-sdk@0.3.224/sdk.d.ts:196-205, 2167-2215, 2436-2450`.
- Code anchors as cited throughout, read at `d7e4768e6`.
