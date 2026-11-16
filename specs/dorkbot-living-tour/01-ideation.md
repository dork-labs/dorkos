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

- **Spotlight primitive — DECIDED 2026-07-22 (operator review + library research, see below).** Adopt **`@reactour/tour`** (MIT, controlled `useTour()` API, fully swappable popover, mask-based cutout) wrapped behind our own `TourSpotlight` component API in `shared/ui`, so the tour engine never imports the library directly and a swap stays local. SPECIFY carries a **spike gate**: prove the hardest real flow (deep-link → async-mounted anchor → mobile bottom-sheet caption) plus the a11y bar before building on it. Documented fallback: `react-joyride` v3 (MIT, rewritten for React 19, dominant adoption, equally swappable tooltip). Roll-our-own (`@floating-ui` autoUpdate + SVG-mask + `motion` + Radix focus primitives — all already in our tree) only if both fail the spike; the mask math is cheap but scroll/resize tracking and focus/announcer timing are the hidden cost the libraries have paid down. The `aria-live` announcer is ours regardless (neither library provides it to our bar). Disqualified by research: intro.js and shepherd.js (both AGPL/commercial dual-licensed), onborda (no release in ~12 months). Verified 2026-07: no tour library in our dependency tree; `motion` + `@floating-ui/react-dom` (via Radix) already ship.
- **Anchors — DECIDED 2026-07-22.** No new `data-tour-id` attribute: tours target the existing **`data-testid`** convention (531 uses in the client; the e2e capture pipeline already consumes it, and the PR #371 selector-drift incident is the failure class this prevents). The tour/capture-consumed subset graduates into a small **typed anchor registry** (shared const map) imported by tour scripts and tests alike, so renames are compile-time events. Anchors stay demand-driven (added when a consumer points at them), never lint-required. `data-testid` must NOT be stripped from production builds.
- **Occasion detection.** Where do "first schedule created / first channel connected" signals come from without new server surfaces? Candidates: existing TanStack Query caches (tasks list transitions 0→1), session events, or a small client-side "firsts" store persisted in config (`onboarding`-adjacent but distinct: `tours.seen`, `tours.declined`). Must survive refresh; must never fire for pre-existing users (backfill "seen" for anyone with `completedAt` predating the feature, or gate on install age).
- **Script + copy.** Same authored-template approach as Tier 1 (script-as-data, DorkBot voice, personality-inflected via `dorkbot-templates`); tours are token-free.
- **Interruption/resume.** A tour interrupted by navigation or an incoming approval simply ends (state saved as "seen"); no resume machinery in v1 — tours are ≤3 steps by design so resume isn't worth its complexity.
- **Scope guardrails.** v1 subsystems: Tasks, Relay, Mesh, plus the on-demand general tour. Marketplace/Workspaces later. Nothing fires during an active streaming turn.

## Open questions — ANSWERED 2026-07-22 (operator review)

1. **Firsts store: `~/.dork/config.json`.** A `tours` block (`{ seen: string[], declined: string[] }`) beside `onboarding`; schema addition + semver migration per the `adding-config-fields` path. localStorage was rejected: per-browser state means being re-toured (or re-nagged) on every device, and multi-client consistency is the product's thesis. No backfill needed: occasions are observed 0-to-1 transitions, which pre-existing users with existing data never produce.
2. **Tour offers do NOT ride Tier 1's chips: build a general suggestion-chip slot.** Tier 1's chips are script-local to the onboarding conversation; tour offers happen mid-real-session and must be client-rendered affordances (never LLM text). SPECIFY defines a session-surface suggestion-chip slot, triggered by client-observed events; the living tour is its first customer, future nudges reuse it.
3. **Spotlight a11y: requirements committed now, primitive chosen in SPECIFY.** Esc and click-outside always end the tour; focus moves into and is trapped in the caption bubble; the dimmed background goes `inert`; captions announce via `aria-live="polite"` and name the target in text; reduced-motion collapses cutout animation.

Remaining SPECIFY-time work is empirical, not decisional: prototype cutout rect-to-rect morphs under `motion`, and anchor-wait behavior under slow loads (skip honestly on timeout).

## Non-goals

- No LLM-driven tours, no video, no coach marks sprayed across every surface, no re-engagement nags.
- Not a help system: docs remain docs; the tour shows _where things live_, not how everything works.
