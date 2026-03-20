---
slug: docker-image-publishing
number: 130
title: 'Docker Image Publishing to GHCR'
created: 2026-03-14
status: draft
authors: ['Claude Code']
ideation: specs/docker-image-publishing/01-ideation.md
research: research/20260314_ghcr_docker_publishing_github_actions.md
---

# Docker Image Publishing to GHCR

## Status

Draft

## Overview

Set up automated Docker image publishing to `ghcr.io/dork-labs/dorkos` via GitHub Actions. On every tagged release, a workflow builds a multi-platform image (amd64 + arm64) from the published npm package and pushes it to GHCR with semver tags and supply-chain attestation. This also fixes a release ordering issue (npm publish must happen before tag push) and updates documentation to accurately describe the Docker image lifecycle.

## Background / Problem Statement

The DorkOS documentation (`docs/self-hosting/docker.mdx`, `docs/getting-started/installation.mdx`) references `ghcr.io/dork-labs/dorkos:latest` as a Docker installation method. However, no publishing automation exists. Users who follow the documentation encounter "denied" errors when attempting `docker pull ghcr.io/dork-labs/dorkos:latest`.

Additionally, the current release command (`.claude/commands/system/release.md`) pushes the git tag (Phase 5.7) before publishing to npm (Phase 5.8). Since the Docker workflow installs from npm, this creates a race condition where the Docker build triggers before the npm package is available.

## Goals

- Automate Docker image publishing on every tagged release with zero manual intervention
- Support both amd64 and arm64 platforms natively
- Provide supply-chain provenance via GitHub Artifact Attestation
- Follow semver tagging: `{{version}}`, `{{major}}.{{minor}}`, `sha-*`, `latest`
- Fix release phase ordering so npm publish precedes tag push
- Ensure documentation accurately reflects the Docker image lifecycle

## Non-Goals

- Image signing with cosign (GitHub Artifact Attestation covers supply-chain provenance)
- SBOM generation (`actions/attest-sbom`)
- Automated post-publish image testing (follow-up work)
- Docker Compose orchestration changes
- Kubernetes manifests or Helm charts
- `{{major}}` tag (not applicable while pre-1.0)

## Technical Dependencies

| Dependency                        | Version | Purpose                         |
| --------------------------------- | ------- | ------------------------------- |
| `actions/checkout`                | v4      | Checkout repository             |
| `docker/login-action`             | v3      | Authenticate to GHCR            |
| `docker/setup-qemu-action`        | v3      | ARM64 emulation                 |
| `docker/setup-buildx-action`      | v3      | Multi-platform builds           |
| `docker/metadata-action`          | v5      | Automatic semver tag generation |
| `docker/build-push-action`        | v6      | Build and push image            |
| `actions/attest-build-provenance` | v2      | SLSA supply-chain attestation   |

All actions are pinned to major versions. No external secrets are required beyond the default `GITHUB_TOKEN`.

## Detailed Design

### 1. GitHub Actions Workflow

**File:** `.github/workflows/publish-docker.yml`

The workflow triggers on tag pushes matching `v*` and supports manual dispatch for re-runs. It uses the canonical Docker action stack that is the industry standard for GHCR publishing.

```yaml
name: Publish Docker Image

on:
  push:
    tags: ['v*']
  workflow_dispatch:

env:
  REGISTRY: ghcr.io
  IMAGE_NAME: dork-labs/dorkos

jobs:
  build-and-push:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
      attestations: write
      id-token: write

    steps:
      - uses: actions/checkout@v4

      - name: Log in to GHCR
        uses: docker/login-action@v3
        with:
          registry: ${{ env.REGISTRY }}
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Set up QEMU
        uses: docker/setup-qemu-action@v3

      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v3

      - name: Extract version from tag
        id: version
        run: echo "version=${GITHUB_REF_NAME#v}" >> "$GITHUB_OUTPUT"

      - name: Wait for npm package availability
        run: |
          VERSION="${{ steps.version.outputs.version }}"
          echo "Waiting for dorkos@${VERSION} on npm..."
          for i in $(seq 1 30); do
            if npm view "dorkos@${VERSION}" version 2>/dev/null; then
              echo "Package available!"
              exit 0
            fi
            echo "Attempt $i/30 — not yet available, waiting 10s..."
            sleep 10
          done
          echo "::error::Package dorkos@${VERSION} not found on npm after 5 minutes"
          exit 1

      - name: Extract Docker metadata
        id: meta
        uses: docker/metadata-action@v5
        with:
          images: ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}
          tags: |
            type=semver,pattern={{version}}
            type=semver,pattern={{major}}.{{minor}}
            type=sha
          flavor: |
            latest=auto

      - name: Build and push Docker image
        id: push
        uses: docker/build-push-action@v6
        with:
          context: .
          file: ./Dockerfile.run
          push: true
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
          platforms: linux/amd64,linux/arm64
          build-args: |
            INSTALL_MODE=npm
            DORKOS_VERSION=${{ steps.version.outputs.version }}
            MOCK_CLAUDE=false
          cache-from: type=gha
          cache-to: type=gha,mode=max

      - name: Generate artifact attestation
        uses: actions/attest-build-provenance@v2
        with:
          subject-name: ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}
          subject-digest: ${{ steps.push.outputs.digest }}
          push-to-registry: true
```

#### Key Design Decisions

**npm availability check:** Even though the release command reorder (see section 3) ensures npm publish happens before the tag push, the workflow includes a safety-net polling loop. This guards against npm registry propagation delays and makes `workflow_dispatch` re-runs resilient. The loop polls `npm view dorkos@{version}` every 10 seconds for up to 5 minutes (30 attempts).

**Multi-platform via QEMU:** The workflow builds for both `linux/amd64` and `linux/arm64` using QEMU emulation. This adds approximately 15-30 minutes to the build but ensures native performance for Apple Silicon Docker Desktop users and ARM-based servers (AWS Graviton, Ampere). Since releases are infrequent, this tradeoff is acceptable.

**GHA caching:** Layer caching via `type=gha,mode=max` uses GitHub Actions' built-in 10 GB cache. This significantly reduces rebuild time for unchanged layers (Node.js base image, npm install).

**Metadata-driven tagging:** The `docker/metadata-action` automatically generates tags from the git tag:

- `v0.12.0` produces: `0.12.0`, `0.12`, `sha-abc1234`, `latest`
- Pre-release tags (e.g., `v0.13.0-beta.1`) skip the `latest` tag automatically via `latest=auto`
- No `{{major}}` tag is generated while the project is pre-1.0

**Attestation:** The `actions/attest-build-provenance@v2` step generates a SLSA provenance attestation and pushes it to the registry. Users can verify the image's build origin with `gh attestation verify`.

### 2. Dockerfile.run Updates

Add OCI-standard labels to `Dockerfile.run` for repository linking and metadata. These labels enable GHCR to automatically link the package to the source repository and display metadata in the GitHub UI.

```dockerfile
LABEL org.opencontainers.image.source="https://github.com/dork-labs/dorkos"
LABEL org.opencontainers.image.description="DorkOS — the coordination layer for autonomous AI agents"
LABEL org.opencontainers.image.licenses="MIT"
```

These labels should be placed after the `FROM` instruction in the final stage of the Dockerfile, following OCI Image Spec conventions.

### 3. Release Command Reorder

**File:** `.claude/commands/system/release.md`

The current release flow has a critical ordering issue:

```
Current order:
  Phase 5.7: Push to origin (git push origin main && git push origin vX.Y.Z)
  Phase 5.8: npm publish (pnpm run publish:cli)

Required order:
  Phase 5.7: npm publish (pnpm run publish:cli)
  Phase 5.8: Push to origin (git push origin main && git push origin vX.Y.Z)
```

**Rationale:** The tag push (`git push origin vX.Y.Z`) triggers the Docker workflow. The Docker workflow uses `INSTALL_MODE=npm` to install the just-published npm package inside the image. If the tag push happens before npm publish, the Docker build fails because the package does not yet exist on the registry. Even with the npm availability polling loop as a safety net, the correct ordering eliminates unnecessary waiting.

The swap is minimal — two adjacent phases exchange positions. The release flow's semantics are preserved: commit, npm publish, push to origin, create GitHub Release.

### 4. Release Report Update

**File:** `.claude/commands/system/release.md`

Add a Docker publishing mention to Phase 6 (Report) so the release operator knows to monitor the Docker workflow:

```markdown
### Docker Image

- Image will be published automatically to `ghcr.io/dork-labs/dorkos:{version}`
- Triggered by the tag push above
- Monitor progress: https://github.com/dork-labs/dorkos/actions/workflows/publish-docker.yml
```

### 5. Documentation Updates

#### `docs/self-hosting/docker.mdx`

Add the following content:

**Image versioning section:**

- Explain available tags: `latest`, `0.12.0` (exact version), `0.12` (minor track), `sha-*` (commit)
- Recommend pinning to an exact version for production: `ghcr.io/dork-labs/dorkos:0.12.0`
- Note that `latest` tracks the most recent non-prerelease version

**Multi-platform support note:**

- The image is built for both `linux/amd64` and `linux/arm64`
- Works natively on Intel/AMD servers and Apple Silicon via Docker Desktop

**Supply chain verification section:**

```bash
gh attestation verify oci://ghcr.io/dork-labs/dorkos:0.12.0 --owner dork-labs
```

#### `docs/getting-started/installation.mdx`

- Verify existing Docker tab examples reference the correct image (they already do)
- Add a version pinning example alongside the `latest` tag:
  ```bash
  docker pull ghcr.io/dork-labs/dorkos:0.12.0
  ```

### 6. .dockerignore

No changes needed. The `.dockerignore` uses a deny-all allowlist pattern. The Docker workflow uses `INSTALL_MODE=npm`, which installs the package from the npm registry at build time rather than copying local files into the build context. The existing allowlist already includes `!Dockerfile.run`, which is the only file the build context needs to reference.

## Implementation Phases

### Phase 1: Workflow + Dockerfile (core infrastructure)

| #   | Task                               | File                                   |
| --- | ---------------------------------- | -------------------------------------- |
| 1   | Create the GitHub Actions workflow | `.github/workflows/publish-docker.yml` |
| 2   | Add OCI labels to Dockerfile       | `Dockerfile.run`                       |

### Phase 2: Release Command Reorder

| #   | Task                                    | File                                 |
| --- | --------------------------------------- | ------------------------------------ |
| 3   | Swap phases 5.7 and 5.8                 | `.claude/commands/system/release.md` |
| 4   | Add Docker publishing to Phase 6 report | `.claude/commands/system/release.md` |

### Phase 3: Documentation

| #   | Task                                                 | File                                    |
| --- | ---------------------------------------------------- | --------------------------------------- |
| 5   | Add versioning, multi-platform, and attestation docs | `docs/self-hosting/docker.mdx`          |
| 6   | Add version pinning example                          | `docs/getting-started/installation.mdx` |

## Post-Deploy (One-Time Manual Steps)

After the first release that successfully pushes an image:

1. Navigate to `https://github.com/orgs/dork-labs/packages/container/dorkos`
2. Click "Package settings" in the sidebar
3. Under "Manage Actions access", connect the package to the `dork-labs/dorkos` repository
4. Enable "Inherit access from source repository"
5. Under "Danger zone", change visibility to **Public**

These steps are required because GHCR packages default to private and are not automatically linked to their source repository.

## Acceptance Criteria

1. `docker pull ghcr.io/dork-labs/dorkos:latest` succeeds after a tagged release
2. `docker run -p 4242:4242 ghcr.io/dork-labs/dorkos:latest --help` produces expected output
3. Both amd64 and arm64 architectures are available (`docker manifest inspect` shows two platforms)
4. Image tags follow semver: `0.12.0`, `0.12`, `sha-*`, `latest`
5. `gh attestation verify oci://ghcr.io/dork-labs/dorkos:0.12.0 --owner dork-labs` succeeds
6. The release command publishes to npm before pushing the git tag
7. The Docker workflow includes an npm availability polling loop as a safety net
8. Documentation accurately describes image versioning, multi-platform support, and attestation verification

## Testing Strategy

| Test                   | Method                                                                             | When                        |
| ---------------------- | ---------------------------------------------------------------------------------- | --------------------------- |
| Workflow YAML validity | GitHub Actions lints on push                                                       | Every commit                |
| First real build       | Tag a release and observe workflow                                                 | First release after merge   |
| Manual re-run          | Trigger via `workflow_dispatch` on an existing tag                                 | Post-deploy verification    |
| Image correctness      | `docker pull` + `docker run --help`                                                | After first successful push |
| Multi-platform         | `docker manifest inspect ghcr.io/dork-labs/dorkos:latest`                          | After first successful push |
| Attestation            | `gh attestation verify oci://ghcr.io/dork-labs/dorkos:{version} --owner dork-labs` | After first successful push |
| Release flow           | Perform a patch release and verify npm publishes before tag push                   | First release after merge   |

There are no unit tests to write for this feature. Validation is inherently integration-level: the workflow either succeeds and produces a pullable image, or it fails visibly in GitHub Actions.

## Risks & Mitigations

| Risk                                                | Likelihood           | Impact                             | Mitigation                                                                                                                   |
| --------------------------------------------------- | -------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| npm publish takes >5 min, Docker workflow times out | Low                  | Workflow fails, no image published | 30 retries x 10s = 5 min polling. Can increase the retry count if needed. Manual re-run via `workflow_dispatch` as fallback. |
| QEMU arm64 build is extremely slow (~30 min)        | Medium               | Slow release pipeline              | Accept for now. Can drop to amd64-only if build times exceed 45 min. ARM users can build from source.                        |
| GHCR package stays private after first push         | Certain (first time) | Users cannot pull the image        | Documented in Post-Deploy section. One-time manual step.                                                                     |
| Release command phase swap breaks existing flow     | Low                  | Release fails                      | The swap is two adjacent phases exchanging position. Semantics are preserved. Verify with next patch release.                |
| `docker/metadata-action` generates unexpected tags  | Low                  | Wrong tags on image                | The tag patterns are well-documented and widely used. Pre-release detection via `latest=auto` is battle-tested.              |

## Security Considerations

- **Authentication:** Uses `GITHUB_TOKEN` (automatically provided by GitHub Actions). No external secrets or PATs required.
- **Permissions:** The workflow requests only `contents: read`, `packages: write`, `attestations: write`, and `id-token: write`. These are the minimum required.
- **Supply chain:** GitHub Artifact Attestation generates SLSA provenance, enabling users to verify the image was built from the expected source commit in the expected repository.
- **Image contents:** The image installs from the public npm registry, which is the same artifact users install directly. No additional attack surface.

## Dependencies

- GitHub org `dork-labs` must have GHCR enabled (enabled by default for all GitHub organizations)
- `GITHUB_TOKEN` must have `packages:write` permission (default for organization repositories)
- `Dockerfile.run` must support `INSTALL_MODE=npm` with a `DORKOS_VERSION` build arg (already implemented)
