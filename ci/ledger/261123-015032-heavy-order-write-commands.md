---
id: 261123-015032
title: The committed order line takes its write commands, so the coordinator's script can be retired
kind: hygiene
status: proposed
actor: agent
gates: [wf.scripts-test.fixtures]
prs: []
ratchet-release: []
field-changes: []
---

DOR-5079. The coordinator's own order script (`.temp/coord/heavy.sh`) answered
the two hand rewrites of 2026-11-22, which silently dropped other chats' queued
labels, with write commands: `--list`, `--insert`, `--move`, `--remove
--reason` and a logged `--done`. The committed line
(`scripts/heavy-run-lock.sh`, `scripts/lib/heavy-order.sh`) took only `--done`
and `--status`, so that script could not be retired (DOR-5073 brought over the
start rule only).

They now live in `scripts/lib/heavy-order-write.sh`, with the same command
names, output and write exit codes (the environment names carry the `DORKOS_`
prefix, and a refused run still exits 75, not the old script's 1): 0 ok, 2
refused, 3 the verify refused the write (the new
labels must be exactly the old ones minus what the command removes plus what it
adds), 4 the lock was not had within `DORKOS_HEAVY_ORDER_LOCK_WAIT` (30 s).
Every managed write, the run path's own leaving and stale moves included, keeps
`heavy-order.sum` in step and appends to `heavy-order.log`, so a hand edit is
named out loud. Writes and the run path share one lock: a kernel `flock` on
the order folder's `heavy-order.lock`, the file name and the kind of lock the
coordinator's script uses in its own folder. It replaces the old `heavy-order.lock.d` folder lock,
which took over any lock older than 30 s with no owner check, so two waiting
writers could both get in and lose a write (DOR-5082). The kernel drops a
flock the moment its holder dies, so there is nothing to take over.

Hygiene rather than an experiment: no gate's pass or fail, duration or retries
change. The gate listed is the fixture job that runs
`scripts/test-heavy-run-lock.sh`, which gains the cases, including a slow
write that keeps two waiting writers out and a SIGKILLed holder that frees the
lock at once. A side-by-side run of
both scripts over one order file gave the same output, exit codes, final file
and log for 21 commands; the only difference is the usage line, since the
committed run form is `--label <label> <command>`.
