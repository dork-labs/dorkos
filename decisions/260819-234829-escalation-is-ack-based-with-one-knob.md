---
id: 260819-234829
title: Blocking notifications climb an ack-based escalation ladder with exactly one knob
status: accepted
created: 2026-08-19
spec: notification-system
superseded-by: null
---

# 260819-234829. Blocking notifications climb an ack-based escalation ladder with exactly one knob

## Status

Accepted 2026-08-22 — shipped in DOR-1387 (PR #1153). The single knob
`notifications.escalation.phoneAfterMinutes` is in
`packages/shared/src/config-schema.ts`; see Implementation notes below.

## Context

A blocked agent can wait up to 4 hours (the ask park ceiling) with zero signal
outside the app — the exact failure mode users of every coding-agent tool
complain about, and the gap an entire paid third-party ecosystem exists to
fill. Incident tooling (PagerDuty, incident.io) solved this with escalation
policies, but their configurable per-channel matrices are operator burden a
personal tool must not impose. Presence detection across a web tab, an Electron
window, and a phone is unreliable as a single trigger.

## Decision

Only Blocking-tier notifications escalate. The ladder is fixed: in-app mirrors
at t=0; a desktop notification at t=0 when the relevant surface is unfocused; a
phone leg (web push and/or Telegram/Slack via the existing relay targets) after
one configurable delay (`notifications.escalation.phoneAfterMinutes`, default
2, `never` supported). Escalation is cancelled by acknowledgment — the
interaction resolving, the item being approved/rejected, any delivery marked
seen/acted, or the notification being read — never by inferred presence.
Timers re-arm from still-pending state on boot, idempotent via the delivery
ledger.

## Consequences

### Positive

- The walk-away promise becomes real: a blocked agent reaches the operator's
  pocket in minutes, and answering anywhere silences everything.
- One knob keeps the settings surface honest to the Calm Tech posture.
- Ack-based cancellation cannot be fooled by a focused-but-unattended window.

### Negative

- A user who acknowledges on desktop but wanted the phone ping anyway has no
  per-channel override (deliberate; revisit only with evidence).
- In-memory timers mean a server restart inside the delay window re-arms from
  state — a duplicate phone ping is possible at the margin (bounded by the
  ledger check).

## Implementation notes

Shipped in DOR-1387 (`apps/server/src/services/notifications/`).

**The ladder itself** is `escalation-service.ts`, a module-level singleton in
the shape `notify()` already uses, so a projector, a route and an MCP tool each
start a clock with one free function and grow no dependency on the inbox.

- **Three arm seams, one disarm.** `ask-resolution.ts` arms on the projector's
  `pending` change (every runtime's Asks ride that one seam);
  `session-lifecycle.ts` arms when a session enters `error`; and both
  schedule-park write sites arm at the write that parks one (parked schedules
  have no observer seam, which is why the hook lands at the write). Nothing
  cancels at those seams: every resolution runs through
  `NotificationService.resolveStanding`, which disarms once for all three
  kinds — synchronously and before it awaits a chat network, so an escalation
  cannot slip out in that window.
- **The four acks this ADR names are two mechanisms, and only one is live.**
  "The interaction resolved" and "the item was approved or rejected" are the
  same disarm above, and that is the ack that actually fires today. **"The
  notification was read" turned out to be the same one again, not a third**: a
  standing kind stores no row while it stands, so the only row a person can mark
  read is the history row a resolution already wrote — by which time the timer
  is gone. A hook on the read path would have been a line that could never run,
  so there isn't one. **"A delivery marked seen/acted" is wired but dormant**:
  `NotificationStore.wasAcknowledged` is checked before every fire, and nothing
  in production writes `seen_at` or `acted_at`, so it always answers `false`
  today. It is kept as the seam a channel-side ack hook lands on — a tapped
  push, a pressed chat button — and is documented as dormant at the method
  rather than left to look load-bearing.
- **`session.error` is keyed per EPISODE**, not per session:
  `session-error:<sessionId>:<since>`. On a session-only key the ledger's
  "already escalated?" check reads the first episode's row forever, so a session
  that falls over, is fixed, and falls over again escalates only the FIRST time
  — for up to the row's thirty-day life. One shared payload builder in
  `session-lifecycle.ts` serves both the arm and the resolution, because an
  identical key at both edges IS the disarm.
- **The knob is read live**, on every arm AND again at fire time, so moving it
  to `never` silences a timer that is already running.
- **One key, not two.** A timer is filed under the registry's own
  `dedupeKey(payload)` rather than a builder the escalation service keeps of its
  own. That single string is the timer's key, the ledger's `subject_key` and
  what a resolution cancels with — a second builder would be the one place "a
  ping nothing can cancel" could live.

**Idempotency needed the ledger to describe a subject, not only a row.** A
standing condition writes no notification row while it stands (ADR
260819-234828) and reaching somebody WHILE it stands is the ladder's entire
job — so an escalation delivery had nothing to hang off. Migration 0069 makes
`notification_deliveries.notification_id` nullable and adds `subject_key`,
written for every delivery (escalated or not) and identical to the raising
kind's dedupe key. "Has this been escalated?" and "has any channel marked this
seen?" are then one indexed query each, and they survive a restart. Orphan
escalation rows have no cascade to follow, so `prune()` takes them by age.

**Both legs are started before either is awaited, and neither can fail the
other.** A chat leg refused by the hourly allowance still leaves the push leg
to reach a phone — a ceiling that silenced both would be a gag rather than a
bound. The allowance is the same `NotifyBudget` instance `relay_notify_user`
spends, hoisted to the composition root: one ceiling per agent across both ways
it can interrupt somebody.

**The registry's `relay: 'never'` on the standing kinds is deliberately not
consulted.** That policy governs the one history row each writes when it
resolves ("your ask expired" does not belong on Telegram). Escalation is the
separately decided case this ADR describes, so it sends under its own
`'always'` policy — while the consent gates the channel owns, the binding's
"Agent can start conversations" switch and the budget, are untouched.

**Boot catch-up is bounded twice.** A condition that came due while the server
was down escalates once; one not yet due gets the REMAINDER of its delay rather
than a fresh one; and one older than four hours (the Ask park ceiling) is left
alone entirely — past that it is a backlog, not news, and buzzing a phone about
a week-old parked schedule on every restart is the noise the tiering exists to
prevent. Parked schedules are the only standing kind that outlives a restart;
an Ask lives in a projector, so a cold boot has none to find and the live seam
picks each one up as its session rehydrates.

**The push leg** is `channels/web-push.ts`: a VAPID keypair generated on first
use at `<dorkHome>/push/vapid.json` (`0600` inside a `0700` directory, resolved
from `dorkHome` and never `os.homedir()`), payloads restricted to
`WebPushPayload` (title, short body, route, id, tier — never a tool input), and
`404`/`410` pruning the row rather than retrying a browser that is gone. A
keypair that cannot be read or written makes push unavailable rather than
throwing, so a read-only home directory loses the push leg and keeps the chat
one.
