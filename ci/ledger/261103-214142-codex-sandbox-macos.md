---
id: 261103-214142
title: Prove Codex file isolation on hosted macOS without changing Linux privileges
kind: incident-fix
status: proposed
actor: agent
gates: [wf.test.codex-sandbox, wf.test.test, wf.test.test-shard]
prs: [3480]
hypothesis:
  metric: gate.wf.test.codex-sandbox.failure_rate@pull_request
  slo: main-green
  baseline: 1
  baseline_source: 'Predecessor probe in test run 41712417984 at 2e0d17fd93: its one containing shard failed, with every Codex thread/start refused by bwrap loopback RTM_NEWADDR. This is a one-run predecessor baseline, not historical samples of the new job.'
  target: 0
  after_days: 14
ratchet-release: []
field-changes: []
---

Security's latest route is one hosted macOS job, with contents read only,
no secrets and no saved checkout credential. The earlier proposed AppArmor
sysctl step is superseded; it is not added to the shards or any other job.
Both Linux shard commands partition Codex's binary suites to the required
macOS job: transport/protections, credits and protocol snapshot, three files.
The inventory guard requires every binary file under Codex to be named by the
hosted command, and the receipt requires every suite to execute. No native
assertion is removed or skipped.
The job uploads shard-files-codex for the existing fan-in union and
vitest-shard-report-codex for the existing collector pattern, preserving test
counts and failure evidence across the platform partition.
OpenCode's M2 canary and the mocked Linux refusal tests remain in the shards.
This adds proof; it does not resolve
Linux runner restrictions or establish Linux support.

Run the complete vendored-binary suites, including both protected
probes and their readable command controls. Require every collected test to
pass, reject a missing binary or skipped suite, and require both named probes
in the report. The existing required test fan-in now waits for this job too;
no required context, trigger, retry, shard count or timeout is changed.
The canary guard's expected job count increases from ten to eleven; its
byte-for-byte guard, placement and event/ref assertions stay unchanged.
Each protected probe still checks all three permission modes, mid-turn files
and sibling plugin writes, and prints startMs at 10,000 home files.

The one-run failure baseline establishes the immediate blocker, not a trend
or a causal performance estimate. Read the first run manually, then the
14-day collector window; no successful runs yet exist on this route.
If hosted macOS cannot execute the readable control, keep the check red and
take the separate Linux sysctl job fallback back to Security. Never skip a
probe or disable sandbox isolation to make it green.
