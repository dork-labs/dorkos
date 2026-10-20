---
id: 261020-115838
title: "Fix or delete workbench/session-doc-routes.spec.ts › a person reviews, allows and turns off a document route from the canvas header"
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
