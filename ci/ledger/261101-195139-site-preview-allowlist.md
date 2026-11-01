---
id: 261101-195139
title: 'Vercel previews only for main and */site-* branches, so scratch branches stop making Neon databases'
kind: experiment
status: proposed
actor: agent
gates:
  - wf.neon-preview-sweep.sweep
prs: []
hypothesis:
  metric: tracked.neon-preview-branches
  baseline: 164
  baseline_source: 'Coordinator count on 2026-11-01: about 164 agent scratch branches had each been given a dorkos-site preview deploy and a Neon preview branch; the Neon bill tripled.'
  target: 10
  after_days: 14
ratchet-release: []
field-changes: []
---

## Why

Entry 260925-230012 turned deploys off for two prefixes (`gh-readonly-queue/**`, `codex/archive/**`).
Agent scratch branches of every other shape kept deploying, and each deploy makes a Neon branch.
The site's `ignoreCommand` cannot help: Vercel's Neon step runs when the deployment is created,
before the ignore step (measured on #2126, and Vercel's docs say the ignore step runs once the
deployment is `BUILDING`). Only `git.deploymentEnabled` stops the deployment.

## What changed

`apps/site/vercel.json` is now an allowlist: `"**": false`, `"main": true`, `"**/site-*": true`.
Vercel deploys a branch if any matching key is true. So production still deploys, a branch whose
last part starts `site-` (`designer/site-hero-copy`) gets a preview, and nothing else deploys.
Every site PR still runs the `site-build` check. The `ignoreCommand` is unchanged.

Vercel reads `vercel.json` from the pushed commit, so branches cut from an older `main` keep
deploying until rebased; the nightly sweep clears their databases.

## Reading the verdict

The collector cannot read Neon, so read it by hand: the "branches before" line of the last seven
neon-preview-sweep job summaries. Verified if it stays at or under 10.

Revert if `main` stops deploying production, or if a `*/site-*` branch with an open PR gets no
preview.
