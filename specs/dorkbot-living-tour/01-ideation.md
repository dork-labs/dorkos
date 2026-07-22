# DorkBot Living Tour — Ideation

**Id:** 260722-120926 · **Created:** 2026-07-22 · **Project:** DorkBot Is the Onboarding (Tier 3, DOR-419) · **Stage:** ideation — decisions here are directional, to be settled in SPECIFY after Tiers 1-2 ship.

## Problem

After the conversational onboarding (Tier 1) and the action dashboard (Tier 2), a new operator can talk to DorkBot and start work, but the rest of the cockpit (Tasks, Relay channels, Mesh, Workspaces, Marketplace) is still learn-by-poking. Feature tours in most products are overlay slideshows users dismiss and forget; DorkOS has something better available: an agent who lives in the product and can walk you to the real thing at the moment it matters.

## Idea

DorkBot gives tours **of real surfaces, on real occasions**, not a day-one slideshow:

- **Occasion-driven, not sequential.** Subsystems introduce themselves at first genuine use: the first time DorkBot schedules something, it says "I put that on the schedule — this is where schedules live" and offers to show `/tasks`. First channel connect → Relay's home. First multi-agent moment → Mesh. No occasion, no tour.
- **Deep-link + spotlight.** Accepting an offer navigates to the real route and spotlights the real element (dim overlay + cutout + a DorkBot caption bubble). Never a screenshot, never a fake mock; if the surface is empty, the tour points at the thing you just created, so there is always a real referent.
- **Conversational entry and exit.** Tour offers arrive as chips in the session ("Show me" / "Later"); every tour step is escapable (click anywhere outside / Esc); "Later" is remembered and not re-offered for that subsystem more than once (a nag is worse than no tour).
- **An explicit door too:** "Show me around" (the onboarding hand-off suggestion chip, and a Getting Started row) starts the general tour on demand — same mechanics, user-initiated.

## Mechanics to settle in SPECIFY

- **Spotlight primitive.** Likely a small `TourSpotlight` overlay (portal, dim + cutout by target ref/selector, caption slot, keyboard escape) in `shared/ui` — needs a registry of tourable anchors (data-tour-id attributes) so features opt in without coupling. Investigate `motion` layout for cutout transitions; respect reduced-motion.
- **Occasion detection.** Where do "first schedule created / first channel connected" signals come from without new server surfaces? Candidates: existing TanStack Query caches (tasks list transitions 0→1), session events, or a small client-side "firsts" store persisted in config (`onboarding`-adjacent but distinct: `tours.seen`, `tours.declined`). Must survive refresh; must never fire for pre-existing users (backfill "seen" for anyone with `completedAt` predating the feature, or gate on install age).
- **Script + copy.** Same authored-template approach as Tier 1 (script-as-data, DorkBot voice, personality-inflected via `dorkbot-templates`); tours are token-free.
- **Interruption/resume.** A tour interrupted by navigation or an incoming approval simply ends (state saved as "seen"); no resume machinery in v1 — tours are ≤3 steps by design so resume isn't worth its complexity.
- **Scope guardrails.** v1 subsystems: Tasks, Relay, Mesh, plus the on-demand general tour. Marketplace/Workspaces later. Nothing fires during an active streaming turn.

## Open questions for SPECIFY

1. Does the "firsts" store live in `~/.dork/config.json` (schema addition + migration) or client localStorage (no migration, but not synced across clients)? Leaning config: multi-client consistency is the product's whole point.
2. Can the tour offer ride the existing session-chip UI from Tier 1's conversation, or does it need a chat-level affordance for _any_ session (DorkBot suggestion chips as a general mechanism)?
3. Accessibility review of the spotlight pattern (focus trap, screen-reader narration of captions).

## Non-goals

- No LLM-driven tours, no video, no coach marks sprayed across every surface, no re-engagement nags.
- Not a help system: docs remain docs; the tour shows _where things live_, not how everything works.
