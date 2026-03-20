---
slug: docker-image-publishing
number: 130
created: 2026-03-14
status: ideation
---

# Docker Image Publishing to GHCR

**Slug:** docker-image-publishing
**Author:** Claude Code
**Date:** 2026-03-14
**Branch:** preflight/docker-image-publishing

---

## 1) Intent & Assumptions

- **Task brief:** Set up a GitHub Actions workflow to automatically build and publish the DorkOS Docker image to `ghcr.io/dork-labs/dorkos` on every tagged release. The documentation already references this image but no publishing automation exists — users get "denied" errors when trying to pull it. This work also includes updating documentation to accurately reflect the Docker image lifecycle, adding OCI labels to `Dockerfile.run`, and ensuring the `/system:release` command's output acknowledges that Docker publishing happens automatically.
- **Assumptions:**
  - `Dockerfile.run` is the correct runtime image (not the smoke-test `Dockerfile`)
  - The GitHub org is `dork-labs` and the repo is `dorkos`
  - `GITHUB_TOKEN` has sufficient permissions for GHCR push (no PAT needed)
  - npm publish completes before the Docker workflow runs (tag push triggers both; Docker workflow uses `INSTALL_MODE=npm` to pull the just-published package)
  - GHCR package visibility will be set to public manually after first push (one-time)
- **Out of scope:**
  - Docker Compose orchestration beyond what's already documented
  - Kubernetes manifests or Helm charts
  - Image signing with cosign (GitHub Artifact Attestation covers supply-chain provenance)
  - SBOM generation
  - Automated image testing post-publish (can be a follow-up)

## 2) Pre-reading Log

- `Dockerfile`: CLI smoke test image — installs from tarball, mocks Claude, runs validation. Not for publishing.
- `Dockerfile.run`: Production runtime image — installs from tarball or npm, runs `dorkos init`, exposes port 4242, ENTRYPOINT is `dorkos`. This is the image to publish.
- `Dockerfile.integration`: Full integration test image — installs dorkos, runs `scripts/smoke-test.sh` (health, API, client checks).
- `.dockerignore`: Deny-all allowlist — only copies Dockerfiles, tarballs, and smoke-test script.
- `.github/workflows/cli-smoke-test.yml`: Triggers on push to main. Jobs: build-tarball, smoke-test-bare (Node 20/22), smoke-test-docker, integration-test. No publishing.
- `.github/workflows/update-homebrew.yml`: Manual dispatch. Updates Homebrew formula with new version SHA. Requires `HOMEBREW_TAP_TOKEN`.
- `.claude/commands/system/release.md`: 6-phase release orchestrator. Bumps VERSION, syncs package.json files, updates CHANGELOG.md + docs/changelog.mdx, scaffolds blog post, commits, tags, pushes, publishes to npm, creates GitHub Release. No Docker publishing step.
- `docs/self-hosting/docker.mdx`: Comprehensive Docker guide referencing `ghcr.io/dork-labs/dorkos:latest` throughout. Includes docker run, docker-compose, Caddy reverse proxy, build-from-source. All examples assume the image exists.
- `docs/getting-started/installation.mdx`: Lists Docker as an installation method alongside npm/Homebrew. References `ghcr.io/dork-labs/dorkos:latest`.
- `VERSION`: Current version is `0.12.0`.
- `package.json`: Has `docker:build` and `docker:run` scripts. No `docker:publish`.
- `.dockerignore`: Needs updating to support npm-mode builds (currently only allows tarballs).

## 3) Codebase Map

- **Primary components/modules:**
  - `Dockerfile.run` — Runtime Docker image (target for publishing)
  - `.github/workflows/cli-smoke-test.yml` — Existing CI pattern to follow
  - `.claude/commands/system/release.md` — Release orchestrator (needs awareness update)
  - `docs/self-hosting/docker.mdx` — User-facing Docker guide (needs version tag docs)
  - `docs/getting-started/installation.mdx` — Installation page (references Docker)
  - `VERSION` — Single source of truth for version
  - `package.json` — Root scripts (`docker:build`, `docker:run`)
- **Shared dependencies:**
  - `packages/cli/` — The npm package that gets installed inside the Docker image
  - `.dockerignore` — Controls Docker build context
- **Data flow:**
  - Git tag push (`vX.Y.Z`) → GitHub Actions workflow → `docker/build-push-action` → GHCR
  - `Dockerfile.run` with `INSTALL_MODE=npm` → `npm install -g dorkos@X.Y.Z` → runtime image
- **Feature flags/config:** None
- **Potential blast radius:**
  - Direct: 1 new workflow file, 1 Dockerfile edit (labels), 2 doc files, 1 release command
  - Indirect: `.dockerignore` may need adjustment for npm-mode builds
  - Tests: No test changes needed — this is CI infrastructure

## 4) Root Cause Analysis

_N/A — not a bug fix._

## 5) Research

Research report: `research/20260314_ghcr_docker_publishing_github_actions.md`

### Potential Solutions

**1. Tag-triggered GitHub Actions workflow with docker/build-push-action**

- Description: Canonical four-action stack (login, buildx, metadata, build-push) triggered on `on: push: tags: ['v*']`
- Pros:
  - Industry standard, well-documented
  - `GITHUB_TOKEN` auth (no PAT needed)
  - `docker/metadata-action` auto-generates semver tags
  - Decoupled from release command — fires automatically on tag push
- Cons:
  - Requires npm publish to complete before Docker build starts (race condition if npm is slow)
  - One-time manual step to make GHCR package public
- Complexity: Low
- Maintenance: Low

**2. Release-event triggered workflow**

- Description: Trigger on `on: release: types: [published]` instead of tag push
- Pros:
  - Fires only when a formal GitHub Release is created
- Cons:
  - `GITHUB_TOKEN`-created releases don't trigger other workflows (chaining problem)
  - Draft releases don't fire the trigger
  - More fragile coupling to the release process
- Complexity: Low
- Maintenance: Medium (debugging trigger failures)

**3. Manual dispatch only**

- Description: `workflow_dispatch` trigger, operator clicks "Run workflow" after release
- Pros:
  - Full control over when images are published
- Cons:
  - Easy to forget, breaks the "Docker just works" promise in docs
  - Adds friction to every release
- Complexity: Low
- Maintenance: High (human in the loop)

### Security Considerations

- `GITHUB_TOKEN` scoped to repo, no external secrets needed
- GitHub Artifact Attestation provides SLSA provenance (verifiable with `gh attestation verify`)
- OCI labels link image to source repository for transparency

### Performance Considerations

- amd64 build: ~3-5 min
- arm64 via QEMU: ~15-30 min additional
- GHA layer caching (`type=gha,mode=max`) minimizes rebuild time
- Total workflow: ~20-35 min (acceptable for infrequent releases)

### Recommendation

**Recommended Approach:** Tag-triggered workflow (Solution 1) with multi-platform (amd64 + arm64), GHA caching, and GitHub Artifact Attestation.

**Rationale:** This is the canonical approach used by the Docker ecosystem. It integrates seamlessly with the existing release process (which already pushes tags) with zero changes to `/system:release`. The `docker/metadata-action` handles semver tagging automatically. Multi-platform support via QEMU adds build time but ensures native performance on Apple Silicon and ARM servers.

**Caveats:**

- npm publish must complete before Docker build pulls the package. Since the tag push triggers both npm publish (manual in release command) and the Docker workflow simultaneously, there's a potential race. Mitigation: the Docker workflow should wait for the npm package to be available, or the release command should push the tag _after_ npm publish succeeds (which it already does — tag push is Phase 5.7, npm publish is Phase 5.8... actually, tag push happens BEFORE npm publish in the current flow).
- **Critical ordering issue:** The current release command pushes the git tag (Phase 5.7) BEFORE npm publish (Phase 5.8). This means the Docker workflow would trigger and try to `npm install -g dorkos@X.Y.Z` before the package is published. Solutions: (a) reorder release phases so npm publish happens before tag push, (b) add a retry/wait loop in the Docker workflow, or (c) build from tarball instead of npm. Option (a) is cleanest.

## 6) Decisions

| #   | Decision                | Choice                                         | Rationale                                                                                                                                                                                                               |
| --- | ----------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Docker image build mode | npm (install published package)                | Verifies the published npm package works in Docker. Simpler than building from source. Image content matches what users get via `npm install`.                                                                          |
| 2   | Platform support        | amd64 + arm64 via QEMU                         | Native ARM support for Apple Silicon Docker users and Graviton servers. Adds ~15-30 min to builds but releases are infrequent. Professional-grade from day one.                                                         |
| 3   | Release integration     | Automated workflow only                        | Tag push triggers the workflow automatically. No manual steps. The existing release command already pushes tags. Zero changes to `/system:release` operator flow (but Phase 6 report should mention Docker publishing). |
| 4   | Supply chain security   | GitHub Artifact Attestation                    | Zero extra tooling — uses `actions/attest-build-provenance`. Adds 3 lines to workflow. Users can verify with `gh attestation verify`.                                                                                   |
| 5   | Image tagging strategy  | semver + minor + sha + latest                  | `0.12.0`, `0.12`, `sha-abc1234`, `latest` (auto-managed, skipped for pre-releases). No `{{major}}` tag while pre-1.0.                                                                                                   |
| 6   | Layer caching           | GHA cache (`type=gha,mode=max`)                | Zero-cost, zero-setup, 10 GB limit is sufficient for Node.js images.                                                                                                                                                    |
| 7   | Workflow trigger        | `on: push: tags: ['v*']` + `workflow_dispatch` | Tag push is reliable, works with `GITHUB_TOKEN`, matches existing patterns. Manual dispatch for re-runs.                                                                                                                |

### Open Issue: Release Phase Ordering

The current `/system:release` pushes the git tag (Phase 5.7) **before** npm publish (Phase 5.8). Since the Docker workflow uses `INSTALL_MODE=npm`, it needs the npm package to exist before it can build. Two options:

1. **Reorder release phases**: Push tag after npm publish succeeds (swap 5.7 and 5.8). This is the cleanest fix.
2. **Add npm availability check to Docker workflow**: Poll `npm view dorkos@X.Y.Z` until it resolves before building. More resilient but adds complexity.

Recommendation: Option 1 (reorder). The tag push is what triggers the Docker workflow, so it should be the last step after all artifacts are published.
