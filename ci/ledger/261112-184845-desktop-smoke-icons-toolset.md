---
id: 261112-184845
title: 'Desktop Smoke fetches the icons toolset itself, like Desktop Release'
kind: incident-fix
status: proposed
actor: agent
gates:
  - wf.desktop-smoke.packaged-runtime
prs: []
hypothesis:
  metric: 'gate.wf.desktop-smoke.packaged-runtime.failure_rate'
  baseline: 0.0226
  baseline_source: 'gh run list --workflow desktop-smoke.yml --branch main --event push --created 2026-10-29..2026-11-12: 6 failure, 259 success, 19 cancelled (6/265). 4 of the 6 are the 2026-11-08 electron-builder 504 (QA shared-cause report, cluster C1, logs/128994302057.log:1590-1591).'
  target: 0.008
  after_days: 28
ratchet-release: []
field-changes: []
---

On 2026-11-08 `packaged-runtime` failed 6 times (4 on main) with electron-builder's
`Response code 504 (Gateway Time-out) failedTask=build`, right after `downloaded label=electron`.
The same electron-builder 26.17.0 hit the same 504 that day in Desktop Release v0.135.0 while
downloading its icons toolset (`icons@1.2.3/icons-bundle.tar.gz`) through the plain GitHub release
download URL; entry 261109-060757 / #3582 fixed it there only. electron-builder does not log the
URL, so attributing the smoke failures to the icons toolset is inference from the same version,
the same day and the same point in packaging.

What changed: `desktop-smoke.yml` gets #3582's "Fetch the icons toolset" step unchanged, before
`Package the app`: `gh release download` through the API into `$RUNNER_TEMP`, the SHA-256 pin
checked before extracting, the installed electron-builder checked to still pin the same release
and hash, and `ELECTRON_BUILDER_ICONS_TOOLSET_DIR` pointed at the result. It uses the job's
existing `GITHUB_TOKEN` (`contents: read`); no new secret or permission. The workflow's four
actions are also pinned by full commit SHA, to the same SHAs already used in
community-two-desktop.yml.

Revert or revisit if the step fails while electron-builder's own download works, if
`packaged-runtime` still fails with a 504 after `downloaded label=electron` (then the URL was
another asset, and it needs its own prefetch), or if the stale-pin check fires on an
electron-builder bump (update the pin here and in both desktop-release.yml jobs).
