---
id: 261108-105818
title: pnpm install no longer downloads the ffmpeg binary; capture fetches it on first use
kind: hygiene
status: proposed
actor: agent
gates: []
prs: []
ratchet-release: []
field-changes: []
---

On 2026-11-08 GitHub releases answered 504 for `ffmpeg-static`'s
`ffmpeg-linux-x64.gz` on and off for over two hours. That package's install
script downloads the binary and exits non-zero on any non-200, so every CI job's
`pnpm install --frozen-lockfile` failed with it: test, browser-test,
credential-free-build, openapi-fresh, harness-windows. It ejected #3538, #3501
and #3487 from the merge queue several times (DOR-3954).

Only the capture pipeline (`apps/e2e/capture/optimize.ts`) runs ffmpeg, and no CI
workflow runs capture. So `ffmpeg-static` moves from `onlyBuiltDependencies` to
`ignoredBuiltDependencies`: no install anywhere runs its download. Capture runs
the package's own `install.js` on first use, with one retry, so the release tag
and the `FFMPEG_BINARIES_URL` mirror override behave as before.

Hypothesis: no CI install fails on a GitHub releases outage for ffmpeg again, and
installs get slightly faster. Nothing else measurable should move. Revert if a CI
job starts needing ffmpeg; it should then fetch it on demand the way capture
does, rather than put the download back into every install.
