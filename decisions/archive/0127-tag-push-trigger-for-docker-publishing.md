---
number: 127
title: Use Tag Push Trigger for Docker Image Publishing
status: archived
created: 2026-03-14
spec: docker-image-publishing
superseded-by: null
---

# 0127. Use Tag Push Trigger for Docker Image Publishing

## Status

Draft (auto-extracted from spec: docker-image-publishing)

## Context

DorkOS needs to automatically publish Docker images to GHCR on each release. Three trigger strategies were evaluated: tag push (`on: push: tags: ['v*']`), release event (`on: release: types: [published]`), and manual dispatch only. The release process already creates git tags as part of its flow, and uses `GITHUB_TOKEN` for git operations.

## Decision

Use `on: push: tags: ['v*']` as the primary trigger, with `workflow_dispatch` as a secondary for manual re-runs. The release event trigger was rejected because `GITHUB_TOKEN`-created events do not trigger other workflows (chaining problem), and draft releases do not fire the trigger. Manual-only dispatch was rejected because it adds friction and is easy to forget.

## Consequences

### Positive

- Fires reliably on any tag push regardless of how the push was made
- Works with `GITHUB_TOKEN` (no PAT or GitHub App token needed)
- Matches existing CI patterns in the repository
- `workflow_dispatch` enables manual re-runs on existing tags

### Negative

- The tag push triggers the workflow immediately, requiring npm publish to complete first (mitigated by reordering release phases and adding npm availability polling)
- Any accidental `v*` tag push will trigger a build (mitigated by branch protection and release discipline)
