---
id: 261016-120446
title: Avoid parsing files without raw status colours
kind: hygiene
status: proposed
actor: agent
gates: [wf.test.test-shard]
prs: [2945]
ratchet-release: []
field-changes: []
---

The existing colour audit exceeded its normal five-second limit on PR2945.

Skip parsing only files without raw class prefixes, escapes or entities. Keep the original AST scanner, allowlist and ratchet unchanged. Dirent traversal follows symbolic links as before.

The separate actual-function corpus oracle matched every file count and diagnostic. All fourteen maintained cases passed with the normal deadline. Local timings are descriptive; no hosted latency improvement is claimed.

This hygiene change does not alter shard counts, workers, retries, timeouts or required checks. The six-shard experiment remains separate. Revert if corpus results diverge or the scanner misses a raw status colour.
