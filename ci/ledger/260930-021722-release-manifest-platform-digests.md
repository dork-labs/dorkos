---
id: 260930-021722
title: The Community release manifest records each platform's image digest
kind: hygiene
status: proposed
actor: agent
gates: [wf.publish-community.build-and-publish]
prs: [2373]
ratchet-release: []
field-changes: []
---

`scripts/generate-community-release-manifest.ts`, which the Community publish job runs,
now also records each platform's own manifest digest from the OCI index Buildx pushed
(DOR-2586). Fly reports the linux/amd64 manifest, not the index, so the launcher can
check a deploy against the digest the signed manifest names instead of reading the
registry. The field is optional, so manifests from 0.92.0 and earlier still parse.

Nothing in CI should move: the job builds, pushes and attests exactly as before, and
the generator reads the same index file it already read. It now refuses an index
entry without a digest, which Buildx always writes. Revert if a release's publish job
fails in the manifest step.
