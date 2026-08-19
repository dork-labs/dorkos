---
id: 260819-234830
title: OS-level notifications join DorkOS's periphery — superseding the ADR 0009 ban
status: draft
created: 2026-08-19
spec: notification-system
supersedes: '0009'
superseded-by: null
---

# 260819-234830. OS-level notifications join DorkOS's periphery — superseding the ADR 0009 ban

## Status

Draft (auto-extracted from spec: notification-system). Supersedes ADR 0009
(calm-tech notification layers) on the point of OS-level delivery; 0009's
in-app layering (badge → toast → title) remains valid and absorbed.

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
