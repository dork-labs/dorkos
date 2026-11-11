---
id: 261111-084457
title: Release jobs wait for the npm tarball and never hash a non-gzip download
kind: incident-fix
status: proposed
actor: agent
gates:
  - wf.publish-docker.build-and-push
  - wf.publish-docker.build-and-push-hub
  - wf.update-homebrew.update-formula
prs: []
hypothesis:
  metric: 'gate.wf.publish-docker.build-and-push.failure_rate'
  baseline: 0.67
  baseline_source: 'the 0.135.5 release (2026-11-11, DOR-4161): the Docker build failed 2 of 3 runs on a cached npm 404 for the plain tarball URL, and the Homebrew formula shipped the sha256 of that 404 page for about 20 minutes until QA re-ran it'
  target: 0
  after_days: 28
ratchet-release: []
field-changes: []
---

In 0.135.5, `npm view` answered while npm's CDN still served a cached 404 for the plain tarball URL. `scripts/wait-for-npm.sh` waited only on the metadata, so the Docker build fetched the 404 and failed, and the formula job hashed the 404 page with `curl -sL | shasum`.

Now the shared wait also requires `curl -f` on the plain tarball URL, and the formula's checksum comes from `scripts/npm-tarball-sha256.sh`. That script downloads with `curl -f`, refuses anything that isn't gzip, and refuses a download whose sha512 doesn't match npm's `dist.integrity` before it takes the sha256. Both scripts have hermetic fixture suites in the `fixtures` job, including an HTML 404 body and a valid gzip with the wrong contents.

Revert if the wait times out on releases whose tarball is plainly live, or if a correct release is refused for a mismatch npm itself doesn't show.
