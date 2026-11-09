---
id: 261109-033332
title: Release workflows publish only from main, and release secrets need the release environment
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
any commit, and the release secrets sat at repository level where any branch's
workflow could read them.

What changed:

- Each of the four starts with a `tag-is-on-main` job that every other job
  needs. It fetches only main's commit graph, anonymously, and fails unless the
  run's commit is on main. It is a backstop: a pushed tag runs its own commit's
  copy of the workflow, so it can delete the check.
- The real lock is the `release` environment (a required reviewer, `v*` tags
  only), which a person creates by hand before this merges. The three jobs that
  use release secrets name it: desktop `build-macos` (signing, notarization),
  docker `mirror-docker-hub` and homebrew `update-formula` (tap push).
- A manual `publish-docker` run on any ref but main is refused.
- `desktop-release` gains a `sign` input (default on). Off, it builds an
  unsigned app from any ref, names no environment and publishes nothing: the
  lane test path.
- The daily collector goes red when a release secret name is back at
  repository level, or the environment loses its reviewer or its `v*` tag
  policy (`release_environment` in `ci/config.yaml`). A token that may not read
  them is a warning: CI's own token cannot list repository secrets.

This is a hygiene change: it claims no speed or flake improvement, and no
required check changes. Revert the environment lines only if the environment
itself is replaced by a stronger lock; never revert the main check alone.
