---
id: 260807-170131
slug: team-room-home
status: ideation
created: 2026-08-07
design-session: .dork/visual-companion/55521-1786115964
---

# Ideation: The home is a room (#team)

## Problem

The dashboard at `/` is a report about the system — status cards, promo cards, an activity
preview — while the live things it describes (running agents, waiting approvals, conversations)
live elsewhere. A snapshot of things that change every few seconds is stale the moment you stop
looking. Competitive research (Devin, Cursor, Codex, Copilot mission control, Conductor,
VibeKanban) shows every agent-native product converged on the same answer: the home IS the live
surface, not a report about it. Ours isn't.

## Direction (decided in the 2026-08-07 visual-companion session)

Replace the dashboard with the **#team room** — a real room containing the user and all their
agents — with a pinned triage header ("Waiting on you" + presence strip), a feed (moments,
agent posts, group conversation), and the full room composer. Sidebar shrinks to
**Home · Team · Connections · Marketplace**; Activity, Scheduled (Tasks), and Workspaces become
tabs on the home surface. A unified "Jump back in" recents list (DMs + rooms + runs) replaces
the sidebar Recents section and appears as a popover on the focused-empty composer.

**The full decision record — options considered, what was chosen and why, the moments
taxonomy, welcome-back rules, the where-you-reply routing rule, and captured risks — is in
[design-decisions.md](design-decisions.md).** That file is the source of truth for this spec's
design intent; this ideation doc is the frame around it.

## Scope of the program (expected decomposition)

- Phase 0 — thread-over-sessions ADR + room↔session identity hardening (prerequisite)
- Phase 1 — IA shell: tabs, sidebar consolidation, unified Jump-back-in
- Phase 2 — #team room home: pinned header, presence strip, feed, default-route swap
- Phase 3 — moments + welcome-back messages (config + etiquette caps)
- Phase 4 — extension/Shapes story for the new home surface

## Dependencies

- `composer-parity` (+ `composer-rich-text`, `room-attachments`) specs in flight — room-home
  composer work waits for parity.
- Rooms are behind the demo-claim gate (unverified end-to-end); hardening is part of this
  program, not an afterthought.
