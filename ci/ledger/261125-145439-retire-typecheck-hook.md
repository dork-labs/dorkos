---
id: 261125-145439
title: The per-edit typecheck hook is retired
kind: incident-fix
status: proposed
actor: agent
gates: []
prs: []
hypothesis:
  metric: tracked.machine-load
  baseline: null
  baseline_source: "Nov 25, measured through the load gate: the hook's exact command (apps/server tsc --noEmit --incremental at the default heap) ran out of memory both times, at 4.49 GB after ~30 s, and never wrote its tsbuildinfo; ~280 apps/server .ts edits fired it in the previous 24 h"
  target: 0
  after_days: 14
ratchet-release: []
field-changes: []
---

`.claude/hooks/typecheck-changed.sh` ran a whole-package `tsc --noEmit --incremental` after every `.ts` edit, in every
repo-homed session and helper, outside the load gate. On apps/server it needs about 7 GB (the gated full typecheck
peaks at 6.7 GB resident with an 8 GB heap) and ran out of memory at Node's default heap on every edit, so it returned a
crash dump as "TypeScript errors" and its incremental cache never existed. The Mac crashed twice on memory the same
morning.

Removed from `.claude/settings.json` and deleted. Live sessions keep the hook list they read at start, so
`in-project.sh` (read from the session's project root on every call) also refuses to run it: it stops in every session
started in a checkout that has this change. Type errors are still caught by the required `typecheck` check on every PR,
and `pnpm heavy pnpm --filter <pkg> typecheck` checks one package locally, in the gate. Bring a per-edit check back only
if it is cheap enough to run per edit (measure it first).
