---
id: 261002-185940
title: check-copy-length.ts reports in-app copy blocks over the length cap
kind: hygiene
status: proposed
actor: agent
gates: [wf.typecheck.typecheck]
prs: []
ratchet-release: []
field-changes: []
---

The app-copy standard set on 2026-10-02 (the `writing-app-copy` skill) caps one block of in-app
copy at 15 words: three or fewer preferred, six or fewer good, seven to fifteen flagged, sixteen
or more never. Measured the same day, `apps/client/src` held 4,741 blocks: 214 at sixteen words or
more, 643 at seven to fifteen, the longest at 82.

`scripts/check-copy-length.ts` measures every block, reusing `check-vocab-gate.ts`'s copy-position
classifier and file walk, and joins JSX text split by an interpolation so a sentence with a name
in it counts as one block. It rides the `typecheck` job next to the vocab gate, for the same
reason that gate does: `typecheck` is required, unfiltered and reports on `merge_group`.

It landed with `--report-only`, so it printed the offenders and always exited 0. The app-wide
copy sweep (seven PRs, #2481 to #2489 and the last wave) brought every block under the cap, and
its last PR dropped the flag, which turned it into a gate. The step adds a few seconds of TypeScript parsing to a job that already installs
everything it needs.

Revert or revisit if the step's duration becomes noticeable in `typecheck`, or if its idea of a
block starts producing false errors people work around instead of fixing.
