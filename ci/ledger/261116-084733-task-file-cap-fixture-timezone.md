---
id: 261116-084733
title: Give the file-cap dispatch fixture an explicit UTC schedule
kind: hygiene
status: proposed
actor: agent
gates: []
prs: []
ratchet-release: []
field-changes: []
---

The file-cap fixture creates its 03:00 schedule explicitly in UTC (DOR-4529),
matching the fixed UTC occurrence it dispatches. New schedules now inherit the
person's time zone when none is supplied. Under UTC+3, the fixture's old fire
was three hours late, so the real scheduler correctly skipped it before any
runtime turn. The four cap checks then failed at their send-message assertion.

The fixture now also requires a completed run and exactly one runtime turn.
A skipped run reports its stored reason directly. All existing cap and
provenance checks still run through the real scheduled dispatch.

This is test hygiene, with no aggregate speed or flake claim. Production clocks,
time-zone defaults, stale-run policy, permission caps and test budgets stay the
same. Removing the explicit zone must reproduce the four stale skips; breaking
dispatch must still fail those four cases. Revert if either control passes or
the fixture stops exercising its real scheduled turn.
