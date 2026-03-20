# Docker Image Publishing — Task Breakdown

**Spec**: [02-specification.md](./02-specification.md)
**Generated**: 2026-03-14
**Mode**: Full decomposition

---

## Phase 1: Workflow + Dockerfile

Core infrastructure for building and publishing Docker images to GHCR.

### Task 1.1: Create GitHub Actions workflow for Docker image publishing

**Size**: Medium | **Priority**: High | **Dependencies**: None | **Parallel with**: 1.2

Create `.github/workflows/publish-docker.yml` with the canonical Docker action stack:

- **Trigger**: `on: push: tags: ['v*']` + `workflow_dispatch` for manual re-runs
- **Actions**: checkout, login, QEMU, Buildx, metadata, build-push, attestation
- **Platforms**: `linux/amd64,linux/arm64` via QEMU emulation
- **Tags**: `{{version}}`, `{{major}}.{{minor}}`, `sha`, `latest` (auto-managed)
- **Build args**: `INSTALL_MODE=npm`, `DORKOS_VERSION` from tag, `MOCK_CLAUDE=false`
- **Caching**: GHA layer cache (`type=gha,mode=max`)
- **Safety net**: npm availability polling loop (30 attempts x 10s = 5 min)
- **Attestation**: `actions/attest-build-provenance@v2` with SLSA provenance
- **Permissions**: `contents: read`, `packages: write`, `attestations: write`, `id-token: write`

**Files**: `.github/workflows/publish-docker.yml` (new)

---

### Task 1.2: Add OCI labels to Dockerfile.run

**Size**: Small | **Priority**: High | **Dependencies**: None | **Parallel with**: 1.1

Add three OCI-standard labels after the `FROM` instruction:

```dockerfile
LABEL org.opencontainers.image.source="https://github.com/dork-labs/dorkos"
LABEL org.opencontainers.image.description="DorkOS — the coordination layer for autonomous AI agents"
LABEL org.opencontainers.image.licenses="MIT"
```

These enable GHCR to link the package to the source repository and display metadata.

**Files**: `Dockerfile.run` (edit)

---

## Phase 2: Release Command Reorder

Fix the release ordering so npm publish happens before the tag push that triggers Docker builds.

### Task 2.1: Swap release phases so npm publish precedes tag push

**Size**: Small | **Priority**: High | **Dependencies**: None | **Parallel with**: 2.2

In `.claude/commands/system/release.md`, swap phases 5.7 and 5.8:

- **Current**: 5.7 = Push to Origin, 5.8 = Publish to npm
- **New**: 5.7 = Publish to npm, 5.8 = Push to Origin

Content stays identical — only heading numbers and order change. The tag push becomes the final signal that all artifacts are ready (ADR-0128).

**Files**: `.claude/commands/system/release.md` (edit)

---

### Task 2.2: Add Docker publishing section to Phase 6 release report

**Size**: Small | **Priority**: Medium | **Dependencies**: None | **Parallel with**: 2.1

Add a `### Docker Image` section to Phase 6 (Report) between `### What's Next` and `### Release Notes`:

```markdown
### Docker Image

- Image will be published automatically to `ghcr.io/dork-labs/dorkos:{version}`
- Triggered by the tag push above
- Monitor progress: https://github.com/dork-labs/dorkos/actions/workflows/publish-docker.yml
```

**Files**: `.claude/commands/system/release.md` (edit)

---

## Phase 3: Documentation

Update user-facing docs to reflect the Docker image lifecycle.

### Task 3.1: Add versioning, multi-platform, and attestation docs to Docker guide

**Size**: Medium | **Priority**: Medium | **Dependencies**: 1.1 | **Parallel with**: 3.2

Add three new sections to `docs/self-hosting/docker.mdx` between Quick Start and Configuration:

1. **Image Versioning** — Tag table (latest, exact, minor track, sha), pinning recommendation, pre-release behavior
2. **Multi-Platform Support** — amd64 + arm64, automatic platform selection, use cases (Intel, Apple Silicon, Graviton)
3. **Supply Chain Verification** — `gh attestation verify` command with SLSA explanation

**Files**: `docs/self-hosting/docker.mdx` (edit)

---

### Task 3.2: Add version pinning example to installation docs

**Size**: Small | **Priority**: Low | **Dependencies**: 1.1 | **Parallel with**: 3.1

Update the Docker tab callout in `docs/getting-started/installation.mdx` to mention version pinning:

```
Pin a specific version for reproducible deployments: `ghcr.io/dork-labs/dorkos:0.12.0`.
```

The existing examples already use the correct image reference. This adds a nudge toward pinning.

**Files**: `docs/getting-started/installation.mdx` (edit)

---

## Dependency Graph

```
Phase 1 (parallel):     1.1 ──┐
                         1.2 ──┤
                               │
Phase 2 (parallel):     2.1 ──┤  (independent of Phase 1)
                         2.2 ──┤
                               │
Phase 3 (parallel):     3.1 ──┘  (depends on 1.1)
                         3.2 ──   (depends on 1.1)
```

## Summary

| Phase                      | Tasks | Size               | Estimated Effort |
| -------------------------- | ----- | ------------------ | ---------------- |
| 1. Workflow + Dockerfile   | 2     | 1 medium + 1 small | ~30 min          |
| 2. Release Command Reorder | 2     | 2 small            | ~15 min          |
| 3. Documentation           | 2     | 1 medium + 1 small | ~20 min          |
| **Total**                  | **6** |                    | **~65 min**      |
