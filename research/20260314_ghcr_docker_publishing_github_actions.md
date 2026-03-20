---
title: 'GHCR Docker Image Publishing via GitHub Actions'
date: 2026-03-14
type: implementation
status: active
tags:
  [docker, ghcr, github-actions, ci-cd, containers, release, multi-platform, cosign, supply-chain]
feature_slug: docker-image-publishing
searches_performed: 10
sources_count: 22
---

# GHCR Docker Image Publishing via GitHub Actions

## Research Summary

This report covers best practices for publishing Docker images to GitHub Container Registry (GHCR) via GitHub Actions for the DorkOS monorepo. The canonical approach uses `docker/metadata-action` + `docker/build-push-action` + `GITHUB_TOKEN` auth, triggered on tag push (`v*`). Multi-platform (amd64 + arm64) is achievable via QEMU but adds significant build time; the recommendation is to start amd64-only and add arm64 only when user demand warrants it. GitHub's built-in `actions/attest-build-provenance` provides supply-chain attestation with zero additional tooling.

---

## Key Findings

### 1. Authentication: GITHUB_TOKEN is the Right Choice

Use `secrets.GITHUB_TOKEN` — not a PAT — for GHCR authentication in GitHub Actions. GHCR moved out of beta and now supports fully granular `GITHUB_TOKEN` permissions. The workflow just needs `packages: write` permission granted on the job.

- No secret rotation required
- Scoped to the repository and workflow run
- `docker/login-action` handles GHCR login cleanly with `registry: ghcr.io`, `username: ${{ github.actor }}`, `password: ${{ secrets.GITHUB_TOKEN }}`

**Exception**: If the image push needs to trigger another downstream workflow, `GITHUB_TOKEN` cannot do that (GitHub blocks workflow-to-workflow chaining via `GITHUB_TOKEN`). In that case a PAT or GitHub App token is needed. For DorkOS this is not a concern.

### 2. Triggering: Tag Push Over Release Event

Two viable triggers exist:

| Trigger                           | Pros                                                                                | Cons                                                                                                   |
| --------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `on: push: tags: ['v*']`          | Simple, reliable, fires immediately on `git push --tags`, works with `GITHUB_TOKEN` | Must ensure tags follow the version bump process                                                       |
| `on: release: types: [published]` | Tight coupling to GitHub Release UX, release notes available                        | Requires non-`GITHUB_TOKEN` if the release is created by another workflow; draft release does not fire |

**Recommendation**: Use `on: push: tags: ['v*']` as the primary trigger, with `workflow_dispatch` as a secondary for manual re-runs. This matches the existing npm publish pattern (which also fires on version tags) and avoids `GITHUB_TOKEN` chaining issues.

### 3. Recommended Action Stack

The canonical four-action stack (all from Docker's official GitHub org):

```yaml
- uses: docker/login-action@v3
- uses: docker/setup-buildx-action@v3 # required for cache and multi-platform
- uses: docker/metadata-action@v5
- uses: docker/build-push-action@v6
```

Plus GitHub's own attestation action:

```yaml
- uses: actions/attest-build-provenance@v2
```

All of these are pinned to major-version tags. For production security, pin to full SHA digest (see Security section).

### 4. Image Tagging Strategy

`docker/metadata-action` with `type=semver` generates the right tags automatically from git tags. For a tag `v0.11.0`:

```yaml
tags: |
  type=semver,pattern={{version}}        # → 0.11.0
  type=semver,pattern={{major}}.{{minor}} # → 0.11
  type=sha                               # → sha-abc1234  (traceability)
```

**Do not** include `type=semver,pattern={{major}}` while the project is pre-1.0 (i.e., `0.x`). The metadata-action README explicitly warns against this because it would tag `0` which implies stability that does not yet exist.

**`latest` tag**: Controlled via `flavor: latest=auto` (the default). With `auto`, `latest` is only applied when the git tag is not a pre-release (i.e., no `-rc`, `-beta`, `-alpha` suffix). This is the correct behavior — do not set `latest=true` explicitly.

**Full tags example for `v0.11.0`**:

- `ghcr.io/dork-labs/dorkos:0.11.0`
- `ghcr.io/dork-labs/dorkos:0.11`
- `ghcr.io/dork-labs/dorkos:sha-abc1234`
- `ghcr.io/dork-labs/dorkos:latest`

**For a pre-release `v0.11.0-rc.1`**:

- `ghcr.io/dork-labs/dorkos:0.11.0-rc.1`
- `ghcr.io/dork-labs/dorkos:sha-abc1234`
- (`latest` NOT applied — correct behavior)

### 5. Repository-to-Package Linking

GHCR packages are not automatically linked to a repository when pushed from Actions. Two mechanisms connect them:

**Option A — Dockerfile `LABEL` (recommended, persistent)**:

```dockerfile
LABEL org.opencontainers.image.source="https://github.com/dork-labs/dorkos"
LABEL org.opencontainers.image.description="DorkOS — the operating system for autonomous AI agents"
LABEL org.opencontainers.image.licenses="MIT"
```

**Option B — `docker/metadata-action` labels output** (automatic, per-build):
The `labels` output from `metadata-action` includes `org.opencontainers.image.source` derived from `github.repository`. Passing `labels: ${{ steps.meta.outputs.labels }}` to `build-push-action` handles this automatically.

Both options should be used: the `LABEL` in the Dockerfile ensures the link exists even for manual `docker build` runs; the `metadata-action` labels ensure it in CI.

### 6. Package Visibility

GHCR packages default to **private** on first push. To make `ghcr.io/dork-labs/dorkos` public:

1. Navigate to the package page: `https://github.com/orgs/dork-labs/packages/container/dorkos`
2. Click "Package settings"
3. Under "Danger Zone" → "Change visibility" → Public

This is a one-time manual operation. Once public, it cannot be made private again without deleting and re-creating.

**Organization-level default**: In org settings → Packages → "Package creation" → set default to Public to avoid needing this step on every new package.

**Inheriting repo permissions**: After linking the package to the repository (via the label above), you can enable "Inherit access from source repository" in package settings. This means anyone with repo read access can pull the image.

### 7. Multi-Platform Builds

**Trade-offs**:

| Approach                       | Build time                                                  | Complexity         | Use case                                       |
| ------------------------------ | ----------------------------------------------------------- | ------------------ | ---------------------------------------------- |
| `linux/amd64` only             | Fast (2-5 min)                                              | Zero overhead      | Default; covers all GitHub-hosted runners      |
| QEMU emulation (amd64 + arm64) | Very slow (10-30x slower for arm64 emulation on amd64 host) | Moderate           | Acceptable for infrequent release builds       |
| Matrix + merge manifest        | Fast (parallel native runners)                              | High               | Production-grade; requires 2+ runners          |
| Docker Build Cloud             | Fast (offloaded)                                            | Low (paid service) | Worth evaluating if build times become painful |

**QEMU setup** (for single-runner multi-platform):

```yaml
- uses: docker/setup-qemu-action@v3
- uses: docker/setup-buildx-action@v3
  # then in build-push-action:
  platforms: linux/amd64,linux/arm64
```

**Recommendation for DorkOS**: Start with `linux/amd64` only. The CLI is Node.js-based and installable via npm — users on Apple Silicon install via `npm install -g dorkos`, not `docker pull`. Add arm64 if Docker-native deployment on Apple Silicon servers becomes a real user need. Multi-platform can be added in a follow-up PR without changing the workflow structure.

### 8. Layer Caching

Three approaches:

| Cache backend                        | How                                        | Pros                                     | Cons                                                                                |
| ------------------------------------ | ------------------------------------------ | ---------------------------------------- | ----------------------------------------------------------------------------------- |
| **GHA cache** (`type=gha`)           | GitHub Actions cache service               | Zero external deps, works out of the box | 10 GB limit total; requires Buildx ≥ 0.21.0 (for API v2, mandatory post April 2025) |
| **Registry cache** (`type=registry`) | Separate tag in GHCR (e.g., `:buildcache`) | `mode=max` for full layer cache          | Uses extra GHCR storage; always pulled                                              |
| **Inline cache**                     | Embedded in image                          | Simplest                                 | Only supports `mode=min`; not useful for Node.js multi-stage builds                 |

**Recommendation**: Start with `type=gha,mode=max`. It is zero-cost, zero-setup, and the 10 GB limit is more than sufficient for a Node.js image. If the build starts being cache-busted frequently (due to the 10 GB cap being shared with other workflows), switch to `type=registry` with a dedicated `:buildcache` tag.

```yaml
cache-from: type=gha
cache-to: type=gha,mode=max
```

### 9. Supply Chain Security

**GitHub Artifact Attestations (recommended — zero extra tooling)**:

`actions/attest-build-provenance` generates a SLSA provenance attestation and publishes it to the GHCR registry alongside the image. This is GitHub's native answer to cosign and requires:

- `attestations: write` permission on the job
- `id-token: write` permission on the job
- The image digest from `build-push-action` outputs

```yaml
- name: Generate artifact attestation
  uses: actions/attest-build-provenance@v2
  with:
    subject-name: ghcr.io/dork-labs/dorkos
    subject-digest: ${{ steps.push.outputs.digest }}
    push-to-registry: true
```

Users can verify: `gh attestation verify oci://ghcr.io/dork-labs/dorkos:0.11.0 --owner dork-labs`

**cosign** (optional, more explicit): cosign is the Sigstore tool for containers. It signs images keylessly using the GitHub OIDC token. Worth adding if the community specifically requests it, but `attest-build-provenance` covers most supply-chain requirements without extra tooling.

**SBOM** (optional): `actions/attest-sbom` generates an SBOM attestation from a pre-generated SBOM file (requires a separate SBOM generation tool like `syft`). Adds meaningful value for enterprise adopters; skip for now.

### 10. Action Version Pinning

For security, pin actions to their full SHA, not just major version tags. Tags can be moved; SHAs cannot. Example:

```yaml
# Less secure (tag can be moved):
uses: docker/build-push-action@v6

# More secure (SHA-pinned):
uses: docker/build-push-action@263435318d21b8e681c14492fe198d362a7d2c83
```

For an internal project shipping to developer users, major-version pinning (`@v3`, `@v5`) is a pragmatic balance. Add SHA pinning if the project moves toward SOC 2 or supply-chain compliance requirements.

---

## Complete Recommended Workflow

```yaml
name: Publish Docker Image

on:
  push:
    tags:
      - 'v*'
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
      - name: Checkout repository
        uses: actions/checkout@v4

      - name: Log in to GHCR
        uses: docker/login-action@v3
        with:
          registry: ${{ env.REGISTRY }}
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v3

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
          platforms: linux/amd64
          cache-from: type=gha
          cache-to: type=gha,mode=max

      - name: Generate artifact attestation
        uses: actions/attest-build-provenance@v2
        with:
          subject-name: ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}
          subject-digest: ${{ steps.push.outputs.digest }}
          push-to-registry: true
```

**Notes on this workflow**:

- Uses `Dockerfile.run` (the runtime image, not the smoke-test `Dockerfile`). Confirm the correct Dockerfile target before shipping.
- `IMAGE_NAME` is hardcoded to `dork-labs/dorkos` rather than `${{ github.repository }}` to prevent accidental renames from affecting the published namespace.
- `workflow_dispatch` allows manual re-runs on existing tags.
- The `platforms: linux/amd64` line is easy to extend to `linux/amd64,linux/arm64` later by also adding `docker/setup-qemu-action@v3` before Buildx setup.

---

## Dockerfile Additions Needed

Add these labels to `Dockerfile.run` (or whichever Dockerfile becomes the published image):

```dockerfile
LABEL org.opencontainers.image.source="https://github.com/dork-labs/dorkos"
LABEL org.opencontainers.image.description="DorkOS — the coordination layer for autonomous AI agents"
LABEL org.opencontainers.image.licenses="MIT"
```

---

## GHCR Setup Checklist (One-Time)

1. After first push, navigate to `https://github.com/orgs/dork-labs/packages/container/dorkos`
2. Package settings → "Connect repository" → select `dork-labs/dorkos`
3. Package settings → "Inherit access from source repository" → enable
4. Package settings → "Change visibility" → Public
5. (Optional) Org Settings → Packages → set default creation visibility to Public

---

## Detailed Analysis

### Why `Dockerfile.run` and Not `Dockerfile`

The root `Dockerfile` is explicitly a CLI smoke test image — it installs from a pre-built `.tgz`, mocks Claude, and runs smoke tests as its `CMD`. This is not a runtime image. `Dockerfile.run` is likely the correct target for the published image; this should be verified before the workflow is committed.

### Tag-Push vs Release Event: The GITHUB_TOKEN Problem

When the release process bumps the version and creates a git tag programmatically (e.g., via a release script or another workflow), and that tag creation uses `GITHUB_TOKEN`, the Docker publish workflow will NOT fire on the `on: release: types: [published]` trigger — because `GITHUB_TOKEN`-created events do not trigger other workflows. The `on: push: tags` trigger does not have this limitation: any git tag push fires it, regardless of how the push was made.

### Pre-release Tags and `latest`

With `flavor: latest=auto`, the metadata-action uses the following logic:

- Tag `v0.11.0` (no prerelease identifier) → `latest` IS applied
- Tag `v0.11.0-rc.1` → `latest` is NOT applied (pre-release suffix detected)
- Tag `v0.11.0-beta.3` → `latest` is NOT applied

This means the release process must use a clean tag format for GA releases and a `-rc`/`-beta`/`-alpha` suffix for pre-releases. This matches standard semver convention.

### The `major` Tag and Pre-1.0 Projects

The `type=semver,pattern={{major}}` tag (which would produce just `0` for `v0.11.0`) is specifically warned against in the metadata-action README for pre-1.0 software. A `0` tag implies "always the latest 0.x", which is misleading during rapid development. Omit it until `v1.0.0`.

---

## Research Gaps and Limitations

- **`Dockerfile.run` contents not reviewed**: The correct Dockerfile for the published image was not confirmed. The existing root `Dockerfile` is a smoke-test image and should not be published to GHCR as a runtime image.
- **Organization namespace**: Assumed `dork-labs` is the correct GitHub org name. This should be verified against the actual org.
- **Node.js build context**: The Turborepo monorepo likely requires a specific build context strategy in the Dockerfile (e.g., copying `pnpm-lock.yaml`, workspace dependencies). This is a Dockerfile concern, not a CI concern, but worth auditing.
- **Image signing with cosign**: Not researched in full depth since `attest-build-provenance` covers the core requirement. If cosign is needed specifically, a separate investigation into keyless signing with the GitHub OIDC provider would be warranted.

---

## Contradictions and Disputes

- **`on: release` trigger documentation**: GitHub's official Docker publishing docs use `on: push: branches: ['release']` as the trigger (branch push, not tag push), which is unusual and not reflective of real-world release workflows. The broader community consensus is strongly in favor of `on: push: tags: ['v*']`.
- **inline vs GHA cache**: Some sources recommend inline cache for simplicity, but the Docker documentation explicitly states inline cache only supports `mode=min`. For a multi-stage Node.js build, `mode=max` via GHA cache is strictly better.

---

## Sources and Evidence

- [Publishing Docker images - GitHub Docs](https://docs.github.com/en/actions/publishing-packages/publishing-docker-images)
- [Working with the Container registry - GitHub Docs](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry)
- [docker/metadata-action README](https://github.com/docker/metadata-action)
- [docker/build-push-action README](https://github.com/docker/build-push-action)
- [Tags and labels | Docker Docs](https://docs.docker.com/build/ci/github-actions/manage-tags-labels/)
- [Cache management with GitHub Actions | Docker Docs](https://docs.docker.com/build/ci/github-actions/cache/)
- [Multi-platform image with GitHub Actions | Docker Docs](https://docs.docker.com/build/ci/github-actions/multi-platform/)
- [GitHub Actions cache backend | Docker Docs](https://docs.docker.com/build/cache/backends/gha/)
- [Configuring a package's access control and visibility - GitHub Docs](https://docs.github.com/en/packages/learn-github-packages/configuring-a-packages-access-control-and-visibility)
- [Safeguard your containers with new container signing capability in GitHub Actions - GitHub Blog](https://github.blog/security/supply-chain-security/safeguard-container-signing-capability-actions/)
- [Publishing Multi-Arch Docker images to GHCR using Buildx and GitHub Actions - DEV Community](https://dev.to/pradumnasaraf/publishing-multi-arch-docker-images-to-ghcr-using-buildx-and-github-actions-2k7j)
- [Building Multi-Platform Docker Images for ARM64 in GitHub Actions | Blacksmith](https://www.blacksmith.sh/blog/building-multi-platform-docker-images-for-arm64-in-github-actions)
- [Cache is King: A guide for Docker layer caching in GitHub Actions | Blacksmith](https://www.blacksmith.sh/blog/cache-is-king-a-guide-for-docker-layer-caching-in-github-actions)
- [Docker Image attestation with GitHub attestations](https://www.augmentedmind.de/2025/03/09/docker-image-attestations-github/)
- [Publishing Semantic Versioned Docker Images to GitHub Packages Using GitHub Actions | Medium](https://medium.com/@jaredhatfield/publishing-semantic-versioned-docker-images-to-github-packages-using-github-actions-ebe88fa74522)

---

## Search Methodology

- Searches performed: 10
- Most productive terms: `docker/metadata-action semver tags`, `GHCR GITHUB_TOKEN workflow`, `docker buildx QEMU arm64 build time trade-offs`, `github actions docker layer caching gha mode`
- Primary sources: docs.docker.com, docs.github.com, github.com/docker/\* repos, community write-ups on DEV.to and Medium
