---
id: 261115-175742
title: Dependabot lockfile repair also runs on manifest-only PRs
kind: incident-fix
status: proposed
actor: agent
gates:
  - wf.dependabot-lockfile-repair.repair-lockfile
  - wf.typecheck.typecheck
prs: [3800]
hypothesis:
  metric: gate.wf.typecheck.typecheck.failure_rate@pull_request
  baseline: 0.0588
  baseline_source: 'origin/ci-steward-data@bf254311c37dfd0359f764247bb43c83fb75102c, snapshots/2026-11-08.json to 2026-11-14.json, gates["wf.typecheck.typecheck@pull_request"].conclusions: 27 failures over 459 completed, non-cancelled PR runs. The install-step count is from @ci-steward''s Nov 15 read, rechecked by hand over the Actions API for Nov 12 00Z to Nov 15 16Z.'
  target: 0.055
  after_days: 14
ratchet-release: []
field-changes: []
---

@ci-steward's Nov 15 read counted about 12 jobs failing in `pnpm install`
between Nov 12 and Nov 15. A pass over every failed run in that window
(Actions API, the first failed step of each failed job) found 17. All came from
one PR, #3662 (Dependabot, "bump @hono/node-server in /apps/space", head
23be434), and all failed with ERR_PNPM_OUTDATED_LOCKFILE, not on the network.
No earlier attempt of a re-run run failed in install either, so a retry around
`pnpm install` (the first plan for DOR-4458) would have saved none of them.

The cause: Dependabot's security updates open one PR per workspace directory
that edits only that package's package.json. When the lockfile does not
already satisfy the new range, every installing job goes red. The repair
workflow's resolver-only run (`pnpm install --lockfile-only`) fixes exactly
that, but it triggered on `pnpm-lock.yaml` alone, so it never ran on #3662 (no
run exists for that branch). The same manifest-only shape appears on #3675,
#3231, #3153, #3136 and #3133.

Change: the `pull_request_target` path filter adds `package.json`,
`apps/*/package.json` and `packages/*/package.json`. The `dependabot[bot]`
actor gate, `--lockfile-only` and `--ignore-scripts` are unchanged, so the
wider trigger reaches no new author and runs nothing a PR wrote. A
manifest-only PR whose lockfile already fits writes nothing and exits.
`scripts/__tests__/dependabot-lockfile-repair-paths.test.ts` pins the paths
against pnpm-workspace.yaml and pins the safety lines.

Primary check, by hand at 14 days: Dependabot PRs whose first failure is
ERR_PNPM_OUTDATED_LOCKFILE drop from 1 PR / 17 jobs in the window to 0. The
catalogue has no metric for that; the typecheck PR-leg failure rate is the
closest computed proxy (one job per PR, required), and real type errors
dominate it, so the target is only the baseline less about one such PR
failure a week. Revert if the
job pushes a lockfile commit that moves a version the PR did not propose, or
runs on a PR not authored by Dependabot.
