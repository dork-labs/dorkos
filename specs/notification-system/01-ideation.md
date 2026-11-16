---
status: ideation
created: 2026-08-19
design-session: .dork/visual-companion/12683-1787180875
research: research/20260819_notification-system-review.md
decisions: design-decisions.md
depends-on:
  - DOR-1369 (bottom-slot arbiter — in flight, consume, do not touch)
  - specs/sidebar-simplification (Heads up zone, Today digest, 2A agent-DM routing)
supersedes-adrs:
  - '0009-calm-tech-notification-layers (the OS-notification ban — superseding ADR to be drafted at SPECIFY)'
---

# Unified notification system

## Problem

DorkOS has ~14 independent attention systems and no notification system. Two
engines compute "needs attention" with different rules; the event that most
deserves a notification (an agent parked a scheduled task for approval)
produces zero signal anywhere; the moment users most want a tap on the
shoulder (an agent blocked while they walked away) produces zero signal
outside the app for up to 4 hours; one failed click can produce two toasts;
dismissal/preference state is split between server config and per-browser
localStorage. Full evidence with file:line citations:
`research/20260819_notification-system-review.md` §2, §6.

## Direction (all decided — see design-decisions.md)

One model: every message to the operator is exactly one of four kinds —
**Attention** (standing, mirrored, clears on resolution), **Activity** (event,
Inbox, read state), **Suggestion** (bottom slot), **Feedback** (inline first,
toast only off-screen) — with three tiers (**Blocking / Notable / Quiet**).
One server pipeline (registry + `notify()` + audience/presence/dedupe +
per-channel delivery ledger) feeding in-app mirrors, an Inbox with filtered
lenses (global bell, agent profile, session), and out-of-app channels
(Electron native, desktop web push, Telegram/Slack) behind a one-knob
escalation ladder for Blocking. Strict toast diet. Four moments: answer from
anywhere, the Shift Report, the knock, all-clear everywhere.

## Why now

- The Ask system (DOR-1350/1356) just landed the exact primitives the pipeline
  needs: addressed SSE fan-out, entitlement, park/expire, six answer routes,
  answer-anywhere client discipline.
- The sidebar-simplification pass (2026-08-19) is deleting/reshaping the
  surfaces this system projects into, and its 2A decision routes
  agent-initiated DMs to "a dot in Today" — which needs the doorbell this spec
  provides.
- Competitive white space: no coding-agent vendor ships blocked-agent →
  phone → answer-from-lock-screen natively; users pay for bolt-ons
  (research §3.7).

## Scope

Waves (each ships alone; research §7): **W0** bug fixes + toast diet ·
**W1** one attention engine + parked-schedule signal + honest tray ·
**W2** Inbox (store, ledger, bell, lenses, read state) · **W3** channels +
ladder + sound family + config prefs · **W4** messages integration + Shift
Report · **W5** iOS PWA relay.

Out of scope: email/SMS channels; configurable escalation matrices (one knob
only); snooze (open item); Critical tier implementation.

## Open items

Carried in design-decisions.md §9 — resolve at SPECIFY.
