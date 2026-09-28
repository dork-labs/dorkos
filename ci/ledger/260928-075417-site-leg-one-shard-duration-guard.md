---
id: 260928-075417
title: Site leg on one shard must not slow the browser shards
kind: experiment
status: active
actor: agent
gates:
  - wf.browser-test.browser-shard
prs: []
hypothesis:
  metric: 'gate.wf.browser-test.browser-shard.duration_p90@merge_group'
  slo: 'queue-build'
  baseline: 20.3
  baseline_source: 'hand measurement: 690 green browser-shard jobs of the first 120 six-shard merge_group runs (2026-09-27 20:32Z..2026-09-28 07:08Z), job started->completed p50 18.3, p90 20.3 min'
  target: 20.3
  after_days: 7
ratchet-release: []
field-changes: []
---

The guard for 260928-075416 (marketing-site leg on one shard): the metric that
change could make worse, with a ceiling.

**What could get worse.** Shard 1 now owns both site specs and is the only
shard that boots the site leg. The balanced cut counts the two specs' test time
(about 20s) against shard 1, but not the leg's boot, so shard 1 runs roughly a
minute longer than the others. The queue build waits for its slowest shard,
so if shard 1 became the long pole by more than today's spread, queue builds
would slow.

**Why it should not.** Today every shard pays that boot, so shard 1 costs what
every shard costs now, and shards 2-6 get faster. The p90 across shards should
hold or drop. **Target equals the baseline**: `verified` means p90 at or under
20.3 minutes.

**Revert, or weigh the boot into the cut,** if p90 rises above 20.3 or shard
1's job time sits more than 2 minutes above the other shards' median. The
cheap fix is adding the site leg's measured boot seconds to the pinned shard's
starting load in `partition`, which the new per-leg boot line now measures.
