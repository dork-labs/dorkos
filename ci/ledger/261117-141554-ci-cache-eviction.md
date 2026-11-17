---
id: 261117-141554
title: caches only main saves, and closed PRs' caches are deleted, so main's build cache stops being evicted
kind: experiment
status: proposed
actor: agent
gates:
  - wf.credential-free-build.credential-free-build
  - wf.cli-smoke-test.build-tarball
  - wf.db-check.db-check
  - wf.desktop-renderer.renderer-defines
  - wf.desktop-smoke.packaged-runtime
  - wf.docs-openapi-check.openapi-fresh
  - wf.evals.structural
  - wf.evals.credentialed
  - wf.lint.lint
  - wf.scripts-test.harness
  - wf.site-build.site-build
  - wf.typecheck.typecheck
  - wf.cache-cleanup.cache-cleanup
prs: []
hypothesis:
  metric: 'tracked.cache-hit-rate'
  baseline: null
  baseline_source: 'gh api repos/dork-labs/dorkos/actions/caches, 2026-11-17 ~14:20Z: 10.3 GB in 25 entries against the 10 GB budget; 7.2 GB of it on refs/pull/N/merge. turbo-credential-free-Linux-* (saved on pull_request only) 4.3 GB in 13 entries across 10 PRs; refs/pull/3894/merge, a PR on a base older than DOR-4537, 4.0 GB (pnpm-store x2, node-cache Linux and Windows, turbo-credential-free x2). main held node-cache-Linux/macOS (setup-node cache: pnpm), both pnpm-store images and two 22 MB turbo-test-builds entries. Hit rate not yet computed by the collector.'
  target: 0.8
  after_days: 7
ratchet-release: []
field-changes: []
---

DOR-4537's follow-up, under DOR-4190 (ledgers 261116-114104, #3852; 261116-091832, #3849).
DOR-4537 made every `pnpm-store-*` save main-only, but three things still wrote caches to PR
merge refs, a scope only that PR can read back:

1. `credential-free-build.yml` saved `.turbo/cache` as `turbo-credential-free-*` on
   `pull_request` only. The workflow has no run on `main`, so no entry was ever readable by
   another PR or the queue. Removed, restore and save both; no `push: main` leg is added (the
   queue already tested the tree, and the queue leg is cold by construction).
2. setup-node's `cache: pnpm` saves a `node-cache-*` store in its post step on any ref whose
   restore missed. Every real use in a workflow that runs on `pull_request` or `merge_group`
   (cli-smoke-test, db-check, desktop-renderer, desktop-smoke, docs-openapi-check, evals x2,
   lint, scripts-test harness, site-build, typecheck) now uses the DOR-4537 shape: an
   image-keyed `actions/cache/restore` on every ref and an `actions/cache/save` only on
   `refs/heads/main`, both pinned to v6.1.0. The Linux key is test.yml's, so these jobs
   restore the store main's canary saved. Left on `cache: pnpm`: schedule- and dispatch-only
   workflows (ci-steward, coverage-unique, community-two-desktop, browser-native-release-artifact,
   mutation-pilot) and tag-only ones (desktop-release, publish-community), which never run on a
   PR ref. A new drift test fails if any PR or queue workflow uses `cache: pnpm` again.
3. PRs on old bases still run the old workflow files. New `cache-cleanup.yml` deletes a PR's
   caches when it closes, and twice a day sweeps every `refs/pull/<n>/merge` cache whose PR is
   closed or merged. It never deletes a `main`, queue, tag or open-PR entry.

Expected, and how to read it beside the computed verdict: `main` keeps a `turbo-test-builds-*`
entry for 7 straight days, total cache on `refs/pull/*` refs stays under 3 GB, and queue shards'
turbo restore logs a hit (`gh api repos/dork-labs/dorkos/actions/caches` and the shards' logs).
main's `node-cache-*` entries (735 MB Linux, 687 MB macOS) stop being written and age out after 7
days unread; macOS moves to `pnpm-store-macOS-<image>-ARM64-*`, saved by desktop-smoke's push leg.
Watch beside it: `gate.wf.credential-free-build.credential-free-build.duration_p90`, now always
cold, and the install step on PR runs right after a lockfile change, before the canary saves.

Revert (1) if credential-free-build's p90 grows past 15 minutes. Revert or rework (2) if PR
install times rise by more than a minute at p50 for a week with main holding a store for the
lockfile. Revert (3) if it ever deletes an entry on `refs/heads/main` or an open PR's ref, or if
cache use is still over 10 GB after 7 days (then the cause is elsewhere).
