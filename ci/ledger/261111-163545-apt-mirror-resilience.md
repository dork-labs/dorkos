---
id: 261111-163545
title: CI archive checks use installed readers without Ubuntu mirrors
kind: incident-fix
status: active
actor: agent
gates:
  - wf.test.test-shard
  - wf.cli-smoke-test.smoke-test-bare
prs: [3628]
hypothesis:
  metric: gate.wf.test.test-shard.failure_rate
  slo: wasted-queue-builds
  baseline: 0.03595
  baseline_source: 'origin/ci-steward-data@2845e59ae215bdd1d98511d96e2ab58d1f42e992, snapshots/2026-11-10.json: 10/162 completed PR shards and 1/144 queue shards failed (11/306). ci:status read on Nov 11; this snapshot predates the mirror incident.'
  target: 0.02
  after_days: 7
ratchet-release: []
field-changes: []
---

Since about 13:56 UTC on Nov 11, the coordinator reports test setup failing on
Ubuntu DNS (run 43052050496). The first fix tried cached apt indexes and two
archive hosts. Its real Ubuntu run 43062229635 failed at head 832381c065: shard
job 130667732056 could resolve neither archive.ubuntu.com nor
azure.archive.ubuntu.com. Mirror failover cannot fix an outage of every host.

Revised hypothesis: use only the image's installed tools for the archive checks
and CLI smoke. The independent archive leg keeps bsdtar when available, then
falls back to 7z or 7zz. Both paths verify every extracted filename and SHA-256
digest for ZIP and forced ZIP64; 7-Zip also tests the archive's checksums. CI
still fails if unzip, python3 or every independent reader is missing. There is
no apt step or silent skip for these prerequisites.

Ubuntu 26.04 lists 7zip, unzip and Python; Ubuntu 24.04 lists p7zip-full:
https://github.com/actions/runner-images/blob/main/images/ubuntu/Ubuntu2604-Readme.md
https://github.com/actions/runner-images/blob/main/images/ubuntu/Ubuntu2404-Readme.md
The smoke step checks Python, gcc, g++ and make directly. The unused apt helper
is removed. Codex's original distro bubblewrap/AppArmor install and all its
proof checks are restored unchanged: it still requires Ubuntu packages. Its
outage handling belongs to a separate reviewed commit and ledger entry. Codex
is a dependency of the required test fan-in, so it can still block that check.
This entry changes no test retry, job ceiling, required context or trigger.

Local proof: with bsdtar hidden and CI set, the old archive suite failed its two
bsdtar cases despite real 7z being present. After the change all eight cases
pass, including extraction by real 7-Zip for ZIP and forced ZIP64. Workflow
fixtures also exercise missing readers/build tools with apt unavailable.

The catalogue has no infra-only failure metric. The gate failure rate above is
the narrowest computed proxy; real test failures confound it. At seven days,
also inspect archive and smoke setup logs: target zero Ubuntu DNS failures in
those steps. The pre-incident snapshot does not measure today's outage rate.
Revert or revise if a missing tool can pass, 7-Zip cannot preserve paths/bytes,
or either covered step still reaches an Ubuntu mirror.
