---
id: 261018-131608
title: Where the space server lives is one file, read by CI
kind: experiment
status: proposed
actor: agent
gates:
  - wf.test.community-packaged
  - wf.test.community-pg
  - wf.publish-community.build-and-publish
  - wf.scripts-test.fixtures
  - wf.scripts-test.harness
prs: []
hypothesis:
  metric: gate.wf.test.community-packaged.duration_p50@pull_request
  baseline: 0.27
  baseline_source: 'origin/ci-steward-data snapshots/2026-10-11..2026-10-17.json (collected 2026-10-18T09:26Z), gates["wf.test.community-packaged@pull_request"].durations: 542 completed runs, median 16 s = 0.27 min; 162 of them (30%) ran the proof (over 60 s), the rest were the scope step answering false in 13-16 s.'
  target: 0.5
  after_days: 21
ratchet-release: []
field-changes: []
---

## Why

The space server lives in `apps/community` today. Step 7 of `specs/server-merge`
(the "7d" move) puts it in `apps/server/src/services/spaces/` and its web pages
in `apps/client`, as pure renames. Before this change the folder was written out
in `test.yml` (the `community-pg` evidence upload, the `community-packaged` run
step), `publish-community.yml` (the Dockerfile and the migrations),
`scripts/community-packaged-scope.sh`, the acceptance runner, its Dockerfile and
`run.mjs`, the vocabulary gate, the one-shot-route gate, the two-desktop journey
and the tests that pin them. A move PR that also edits each of those is a large
diff in exactly the files that gate the queue.

## What changed (DOR-3007)

`ci/space-server.env` holds three `KEY=value` lines (`SPACE_DIR`,
`SPACE_SRC_DIR`, `SPACE_WEB_DIR`), readable as a bash `source`, as
`$GITHUB_ENV` lines and through `scripts/lib/space-server.mjs`. Every place
above reads it. The workflows append it to `$GITHUB_ENV` in a step with no `if:`
right after checkout (a `paths:` filter cannot read env; neither job has one,
and no required job gained a skip). With the file naming `apps/community`,
every job runs the same commands on the same paths as before.

The packaged-scope list now keys on the three folders plus the file itself,
and its fixtures score the future layout too: under it, the space server's own
folders reach the proof and the rest of `apps/server` does not. The acceptance
runner finds the repository root by the file rather than by a fixed number of
`..`, and passes the folder to its Dockerfile as a build argument.
`scripts-test-scope.sh` gains the file and `publish-community.yml`, so a PR
that edits only the file still runs the suites that read it.

## The bet

No behaviour change now, and none in the scope when the folder moves. The
narrowest number that would show the scope going wrong is the pull-request
leg's median duration: today most PRs skip the proof in about 15 s, so the
median sits at 0.27 min. A scope that started matching every `apps/server`
change (the failure the ticket names) would run the six-minute proof on most
PRs and push the median past several minutes. Target: it stays at or under
0.5 min for the 21 days after merge. Revert, or fix the list, if it rises above
that while the PR mix is unchanged, or if `community-packaged` or `community-pg`
fails on a PR whose only change is this one.
