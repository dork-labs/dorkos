---
id: 261116-114104
title: only main saves the pnpm stores, so queue and PR copies stop evicting main's build cache
kind: experiment
status: proposed
actor: agent
gates:
  - wf.test.community-pg
  - wf.test.test-shard
  - wf.test.test-binary
  - wf.browser-test.browser-smoke
  - wf.browser-test.browser-shard
  - wf.browser-test.first-run
  - wf.browser-test.copy-spec-drift
  - wf.app-frame-browser.gesture-spec
  - wf.credential-free-build.credential-free-build
  - wf.harness-windows.harness-windows
  - wf.scripts-test.fixtures
prs: []
hypothesis:
  metric: 'tracked.cache-hit-rate'
  baseline: null
  baseline_source: 'gh cache list, 2026-11-16 11:30Z: 11.3 GB used of the 10 GB budget; 13 of 20 entries (~9.5 GB) on refs/heads/gh-readonly-queue/main/pr-* and refs/pull/N/merge (pnpm-store-Linux-ubuntu24/ubuntu26-X64-<lock> at ~735 MB each, node-cache-Windows-x64-pnpm-<hash> at ~695 MB); refs/heads/main held no pnpm-store and no turbo-test-builds entry. Hit rate not yet measured; queue shards logged "Cache not found" for turbo-test-builds (ledger 261116-091832)'
  target: 0.8
  after_days: 7
ratchet-release: []
field-changes: []
---

DOR-4537, under DOR-4190; follow-up to ledgers 261115-201939 (#3814) and 261116-091832 (#3849),
and the concrete form of seeded proposal 260919-175507. GitHub scopes caches by ref and lets
every ref read `main`'s scope. The image-keyed pnpm stores used a plain `actions/cache`, which
saves in its post step on any ref whose restore missed, and the Windows harness used setup-node's
`cache: pnpm`, which does the same. Whenever `main` had no entry for the current lockfile (every
lockfile change until the next canary, and always on Windows, where nothing runs on `main`),
each queue build and PR run saved its own 695-735 MB copy into a scope deleted on merge or read by
nothing else. On 2026-11-16 those copies held ~9.5 GB of the 10 GB budget and LRU eviction took
`main`'s `turbo-test-builds-*` entry within hours of each canary, so the build cache the queue
shards restore was gone before they asked for it.

The change: every `key: pnpm-store-…` step (test.yml community-pg, test-shard, test-binary;
browser-test.yml browser-smoke, browser-shard, first-run, copy-spec-drift; app-frame-browser.yml;
credential-free-build.yml) becomes `actions/cache/restore` plus `actions/cache/save`, both pinned
to v6.1.0 by SHA, with the save gated on `github.ref == 'refs/heads/main'` and a restore miss and
placed straight after the install, so a later red step still leaves the store. harness-windows.yml
drops `cache: pnpm` for the same image-keyed restore and main-only save. Keys are unchanged except
Windows, which moves from `node-cache-Windows-x64-pnpm-*` to `pnpm-store-Windows-<image>-X64-*`.

Who saves on `main`: test.yml's and browser-test.yml's schedule / workflow_dispatch canaries
(ubuntu-latest and ubuntu-24.04 images respectively) and app-frame-browser.yml's
workflow_dispatch. credential-free-build.yml (pull_request, merge_group) and harness-windows.yml
(pull_request, merge_group, workflow_dispatch) have no scheduled or push run on `main`:
credential-free-build restores whatever the canaries saved for its image, and harness-windows
installs from the registry until someone dispatches it on `main` for the current lockfile.

Expected: Actions cache use falls under 10 GB and stays there, `main` keeps a
`turbo-test-builds-*` entry between canaries, and queue shards' turbo restore logs a hit rather
than "Cache not found". Watch beside it: `gate.wf.harness-windows.harness-windows.duration_p50`
(cold Windows installs) and the pnpm install step time on queue builds right after a lockfile
change. Revert if the cache stays over budget after 7 days, or if cold installs in the queue cost
more than the evicted build cache saved.
