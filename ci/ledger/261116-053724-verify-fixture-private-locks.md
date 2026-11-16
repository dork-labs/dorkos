---
id: 261116-053724
title: Isolate verify scheduling fixture lock files
kind: hygiene
status: proposed
actor: agent
gates: []
prs: []
ratchet-release: []
field-changes: []
---

The verify scheduling fixture now gives its real heavy-run wrappers a lock
directory inside its owned temporary directory (DOR-4525). Its commands are stubs,
so waiting behind unrelated host jobs adds no protection and can exhaust the
existing five-second test budget before the captured Turbo calls are asserted.

The real shell, wrappers and Perl locks still run. Production commands, host slot
limits, scheduling assertions and test budgets are unchanged. Disposable controls
hold an owned fake-host slot to reproduce the old timeout and prove the isolated
fixture finishes while that slot stays held; a direct wrapper control still queues.

This is test-fixture hygiene, with no aggregate CI speed or flake claim. Revert if
the fixture stops checking the real verify commands or touches shared host slots.

Main integration at d9993507b247c84825d407e5621b1728b60fb965 also changes this
fixture to disable the heavy lock and allow 30 seconds (DOR-4456). Retain the
stronger private-directory isolation here: real wrappers/Perl locks and the
original five-second case. Main's separate 8 GiB verify typecheck heap remains
unchanged. Repeat the seven command assertions and owned held-slot/concurrency
controls against the integrated actual command; do not occupy real host slots.
