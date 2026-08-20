---
id: 260819-234830
title: OS-level notifications join DorkOS's periphery — superseding the ADR 0009 ban
status: proposed
created: 2026-08-19
spec: notification-system
supersedes: '0009'
superseded-by: null
---

# 260819-234830. OS-level notifications join DorkOS's periphery — superseding the ADR 0009 ban

## Status

Proposed. Supersedes ADR 0009 (calm-tech notification layers) on the point of
OS-level delivery; 0009's in-app layering (badge → toast → title) remains
valid and absorbed. The Electron leg (DOR-1386) has shipped — see
Implementation notes below; the browser and web-push legs remain to land.

## Context

ADR 0009 excluded the Browser Notification API entirely, reasoning from Calm
Tech's "check history, don't push". That decision predates the product's
current center of gravity: fleets of agents working for hours whose single
biggest waste is a blocked agent nobody notices. Calm Tech itself argues
technology "should make use of the periphery" — and for an operator who has
walked away, the periphery is the lock screen, not a tab title. Every native
surface required is now available: the Electron app is signed (macOS action
and reply callbacks work), localhost is a secure context for the Notification
API, and the relay already reaches Telegram/Slack.

## Decision

OS-level notifications are permitted and tiered: Electron native notifications
(with Allow/Deny actions and inline Reply for asks), in-page browser
notifications while the tab is hidden, and web push / relay messages as the
escalated phone leg — all governed by the four-kinds/three-tiers model
(Blocking and Notable only; Suggestions and Quiet never leave the app), by
contextual permission priming (never a prompt on launch), and by the ack-based
ladder. Sound is escalation-tier only: the knock for Blocking, all-clear
settle, turn-end chime off by default.

## Consequences

### Positive

- The product's core promise — safely stop watching — becomes true, natively,
  across desktop app, browser, and phone.
- Answer-from-the-notification removes the round trip that costs blocked
  agents 20–40 idle minutes today.
- Tiering and priming keep the Calm Tech posture: fewer, better interruptions.

### Negative

- A revoked OS permission silently degrades the ladder to the relay leg
  (mitigated by the settings surface showing channel health).
- Notification content now leaves the app process boundary; payloads must stay
  title-level (enforced in the registry, reviewed as a security property).

## Implementation notes

Shipped in DOR-1386 (`apps/desktop/src/main/notifications/`) — the Electron
leg of the ladder:

- `notifications/index.ts` watches the server's global SSE stream for the two live
  signals that carry Blocking/Notable today: the existing addressed
  `interaction_pending`/`interaction_resolved` events (an Ask is Attention —
  nothing broadcasts on the `notification` channel while it stands, see
  `notification-service.ts`'s module doc) for actionable Ask banners, and the
  new `notification`/`notification_read` events for everything else. Blocking
  always shows; Notable only while `BrowserWindow.getFocusedWindow()` is
  `null`; Quiet never does. A notification that arrives already read (the
  operator's own action, or read on another window) is skipped rather than
  popped again.
- A pending approval gets native Allow/Deny action buttons; a single-question
  ask gets a native inline Reply field (macOS `hasReply`); a multi-question
  ask or an elicitation is click-to-open only — one free-text field cannot
  honestly answer more than one question.
- Actions call the same `POST /api/sessions/:id/{approve,deny,submit-answers}`
  routes the cockpit's own buttons call, reached over `127.0.0.1` from the
  main process with no credential. A `401`/`403` (remote login on, main holds
  none) falls back to focusing the window and deep-linking to the Ask instead
  of a silent no-op, logged once per outage rather than once per click.
- Every native banner sets `silent: true` — sound is the client-side knock's
  job (spec's "Sounds" section), not the OS banner's; both firing would double
  one interruption into two sounds.
- `event-stream.ts` pulled the shared connection machinery out of
  `agent-activity.ts` (the tray's own watcher), so this reads the same TCP
  connection to `/api/events` rather than opening a second one — one
  reconnect loop and one outage log for both consumers, tested directly
  (`event-stream.test.ts`).
- Shown banners are de-duped by id (capped at 200 tracked) and closed when
  their Ask resolves (`interaction_resolved`) or their notification is marked
  read (`notification_read`).
- Deferred to later W3 tasks, not part of this PR: the browser leg (in-page
  `Notification` while the tab is hidden), web push, and the escalation
  service's phone leg.
