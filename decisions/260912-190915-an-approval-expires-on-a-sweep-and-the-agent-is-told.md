---
id: 260912-190915
title: An approval expires on a sweep, and the only party told is the agent that asked
status: accepted
created: 2026-09-12
spec: approval-expiry-notice
superseded-by: null
amends: null
---

# 260912-190915. An approval expires on a sweep, and the only party told is the agent that asked

## Status

Accepted (extracted from spec: `approval-expiry-notice`, DOR-1932). The implementation lands with this
record, so it is `accepted` rather than `proposed`.

## Context

An approval that nobody answers emits no event at all. Expiry is evaluated only when somebody presents a
token (`consume`) or tries to decide a stale row (`decide`); a request that simply runs out of time with
nobody looking never reaches `settle()`, never broadcasts, and never disarms anything. The agent that
asked is left holding a token it cannot know is dead.

Two things had to be measured before deciding, because the issue sized this as a behavior change with
real blast radius.

**The operator is already served.** Three surfaces retire an expired approval on their own deadline with
no server event: the approvals list prunes locally on a timer, the desktop banner is handed `expiresAt`
when it is raised, and `listPending` filters expired rows server-side. Each carries a comment saying it
does this precisely because the server announces nothing. So "nothing can observe expiry" is true of the
server and false of the screen, and the unserved party is the agent.

**The escalation ladder is a single rung, and it has already fired.** `EscalationService` arms exactly one
`setTimeout`, deletes it before firing, records a `hasEscalated` ledger row, and never re-arms. Its delay
is one global knob defaulting to **2 minutes**, read off config and never off the approval's own
`expiresAt`. Against a two-hour window the ping fires at minute 2 and expiry arrives at minute 120 — so
the timer `settle()` would cancel has been gone for 118 minutes. The interaction the issue flagged as the
thing to decide rather than discover turns out, on the default configuration, not to exist.

## Decision

**Expiry is settled by one periodic sweep**, not by a timer per approval and not lazily on read. The sweep
settles every pending, unspent, past-deadline row behind the existing `markConsumed` conditional write, so
it and a concurrent `consume` cannot both settle one approval. Its interval tracks the configured decision
window downward (`clamp(ttlMs, MIN, 60s)`), because `DORKOS_APPROVAL_TTL_MS` exists to shorten that window
to seconds and a sweep slower than the window it polices would defeat it. It runs `purgeExpired` on the
same tick, which keeps that sweep's 24-hour retention window unchanged while fixing the fact that it only
ever ran at boot.

**Expiry disarms escalation through the ordinary `settle()` path, with no expiry-specific branch.** Where
that is reachable at all — a `phoneAfterMinutes` longer than the window, or a shortened window — disarming
is correct: a request whose window has closed cannot be answered, and paging somebody about it asks louder
for something that can no longer be given. An expiry is the withdrawal of a demand, not a new one.

**The only party told is the agent**, over the DOR-1931 verdict-delivery seam, carried as a third
`outcome` on the existing `approval_verdict` context kind rather than a new kind. No new operator
notification is added. Waking the session is justified by the same reasoning DOR-1931 already accepted for
a denial: a refusal may need to reach an agent that assumed it was allowed, and an expiry is a refusal by
timeout.

**`releaseStaleVerdictClaims` is narrowed to unspent rows in the same change.** An expiry-settled row keeps
`state = 'pending'`, so without an added `consumed_at IS NULL` clause every restart would strip the
delivery receipt off an expiry notice that was correctly delivered — the boot sweep's own documented
invariant, that a claim on a pending row can only belong to a live hold, is made false by this feature.

## Alternatives considered

- **A timer per approval.** Promptest, and it dies on restart — which immediately owes a re-arming pass
  that reads the table back at boot, machinery the sweep gets for free on its first tick. It also
  duplicates the per-hold cap timer `awaitDecision` already arms.
- **Notify the operator too.** Rejected: it is a buzz about the person's own non-action, and this exact
  store already refuses that shape of message on the grounds that such a row "would land unread and pop a
  banner about a decision the person had already made."
- **Escalate harder at expiry**, which the issue raised as a genuine fork. Rejected for the reason above;
  recorded here because it is the alternative a future reader is most likely to reach for.
- **A new `ContextKind` for expiry.** Rejected: an expiry is an outcome of an approval verdict, not a
  different sort of thing, and a second kind would owe a second shared writer and three more adapter cases
  for no gain.

## Consequences

### Positive

- An approval lifecycle now has no silent ending: every one of the four outcomes reaches `settle()`, so
  any future consumer of the lifecycle sees all of them.
- The agent that asked learns its request lapsed instead of holding a dead token, on all three runtimes,
  rendered identically because the shared writer from DOR-1931 is extended rather than bypassed.
- The operator's surfaces get a real event in addition to their local timers, at no cost and with no new
  surface.
- `purgeExpired` stops being a boot-only no-op on a long-running server.

### Negative

- A delivery starts a turn nobody typed, and for expiry the trigger is the _absence_ of a person's action
  rather than their decision — a weaker justification than DOR-1931's, accepted for consistency with it
  rather than on its own strength.
- One more periodic interval in a server that has no scheduler to register it with, so it is another bare
  `setInterval` to own and tear down.
- Worst-case lateness of one sweep interval between the deadline and the event. Nothing waits on that
  precision today, but a future consumer that needs exact timing would not get it here.
