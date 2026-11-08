---
id: 261103-214142
title: Prove Codex file isolation with distro bubblewrap and scoped AppArmor
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

One Ubuntu 24.04 probe job installs bubblewrap, AppArmor profiles/utils and
strace from the runner's distribution packages. It loads the distro's
bwrap-userns-restrict profile for /usr/bin/bwrap, then requires that exact
binary to create user and network namespaces. A missing profile, rejected
load or unsuccessful preflight fails the job. No global sysctl or fallback,
new repository, secret, trigger or existing permission changes.

Codex 0.163.0 prefers a protected distro executable on PATH, but can fall back
to a bundled binary when its capabilities differ. Trace actual execve and
execveat calls during all native suites; require a successful namespace
execution of /usr/bin/bwrap and reject a different bubblewrap path, including
a bundled fd execution. Print its path and counts. A PATH lookup or --help
alone is not proof. Tracing may add startup overhead; reported startMs is
from this instrumented run and must be treated accordingly.

The general Linux shards partition all three Codex binary suites to this
required job: transport/protections, credits and protocol snapshot. The
inventory guard requires every binary file to be named by the command; the
receipt requires every suite and both protected probes, no skips and no
failed assertions. Readable file/skill controls prove a command ran.
OpenCode's M2 canary and mocked Linux refusals remain in the general shards.
The job uploads shard-files-codex and vitest-shard-report-codex for the
existing union and collector patterns, preserving counts and evidence.

The existing required test fan-in accepts only success from this job.
Required context names, triggers, retries, shard counts and existing
deadlines are unchanged. The canary guard count rises from ten to eleven;
its byte-identical ref checks remain. All three permission modes, mid-turn
files and sibling plugin writes remain asserted. Report startMs per mode at
10,000 files; arrange the larger CI measurement if it exceeds 1–2 seconds.

The one-run predecessor baseline establishes the blocker, not a trend.
Read the first run manually and the following 14-day collector window.
If profile loading, executable selection or native controls fail, keep the
job red and report it to Security; never skip assertions, replace the
sandbox or fall back to a global AppArmor relaxation. This setup requires
host administrator access and does not promise default Docker support.

The follow-up corrects the job's stale macOS comment only; execution is unchanged.
