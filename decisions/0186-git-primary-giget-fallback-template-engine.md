---
number: 186
title: Git Primary + giget Fallback Template Download Engine
status: draft
created: 2026-03-23
spec: agent-creation-and-templates
superseded-by: null
---

# 0186. Git Primary + giget Fallback Template Download Engine

## Status

Draft (auto-extracted from spec: agent-creation-and-templates)

## Context

DorkOS needs to download project templates from GitHub repositories when creating new agent workspaces. Two viable approaches exist: `git clone --depth 1` (shell command, requires git installed) and `giget` (npm package, pure JavaScript tarball download). Each has trade-offs around progress reporting, dependencies, and error handling.

## Decision

Use `git clone --depth 1` as the primary template download method. Git provides real progress events via parseable stderr output, developers already have it installed, and the implementation is 3 lines of code. Fall back to `giget` (UnJS package) when git is not available — giget downloads tarballs without requiring git, but has no progress callbacks, no cancellation, and generic error messages requiring string classification. A 30-second `Promise.race()` timeout guards against giget hanging on large templates.

## Consequences

### Positive

- 99%+ of DorkOS users (developers) have git installed — primary path covers nearly everyone
- Real progress bar UX from git stderr parsing
- giget fallback ensures templates work in constrained environments
- No hard dependency on either mechanism alone

### Negative

- Two code paths to maintain and test
- giget error handling requires fragile string matching
- Git progress stderr parsing is informal (not a stable API)
