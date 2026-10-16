---
id: 261016-194918
title: The hub image is published and attested with each release
kind: experiment
status: proposed
actor: agent
gates: [wf.publish-docker.build-and-push-hub]
prs: []
hypothesis:
  metric: gate.wf.publish-docker.build-and-push-hub.failure_rate
  baseline: 0
  baseline_source: 'No runs yet for the new job. Its sibling wf.publish-docker.build-and-push, which builds from the same npm package with the same QEMU multi-arch setup, succeeded on its last 5 release runs (gh run list --workflow publish-docker.yml, 2026-10-16), taking 1241 to 1480 seconds including the npm wait.'
  target: 0
  after_days: 30
ratchet-release: []
field-changes: []
---

A new job in `publish-docker.yml`, beside the runtime image's, on the same `v*` tag. It builds the Dockerfile's `hub` target from the just-published npm package for amd64 and arm64, and pushes it to `ghcr.io/dork-labs/dorkos-hub` under the version and the commit, with no `latest`, because DorkOS Cloud pins each hub to a digest and upgrades in waves. It attests the digest, then verifies the attestation against this workflow and the tag before the job passes. That is what Cloud asked for on A3 (DOR-2935): published like the space image, signed, tagged per release.

The bet is that it fails no more often than the runtime image's job beside it: zero failures over the next month of releases. Revert or fix if it fails on a release where `build-and-push` passed, which would point at the hub target or the attestation step rather than the shared build.
