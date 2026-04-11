---
number: 222
title: Pin @vitejs/plugin-react at v5.x During electron-vite v5 Upgrade
status: draft
created: 2026-04-01
spec: upgrade-electron-vite
superseded-by: null
---

# 222. Pin @vitejs/plugin-react at v5.x During electron-vite v5 Upgrade

## Status

Draft (auto-extracted from spec: upgrade-electron-vite)

## Context

The electron-vite v5.0.0 upgrade bundles Vite 7 internally. The renderer build uses `@vitejs/plugin-react` for JSX transform and React Fast Refresh (HMR). At the time of the upgrade, `@vitejs/plugin-react` v6.0.0 has been released. However, v6 drops its Babel dependency and requires Vite 8 as a peer dependency. Since electron-vite v5 bundles Vite 7, `@vitejs/plugin-react` v6 would produce a Vite peer dependency mismatch at runtime.

## Decision

We keep `@vitejs/plugin-react` at `5.1.4` (current version, pinned exact) rather than upgrading to v6.x. The version is already Vite 7-compatible and there are no functional gaps relevant to this project. Upgrading to `@vitejs/plugin-react` v6 is deferred until electron-vite ships with Vite 8.

## Consequences

### Positive

- Avoids a peer dependency mismatch (Vite 8 required vs. Vite 7 bundled)
- Zero code changes needed in renderer source files
- HMR and JSX transform continue to work identically

### Negative

- `@vitejs/plugin-react` v5 will eventually fall out of active maintenance
- Plugin v6's Babel-free transform cannot be adopted until the electron-vite bundle upgrades to Vite 8
- Requires a follow-up upgrade once electron-vite v6 (or the next major) ships Vite 8
