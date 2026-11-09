---
id: 261109-095000
title: Raise the browser shard timeout ladder from queue-run tail timings
kind: incident-fix
status: proposed
actor: agent
gates:
  - wf.browser-test.browser-shard
  - wf.browser-test.browser-test
prs: []
hypothesis:
  metric: gate.wf.browser-test.browser-test.ejections_caused@merge_group
  slo: queue-green
  baseline: 8
  baseline_source: 'DOR-4045 incident handoff: at least eight browser-test clock ejections since 2026-11-08 11:30Z. Timing cross-check: GitHub Actions API, latest 30 browser-test.yml merge_group runs as of 2026-11-09 09:33Z, including failed runs; source run IDs and p95 method below. Eight is a lower bound, not a normalized seven-day collector count.'
  target: 0
  after_days: 7
ratchet-release: []
field-changes:
  - gate: wf.browser-test.browser-shard
    field: timeout-minutes
    from: 45
    to: 60
  - gate: wf.browser-test.browser-shard
    field: timeout-minutes
    from: 'suite step: 35'
    to: 'suite step: 45'
  - gate: wf.browser-test.browser-shard
    field: timeout-minutes
    from: 'Playwright globalTimeout: 25'
    to: 'Playwright globalTimeout: 35'
---

DOR-4045 hypothesis: correcting the stale per-shard deadline and raising the
two outer limits together removes browser-test ejections caused by the shard
clock: at least eight since 2026-11-08 11:30Z -> zero over seven days.
The catalogue metric counts all browser-test ejections. Review the failing
reports separately to identify clock ejections; unrelated test defects can
keep that broader metric above zero. Do not claim a clock-specific computed
verdict from the broader metric alone.

## Measurement

Public GitHub Actions API equivalent of `gh run list --event merge_group`
filtered to browser-test.yml, then each run's jobs and suite-step timestamps.
`gh` could not load its protected login configuration in this session; no
credentials were read. Latest 30 runs span 2026-11-08 21:17:11Z through
2026-11-09 09:33:21Z. There are 29 completed samples per shard, from 22 green
and seven failed queue runs. Run 42594332134 was still running at collection;
its six unfinished suite steps are excluded, never counted as zero.

Nearest-rank p95 = sorted sample at ceil(0.95 * n). Values are minutes of
`Run the browser suite`, not job wall time and not green-run medians.

| Shard |   n | Suite p95 | Suite max |
| ----- | --: | --------: | --------: |
| 1     |  29 |     25.03 |     25.05 |
| 2     |  29 |     24.88 |     25.03 |
| 3     |  29 |     23.98 |     24.03 |
| 4     |  29 |     23.73 |     24.45 |
| 5     |  29 |     22.80 |     23.47 |
| 6     |  29 |     23.65 |     25.03 |

Some samples stop at 25 minutes, so their timings are censored lower bounds.
Run [42588311172](https://github.com/dork-labs/dorkos/actions/runs/42588311172)
still reached 25.03 minutes on shard 2 after the refreshed timing weights.
The deadline must leave room beyond the observed p95; changing the shard cut
alone does not fix a stale suite estimate.

## Change and cost

UNSHARDED_SUITE_MINUTES 58 -> 79, boot allowance 5 and multiplier 1.75 stay.
At six shards: ceil((5 + (79 - 5) / 6) * 1.75 / 5) * 5 = 35 minutes,
about 40% above the largest observed p95 (25.03, censored). Step 35 -> 45;
job 45 -> 60. The ten-minute shutdown margin is retained; fifteen minutes
outside the step cover setup and uploads. Six shards stay within the 60-job
capacity ruling. No new runners; genuinely hung shards can consume ten more
suite minutes, and the backstop permits fifteen more job minutes.

ci/config.yaml's observed deadline moves 25 -> 35 with Playwright, and the
existing ruler test checks both the derivation and the actual workflow ladder.
Historical headroom readings use today's deadline, so their ratio falls even
before new jobs complete; that is a ruler change, not runtime improvement.

## Check and revert

After seven days, count browser-test ejections caused by the shard clock,
including failed queue runs; target zero. Keep actual test failures visible.
Revisit the estimate if any healthy shard still reaches 35 minutes. Revert or
revise if reporter shutdown reaches the 45-minute step cap, setup/uploads
reach the 60-minute job cap, or repeated hung shards measurably worsen queue
capacity. Never declare success from a green-run-only sample.

Source run IDs (newest first):
42594332134, 42588311172, 42583640926, 42580190458, 42580187607, 42575342661, 42572296607, 42572294712, 42569132532, 42569130897, 42569130086, 42564036524, 42558209562, 42554770963, 42552138763, 42552101167, 42540940059, 42540589919, 42537406199, 42534731426, 42532640612, 42532168089, 42527345239, 42527343619, 42527246839, 42524431115, 42524429993, 42524428714, 42524426046, 42524427171.
