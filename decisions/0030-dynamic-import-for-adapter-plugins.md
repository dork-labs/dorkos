---
number: 30
title: Adapter Plugin Contract — Dynamic import() Loading and Factory Export Pattern
status: accepted
created: 2026-02-25
spec: relay-runtime-adapters
superseded-by: null
---

# 30. Adapter Plugin Contract — Dynamic import() Loading and Factory Export Pattern

## Status

Accepted

## Context

The Relay adapter system needs to support third-party adapters distributed as npm packages or local files. Two decisions are coupled and documented together: (1) how plugins are loaded at runtime, and (2) what shape a plugin module must export. Several loading approaches were considered: a full plugin framework with dependency injection, require()-based loading, and native ES module dynamic import(). For the export contract, options included named class export (`export class SlackAdapter`), default export factory function, or named factory plus config schema.

## Decision

**Loading:** Use native `import()` for all dynamic adapter loading — `import(packageName)` for npm packages and `import(pathToFileURL(absolutePath).href)` for local files. Loading errors are non-fatal; log and continue with remaining adapters. No hot-reload (server restart required); only enable/disable toggling via config.

**Export contract:** Third-party adapters export a default factory function that receives adapter-specific config and returns a `RelayAdapter` instance. Package naming convention: `dorkos-relay-{channel}` (e.g., `dorkos-relay-slack`). The host system calls the factory, then duck-type validates the returned object against the `RelayAdapter` interface shape.

## Factory Signature Update

The original factory signature was:

```typescript
export default function createAdapter(config: Record<string, unknown>): RelayAdapter;
```

This was updated to include the adapter instance `id` parameter:

```typescript
export default function createAdapter(id: string, config: Record<string, unknown>): RelayAdapter;
```

The `id` is the adapter instance ID from the user's `adapters.json` configuration (e.g., `"my-telegram"`). Without it, plugin-loaded adapters could not set their own `id` property correctly -- the ID was available to the plugin loader via `entry.id` but was never passed through to the factory function.

This change was made as part of the relay adapter DX improvements (`specs/relay-adapter-dx`). The built-in adapter factory map was updated in parallel to use the same `(id, config)` signature.

## Consequences

### Positive

- Zero new dependencies — uses Node.js built-in module system
- Matches established patterns from ESLint, Vite, and Rollup plugin ecosystems (both loading and factory export)
- Simple, ergonomic API — one function to call with id and config; config injection happens at creation time
- Adapter authors only need to learn one pattern

### Negative

- Node.js module cache prevents true hot-reload of local file adapters without restart
- esbuild CLI bundles may need testing to ensure dynamic import resolution works correctly
- Duck-type validation is runtime-only; TypeScript cannot statically verify the contract across package boundaries
