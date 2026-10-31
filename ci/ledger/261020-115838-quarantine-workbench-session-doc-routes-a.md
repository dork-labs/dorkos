---
id: 261020-115838
title: 'Fix or delete workbench/session-doc-routes.spec.ts › a person reviews, allows and turns off a document route from the canvas header'
kind: hygiene
status: active
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

## Closed 2026-10-31

Fixed by #3264 (the lifecycle test got a budget that fits its work). `pnpm ci:flaky
--days 14` on the data branch at `ba1be9f952` scores it COOLING: last flake
2026-10-28, clean for the 13 queue builds since, longer than its own average gap
(11.4). The entry had already expired on 2026-10-27, so it was not absorbing
anything.

`pnpm ci:quarantine remove` could not take it out: when the list is honoured it
read the expiry-filtered entries, so an expired entry was "not in the lane". This
change makes `remove` edit the raw list (packages/ci-steward/src/quarantine-commands.ts,
pinned in quarantine-cli.test.ts). The entry was removed from the data branch at
`ec8373bb06c1`; `pnpm ci:quarantine list` now shows 0 of 10 slots.
