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

- Each of the four release workflows starts with a `tag-is-on-main` job that
  every other job needs. It fetches only main's commit graph, anonymously, and
  fails a commit that is not on main, with no exception. It is a backstop: a
  pushed tag runs its own commit's copy of the workflow, so it can delete the
  check.
- The environments hold the secrets. `release` (signing; Dorian approves;
  `v*` tags and `main`): desktop `build-macos`.
  `release-publish` (Docker Hub and the Homebrew tap; Dorian approves; `v*`
  tags only): docker `mirror-docker-hub`, homebrew `update-formula`.
  `automation` (the merge-tail App key and the Neon key; `main` only):
  merge-tail `arm`, the queue guard, the Dependabot lockfile repair and the
  Neon sweep.
- Desktop signs only on a `v*` tag or `main`; a `sign` input can only turn it
  off. The signing job runs the commit's own code (`pnpm install`,
  electron-builder), so only code on main may reach the certificate. Against
  an agent that holds Dorian's token, that and the branch rules are the bound;
  the approval click stops lanes and accidents.
- A version taken from a tag or an input must be a plain release version
  (X.Y.Z or X.Y.Z-pre) before any step uses it, and later steps read it from
  `env:`, never from an expression inside a script (publish-docker,
  update-homebrew).
- Publishing is gated in structure: in the four release workflows, every job
  that names `release-publish` or holds `contents: write`/`packages: write`
  has a job-level `if:` opening with `startsWith(github.ref, 'refs/tags/v')`,
  and the census's new `tag-gate` check (`tag_gate` in `ci/config.yaml`)
  refuses one that does not. Desktop's builds drop to `contents: read`, and a
  new tag-only `publish` job attaches and publishes. That adds back one ubuntu
  runner assignment per release, the risk DOR-2728 removed.
- `publish-docker` refuses any run that is not on a `v*` tag, manual runs
  included.
- `update-homebrew` drops `release: published`, which never fired (the release
  is published with GITHUB_TOKEN, which starts no workflow), so each release
  asks for one Homebrew approval, not two.
- `queue-repeat-guard` moves from `merge_group` (the pull request's own copy of
  the workflow) to `workflow_run` on changelog-fragment-check (main's copy), so
  it can enter `automation`. It checks out main only and validates the queue
  ref before use.
- `dependabot-lockfile-repair` refuses unless Dependabot both opened and pushed
  the PR and it changes only package.json files and the lockfile; pins pnpm;
  skips the pnpmfile; keeps no credential in the checkout; and mints the App
  token only after pnpm has exited.
- The daily collector goes red when a listed secret is back at repository
  level, or an environment is gone, no longer requires its named reviewer, or
  deploys any ref but its own (`secret_environments` in `ci/config.yaml`). A
  token that may not read them is a warning: CI's own token cannot list
  repository secrets.

This is a hygiene change: it claims no speed or flake improvement, and no
required check changes. The queue guard fires seconds later than before, which
is the one timing change. Revert an environment line only if a stronger lock
replaces it; never revert the main check alone.
