---
id: 261111-163545
title: CI tool installs survive one Ubuntu mirror outage
kind: incident-fix
status: proposed
actor: agent
gates:
  - wf.test.test-shard
  - wf.test.codex-sandbox
  - wf.cli-smoke-test.smoke-test-bare
prs: []
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
security.ubuntu.com DNS (run 43052050496). Refreshing every apt source before
installing one archive reader makes an unrelated mirror an all-PR blocker.

Hypothesis: use the runner's existing build tools for CLI smoke, and install the
remaining archive/sandbox packages from cached indexes first, then retry against
two scoped Ubuntu archive hosts. A failed refresh must not prevent trying the
install. The scoped fallback excludes security and third-party sources for this
tool install only; it does not edit the runner's global sources or trust keys.

The runner-image inventory lists Python, gcc, g++ and make, and unzip, but not
libarchive-tools/bsdtar:
https://github.com/actions/runner-images/blob/main/images/ubuntu/Ubuntu2404-Readme.md
The smoke step checks the installed tools rather than requiring apt. Archive and
Codex checks still verify their real tools/profile after installation. No test
retry, job ceiling, required context, event or required-job condition changes.

The catalogue has no infra-only failure metric. The gate failure rate above is
the narrowest computed proxy; real test failures confound it. At seven days,
also inspect setup logs for these three jobs: target zero failures attributable
to a single Ubuntu mirror outage. The pre-incident snapshot does not measure
today's outage rate; the reported run is incident evidence, not a fabricated
collector baseline. Revert or revise if a missing tool can pass, distro package
or signature checks fail, or the fallback still fails with one healthy mirror.
