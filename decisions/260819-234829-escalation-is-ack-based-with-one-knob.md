---
id: 260819-234829
title: Blocking notifications climb an ack-based escalation ladder with exactly one knob
status: draft
created: 2026-08-19
spec: notification-system
superseded-by: null
---

# 260819-234829. Blocking notifications climb an ack-based escalation ladder with exactly one knob

## Status

Draft (auto-extracted from spec: notification-system)

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
