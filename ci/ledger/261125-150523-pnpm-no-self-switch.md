---
id: 261125-150523
title: pnpm no longer switches itself to the packageManager pin locally
kind: incident-fix
status: proposed
actor: agent
gates: []
prs: []
hypothesis:
  metric: tracked.machine-load
  baseline: null
  baseline_source: 'Nov 25: three pnpm self-install loops (two machine crashes, one caught live at 399 node processes and 23 GB), all from a pnpm that differed from the pin running with HOME moved to an empty folder inside a worktree (ops, t2)'
  target: 0
  after_days: 14
ratchet-release: []
field-changes: []
---

`managePackageManagerVersions: false` in `pnpm-workspace.yaml`. pnpm 10 switches itself to the `packageManager` pin by
default, keeping the pinned version under its home; with HOME moved to an empty folder inside a worktree it fetched
the pin again in a child that did the same, without end. With switching off, the pnpm on PATH runs and no switch is
attempted, whatever HOME is. Checked Nov 25: `pnpm --version` prints 10.33.0 (Homebrew, PATH) with the setting and
10.28.2 (switched) without it.

CI is unchanged: `pnpm/action-setup` installs exactly the pinned version from `packageManager`. Locally the PATH pnpm
runs; a non-frozen install with a newer pnpm may rewrite `pnpm-lock.yaml` metadata, so local installs stay
`--frozen-lockfile`. Revert if a lockfile churn or a pnpm-version-specific failure appears locally.
