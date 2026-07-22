# DorkBot Living Tour — Specification (Tier 3, DOR-419)

**Id:** 260722-120926 · **Status:** specified · **Builds on:** Tiers 0-2 (shipped: conversation onboarding, dashboard composer/cards, `data-testid` conventions). Decisions locked in 01-ideation (operator-reviewed 2026-07-22): `@reactour/tour` behind a wrapper with a spike gate, `data-testid` + typed anchor registry, config-backed firsts store, general suggestion-chip slot.

## Summary

DorkBot gives tours of real surfaces on real occasions. Three occasion tours (Tasks, Relay, Mesh) fire at first genuine use; one general tour runs on demand ("Show me around"). Tours are token-free (authored captions in DorkBot's voice), ≤3 steps, decline-once, and end on any escape. The spotlight primitive is our own `TourSpotlight` API wrapping `@reactour/tour` (go/no-go spike first).

## Phase 0 — the spike (go/no-go gate, first commit(s))

Prove `@reactour/tour` against the hardest real flow before building on it, in a dev-playground route (`/dev` showcase), evaluated against ALL of:

- S1: deep-link to `/tasks`, wait for an async-mounted anchor (poll with a 4s budget), scroll into view, spotlight it; on timeout the step skips (no spotlight on nothing).
- S2: fully custom popover: our caption bubble (DorkBot avatar + authored line + chips), zero library styling.
- S3: mobile viewport (<640px): caption renders as a bottom sheet.
- S4: a11y bar: Esc AND click-outside end the tour; focus trapped in the caption; background `inert`/`aria-hidden`; caption announced via `aria-live="polite"` and naming its target in text; `prefers-reduced-motion` collapses cutout animation.
- S5: step-to-step cutout transition is smooth (no jump-cut worse than a fast fade).

**If any criterion fails:** retry with `react-joyride` v3 (same wrapper API). If both fail: roll-our-own (`@floating-ui` autoUpdate + SVG-mask + `motion` + Radix focus primitives — all in-tree). The spike outcome is recorded in the PR body and the ideation doc. The `TourSpotlight` wrapper API below is the contract either way; the tour engine never imports the library.

## Architecture

### Anchor registry (`shared/config`)

`apps/client/src/layers/shared/config/tour-anchors.ts`: a typed const map, e.g. `TOUR_ANCHORS = { dashboardComposer: 'dashboard-composer', yourAgents: 'dashboard-your-agents', navTasks: 'nav-tasks', navAgents: 'nav-agents', relayChannels: 'settings-relay-channels', tasksList: 'tasks-list' } as const`. Consumers stamp `data-testid={TOUR_ANCHORS.x}` (reuse existing testids where surfaces already have them — extend, don't duplicate). `data-testid` is never stripped from production builds (assert via a build test or a comment-anchored config guard).

### `TourSpotlight` (`shared/ui`)

Controlled wrapper: `{ steps: TourStep[], activeIndex, onAdvance, onEnd }` where `TourStep = { anchor: TourAnchorId, caption: string, chipLabel?: string }`. Owns: anchor resolution (poll + 4s timeout → auto-advance/skip), scroll-into-view, the mask/popover rendering via the spiked library, and the full S4 a11y bar (the `aria-live` announcer is OURS regardless of library). No tour state inside: the engine drives it.

### Tour engine (`features/tours`)

- `model/tour-definitions.ts` — tours as data: `{ id: 'tasks' | 'relay' | 'mesh' | 'general', steps, occasion? }`. Captions from `@dorkos/shared/dorkbot-templates` (authored, personality-inflected via the same trait templates as onboarding; plain language, no em dashes).
- `model/use-tour-occasions.ts` — occasion detection, client-side, observed 0→1 transitions while the app is open: tasks count 0→1 (tasks query cache), relay channels 0→1, mesh agents 1→2. Never fires during an active streaming turn; never fires when `tours.seen`/`declined` contains the id; at most one offer per session view at a time.
- `model/use-tours.ts` — the engine: offer → accept (run tour, mark seen) / decline (mark declined, never re-offer). State persists via the config `tours` block.
- `ui/TourOfferChips.tsx` — the **suggestion-chip slot**: client-rendered chips ("Show me" / "Later") that appear under the latest assistant message on the session surface when an occasion fires. Built as a general slot (the tour is its first customer): the chat feature exposes a mount point; the tours feature contributes into it (follow the existing slot/contribution patterns, e.g. dashboard sections; mind FSD: chat may render the slot, tours contributes via the app layer or an extension-registry-style seam — no feature→feature model import).

### Config (`tours` block)

`packages/shared/src/config-schema.ts`: `tours: { seen: string[], declined: string[] }` with `.default({ seen: [], declined: [] })`. Added-with-default → conf's defaults-merge handles it: **no migration needed** (verify against the config-manager migration conventions; if the release-time drift check disagrees, add the trivial migration then). PATCH via the existing config route; client mutations mirror the onboarding-state pattern (`use-onboarding.ts`).

### Entry points

- **On-demand:** the onboarding hand-off suggestion chip "Show me around" (already inserts text today — rewire to launch the general tour directly instead of inserting text), plus a "Show me around" row in the Getting Started card. Both run the `general` tour: composer → your-agents → Tasks nav (3 steps, deep-link home first).
- **Occasions:** tasks/relay/mesh tours offered via `TourOfferChips` when their 0→1 transition is observed. Copy example (Tasks): "I put that on the schedule. Want to see where schedules live?"

## Tests

- `TourSpotlight`: anchor found → spotlight; anchor timeout → skip; Esc/click-outside → onEnd; focus trap + inert + aria-live (jsdom-level assertions); reduced-motion branch.
- Engine: occasion fires only on observed 0→1 (not on initially-nonzero, not during streaming); seen/declined suppress offers; accept marks seen + runs; decline marks declined; config PATCH shapes.
- Templates: captions per tour exist, personality-inflected, no em dashes.
- Anchor registry: every `TOUR_ANCHORS` value appears in the DOM of its owning component's test (each owning component's test asserts its own anchor).
- Regression canaries: onboarding conversation tests (the "Show me around" chip rewire), Getting Started card tests.

## Acceptance (browser-verified, fresh + populated containers)

1. Fresh install → complete onboarding → "Show me around" runs the general tour over the real dashboard: dim + cutout on the composer, DorkBot caption, chip-advance, Esc exits.
2. Create the first task (via DorkBot or /tasks) → the offer chip appears in-session; accept → deep-links to /tasks and spotlights the real list; decline → never offered again (persists across refresh + a second client).
3. Screen-reader sanity: captions announced, focus lands in the caption, background inert; reduced-motion shows no cutout animation.
4. Zero tokens consumed by any tour.

## Execution plan

Single worktree, single implementing agent (opus), phased commits: (0) spike + verdict, (1) anchor registry + TourSpotlight wrapper + a11y, (2) config block + engine + occasion detection, (3) offer chips + entry-point rewires + general tour, (4) occasion tours + templates + test sweep + fragments (one per user-facing commit). Auditor per REVIEW.md, then the browser pass, then PR. If the spike forces the fallback path, the executing agent reports before proceeding past Phase 1.
