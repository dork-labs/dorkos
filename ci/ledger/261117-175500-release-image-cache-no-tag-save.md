---
id: 261117-175500
title: release image builds stop writing Docker layer cache from tag pushes
kind: experiment
status: proposed
actor: agent
gates:
  - wf.publish-docker.build-and-push
  - wf.publish-docker.build-and-push-hub
  - wf.publish-community.build-and-publish
prs: []
hypothesis:
  metric: 'tracked.cache-hit-rate'
  baseline: null
  baseline_source: 'gh api actions/cache/usage and actions/caches, 2026-11-17 17:45Z: 9.9 GB in 82 entries against the 10 GB budget. 59 buildkit-blob-1-* entries (3.93 GB) plus index-* and binfmt entries sit on refs/tags/v0.135.13, last accessed 16:09Z, the day of that release.'
  target: 0.8
  after_days: 7
ratchet-release: []
field-changes: []
---

DOR-4635 (Actions cache under 10 GB), DOR-4190 program.

`publish-docker.yml` (both images) and `publish-community.yml` build multi-arch images with
`cache-to: type=gha,mode=max`. They run on `push: tags: ['v*']`, so every write lands in the
tag's own cache scope. GitHub lets a run restore only from its own ref and the default branch,
so the next release, on a different tag, never reads it: the only reader is a re-run of the
same tag. One release left 3.93 GB there, which is 40% of the repo's 10 GB budget. Over budget,
GitHub evicts least-recently-used entries first, and those are main's CI caches (pnpm store,
per-shard `turbo-test-builds-*`, Playwright), which every PR and queue run restores.

`publish-docker.yml` now passes an empty `cache-to` on tag refs. A `workflow_dispatch` from
main still writes, and a tag can read that scope. `publish-community.yml` runs only on tags,
so both its cache lines are gone. Nothing changes in what is built or pushed. The cost is a
cold layer build on a re-run of the same tag. That was already the case for every first
attempt, since no tag can read another tag's cache.

Expected within 7 days, after one or more releases: no `buildkit-blob-*` entries on any
`refs/tags/*` ref, and total cache use under 10 GB. Watch the three gates' durations for a
release-time regression. Revert if a release build slows by more than its re-run rate saves.
Related: DOR-4628 (`desktop-release.yml` tag-ref save).
