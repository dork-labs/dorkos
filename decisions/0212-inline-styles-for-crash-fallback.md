---
number: 212
title: Inline Styles Only for Catastrophic Crash Fallback
status: accepted
created: 2026-03-28
spec: client-error-handling
superseded-by: null
---

# 212. Inline Styles Only for Catastrophic Crash Fallback

## Status

Accepted

## Context

The top-level `AppCrashFallback` renders when everything else has failed — providers have crashed, the router is dead, context is unavailable. If this fallback imports any app bundle dependency (shadcn components, Tailwind classes, router hooks), and those dependencies rely on the crashed context, the fallback itself will crash — producing the white screen we're trying to prevent.

## Decision

`AppCrashFallback` uses inline styles exclusively. Zero imports from the app bundle — no shadcn, no Tailwind, no router, no context providers. The only import is the `FallbackProps` type from `react-error-boundary`.

Hardcoded color values match the DorkOS dark theme: `#09090b` (zinc-950) background, `#d4d4d8` (zinc-300) text, `#27272a` (zinc-800) borders, monospace font stack.

## Consequences

### Positive

- Guaranteed to render regardless of what crashed
- No cascading failures from broken context providers
- Matches the app's dark aesthetic even without Tailwind

### Negative

- Cannot use the design system — any visual updates must be manually synced
- Inline styles are verbose and harder to maintain
- Cannot use theme tokens — if the color palette changes, this file must be updated separately
