---
id: 261006-180100
title: Thin file routes and opaque session identity
status: accepted
created: 2026-10-06
spec: session-routing-identity
superseded-by: null
---

# 261006-180100. Thin file routes and opaque session identity

## Status

Accepted; supersedes ADR-0156.

## Context

The code-based route tree has grown from three routes to twelve static destinations and two extension routes. A central file contains page implementation imports, search validation, redirects and layouts. Directory-bearing links disclose local filesystem structure and cannot reliably identify external sessions across runtimes.

## Decision

Use thin file-based TanStack route modules at the app root, outside FSD layers, preserving existing layouts, custom search behavior and DEV bypass. Generate and split the same tree in both web and desktop renderer builds. Govern navigation through typed route factories and AST lint enforcement. Existing sessions use opaque identity resolved server-side into authoritative runtime, native alias and directory; new conversation launches use agent or opaque workspace identity and explicit draft lifecycle.

## Consequences

### Positive

- Page implementation remains in existing FSD layers while generated routes supply type safety and splitting.
- A destination changes in one factory rather than scattered callers.
- Existing links work without agent registration or private filesystem paths.
- Runtime-specific native discovery supports accessible external sessions without creating or billing a turn.

### Negative

- Route generation is a build dependency in two renderer configurations.
- Unknown native identities need bounded discovery and ambiguity/error handling.
- Opaque unregistered workspace launch references need server-owned mapping and lifecycle.
