---
id: 261117-233253
title: Lint tasks hash the root VERSION, so a cached lint can't hide a reached deprecation deadline
kind: hygiene
status: proposed
actor: agent
gates: []
prs: []
ratchet-release: []
field-changes: []
---

`dorkos/deprecated-removal` (#3918, DOR-4188) reads the root `VERSION` at lint
time, so the same source can pass lint at one version and fail at the next.
Turbo's `lint` and `@dorkos/server#lint` hashed only `$TURBO_DEFAULT$` (the
package's own files), so a release bump that reaches a removal version
replayed a cached green lint. Both now also list `$TURBO_ROOT$/VERSION`.

Measured with `turbo run lint --filter=@dorkos/shared --dry=json` in a
worktree at `0afb532cdd`, changing `VERSION` from 0.135.13 to 0.153.0 and back:
main's config gave the same hash both times (`67bb91386e3de36e`); with this
change the hash moved (`23b678609b28d3dd` → `1efd52693f1344b5`).

Nothing measurable should move. Lint misses the cache once per release bump,
the same as any other input change. No retry, skip, shard, worker cap,
required check, gate, steward or judge changes.

Revert if lint cache hit rate between releases drops (it shouldn't: `VERSION`
only changes at a release cut), or if the rule stops reading `VERSION`.
