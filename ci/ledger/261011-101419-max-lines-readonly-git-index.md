---
id: 261011-101419
title: Keep the max-lines rename query from refreshing the Git index
kind: hygiene
status: proposed
actor: agent
gates: [wf.typecheck.typecheck]
prs: [2673]
ratchet-release: []
field-changes: []
---

The rename lookup in `scripts/check-max-lines.ts` now passes
`-c diff.autoRefreshIndex=false` to its existing `git diff` call. The query is
read-only; refreshing index stat-cache entries would change index bytes while
leaving staged blobs unchanged. The explicit command option preserves that
boundary without changing repository configuration.

Only those two arguments and the call's formatting change. Rename detection,
base selection, paths, ESLint measurement, file exemptions, the 500-line limit,
and the lower-only baseline policy stay unchanged. No required check, retry,
worker, timeout, status, or ratchet floor changes. This is hygiene, with no
performance hypothesis or computed verdict claimed.

Run the unchanged max-lines gate and CI Steward census, ledger validation, and
same-commit coverage checks before pushing. Revert or revise the option if it
changes rename results or fails to preserve the read-only index boundary.
