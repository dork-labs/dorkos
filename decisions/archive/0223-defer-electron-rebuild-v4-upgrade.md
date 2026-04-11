---
number: 223
title: Defer @electron/rebuild v4 Upgrade Due to electron-builder Compatibility
status: draft
created: 2026-04-01
spec: upgrade-electron-vite
superseded-by: null
---

# 223. Defer @electron/rebuild v4 Upgrade Due to electron-builder Compatibility

## Status

Draft (auto-extracted from spec: upgrade-electron-vite)

## Context

`@electron/rebuild` is used to rebuild native Node.js modules (specifically `better-sqlite3`) for the target Electron ABI. The project uses `@electron/rebuild` in two ways: (1) automatically via `electron-builder`'s `npmRebuild: true` setting in `electron-builder.yml`, where electron-builder calls the package programmatically; and (2) manually via `npx @electron/rebuild` as a fallback for dev-mode native module mismatches. `@electron/rebuild` v4.0.0 went ESM-only and removed the CommonJS default export that electron-builder relies on internally.

## Decision

We keep `@electron/rebuild` at `^3.7.2` rather than bumping to v4.x. The API breaking changes in v4 (ESM-only, removed default export) create a risk that electron-builder's internal programmatic use will break at packaging time — a failure mode that would be discovered only when running `pnpm pack` or during CI builds. Until electron-builder explicitly documents compatibility with `@electron/rebuild` v4 or ships a version that depends on it directly, the risk outweighs the benefit of the upgrade.

## Consequences

### Positive

- electron-builder's `npmRebuild: true` continues to work reliably for native module rebuilds
- No packaging-time surprises — both local `pack` and CI `dist` builds use the tested path
- The manual fallback (`npx @electron/rebuild --version 39.8.5`) also continues to work

### Negative

- `@electron/rebuild` v3 will eventually fall behind the Electron ABI support curve
- Missing any performance or API improvements in v4
- Requires monitoring electron-builder release notes for explicit v4 compatibility confirmation before upgrading
