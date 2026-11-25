---
id: 261125-184106
title: The browser execution proof knows chat/ref-link-chip.ts, a module registered into a spec
kind: incident-fix
status: proposed
actor: agent
gates:
  - wf.browser-test.browser-test
prs: []
hypothesis:
  metric: tracked.merged-to-released
  baseline: null
  baseline_source: 'Nov 25: every completed rolling browser-test run on main failed at "Prove the browser suite actually executed" (e.g. run 45672988181: "the run reports test files that do not exist on disk: chat/ref-link-chip.ts"), so no commit since 1db24cf could be a release point'
  target: 1440
  after_days: 7
ratchet-release: []
field-changes: []
---

#4334 (DOR-5202) added `apps/e2e/tests/chat/ref-link-chip.ts`, registered into `chat-mock-session.spec.ts` like the
other test-mode chat modules, but not to `REGISTERED_MODULES` in `scripts/assert-browser-tests-executed.sh`. The
proof runs only on full browser runs (main, canary, release branches), not on a PR's smoke shards, so the PR passed and
main went red. Added with its reason, plus fixture rows. A follow-up should make the list check static and run it on
every PR (every `register*Tests` import from a non-spec `.ts` module must be listed), so the next one fails on its PR.
