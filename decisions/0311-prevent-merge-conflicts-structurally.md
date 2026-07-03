---
number: 311
title: Prevent shared-registry merge conflicts structurally, not with merge drivers
status: draft
created: 2026-07-03
spec: merge-conflict-prevention
superseded-by: null
---

# 311. Prevent shared-registry merge conflicts structurally, not with merge drivers

## Status

Draft (auto-extracted from spec: merge-conflict-prevention)

## Context

Multi-agent concurrency produces recurring merge conflicts concentrated in shared registry /
generated files (`decisions/manifest.json`, `specs/manifest.json`, `CHANGELOG.md`) and in
counter-allocated identifiers. Custom git merge drivers and `merge=union` do not run on GitHub's
server-side merge button and require a per-clone `.git/config` bootstrap that fails silently when
absent. DorkOS merges via GitHub, so merge-time resolution is the wrong primary layer.

## Decision

Prevent the conflicts structurally so that two branches producing unrelated artifacts auto-merge
with git's DEFAULT driver: coordination-free timestamp identifiers, id-keyed manifests with no
shared counter, and per-section changelog sentinel anchors. Any custom merge driver is optional
and local-only, never the primary mechanism.

## Consequences

### Positive

- Works on GitHub's server-side merge; no per-clone bootstrap; no silent driver fallback.
- Robust under high agent concurrency; the fix does not depend on every machine's git config.
- Simpler mental model: conflicts are designed out rather than auto-resolved.

### Negative

- Requires reshaping manifests and templates and introduces a second identifier format.
- Does not help legacy application-source conflicts (out of scope by design).
