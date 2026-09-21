---
id: 260920-180654
title: 'Fix or delete rooms/canvas/room-follow.spec.ts › moves this window onto the document the person you follow is on'
kind: hygiene
status: proposed
actor: agent
gates:
  - wf.browser-test.browser-shard
  - wf.browser-test.browser-test
prs: []
ratchet-release: []
field-changes: []
---

This test is in the CI Steward quarantine lane (or was proposed for it): it runs
and is reported on every queue build, but it cannot fail one. Check `pnpm
ci:quarantine list` for whether the entry is live.

That is debt, not a fix. Close it by making the test deterministic, or by deleting
it if what it asserts is not worth a reliable test. Remove the quarantine entry in
the same change (`pnpm ci:quarantine remove`), and let the next queue build prove it.

The evidence: it failed and then passed on the retry on two separate merge-group
builds (4b8982cc2, 94de9c903) with no change in between — the follower window
races the document the leader opens. The fix is to wait on the follower reaching
that document rather than on a fixed beat.
