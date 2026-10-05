---
id: 261005-201839
title: 'Desktop Release: verify and publish inside the build jobs'
kind: experiment
status: active
actor: agent
gates:
  - wf.desktop-release.build-macos
  - wf.desktop-release.build-windows
prs: []
hypothesis:
  metric: tracked.desktop-release-wall-clock
  baseline: 19.6
  baseline_source: 'gh: the 9 tag pushes v0.87.0..v0.98.0 (v0.95.0 excluded, published 26 h later), run created_at to release published_at, p50 19.6 min (14.7, 16.8, 17.8, 18.7, 19.6, 22.9, 38.5, 45.3, 45.4)'
  target: 18
  after_days: 21
ratchet-release: []
field-changes: []
---

DOR-2728. A desktop release ran five jobs: build-macos, build-windows, then verify-macos, verify-windows and publish-release, each on a fresh runner. The last three ran the same checks on the same files the build jobs had just written, and each runner they needed was one more place a release could stall. On v0.98.0, during a GitHub runner-assignment incident (githubstatus, 19:11 UTC), verify-macos waited 10.7 min for a Mac and publish-release never got a runner; the release was published by hand. In the 24 releases before it those waits were 0.1 min or less, so the everyday saving is the verify job itself (about 1 to 2.4 min) plus the artifact round trip.

What changed: the verify commands are now steps right after packaging, before upload and attach, so a broken installer is never attached. Publishing is build-macos's last step; it first waits (at most 28 min) for build-windows to finish, so Windows assets are still attached before the release goes public. Every gate the verify jobs enforced is kept: codesign --verify --deep --strict, spctl Gatekeeper on signed builds, the Windows silent install. Off a tag, or with dry_run, the publish step rehearses and changes nothing.

Not changed: notarization. The v0.98.0 log shows one Apple submission (the .app), about 9 min of the 13.7 min package step; it was checked first and left alone. A "let a release go first" change for PR CI was not made: in that window this repo had 7 to 24 jobs running against a 60-job pool, so nothing on record says PR CI starved a release.

Revert if a build passes its in-job verify but the same installer fails codesign or Gatekeeper on a clean Mac, or if a release publishes before its Windows assets are attached with build-windows still running under the cap.

`after_days` is 21 because `verdicts.min_n` is 10 and there are about five releases a week. The metric `tracked.desktop-release-wall-clock` is new in this same change: tag-push run start to release `published_at`, p50, one sample per tag, drafts and anything published more than 24 h later excluded.
