---
number: 200
title: App-Layer Synchronous Extension Initialization
status: draft
created: 2026-03-26
spec: ext-platform-02-extension-registry
superseded-by: null
---

# 200. App-Layer Synchronous Extension Initialization

## Status

Draft (auto-extracted from spec: ext-platform-02-extension-registry)

## Context

The extension registry must be populated with built-in feature contributions before any React component mounts and queries it. In FSD architecture, the `shared` layer hosts the registry store, but `shared` cannot import from `features` or `widgets`. The initialization code must import contribution data from feature barrels and wire them to the registry — which requires importing across FSD layers.

## Decision

Create an explicit `initializeExtensions()` function in `apps/client/src/app/init-extensions.ts`, called synchronously from `main.tsx` before `createRoot().render()`. The app layer is the only FSD layer permitted to import from all other layers, making it the architecturally correct location. Features export their contribution data via barrel `index.ts` files; `init-extensions.ts` imports from each feature barrel and calls `register()` for each contribution. Features never import each other.

## Consequences

### Positive

- FSD-compliant: no layer violations; only the app layer crosses boundaries
- Synchronous call ensures registry is populated before any component mounts — no race conditions or flash of empty content
- Features remain decoupled: they export data, never knowing who consumes it
- Single, auditable initialization file shows exactly what's registered

### Negative

- Adding a new built-in feature requires updating `init-extensions.ts` in addition to the feature itself
- All contribution data is imported eagerly at startup (acceptable for built-in features; Phase 3 may need lazy loading for extensions)
