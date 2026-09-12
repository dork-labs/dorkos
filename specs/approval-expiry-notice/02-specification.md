---
slug: approval-expiry-notice
number: 260912-190726
created: 2026-09-12
status: specified
---

# Telling an agent nobody ever answered

**Status:** Draft
**Author:** DOR-1932
**Date:** 2026-09-12

> Every claim about existing behavior below was read off the tree at `cb963df89` — the base this branch
> was cut from, after DOR-1931 (`2c71b9b0f`) landed the delivery seam. Where a claim rests on a line of
> code, the file and line are named.

## Overview

An approval that nobody answers emits **no event, ever**. It does not settle, it does not broadcast, and
nothing downstream learns that it lapsed. The agent that asked is left holding a token it has no way to
know is dead.

DOR-1931 built the seam that carries an answer to a session which stopped waiting. It deliberately
carried only real decisions, and said so in two places — `verdictDelivery` refuses a non-decided row
because "`expired` is DOR-1932's subject, not this seam's"
(`apps/server/src/services/core/approvals/approval-service.ts:818`), and the subscription filters
`granted`/`denied` for the same reason
(`apps/server/src/services/core/approvals/approval-verdict-delivery.ts:246`).

This specifies the third outcome: making expiry happen on time, and telling the agent.

## What is actually broken, and what is not

The issue frames this as "nothing can observe the person never answered." That is true of the **server**.
It is not true of the operator's screen, and the difference is the whole shape of this work.

### The operator already sees expiry. Nobody else does.

Three surfaces already retire themselves on the deadline, without any server event:

| Surface               | How it retires today                                                                                                                          |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| The approvals list    | `usePendingApprovals` arms a timer at the soonest deadline in the list and prunes locally (`use-pending-approvals.ts:149-179`)                |
| The desktop banner    | `raiseCapabilityApproval` passes `expiresAt` into `raiseStanding` so a drawn banner can retire itself (`emitters/capability-approval.ts:125`) |
| The server's own list | `listPending` filters expired rows out before returning them (`approval-service.ts:882`)                                                      |

Each of those carries a comment saying the same thing: expiry is the one ending the server never
announces, so the surface handles it alone. That is a coherent design and it works. **It is not the gap.**

The gap is everything that is not a screen the operator is looking at: the agent that asked, and any
future consumer of the approval lifecycle. `settle()` is the funnel every other ending passes through
(`approval-service.ts:971`), and expiry-with-nobody-looking is the one ending that never reaches it.

### The escalation ladder is not a ladder, and it has already fired

The issue names this as the real blast radius. Read against the code, it is close to zero, and the
measurement matters enough to record.

`EscalationService` is **single-shot**. `arm()` sets exactly one `setTimeout`
(`escalation-service.ts:186-188, 251-269`); `fire()` deletes the timer from its own map before running
(`:262`), sends one push and one relay message, writes one ledger row, and never re-arms. A
`hasEscalated` guard (`:291`) refuses a second attempt for the same subject. There is no second rung and
nothing to climb.

Its delay is one config knob, `notifications.escalation.phoneAfterMinutes`, **defaulting to 2 minutes**
(`packages/shared/src/config-schema.ts:863`), and it is read off the global config — never off the
approval's own `expiresAt`. The escalation timer's duration is completely decoupled from the two-hour
decision window.

So on default settings the sequence is: request at minute 0, escalation fires at minute 2, expiry at
minute 120. **By the time an approval expires, the escalation fired 118 minutes ago and its timer is
already gone.** `cancelEscalationByKey` at expiry is a no-op in every default configuration; it was
always going to be. The feared behavior change does not exist at the default, and where it does exist it
is an improvement — see decision 2.

## The four questions, decided

### 1. Timer, sweep, or lazy-on-read? — **One sweep interval.**

Lazy-on-read is today's behavior and is precisely what is unobservable, so it is not a candidate.

A **timer per approval** is the promptest option and the wrong one. Timers live in process memory, so
every one of them dies on restart and the design immediately owes a re-arming pass at boot that reads the
table back — machinery this feature does not otherwise need. It also duplicates a timer that already
exists: `awaitDecision` arms its own cap per hold (`approval-service.ts:685`). And promptness to the
second buys nothing here; nobody is waiting on the millisecond an approval lapses.

A **single sweep interval** gets restart-safety for free — the first tick after boot settles everything
that expired while the process was down, with no separate recovery path — and costs one wakeup over an
indexed query on a table that holds single-digit rows in practice.

**Cadence.** Every 60 seconds by default. Against a two-hour window, worst-case lateness is 0.8%.

It cannot be a fixed 60 seconds, because `DORKOS_APPROVAL_TTL_MS` exists specifically so the eval harness
can watch an approval run out of time (`approval-service.ts:93-98`), and it can shorten the window to one
second. A sweep slower than the window it polices would make that harness wait a minute for a one-second
expiry. So the interval is `clamp(ttlMs, MIN, 60_000)` — it tracks the configured window down, with a
floor so a pathological `ttlMs` passed straight into `ApprovalServiceOptions` (which bypasses
`resolveApprovalTtlMs`) cannot spin the loop.

**Who settles is decided by a write, not a check.** The sweep must not double-settle against a concurrent
`consume`. It reuses the existing race-decider: `markConsumed(id)` is already a conditional update
(`approval-service.ts:1013-1020`) and already gates both existing expiry settles (`:596`, `:1039`). The
sweep marks, and settles only if it won the row.

**Shape.** A class-owned `unref()`'d `setInterval` with a try/catch per tick, following `TaskReconciler`
(`services/tasks/task-reconciler.ts:146-163`). There is no scheduler registry in this server to plug
into; every periodic job is a bare interval owned by its service or by `index.ts`.

### 2. What does the escalation ladder do? — **Expiry disarms, exactly like every other ending. No special case.**

`settle()` already disarms unconditionally, and expiry routes through `settle()` like the other three
outcomes. Nothing is added and nothing is excepted.

On default settings this changes nothing observable, for the reason measured above: the ping fired at
minute 2 and the timer is long gone. It becomes reachable only when `phoneAfterMinutes` is set longer
than the decision window, or when the window is shortened — and in exactly those cases disarming is the
correct behavior, not a regression. **A request whose window has closed cannot be answered.** Buzzing
somebody's phone to ask them to do something impossible is noise, and the notification pipeline already
refuses that class of message on principle (`emitters/capability-approval.ts:30-37`).

The issue asks whether expiry is instead "the moment it should escalate hardest." It is not, and the
reason is worth stating plainly: an expiry is not a new demand on the person. It is the **withdrawal** of
one. Escalating harder at the moment a request stops being actionable would be asking louder for
something that can no longer be given.

### 3. Agent, or operator? — **The agent. The operator gets no new notification.**

The operator's surfaces already handle expiry (table above), and with prompt settling they now get a real
`approval_resolved` and `standing_resolved` event as well — strictly better than the local timers they
fall back on, at no cost and with no new surface. The local timers stay: they are what keeps a card
honest while the connection is down, which is exactly when a dead card would otherwise sit there looking
answerable.

A **new** notification telling a person "the thing you did not answer has expired" is a buzz about their
own non-action. `capability-approval.ts:30-37` already rejects this shape for this exact store, on the
grounds that such a row "would land unread and pop a banner about a decision the person had already
made." Silence here is the designed behavior, not an omission — and over-participation is the failure
mode this codebase's etiquette rules name first.

So the notice goes to the agent, over the DOR-1931 seam, and nowhere else.

**Why the agent is worth waking, in a sentence:** DOR-1931 decided that a **denial** wakes a session
exactly as a grant does, because a refusal may need to reach an agent that assumed it was allowed
(`decisions/260909-123910-…md`, Decision). An expiry is a refusal by timeout. Inventing a quieter rule
for the third outcome would be the drift, not the consistency.

### 4. Is `purgeExpired`'s 24h delete still right? — **The window is right. Running it once at boot was not.**

`purgeExpired` is a **retention** sweep and settling does not delete, so the two never collide: a row
expires at T, settles at T+60s, is delivered, and is deleted at T+24h with the notice long since sent.
The 24-hour window stays exactly as it is — an expired or spent approval should stay auditable for a
while after it stops working.

What was wrong is that it only ever ran at boot (`index.ts:2261`). A server that runs for a month never
purges after the first second of it, so the table grows without bound. Now that a sweep exists, the purge
rides it. The delete is one indexed statement against a cutoff, so the marginal cost per tick is nil.

Its docblock currently reads "expiry itself is enforced in `consume`, never by this sweep"
(`approval-service.ts:933-935`). That sentence becomes false with this change and must be rewritten
rather than left to mislead the next reader.

## The defect this introduces if written naively

**`releaseStaleVerdictClaims` must be narrowed, in the same change.**

An expiry-settled row keeps `state = 'pending'`: `markConsumed` stamps `consumedAt` and never touches
`state`. The boot sweep matches on `state = 'pending' AND notified_at IS NOT NULL`
(`approval-service.ts:860-867`), so **every restart would strip the delivery receipt off an expiry notice
that was correctly delivered**, and the count it returns would report settled rows as stranded.

Its docblock's invariant — "a claim on a PENDING approval can only belong to an in-session hold that is
waiting right now" — is true today only because nothing else claims a pending row. This feature makes it
false.

The fix is one clause: also require `consumed_at IS NULL`. A live hold's row is unspent; an
expiry-settled row is not. The invariant is restored rather than patched around, and the docblock is
updated to say why the clause is there.

This must be proven by a test that fails without the clause.

## Detailed design

### Shared (`packages/shared/src/additional-context.ts`)

`ApprovalVerdictData.outcome` gains `'expired'` (`:836-858`), and `ApprovalVerdictDataSchema` with it
(`:1146`). `decidedAt` is already the field name; for an expiry it carries the moment the window closed,
and the block labels it accordingly rather than calling a deadline a decision.

No new `ContextKind` and no new `CONTEXT_TAG` entry: `approval_verdict` is the right kind, and an expiry
is an outcome of one, not a different sort of thing.

### The block (`services/runtimes/shared/approval-verdict-block.ts`)

`formatApprovalVerdict` (`:128-155`) gains the `expired` case, which means a `NEXT_STEP` entry and the
`Decision:`/`Answered:` labels reading correctly for a non-decision. Every scalar keeps going through
`safeScalar` (`:83-85`) as it does today — an expiry block carries no untrusted field at all (no
`denyReason`), but the defusal is unconditional by design and stays that way.

The three adapters need **no change**: each already delegates the whole body to `formatApprovalVerdict`
(claude-code `context-builder.ts:784-791`, codex `turn-input.ts:125-126`, opencode
`turn-input.ts:87-88`). That is the shared writer earning its keep on its first extension.

### The service (`services/core/approvals/approval-service.ts`)

- `verdictDelivery` accepts an expired row and composes its notice from the stored row only, exactly as
  today — capability title from the registry, nothing caller-supplied.
- A new sweep method settles every pending, unspent, past-deadline row, each behind `markConsumed`.
- `releaseStaleVerdictClaims` gains the `consumed_at IS NULL` clause.
- `purgeExpired` keeps its window and loses its stale docblock sentence.

### Delivery (`services/core/approvals/approval-verdict-delivery.ts`)

The subscription filter admits `expired` alongside `granted` and `denied` — and must still refuse
`consumed`, which is the ordinary grant flow settling a second time for one subject. The trigger content
says what happened in the agent's terms: nobody answered in time, the request is dead, ask again if it is
still needed.

### Boot (`index.ts`)

The sweep starts beside the existing approval boot blocks (`:2244-2264`) and is torn down with the other
intervals.

## What this deliberately does not do

- **It does not guarantee delivery across a restart mid-delivery.** If the process dies between the claim
  and the dispatch, `releaseStaleVerdictClaims` frees the claim but nothing re-broadcasts, so the notice
  is lost. This is inherited from the DOR-1931 seam — a granted verdict has the identical exposure — and
  fixing it is a change to that seam's retry model, not to expiry.
- **It adds no new operator notification**, per decision 3.
- **It does not touch the client's local prune timers**, which remain correct and remain useful offline.

## Security requirements

- The expiry notice is composed entirely from the stored row. Nothing a caller supplied appears in it,
  which is trivially satisfied because an expiry carries no free-text field at all.
- Exactly one settle per approval, enforced by the existing `markConsumed` conditional write.
- Exactly one delivery per approval, enforced by the existing `notified_at` claim — with the boot sweep
  narrowed so it stops handing that claim back for rows already delivered.
- An expiry notice must never read as the operator's words. It rides the registered `approval_verdict`
  tag, so it inherits the transcript strip and the tag defusal unchanged.

## Testing strategy

Each of these must be shown to fail before it passes.

1. An approval that nobody touches settles within one sweep interval, broadcasting `approval_resolved`
   with outcome `expired` — the behavior that does not exist today.
2. The sweep and a concurrent `consume` on the same row settle it exactly once.
3. A restart does not strip the delivery receipt off a settled expiry (the `consumed_at IS NULL` clause),
   seeded by writing the row and running the boot sweep.
4. The expiry notice reaches the requesting session through the seam, and a row with no requesting
   session is refused rather than claimed.
5. `formatApprovalVerdict` renders `expired` as a formatted block on all three adapters — no
   `JSON.stringify` fallback.
6. A shortened `ttlMs` shortens the sweep interval with it.
7. The purge still deletes only past its 24h cutoff when running on the interval.

## Acceptance

1. An unanswered approval produces an `approval_resolved` event on its own, with nobody looking.
2. The agent that asked is told its request lapsed, on all three runtimes, as a formatted block.
3. The operator gets no new notification.
4. Escalation disarms on expiry through the ordinary `settle` path, with no expiry-specific branch.
5. Exactly one settle and exactly one delivery per approval, each proven by a racing test.
6. A restart neither loses nor duplicates a delivered expiry notice.
7. `purgeExpired` keeps its 24h window and now runs for the life of the process.

## Related ADRs

- `260909-123910` — a late approval verdict wakes the session that asked (DOR-1931). This spec extends its
  seam rather than building beside it.
- This spec's own record, extracted at specification time.

## References

- DOR-1932 (this work), DOR-1931 (the delivery seam), DOR-1930 / DOR-939 (the in-session hold),
  DOR-1570 (the escalation ping), DOR-981 (the stored-cwd lesson).
