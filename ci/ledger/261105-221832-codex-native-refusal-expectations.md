---
id: 261105-221832
title: Correct native refusal expectations without changing host or spawn checks
kind: hygiene
status: proposed
actor: agent
gates: [wf.test.codex-sandbox]
prs: [3480]
ratchet-release: []
field-changes: []
---

The ten acceptEdits diagnostics already reach their no-spawn and host checks,
then fail a stale Full-only level assertion. Compare the unchanged level with
the captured input; retain their host and spawn assertions exactly.

The linked-folder case receives a correct pre-launch linked-folder refusal.
The retained trace has no Codex or bubblewrap exec and no creates through the
link or inside its target after fixture setup. Require the existing refusal
code and details, unchanged symlink inode/destination, empty target, no spawn,
no thread binding and unchanged host tree except approved project directories.
The outer host-file invariant remains unchanged. No product changes.

Leave the two default scan refusals unchanged: both failed in run41967701245
at ec430518a0, created November4 at22:25 CT (November5 at04:25 UTC), and in
run42045417702 at4d01d7ba4f. Both Full native positive rows passed in run42085349135.
No required check, mask or timeout changes. Native fixes require Linux CI.
