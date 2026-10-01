---
id: 261001-130114
title: Close the failed four-shard queue sweep verdict, keep the shards, and keep withdrawn merges as confounders
kind: hygiene
status: proposed
actor: agent
gates: []
prs: []
ratchet-release: []
field-changes: []
---

The follow-up that closes 260830-213616 (#1391), whose verdict came back `failed`:
`gate.wf.test.test-shard.duration_p50@merge_group` read 12.2 min after the change
against a target of 10. That verdict stands as computed on `ci-steward-data`
(`verdicts/260830-213616.json`); nothing here re-states its hypothesis, so its
hash is unchanged and the collector keeps the stored verdict.

The shards stay. Reverting would put the queue back on one serialized sweep while
`queue-build` p50 went from 34.8 to 24.4 min over the same windows, and nothing in
the entry's own revert condition (the shards' union stops covering every package)
has happened. So 260830-213616 goes `withdrawn`: the schema's only hand state, besides
`reverted`, that closes an entry, and here it means the hypothesis is closed, not
that the change was undone.

One engine fix rides along. The confounder check skipped `withdrawn` entries, which
was right only while withdrawn meant "never landed". An entry that never merged has no
anchor and drops out anyway, so the skip only ever hid a merged change, and closing
this entry would have stopped it confounding 260824-121951 (#1246) the next time
that verdict is recomputed. Every merged entry now counts. Stored verdicts are
unchanged: a final verdict is recomputed only when its own hypothesis changes.

No gate, timing, retry, shard or required-status change. Revert the engine fix if a
withdrawn entry whose PR merged and was then backed out shows up as a confounder;
that one should be `reverted`, which already counts.
