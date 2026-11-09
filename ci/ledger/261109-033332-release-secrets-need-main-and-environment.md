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
  fails a tag whose commit is not on main. It is a backstop: a pushed tag runs
  its own commit's copy of the workflow, so it can delete the check.
- The real locks are the environments. `release` (signing; Dorian approves;
  `v*` tags and `release/*` branches): desktop `build-macos`.
  `release-publish` (Docker Hub and the Homebrew tap; Dorian approves; `v*`
  tags only): docker `mirror-docker-hub`, homebrew `update-formula`.
  `automation` (the merge-tail App key and the Neon key; `main` only):
  merge-tail `arm`, the queue guard, the Dependabot lockfile repair and the
  Neon sweep.
- Desktop signs only on a `v*` tag or a `release/*` branch; a `sign` input can
  only turn it off. Any other run builds unsigned, names no environment and
  publishes nothing: the lane test path.
- `publish-docker` refuses any run that is not on a `v*` tag, manual runs
  included.
- `queue-repeat-guard` moves from `merge_group` (the pull request's own copy of
  the workflow) to `workflow_run` on changelog-fragment-check (main's copy), so
  it can enter `automation`. It checks out main only and validates the queue
  ref before use.
- `dependabot-lockfile-repair` refuses unless Dependabot both opened and pushed
  the PR and it changes only package.json files and the lockfile; pins pnpm;
  skips the pnpmfile; keeps no credential in the checkout; and mints the App
  token only after pnpm has exited.
- The daily collector goes red when a listed secret is back at repository
  level, or an environment is gone, loses its reviewer, or deploys any ref but
  its own (`secret_environments` in `ci/config.yaml`). A token that may not
  read them is a warning: CI's own token cannot list repository secrets.

This is a hygiene change: it claims no speed or flake improvement, and no
required check changes. The queue guard fires seconds later than before, which
is the one timing change. Revert an environment line only if a stronger lock
replaces it; never revert the main check alone.
