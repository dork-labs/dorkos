---
id: 261125-150319
title: The guard refuses a package manager with its home moved, even inside the load gate
kind: incident-fix
status: proposed
actor: agent
gates: []
prs: []
hypothesis:
  metric: tracked.machine-load
  baseline: null
  baseline_source: 'Nov 25: ops (t2) caught a third pnpm fork bomb live (399 node processes, 23 GB in about a minute) from HOME=<empty dir inside a worktree> pnpm vitest run; the same shape was in flight before both morning crashes'
  target: 0
  after_days: 14
ratchet-release: []
field-changes: []
---

PATH's pnpm (Homebrew 10.33.0) differs from the repo's `packageManager` pin (pnpm@10.28.2), so pnpm switches to the
pinned version it manages under its home. With `HOME` moved to an empty folder inside a worktree it cannot find that
install, runs `pnpm add pnpm@10.28.2` to fetch it, and the child sees the same pin and the same empty home and does it
again, without end. The guard now refuses pnpm, npx, npm, yarn and corepack when `HOME`, `PNPM_HOME`, `XDG_*` or
`COREPACK_HOME` is set on the same command line (inline, through `env`, or `export`ed earlier) or the environment is
cleared (`env -i`, `env -u`), inside `pnpm heavy` too. Text-only, like the rest of the guard. The root fix (no
self-switching at all) is separate; this is the guard's half.
