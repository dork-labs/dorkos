---
number: 129
title: Use npm Install Mode for Published Docker Image
status: archived
created: 2026-03-14
spec: docker-image-publishing
superseded-by: null
---

# 0129. Use npm Install Mode for Published Docker Image

## Status

Draft (auto-extracted from spec: docker-image-publishing)

## Context

`Dockerfile.run` supports two install modes: tarball (builds CLI from source, packs, installs) and npm (installs the published `dorkos` package from the npm registry). For the GHCR-published image, we needed to decide which mode to use in CI.

## Decision

Use `INSTALL_MODE=npm` for the published Docker image. The workflow extracts the version from the git tag and passes it as `DORKOS_VERSION` build arg. This installs the exact same artifact that users get via `npm install -g dorkos`.

## Consequences

### Positive

- The Docker image contains the identical artifact published to npm — no divergence
- Simpler CI workflow (no build step, no tarball packing, no artifact upload)
- Validates that the published npm package works correctly in a Docker environment

### Negative

- Requires npm publish to complete before the Docker build can succeed (mitigated by release phase reordering and npm polling)
- Cannot build a Docker image from an unpublished version (use tarball mode locally for that)
