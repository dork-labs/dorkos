---
number: 121
title: File-Based Adapter Documentation Over Inline Template Literals
status: draft
created: 2026-03-14
spec: adapter-setup-experience
superseded-by: null
---

# 0121. File-Based Adapter Documentation Over Inline Template Literals

## Status

Draft (auto-extracted from spec: adapter-setup-experience)

## Context

The adapter setup experience requires rich markdown documentation for each adapter — full setup guides, per-field help text, and troubleshooting content. This documentation must be authored by adapter developers (both built-in and plugin). Three delivery mechanisms were considered: inline string constants in TypeScript manifests, build-time imports from `.md` files, and runtime file loading from a `docs/` directory per adapter.

## Decision

Adapter documentation is authored as real `.md` files in a `docs/` directory alongside each adapter's source code (e.g., `src/adapters/slack/docs/setup.md`). Files are copied to `dist/` during the build step, read by the adapter-manager at server startup, and injected into manifests before serving via the catalog API. Plugin adapters can either include `setupGuide` directly in `getManifest()` or provide `docs/` files that the plugin loader reads.

## Consequences

### Positive

- Full IDE support for documentation authoring (syntax highlighting, preview, linting)
- Clean diffs in version control — markdown changes are separate from TypeScript
- Scalable pattern for future docs files (troubleshooting.md, advanced.md)
- Plugin adapter developers get the same quality authoring experience

### Negative

- Requires a build copy step (tsc doesn't handle non-TypeScript files)
- Server must read files at startup, adding a small I/O cost (~10ms for 3-4 files)
- Documentation can drift from adapter code if not maintained together
