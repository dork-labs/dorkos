---
id: 261125-144759
title: The heavy-command guard sends package scripts, tsc, wide vitest runs and raised heaps through the load gate
kind: incident-fix
status: proposed
actor: agent
gates: []
prs: []
hypothesis:
  metric: tracked.machine-load
  baseline: null
  baseline_source: 'Nov 25: kernel panic 06:45 and hang 07:08 on an exhausted memory compressor and swap; transcripts of the previous 24 h show about 600 typechecks and 2,200 vitest runs outside the gate (ops session t2)'
  target: 0
  after_days: 14
ratchet-release: []
field-changes: []
---

The guard knew only root scripts, turbo and a vitest with no path. It now also refuses, unless run through `pnpm heavy`:
a package's own heavy script (`--filter`, `-F`, `-C`/`--dir`, `-r`, `npm --workspace`, `yarn workspace`, or after `cd
apps/…`/`packages/…` or with the hook's cwd there), the root `lint`/`lint:fix` (raw turbo lint), `tsc` in any spelling,
vitest given a directory, a name filter, more than three test files or paths from `xargs`, and a raised Node heap. The
gated path, including a raised heap inside it, still passes.

Measured through the gate (Nov 25): the server's full `tsc --noEmit` peaks at 6.7 GB resident and 7.0 GB footprint with
an 8 GB heap, and runs out of memory at about 4.5 GB at Node's default heap. Revert or loosen if agents route around the
guard in a new spelling; the target is zero machine crashes from load in 14 days.
