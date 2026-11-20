---
id: 261117-184500
title: the browser workflows restore a main-saved turbo build cache
kind: experiment
status: proposed
actor: agent
gates:
  - wf.browser-test.browser-smoke
  - wf.browser-test.browser-shard
  - wf.browser-test.first-run
  - wf.app-frame-browser.gesture-spec
prs: []
hypothesis:
  metric: 'tracked.cache-hit-rate'
  baseline: 0
  baseline_source: 'browser-test.yml merge_group run 44156345720 (2026-11-17): the "Build what the webServer legs boot from" step took 126-166 s in each of first-run and browser-shard 1-6, with no .turbo/cache restore anywhere in the workflow. app-frame-browser.yml gesture-spec builds the same two packages the same way.'
  target: 0.5
  after_days: 7
ratchet-release: []
field-changes: []
---

DOR-4634 (replaces DOR-2486, closed as misdiagnosed), DOR-4190 program.

No browser job had a turbo cache, so each one rebuilt `@dorkos/server`, `@dorkos/client` and
their packages from an empty `.turbo/cache`. That's about 130 s a job and seven jobs a queue
build, about 15 runner-minutes, with about 2 minutes on the critical path of the queue's
slowest required check.

Every browser build step (browser-smoke, browser-shard, first-run, and app-frame-browser's
gesture-spec) now restores `turbo-browser-builds-<os>-<arch>-<lockfile>-<sha>`. It falls back
to the same lockfile, then to the newest entry for this OS and arch, the same chain as
test.yml's shards. Only browser-shard (1/6) saves, on `refs/heads/main` (the schedule canary,
`41 0,5,10,21 * * *`, or a dispatch), straight after its build. It has the widest filter
(`--filter=@dorkos/site^...` as well), and every job's build tasks hash the same:
`turbo run build --dry=json` gives `@dorkos/client#build` the same hash under each job's
filter, with or without `--summarize`. Before the save, scripts/keep-build-cache-only.sh
(already pinned by scripts/test-keep-build-cache-only.sh) keeps only this run's build
entries, read from the `--summarize` record that build now writes. So no test result can be
replayed, and the entry doesn't grow run over run. If the trim can't read the record, it
deletes the cache and nothing is saved.

Expected within 7 days: `Cached:` above 0 on the browser build steps of queue builds after a
canary, and the step's p50 down from ~130 s. Packages a PR doesn't touch replay; the client
rebuilds whenever its inputs changed, which is often. Watch the four gates'
`duration_p50@merge_group`. Revert if a restored entry ever coincides with a webServer leg
booting stale code. Turbo's hashes should rule that out, but the legs are the place it would
show.
