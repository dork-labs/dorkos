---
id: 260928-131854
title: Pin the machine-wide Docker orphan sweep's keep side in the fixtures job
kind: hygiene
status: active
actor: agent
gates:
  - wf.scripts-test.fixtures
prs: []
ratchet-release: []
field-changes: []
---

On 2026-09-28 the operator's Mac filled to 3.8 GB free and Docker froze: 1,223
anonymous volumes (147 GB) and about 21 GB of build cache. The volumes came from
agents' throwaway postgres and minio containers, whose images declare a VOLUME,
so a `docker run` without `--rm`, or a container removed without `-v`, leaves an
anonymous volume nothing will mount again. `scripts/sweep-ephemeral-docker.sh`
(ledger 260921-051500) cannot see them: it only reclaims objects stamped with
its own label.

`scripts/sweep-docker-orphans.sh` is the machine-wide backstop, meant to be run
nightly by the operator (a launchd template ships beside it; nothing installs
it). No gate runs the sweep itself. This entry adds one step to the required
`fixtures` job, `bash scripts/test-sweep-docker-orphans.sh`, and the matching
link in `test:scripts` that the shell-suite parity test demands.

Why a delete-side script earns a fixtures step: it runs on shared developer
machines where other agents' live test databases sit in the same Docker, so its
keep side is the part that must never regress. The fixtures pin that named
volumes, volumes a stopped container still mounts, young volumes, unreadable or
offset-bearing dates, and a container that starts mid-sweep are all kept, each
with a positive control, and that `--dry-run` calls nothing that mutates.

No required check, deadline, shard, retry or coverage rule changes. The step is
hermetic (a stub `docker` on PATH, no daemon; the runner's real docker is never
reachable, which an adversarial review caught in the first draft's no-docker
case) and adds about fifteen seconds to a job that already runs every shell
suite, four of them deliberate retry and timeout waits. Revert by removing the
step and the `test:scripts` link together.
