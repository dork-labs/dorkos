---
number: 9
title: Use Calm Tech Layered Notifications for Background Tasks
status: draft
created: 2026-02-21
spec: pulse-v2-enhancements
superseded-by: null
---

# 9. Use Calm Tech Layered Notifications for Background Tasks

## Status

Draft (auto-extracted from spec: pulse-v2-enhancements)

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
