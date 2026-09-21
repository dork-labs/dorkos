---
id: 260921-005000
title: Community releases publish a dedicated attested OCI image and manifest
kind: hygiene
status: active
actor: agent
gates:
  - wf.publish-community.build-and-publish
prs: []
ratchet-release: []
floor-release: []
field-changes: []
---

The guided Community launcher needs an immutable release artifact before it can
make a provider write. This adds a tag-only, non-required release workflow. It
builds the existing Community Dockerfile for Linux amd64 and arm64, publishes
the multi-platform index to its own GHCR repository, attests the index digest,
generates a strict version-to-digest compatibility manifest from registry
readback, attests that file, verifies both attestations against this repository
and workflow, and attaches the manifest plus offline Sigstore bundle to the
existing release.

The first production run has an operator prerequisite: after GHCR creates the
`dorkos-community` package, its visibility must be public. The workflow proves
that state with an anonymous exact-digest read before it publishes the manifest;
the fixture test alone does not claim that the live package is public.

This is hygiene because it adds a product release artifact without changing an
existing pull-request or merge-queue gate. Its own 75-minute timeout matches the
measured multi-platform Docker release lane while the first runs establish a
Community-specific baseline. Revert if it can create a release, select a mutable
tag for deployment, publish a partial platform index, or delay an existing gate.
