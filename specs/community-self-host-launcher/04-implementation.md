# Implementation Summary: Guided Community self-host launcher

**Created:** 2026-09-21
**Last Updated:** 2026-09-21
**Spec:** `specs/community-self-host-launcher/02-specification.md`

## Progress

**Status:** In Progress
**Tasks Completed:** 14 / 15

## Implemented

- The release workflow publishes a two-architecture Community image and attaches an attested, exact-version manifest only after immutable digest and anonymous-read checks pass. The packaged CLI uses the shared strict parser and its compiled migration-corpus fingerprint.
- `dorkos community deploy` resolves and verifies the exact manifest and image attestations, checks pinned Fly and Neon CLI minimums, reads explicitly selected organizations and regions, renders the non-secret plan, supports a write-free dry run, and requires the operator to type the Fly app name before the first write.
- The mode-`0600` durable journal records intent before creation, service-issued identities, exact bindings, non-secret secret digests, and safe errors. Creation never adopts a same-name resource or repeats a write after an unproved outcome.
- The executor creates and re-reads the Fly app, separate Neon project topology, and private Tigris binding. Tigris terms require their own interactive acknowledgement. Database credentials, Fly session credentials, object-store credentials, and generated Community secrets remain in bounded memory and secret stdin paths.
- Secret import uses a durable pre-write baseline. Resume can prove a complete staged set after an import-before-journal interruption without regenerating authentication or invitation secrets. Deployment uses the immutable image digest, one always-on Machine, Fly check readback, applied secret digests, and an independently bounded HTTPS health check.
- Owner creation stays in Community's browser flow. A lost Setup secret is replaced and applied before handoff; successful claim rotates it again and proves the same pinned one-Machine deployment before completion. The operator must confirm one post and one private attachment round trip.
- Incomplete journals can be listed without provider calls. Control-C aborts the exact active provider process or prompt, records a safe cancellation or uncertain checkpoint, and prints every confirmed resource with its owner, possible charges and data, provider page, read-only inspection command, and exact resume command.
- The Fly guide leads with guided setup and keeps the source-based manual path for recovery and audit. A package-level proof builds and installs the npm tarball outside the checkout, then exercises exact manifest resolution, dry run, fake Fly/Neon/Tigris provisioning, owner-pending output, pinned config rendering, and a second resume run that proves each resource was created once.

## Verification

- 142 focused launcher and shared release-contract tests pass.
- The CLI package typecheck and lint pass with no new lint errors.
- `pnpm --filter dorkos test:community-package` builds and installs the production npm tarball in a temporary directory, then passes the complete checkout-independent fake-service flow and removes its temporary package, provider state, journals, and fake credentials.
- Service mutation tests use fake executables and local HTTP fixtures. Ordinary verification never contacts or mutates Fly, Neon, Tigris, GitHub, or another paid service.

## Remaining Work

Task 4.3 remains separate: the explicitly armed credentialed release gate must exercise the exact published package and image in designated test organizations, induce and resume one interruption, verify meaningful Community behavior, and prove exact-identity cleanup. Until that gate passes, the release must not be described as guided-launch ready.
