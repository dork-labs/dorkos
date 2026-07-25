---
id: 260725-004456
title: Status bar items are registry-driven and quiet by default
status: accepted
created: 2026-07-25
spec: composer-status-redesign
superseded-by: null
---

# 260725-004456. Status bar items are registry-driven and quiet by default

## Status

Accepted

## Context

The session status bar grew one item at a time, and each addition cost the same four edits: a `showStatusBar<X>` boolean plus setter in the app store, a hand-written `<StatusLine.Item>` + `<ItemContextMenu>` wrapper in `ChatStatusSection`, a row in the configure popover, and a registry entry that only carried presentation metadata. `ChatStatusSection` reached 605 lines, 250 of which were ten near-identical wrapper blocks, and it subscribed to the entire app store with a selector-less `useAppStore()` — so any unrelated store write re-rendered the bar and its eleven children.

The visibility model was the deeper problem. Every item rendered **always**, and the only control was a preference to hide it: ten toggles, a configure popover, a per-item right-click "Hide this item", and reset-to-defaults — roughly 500 lines whose entire purpose was letting a person undo a decision the product declined to make. The result was a resting bar of fourteen elements in which nothing stood out, so the numbers that mattered (context at 91%, a dropped connection) landed with exactly the same weight as the ones that never change.

Two structural bugs followed from the same architecture. `StatusLine` tracked visible items by registration order via mount effects, so hiding and re-showing an item re-registered it at the end of the list and left it rendering with a leading separator; and because children were rendered in two tree positions depending on whether any item was visible, the empty→non-empty transition unmounted and remounted every item, dropping open popovers. Neither was fixable without changing where visibility is decided.

Mobile made the visibility model's cost concrete. A 375px viewport leaves ~343px of bar; an ordinary degraded state needs ~568px. Overflow was handled by `overflow-x-auto` plus a fade gradient — but `touch-action: pan-y` on an ancestor (for drag-to-collapse) intersects down the tree and blocks the inner container's horizontal panning, so the fade advertised items that could not be reached at all.

## Decision

**The registry is the single source of truth for status bar items, and an item earns its place in the line rather than occupying it by default.**

Three parts:

1. **Promotion replaces visibility.** Each registry entry declares `promote(ctx)` — is this item newsworthy right now? — and `severity(ctx)`, resolved against live state rather than a per-item constant, because one item legitimately occupies different ranks at different values (a context window at 88% outranks a usage warning; at 74% it does not). Entries may declare `neverInLine`, which no user preference can override: `cache` is diagnostics, and `sound`/`refresh` are settings that only change when a person changes them, so neither can ever be news.

2. **Pins replace toggles.** One `statusBarPins` list replaces ten booleans. A pin overrides an item's promotion rule but does **not** bypass the width budget, and a pinned-but-quiet item sorts to the bottom of the ranking — a pin says "show me", not "shout at me". Pinning lives beside the live value in the Session panel, which absorbs the configure popover entirely. Diagnostics rows are deliberately unpinnable; that invariant is what stops pins from degenerating back into ten toggles.

3. **The line is measured, never scrolled and never wrapped.** A `ResizeObserver` on the bar resolves a density tier and an item budget; promotion produces an ordered array of descriptors which is filtered to the right cluster, sorted by severity, and sliced to the budget, with the remainder surfaced as `+N`. The `⋯` reveal is rendered outside the item list, so it is structurally never droppable — which is what makes truncation safe, because nothing is lost, only moved one tap away.

Because visibility is now known synchronously from the registry, `StatusLineContext` and its mount-effect registration are deleted outright, and the line always renders.

## Consequences

- Adding a status item is one registry entry plus one node. `ChatStatusSection` fell to ~300 lines; `ChatStatusStrip` split into a pure priority stack and its renderers.
- Both structural bugs disappear rather than getting patched: separator position derives from declared order, and there is no longer a second render position to remount from.
- `promote` and `severity` are pure functions of a context object, so promotion rules and the mobile ranking are unit-testable without React — the layer most likely to be argued about is the cheapest to verify.
- **The honesty burden moves into the registry.** A wrongly-written `promote` now makes a real signal invisible, where the old model's worst case was merely clutter. That is the deliberate trade — clutter is a certainty and invisibility is a bug — but it means promotion thresholds deserve the scrutiny of a security rule, not a style preference. Threshold constants are named (`CONTEXT_PROMOTE_PERCENT`, `CONTEXT_ACTION_PERCENT`) and separate from the colour-severity constants that the fleet gauge also reads.
- `useIsMobile()` is no longer permitted to drive anything on the bar. It is a single 768px boolean that cannot distinguish a 767px tablet from a 320px phone and cannot see browser zoom or Dynamic Type; it survives only for the popover-vs-bottom-sheet split, which is a genuine presentation choice.
- Width `0`/`null` means "not yet laid out", not "a 0px screen", and resolves to the unlimited tier. Any future consumer of the budget must preserve that reading or desktop mounts will flash a two-item bar.
- Deleting the collapse gesture is a consequence, not a separate decision: a one-line bar of at most a few items has nothing to collapse, and removing it also removes the `touch-action` conflict that made overflow unreachable.
- Stale `dorkos-show-status-bar-*` localStorage keys are purged rather than migrated. These were browser-local UI preferences, never `conf`-backed `~/.dork/config.json` state, so no schema migration applies — a distinction worth preserving when adding future bar preferences.
