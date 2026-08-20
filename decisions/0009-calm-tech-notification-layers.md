---
number: 9
title: Use Calm Tech Layered Notifications for Background Tasks
status: superseded
created: 2026-02-21
spec: pulse-v2-enhancements
superseded-by: 260819-234830
---

# 9. Use Calm Tech Layered Notifications for Background Tasks

## Status

Superseded by [260819-234830](260819-234830-os-notifications-join-the-periphery.md)
(2026-08-19) on the point this ADR banned: OS-level delivery. This ADR's
in-app layering (badge → toast → title) remains valid and is absorbed there
as the in-app half of a now-tiered ladder; only the exclusion of the
Notification API is reversed.

## Context

Pulse scheduled runs complete in the background. Users need awareness of completions without being interrupted. The Calm Tech design philosophy ("check history, don't push") discourages system-level push notifications, but providing zero feedback forces users to manually poll the Pulse panel.

## Decision

Adopt a three-layer ambient notification system ordered by intrusiveness: (1) a static amber dot badge on the sidebar Pulse button for zero-interruption peripheral awareness, (2) an optional Sonner toast that auto-dismisses in 6 seconds for low-interruption feedback, and (3) a tab title badge `(N) DorkOS` for background-tab awareness. The Browser Notification API is explicitly excluded. Notifications only fire for state transitions observed during the current session to prevent retroactive spam.

## Consequences

### Positive

- Peripheral awareness without workflow interruption
- Each layer can be independently enabled/disabled
- No browser permission prompts required
- Session-scoped transitions prevent notification spam after overnight batches

### Negative

- Subtle indicators may be missed by users who don't look at the sidebar
- Polling-based detection (10-second interval) means up to 10 seconds of notification lag
- Tab title management must coordinate with any future title-setting features
