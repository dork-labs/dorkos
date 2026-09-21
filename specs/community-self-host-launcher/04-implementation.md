# Implementation Summary: Guided Community self-host launcher

**Created:** 2026-09-21
**Last Updated:** 2026-09-21
**Spec:** `specs/community-self-host-launcher/02-specification.md`

## Progress

**Status:** In Progress
**Tasks Completed:** 4 / 15

## Tasks Completed

### Provider contracts and fixtures

- Added sanitized Fly and Neon JSON fixtures plus destructive field mutations and a repository fixture scan that rejects credential shapes, secret URLs, and terminal controls.
- Added typed Fly account, organization, region, app, Machine, release, address, and secret-version reads. App creation, staged secret import, immutable-image deployment with `--ha=false`, and exact app deletion run through the bounded subprocess boundary. Independent readback proves staged and applied secret digests, one healthy Machine, the expected image digest, a stable release, and a public address.
- Added typed Neon organization, active-region, project, branch, database, role, and endpoint reads. Project creation always passes `--no-secrets`; exact-ID cleanup is bounded; project labels never establish provenance; and the direct TLS URL remains in a disposable in-memory wrapper bound to independently inventoried project, branch, region, endpoint, database, and role identities.
- Added fixed minimal Fly GraphQL operations for Tigris terms, private creation, exact-ID readback, and exact-name cleanup. Creation checks accepted terms first, never requests public access or excluded secret fields, and requires independent private organization/app/provider binding plus the two expected Fly secret names.
- Added exact release-resolution interfaces that bind the requested version, manifest attestation, image attestation, repository, workflow, and tag without a mutable fallback. The release workflow task owns the shared manifest parser and publication assets.

## Remaining Work

- Task 1.2 still owns packaged command dispatch, the concrete release-asset transport, shared manifest parsing, local CLI version compatibility, and Linux architecture selection.
- Task 1.3 still owns read-only preflight policy, authoritative readiness/unknown classification, immutable plan construction, and typed interactive consent.
- Phase 3 still owns orchestration. It must write creation intent before any mutation, use the wrappers in the frozen transition order, persist only verified identities, refuse blind retries after uncertain outcomes, render the temporary Fly configuration, generate secrets, and call the staged import and deploy boundaries.
- Phase 4 still owns bootstrap rotation through an applied Fly secret deployment, owner handoff, packaged proof, and the separately armed credentialed cleanup gate. The cleanup methods in this slice do not authorize deletion and are not called by ordinary launch failures.

No test in this slice contacts or mutates Fly, Neon, Tigris, or another paid service. All mutation coverage uses fake executables or local HTTP response fixtures.
