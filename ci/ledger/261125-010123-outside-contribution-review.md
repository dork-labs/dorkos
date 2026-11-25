---
id: 261125-010123
title: An outside contribution that changes workflows, scripts, manifests or lockfiles needs Security's signed review
kind: hygiene
status: proposed
actor: agent
gates:
  - wf.pr-gates.pr-gates
prs: []
ratchet-release: []
field-changes: []
---

Review policy for outside contributions, agreed with Security. `pr-gates` accepts Security's signed
review marker or the cloud `security-verdict` as Security's sign-off. For a pull request from another
repository that changes workflows, scripts, package manifests or lockfiles, only the signed review
counts now; the red check names `outside-contribution-needs-signed-review` and lists the paths.
Pull requests from this repository, and outside ones that change none of those paths, are unchanged.

The paths are `OUTSIDE_REVIEW_PATHS` in `scripts/pr-gates-check.sh`: `.github/`, `tools/`,
`.claude/`, `ci/`, `patches/`, `packages/ci-steward/`, any `scripts/` directory, and at any depth
`package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `.npmrc`, `.pnpmfile.cjs`, `lefthook.yml`,
`turbo.json` and `Dockerfile*`; also `docker/`, and the desktop packaging inputs that
`desktop-release.yml` builds and signs with (`apps/desktop/build/`, `apps/desktop/electron-builder.*`,
`apps/desktop/electron.vite.config.*`). Names match without regard to case, and a rename counts
under its old and new name. The check reads the whole paginated
file list, and stays red (exit 2) when it cannot tell which repository the PR comes from or when the
file list is incomplete. `scripts/test-pr-gates-check.sh` covers each path, renames, a second page
of files, and same-repository PRs.

Baseline: either sign-off counted for every PR. Target: every outside contribution that changes
these paths merges with a signed review, and no same-repository PR's `pr-gates` result changes.
Evaluate 2026-12-08 from `pr-gates` runs. Revert if a same-repository PR is ever held by this reason.
