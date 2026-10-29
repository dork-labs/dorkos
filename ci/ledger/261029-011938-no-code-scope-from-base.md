---
id: 261029-011938
title: The no-code scope rule is read from the base commit and compares package.json as parsed JSON
kind: incident-fix
status: proposed
actor: agent
gates: [wf.test.test-shard]
prs: []
hypothesis:
  metric: gate.wf.test.test-shard.ejections_caused
  baseline: 0
  baseline_source: 'no queue ejection traced to a no-code skip since #3238 merged (2026-10-28 23:51Z); the gap was found in review (Security, #dorkos 23:21Z), not by an ejection'
  target: 0
  after_days: 14
ratchet-release: []
field-changes: []
---

Security's review of #3238 (ledger 261028-231741), which merged before the review landed, found two gaps in the pull-request skip:

1. **The PR graded itself.** test.yml ran `scripts/no-code-scope.sh` from the PR's own checkout, so a PR could edit the rule that decides whether its shards run. It now reads the script from the base commit (`git cat-file blob "$base:scripts/no-code-scope.sh"`), and a base without it runs the shards.
2. **"Version-only" matched lines, not keys.** A `"version"` line nested inside `overrides`, `pnpm` or a dependency's own object passed as a version bump. The script now compares each package.json as parsed JSON with `jq`: only the top-level `"version"` key may differ. A new fixture (`only a nested "version" inside overrides`) fails on the old script and passes on this one.

The merge queue and the main canary were never affected; they always run the full suite. Revert only if a no-code release PR starts running the shards again.
