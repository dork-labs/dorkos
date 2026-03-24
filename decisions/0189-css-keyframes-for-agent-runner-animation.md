---
number: 189
title: Use CSS @keyframes for Agent Runner Animation
status: draft
created: 2026-03-23
spec: background-agent-indicator
superseded-by: null
---

# 189. Use CSS @keyframes for Agent Runner Animation

## Status

Draft (auto-extracted from spec: background-agent-indicator)

## Context

The background agent indicator renders up to 4-5 simultaneous animated SVG running figures, each with 10+ independently animated limb segments (thigh, shin, upper arm, forearm per side, plus whole-body bounce). Three animation approaches were evaluated: CSS @keyframes, Motion library (motion/react), and Lottie/Rive.

## Decision

Use CSS `@keyframes` with `transform-origin` per joint for the running cycle animation, reserving Motion's `AnimatePresence` only for enter/exit transitions (slot unfold/collapse). The SVG figure's color is set via a CSS custom property (`--c`) per-agent instance.

## Consequences

### Positive

- Zero JS overhead per animation frame — GPU-composited CSS transforms only
- 5 runners × 10 segments = 50 CSS animations perform effortlessly vs. 50+ Motion instances
- Trivially colorable via CSS custom properties without prop threading
- Already proven across 5 mockup iterations

### Negative

- Cannot dynamically change animation speed at runtime (e.g., faster when agent is active)
- CSS keyframes are less flexible than spring-based Motion animations for future creative changes
- Two animation systems in one component (CSS for cycle, Motion for lifecycle) — but this is already the pattern in ScanLine
