---
id: 261002-161720
title: The desktop build gets a heap ceiling its Vite builds fit under
kind: incident-fix
status: proposed
actor: agent
gates:
  - wf.desktop-smoke.packaged-runtime
  - wf.desktop-release.build-macos
  - wf.desktop-release.build-windows
prs: []
hypothesis:
  metric: 'gate.wf.desktop-smoke.packaged-runtime.failure_rate'
  baseline: 0.274
  baseline_source: 'origin/ci-steward-data snapshots/2026-09-29.json, 2026-09-30.json, 2026-10-01.json, gate wf.desktop-smoke.packaged-runtime: @push 27 failure / 98 decided, @pull_request 7 failure / 26 decided (34 / 124). snapshots/2026-09-27.json had 0 failures in 34 push runs. Every push failure since 2026-09-28 read by hand (30 runs): all are "JavaScript heap out of memory" in @dorkos/desktop#build or @dorkos/client#build'
  target: 0.03
  after_days: 14
ratchet-release: []
field-changes: []
---

Desktop Smoke on `main` went from 0 failures in 34 runs on 2026-09-27 to failing about one run in
four from 2026-09-29. Every failure read (30 of them) is the same: a Node process inside
`turbo build --filter=@dorkos/desktop` dies with "Ineffective mark-compacts near heap limit", at
about 1.95 to 2.0 GB of heap. Two processes do it: `@dorkos/client`'s `vite build` and the desktop
renderer's `electron-vite build`, which builds the same client source a second time. The runner
(`macos-latest`, arm64, 7 GB) gets a default Node heap ceiling of about 2 GB, sized from its RAM.

Measured locally on 2026-10-02 with an uncapped heap: the client's Vite build peaks at 2242 MB of
live heap and the renderer build at 2554 MB. The renderer build fails every time at a 2000 MB
ceiling and passes at 2500 MB, so the intermittency on CI is GC timing near the edge. What grew is
the client's main chunk: 4.40 MB on 2026-09-21, 4.76 MB on 09-28, 4.91 MB on 10-02 (9.5 MB to
10.6 MB in the renderer's copy).

Measured on the runner itself, in two `workflow_dispatch` runs of this change with a heap probe
(37033025428, 37033038836, both green): the client's Vite build peaked at 2331 and 2232 MB of
heap, the renderer build at 2087 and 2129 MB, both above the ~2 GB default and well under 4096.

The change sets `NODE_OPTIONS=--max-old-space-size=4096` on the build step in `desktop-smoke.yml`
and on both build steps in `desktop-release.yml`, where the macOS job builds the same graph on the
same runner. Turbo passes `NODE_OPTIONS` through to its tasks (checked: a task saw the raised
limit). 4096 is about 1.6x the measured peak. The heaviest overlap in the job is the client's
Vite build beside the server's `tsc` (about 3.1 GB and 2.4 GB resident), which fits in 7 GB.

Not done: dropping the client's own build from this job. The desktop renderer does not use
`apps/client/dist`, so that build is redundant here, but it comes in through the
`@dorkos/client` devDependency that also pulls the client's workspace dependencies into the graph.
Worth a separate change if the job's memory or duration becomes the constraint.

Revert or revisit if a heap OOM returns in this job (look at the client's chunk sizes before
raising the number again), or if the job starts failing from system memory pressure instead.
