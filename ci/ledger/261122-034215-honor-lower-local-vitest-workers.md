---
id: 261122-034215
title: Honor a smaller requested worker pool during local verification
kind: hygiene
status: proposed
actor: agent
gates: []
prs: []
ratchet-release: []
field-changes: []
---

DOR-5020 restores `VITEST_MAX_WORKERS=2 pnpm verify`, which DOR-1918
documented for a shared machine. The root scripts later began exporting four before launching Turbo,
overwriting that request even though Turbo still forwards the variable.
Vitest 4.1.11 resolved four with a caller limit of two. The isolated
regression covers the actual shell assignment in all three root commands.

A caller can now lower the local limit to one, two or three. The default
stays four. CI still clears the variable at the Turbo entry points and
leaves worker selection to Vitest. Direct, targeted Vitest runs still accept
larger explicit values, as described in the root Vitest config.
The steward has no metric for worker counts in manually capped local runs,
and no change to a hosted gate or its SLO is expected.
