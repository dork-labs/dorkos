---
number: 271
title: Core Extensions as Flat-Directory First-Party Extensions Reusing the Public API
status: accepted
created: 2026-06-13
spec: core-extensions
superseded-by: null
---

# 271. Core Extensions as Flat-Directory First-Party Extensions Reusing the Public API

## Status

Accepted (implemented in spec: core-extensions)

## Context

Bundled core extensions need a home in the monorepo. Options considered: a flat directory inside the server app (the current `builtin-extensions/` shape, renamed `core-extensions/`), a dedicated `packages/core-extensions/` workspace, or one npm package per extension. They also need a runtime: either reuse the same `ExtensionManifestSchema` + compiler + lifecycle as user extensions, or a separate internal API. Reference research showed VS Code uses a flat `extensions/` directory and JetBrains a flat `plugins/` directory, both treating bundled plugins as first-class consumers of the same extension API.

## Decision

Core extensions live as a **flat directory** of extension folders inside the server app at `apps/server/src/core-extensions/<id>/`, staged to `{dorkHome}/extensions/` at startup via the existing build-copy + `ensureCoreExtensions()` scanner. They reuse the exact same manifest schema, compiler, and lifecycle as user extensions — DorkOS dogfoods its own public extension API with first-party code. A dedicated workspace package or per-extension packages were rejected: they add workspace dependency edges and build/copy complexity for server-internal, bundled-by-definition code with no payoff at this scale.

## Consequences

### Positive

- Zero new workspace edges; the existing `cpSync` build step already bundles the directory.
- The public extension API is proven by first-party code before external authors rely on it (VS Code principle).
- Matches established prior art (VS Code, JetBrains), lowering contributor surprise.

### Negative

- Core extensions cannot be independently versioned or published (acceptable — they are bundled with the host release).
- The server app owns extension source it does not "use" directly; the staging indirection (`ensure*` copy) remains.
