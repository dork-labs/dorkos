---
id: 260925-230012
title: 'Stop Neon preview databases piling up: no preview for queue and archive branches, and a nightly sweep'
kind: experiment
status: proposed
actor: agent
gates:
  - wf.neon-preview-sweep.sweep
prs: [2128]
hypothesis:
  metric: tracked.neon-preview-branches
  baseline: 52
  baseline_source: 'neonctl branches list on the site database project, 2026-09-25, before a hand cleanup to 19 (38 deleted: 34 git branches with no PR, 4 closed PRs).'
  target: 20
  after_days: 14
ratchet-release: []
field-changes: []
---

## Why

The Vercel-Neon integration makes a Neon branch, `preview/<git-branch>`, for every git branch the
site project deploys, and removes it only when the git branch is deleted. The project held 52 on
2026-09-25 against a plan that includes 10 per project and bills the rest. Merged PRs clean up
after themselves (GitHub deletes the head branch). The leak was git branches that never become a
PR: Codex working branches that lost to a sibling attempt, `codex/archive/*` pinned-SHA twins, and
closed PRs. Two sources refill it every day on top of that: `ci-steward-data`, pushed daily by
ci-steward.yml, and every merge-queue build branch, `gh-readonly-queue/main/pr-*`.

The site's `ignoreCommand` cannot help. Measured on the queue branch for #2126: the Neon branch
was created at 22:16:51Z, two seconds after the first deployment was created and before its clone
finished, so the database exists before the ignore step runs. Only `git.deploymentEnabled` stops
the deployment itself.

## What changed

1. `apps/site/vercel.json` sets `git.deploymentEnabled` false for `gh-readonly-queue/**` and
   `codex/archive/**`. Production (`main`) and every other branch still deploy; a test pins both
   sides with Node's minimatch port. Vercel reads vercel.json from the deployed commit, so the
   archive rule reaches only twins of commits made after this merges; older twins keep deploying
   until they age out. `ci-steward-data` is deliberately not listed: that orphan branch has no
   `apps/site` (its deployments already fail with no build), so a key for it could never be
   read. The sweep bounds it to one preview database, deleted and remade about weekly.
2. `neon-preview-sweep.yml`, nightly, runs `scripts/neon-preview-sweep.ts`: it deletes a
   `preview/*` branch made by the integration only when it is not default, protected or primary,
   has no children, was created and last active 7+ days ago with no compute running, and its
   git branch has no open PR (listed through GraphQL cursors, so the listing cannot skip one).
   Any unreadable listing deletes nothing. At most 25 a night. Green with a notice until the
   operator adds `NEON_API_KEY` (secret) and `NEON_PROJECT_ID` (variable).
3. `scripts/worktree-janitor.sh --origin` reports remote branches with no open PR and no local
   worktree, and with `--fix` deletes only those already in `main` or whose merged PR had the same
   head, never the base of an open PR. The `creating-pull-requests` skill now says to delete an abandoned review branch and a
   `codex/archive/*` twin once its PR merges.

## Reading the verdict

The collector cannot read Neon, so this metric has no computed value and the verdict will read
`inconclusive`. Read it by hand: the "branches before" line of the last seven
neon-preview-sweep runs' job summaries. Verified if it stays at or under 20.

Revert the sweep (not the vercel.json change) if it ever deletes a branch whose git branch had an
open PR or activity in the last 7 days, or if it goes red three nights running for a reason that
is not a real Neon or GitHub outage.
