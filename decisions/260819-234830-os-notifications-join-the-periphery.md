---
id: 260819-234830
title: OS-level notifications join DorkOS's periphery — superseding the ADR 0009 ban
status: accepted
created: 2026-08-19
spec: notification-system
supersedes: '0009'
superseded-by: null
---

# 260819-234830. OS-level notifications join DorkOS's periphery — superseding the ADR 0009 ban

## Status

Accepted 2026-08-22. Supersedes ADR 0009 (calm-tech notification layers) on
the point of OS-level delivery; 0009's in-app layering (badge → toast → title)
remains valid and absorbed. All three legs have landed: Electron native
notifications (DOR-1386, PR #1147), in-page browser notifications and the
Notifications settings page (DOR-1385, PR #1151), and the web-push/relay phone
leg (DOR-1387, PR #1153) — see Implementation notes below.

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
- A pending approval gets native Allow/Deny action buttons; a single-question,
  no-fixed-options ask gets a native inline Reply field. Both are **macOS
  only** — Electron's `actions`, `hasReply` and `replyPlaceholder` constructor
  options are all `@platform darwin`; on Windows the same banner shows with no
  buttons and no reply field, click-to-open only. A multi-question ask, a
  single-select question that still carries fixed `options`, or an
  elicitation is click-to-open everywhere, including macOS — a free-text
  reply can't honestly stand in for a set of answers or a choice from a fixed
  list.
- Actions call the same `POST /api/sessions/:id/{approve,deny,submit-answers}`
  routes the cockpit's own buttons call, reached over `127.0.0.1` from the
  main process with no credential. `401`/`403` (remote login on, main holds
  no credential) or a network failure falls back to focusing the window and
  deep-linking to the Ask, logged once per outage rather than once per click.
  A `refused` outcome (the server understood the click and said no — the Ask
  was already resolved by someone else, or its id no longer exists) does
  **not** steal focus: reopening the app over a card that isn't there any
  more would be a surprise for nothing, so that case only logs.
- Every native banner sets `silent: true` — sound is the client-side knock's
  job (spec's "Sounds" section), not the OS banner's; both firing would double
  one interruption into two sounds.
- `event-stream.ts` pulled the shared connection machinery out of
  `agent-activity.ts` (the tray's own watcher), so this reads the same TCP
  connection to `/api/events` rather than opening a second one — one
  reconnect loop and one outage log for both consumers, tested directly
  (`event-stream.test.ts`). Every subscriber callback (a frame, or a
  connection-lost notice) runs inside a try/catch: one subscriber's bug is
  logged and does not stop another subscriber, or crash the main process.
- Shown banners are de-duped by id (capped at 200 tracked) and closed when
  their Ask resolves (`interaction_resolved`) or their notification is marked
  read (`notification_read`).
- **Deviation from the spec's "agent name/emoji, body" wording:** a banner's
  headline names the session's working directory, not the agent — e.g. "dorkos
  is waiting on your answer", not "DorkBot is waiting on your answer". The
  wire event this reads (`InteractionPendingEvent`) deliberately carries no
  agent identity (see `interaction-events.ts`'s own "No denormalized
  identity" rule — a name copied onto a hot event goes stale the moment an
  agent is renamed), so resolving the true agent name here would mean
  correlating against the session list stream as a second lookup. Left as a
  known gap rather than done partially; the cwd-basename fallback matches
  what every other session surface already falls back to.
- Deferred to later W3 tasks, not part of this PR: the browser leg (in-page
  `Notification` while the tab is hidden), web push, and the escalation
  service's phone leg.
- **Manual verification still needed:** whether macOS actually renders both
  Allow and Deny as two distinct buttons on one banner (rather than, say,
  collapsing to one) is unverified pending a smoke test on a signed dev
  build — Electron's own docs note platform limits on how many action buttons
  a banner can show.
