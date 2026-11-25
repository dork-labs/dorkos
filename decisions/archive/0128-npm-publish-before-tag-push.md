---
number: 128
title: Reorder Release Phases — npm Publish Before Tag Push
status: archived
created: 2026-03-14
spec: docker-image-publishing
superseded-by: null
---

# 0128. Reorder Release Phases — npm Publish Before Tag Push

## Status

Draft (auto-extracted from spec: docker-image-publishing)

## Context

The `/system:release` command pushes the git tag (Phase 5.7) before publishing to npm (Phase 5.8). With the introduction of a Docker publishing workflow triggered by tag push that installs from npm (`INSTALL_MODE=npm`), this ordering creates a race condition: the Docker build starts before the npm package exists.

## Decision

Swap phases 5.7 and 5.8 in the release command so the flow becomes: commit → npm publish → push to origin (commit + tag) → GitHub Release. The tag push becomes the final signal that all artifacts (npm package) are ready. An npm availability polling loop in the Docker workflow provides a safety net for registry propagation delays.

## Consequences

### Positive

- Eliminates the race condition between npm publish and Docker build
- The tag push serves as a reliable "all artifacts ready" signal
- The npm polling safety net handles edge cases (registry propagation, manual `workflow_dispatch` re-runs)

### Negative

- If npm publish fails, the tag is never pushed, which means no GitHub Release is created either — the operator must fix npm and re-run the release
- Slight semantic shift: the git tag now represents "published" rather than "tagged" state
