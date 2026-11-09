---
id: 261109-060757
title: 'Desktop Release fetches the icons toolset itself, and can re-run an existing tag'
kind: incident-fix
status: proposed
actor: agent
gates:
  - wf.desktop-release.build-macos
  - wf.desktop-release.build-windows
prs: []
hypothesis:
  metric: 'gate.wf.desktop-release.build-macos.failure_rate'
  baseline: 0.067
  baseline_source: 'gh run list --workflow desktop-release.yml: the 15 tag pushes v0.126.1..v0.135.0 (2026-10-27..11-09), 1 failure (v0.135.0, the icons toolset download answering 504), 14 success'
  target: 0
  after_days: 28
ratchet-release: []
field-changes: []
---

Desktop Release v0.135.0 failed while packaging. electron-builder 26.17.0 downloads its icon
toolset (`icons@1.2.3/icons-bundle.tar.gz` from `electron-userland/electron-builder-binaries`)
through the plain GitHub release download URL, and that URL answered 504 for the whole run. The
same asset downloads fine through the API (`gh release download`), and its SHA-256 matches the
one electron-builder pins (`4e5bb546…66f9`, in `app-builder-lib/out/toolsets/icons.js`).

What changed, in both build jobs: a step before packaging downloads the asset with `gh release
download` into `$RUNNER_TEMP`, checks its SHA-256 against the pin written in the workflow before
extracting, and points electron-builder at the result through `ELECTRON_BUILDER_ICONS_TOOLSET_DIR`,
which `icons.js` reads before it would download anything. The step also checks the installed
electron-builder still pins the same release and hash, so a version bump fails loudly here
instead of packaging with an old toolset.

Second change: a `workflow_dispatch` input `tag`. A re-run of a tag-push run uses the tag's own
copy of the workflow, so this fix could never reach v0.135.0, and the tag cannot move because npm
already has 0.135.0. With `tag` set, both jobs first check the input (exactly `vX.Y.Z`, an existing
tag, its commit already on `main`, a draft Release for it), then build that tag's code with
`main`'s workflow and attach to the draft. That path is stricter than a tag push: it never
replaces an asset (no `--clobber`) and never publishes; a person publishes the draft by hand.
Checkout no longer keeps the token in the git config (`persist-credentials: false`); every `gh`
call names the repo instead.

Revert or revisit if the toolset step fails while electron-builder's own download works, or if
the stale-pin check fires on a version bump (update the pin in both jobs). One failure in 15 is
a small baseline; the real test is the next tag push and the v0.135.0 re-run.
