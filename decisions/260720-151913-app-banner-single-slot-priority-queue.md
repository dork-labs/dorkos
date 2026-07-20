---
id: 260720-151913
title: Global app banners live in one below-header slot with a priority queue, never stacked
status: accepted
created: 2026-07-20
spec: null
superseded-by: null
---

# 260720-151913. Global app banners live in one below-header slot with a priority queue, never stacked

## Status

Accepted. Extends [ADR-0009](0009-calm-tech-notification-layers.md) (calm-tech notification tiering) to the persistent-banner tier, and amends the "shows the payload verbatim, up front" posture of [260711-141639](260711-141639-opt-in-observability-consent.md) — the payload is now one click away, never gone.

## Context

Two app-wide banners — the first-run telemetry disclosure and the all-permissions-bypassed warning — mounted above the whole app shell, one stacked on top of the other. Two bugs fell out of that placement: the shadcn sidebar container is `fixed inset-y-0 z-10`, so it painted _over_ any banner sitting outside the inset; and each banner's height pushed the shell header down instead of sitting under it. Stacking also had no answer for "which one matters most" — if both were eligible, the user saw both, in mount order, with no ranking.

More banners are coming (connection-lost, update-available, and others), so we needed a single answer for _where_ a standing banner renders, _how many_ show at once, and _which_ wins — not another one-off mount.

Separately, the telemetry disclosure showed the exact heartbeat payload as an always-open block. Honest, but it made a routine "is this on?" notice read like a wall of JSON, and it was the tallest thing on the screen on first run.

## Decision

**One slot, below the header, inside the inset.** A single `AppBannerSlot` renders immediately after the shell header and before the main content, _inside_ `SidebarInset`. Because it lives in the inset's normal flow, the fixed sidebar can never paint over it and it never pushes the header down. The embedded (Obsidian) shell keeps mounting its one banner directly; only the web cockpit runs the slot.

**A priority queue — one banner at a time, never a stack.** Each banner is a `BannerDescriptor` (`id`, numeric `priority`, `variant`, `render`) produced by a per-feature descriptor hook that returns `null` when its banner is not eligible. The slot ranks the eligible descriptors and renders _only the highest-priority one_. Swaps are exit-before-enter (`AnimatePresence mode="wait"`), so a higher-priority banner cleanly replaces a lower one and the row collapses to nothing when none are eligible. Adding a banner is one descriptor hook plus one line in the composer — no new mount, no new layout decision.

**A four-rung severity ladder: `critical > warning > info > neutral`.** `critical` is a red banner that announces assertively (`role="alert"`); `warning` (amber), `info` (blue), and `neutral` (muted, for announcements and consent) announce politely (`role="status"`) so a persistent banner never steals focus. **`success` is deliberately not a banner variant** — a success is a transient event, which is a toast's job (ADR-0009); a banner marks a _standing condition_ that persists until it resolves. Colors reuse the existing `--status-*` design tokens (defined once in `index.css`, already mirrored in the Obsidian theme bridge), so there is one source of truth for banner color in both themes.

**Severity-gated dismissal.** A banner shows a dismiss control only when it is given a dismiss handler. The permission-bypass warning is non-dismissible and clears itself when the session leaves bypass mode; the telemetry notice has no dismiss X at all — its two buttons (turn off / keep sharing) are the only exits.

**Progressive disclosure for the telemetry payload.** The consent banner now leads with a one-line summary and tucks the exact payload behind a "See what's sent" toggle that expands in place. This amends 260711-141639: the payload is still shown verbatim and is still one click away on every telemetry surface (consent banner, onboarding step, privacy settings) — it is just no longer the first thing you read. The affordance is single-sourced in the config entity as shared sub-components — the "See what's sent" toggle and the payload block — so all three surfaces read the same; the banner drives the `Banner` primitive's details region while onboarding and settings compose the same pieces in a self-contained disclosure.

## Consequences

### Positive

- The sidebar can never occlude a banner again, and banners no longer push the header down — both original bugs are structurally fixed, not patched.
- One ranked slot means the user sees the single most important standing condition, never a stack competing for attention. New banners (connection, updates) drop in as descriptors with a priority — no layout or z-index archaeology.
- Color lives in the `--status-*` tokens only; light and dark themes and the Obsidian bridge stay correct for free.
- The `role` split keeps the calm-tech promise: only a genuine `critical` interrupts a screen-reader; everything else is announced politely.
- The telemetry notice reads like a one-line disclosure, not a JSON dump, while keeping the full payload one honest click away.

### Negative / trade-offs

- Only one banner is visible at a time by design. If two conditions genuinely both need eyeballs, the lower-priority one waits until the higher one clears. We judge "one clear signal" better than a stack, and the priority ladder makes the choice explicit.
- Eligibility for a banner is expressed in two nearby places for the self-contained banners (the descriptor hook that ranks it and the component that renders it). They read the same state and agree; the duplication is a one-line predicate, kept for the sake of a component that is also usable standalone.
- The permission banner reads its session from the query cache non-reactively (unchanged from before), so it updates on the shell's normal re-render cadence rather than instantly.
