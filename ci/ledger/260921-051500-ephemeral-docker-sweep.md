---
id: 260921-051500
title: Sweep the Docker objects killed runs leave behind
kind: hygiene
status: active
actor: agent
gates:
  - wf.scripts-test.fixtures
  - wf.test.community-packaged
prs: []
ratchet-release: []
field-changes: []
---

Measured on this machine on 2026-09-21: 1,029 Docker volumes holding 110.6 GB,
against 4 volumes and 172 MB after a manual prune. Docker's total footprint was
163 GB. The volumes are anonymous Postgres data directories, one per run of
`apps/community/acceptance/run.sh`, which starts a detached `postgres:17-alpine`
container and removes it with `docker rm -fv` from a `trap ... EXIT`.

The cleanup is correct and cannot work here. `trap ... EXIT` does not run when
the shell is SIGKILLed, and this machine SIGKILLs routinely: memory pressure
under many concurrent agents, the pre-push watchdog, agent reaping. A detached
container also outlives whatever started it, so a killed run left both a live
container and a full data directory. 1,029 volumes is roughly 1,029 runs that did
not exit cleanly.

The change stamps every container, volume and network the script creates with the
creating pid, that pid's start time and a creation timestamp, and sweeps labelled
leftovers at the start of the next run
(`scripts/sweep-ephemeral-docker.sh`). A later run is the only actor that can
clean up after a kill. Ownership decides, not age: a dead owner's objects are
reclaimed however young, a live owner's are left however old, and age is the
fallback only where ownership is unknowable (an object from another Docker
context has no local process to ask). The start time is what makes the pid
trustworthy, since pids are recycled. The script also now creates a NAMED volume
for the data directory: the postgres image declares a `VOLUME` there, and an
anonymous volume carries no labels, so it could never be swept by owner.

Age alone was the first proposal and was wrong in both directions. It waits out
the floor before reclaiming a plainly dead run, and it eventually kills a slow
live one. The operator caught the second half.

The hypothesis is that orphaned ephemeral objects stop accumulating: with the
sweep in place, `docker volume ls -q --filter label=dorkos.ephemeral` should be
empty whenever no acceptance run is in flight, and total Docker disk should stay
flat across a week of normal agent activity rather than ratcheting. Measure by
reading `docker system df` on 2026-09-28; a reclaimed-to-163 GB footprint is a
failed experiment.

No required check, deadline, shard, retry or coverage rule changes. The sweep
never fails its caller: a missing daemon exits clean, because whoever called it
is about to need Docker and will report its absence far better.

This gate script's failure mode is deletion, not omission, so the fixtures
(`scripts/test-sweep-ephemeral-docker.sh`, stubbed docker, no daemon) pin the
keep side as hard as the sweep side: a live owner's objects survive, a recycled
pid does not inherit a dead run's, and anything Docker will not describe is kept.
The stub models the label path per object kind, because containers keep labels
under `.Config.Labels` while volumes and networks keep them at the top level, and
reading the wrong one makes every object look unstamped — which the age fallback
would turn into "delete everything". That bug existed in the first draft and was
caught by a real-Docker smoke, not by the fixtures; modelling the path is what
makes the fixtures able to catch it next time.

Revert by removing the sweep call and the label arguments from
`apps/community/acceptance/run.sh`. The labels are inert on their own.
