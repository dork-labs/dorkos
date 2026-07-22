---
id: 260722-154340
title: Adopt @reactour/tour behind a TourSpotlight wrapper, gated by a spike
status: accepted
created: 2026-07-22
spec: dorkbot-living-tour
superseded-by: null
---

# 260722-154340. Adopt @reactour/tour behind a TourSpotlight wrapper, gated by a spike

## Status

Accepted

## Context

The living tour needs a spotlight primitive: dimmed backdrop with an animated cutout, custom caption UI, deep-link-then-wait anchor flows, and a strict a11y bar. Fresh research (2026-07) disqualified intro.js and shepherd.js (both AGPL/commercial dual-licensed) and onborda (no release in ~12 months). The finalists: `@reactour/tour` (MIT, controlled `useTour`, fully swappable popover, lighter, smaller community) and `react-joyride` v3 (MIT, dominant adoption, rewritten for React 19, heavier, wants partial state ownership). Roll-our-own is viable (`@floating-ui` + SVG mask + `motion` + Radix primitives, all in-tree) but re-pays the scroll/resize-tracking and focus/announcer-timing costs the libraries have amortized.

## Decision

We will adopt `@reactour/tour`, wrapped behind our own `TourSpotlight` component API so the tour engine never imports the library and a swap stays local. Adoption is gated by a spike proving the hardest real flow (deep-link, async-mounted anchor with timeout-skip, custom caption bubble, mobile bottom sheet) plus the full a11y bar; `react-joyride` v3 is the documented fallback, roll-our-own the last resort. The `aria-live` announcer is ours in every path.

## Consequences

### Positive

- The hard overlay math (scroll/resize tracking, positioning) is amortized library code; our surface is one wrapper and the a11y layer.
- The wrapper contract makes the library swappable without touching tour definitions or the engine.

### Negative

- reactour's smaller community means edge-case fixes may fall to us (mitigated by the spike and the fallback).
- A new client dependency to track for license/maintenance drift.
