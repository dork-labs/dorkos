---
id: 261109-033332
title: Release workflows publish only from main, and every secret lives in an environment
kind: hygiene
status: proposed
actor: agent
gates: []
prs: []
ratchet-release: []
field-changes: []
---

DOR-4030. Four release workflows (`desktop-release`, `publish-docker`,
`publish-community`, `update-homebrew`) published on any pushed `v*` tag, from
any commit, and every secret sat at repository level, where any branch's
workflow could read it. Security placed each secret in an environment (Nov 9);
this wires the workflows to them. A person creates the environments first.

What changed:

- Every job that holds an environment secret runs only as main's own copy of
  its workflow, started by hand on main (Security M1, Nov 19; round 3 the same
  day). On a tag push, or a run on any other ref, GitHub runs that ref's copy
  of the file, which an unreviewed tag could have edited to skip every check.
  `desktop-release`, `publish-docker` and `update-homebrew` publish only that
  way. `publish-community` holds no environment secret and still publishes on
  the `v*` tag push (Security ruling, round 3): the launcher trusts its
  release's own tag, and moving that identity to main is its own later PR.
  `release` and `release-mirrors` now deploy `main` only, like `automation`.
- `desktop-release` has no tag-push trigger. A run on main with `tag: vX.Y.Z`
  peels the tag, checks its commit with main's `scripts/ci/tag-is-on-main.sh`
  (on main, or the run-time tip of `release/vX.Y.Z` passing main's
  release-branch check), builds and signs exactly that commit, and `publish`
  re-checks the tag still names it before attaching and publishing. `tag`
  empty is a rehearsal of main that publishes nothing.
- `publish-docker` has no tag-push trigger either (round 3). One run on main
  with `tag` checks the tag's commit the same way and builds exactly that
  commit: it pushes both GHCR images, then `mirror-docker-hub` copies the
  runtime image that same run pushed to Docker Hub BY DIGEST (a job output),
  never by a tag name, with no third-party action. `update-homebrew` is
  main-dispatch only, with `tag`. Step outputs reach scripts through `env:`.
- `publish-community` keeps its tag-push trigger: main's
  `scripts/ci/tag-is-on-main.sh` checks the tagged commit, and each job's first
  step refuses anything but a strict `vX.Y.Z` tag push. Both are defense in
  depth, since a tag push runs the tag's own copy of the file; that is why it
  holds no environment secret, only GITHUB_TOKEN.
- Not closed here (predates this change; follow-up DOR-4795): GHCR packages
  are not locked to these workflows, so any run whose GITHUB_TOKEN may write
  packages can still push to them.
- Each main-dispatch publishing job opens with a step refusing any run but
  `GITHUB_REF` main, `workflow_dispatch`, and `GITHUB_WORKFLOW_REF` naming its
  own file on main. That and the census are defense in depth; the lock is the
  environments' reviewer (DOR-4036) and the tag and release-branch rulesets.
- The census's `tag-gate` check (`tag_gate` in `ci/config.yaml`) refuses a job
  naming `release` or `release-mirrors` (or an environment expression) unless
  its `if:` opens with the main-dispatch condition and its first step is that
  refusal; a tag is never a way into those. A job with `contents: write` or
  `packages: write` and no secret environment must open its `if:` with the
  `v*` tag condition or the main-dispatch condition, and on the dispatch carry
  the same first-step refusal.
- New census checks (`environment-jobs`): every `uses:` in a job naming any
  environment is pinned to a commit SHA, with no exception list
  (`actions/create-github-app-token` is pinned to v3.4.0,
  `f418cff399f7aef4c2f0ad47e25ca7a6abbdd6fc`, in all four workflows), and a
  job that reads an environment's secret must name that environment.
- `queue-repeat-guard` and `arm-door` move from `merge_group` (the pull
  request's own copy of the workflow) to `workflow_run` on
  changelog-fragment-check (main's copy), so they can enter `automation`.
  Both check out main only and validate the queue ref before use. `arm-door`
  goes red when it cannot mint the App token, since without it the label gate
  would be off.
- A version taken from a tag or an input must be a plain release version
  before any step uses it, and later steps read it from `env:`, never from an
  expression inside a script.
- `dependabot-lockfile-repair` refuses unless Dependabot both opened and pushed
  the PR and it changes only package.json files and the lockfile; pins pnpm;
  skips the pnpmfile; keeps no credential in the checkout; and mints the App
  token only after pnpm has exited.
- The daily collector goes red when an environment is gone, lets admins
  bypass it (on all three), deploys any ref but its own, needs any reviewer
  list but exactly its configured one (none, for `automation`), or has
  "Prevent self-review" set other than its configured `prevent_self_review`
  (`secret_environments` in `ci/config.yaml`). That is false on all three for
  the pilot, since the only reviewer also starts the runs, and becomes true on
  `release` and `release-mirrors` once DOR-4036's approver account is the
  reviewer. A token that may not read an environment is red: nobody checked.
- It also goes red when a listed secret is back at repository level, but that
  read needs Secrets: read, which the collector is deliberately not given
  (PM, round 3). Without it the check is reported as not checked, a warning
  that names Security as its owner, never red and never a pass.

This is a hygiene change: it claims no speed or flake improvement, and no
required check changes. The queue guard and the arm door fire seconds later
than before, which is the one timing change. Releases now need three manual
runs on main (desktop-release, publish-docker, update-homebrew), each step
that holds a secret behind an approval; the Community image still publishes
on the tag push. Revert
an environment line only if a stronger lock replaces it; never revert the main
check alone.
