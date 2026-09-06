# Verify a direct MCP connection before reporting success

Related programme: DOR-1792 — Deliver DorkOS Connections.
Work item: DOR-738 — raw-mcp pollConnect returns connected unconditionally.

The direct MCP connector must successfully initialize and inspect the configured
server using the same credentials its runtime would use before recording an
active account. A failed, unauthorized, or timed-out probe must not create an
active account or claim that authentication succeeded. Preserve idempotent polls,
disconnect semantics, multi-provider isolation, and bounded cleanup.

Use the existing MCP probe machinery where its contract fits. Do not invent an
OAuth consent URL from a protocol endpoint or claim the connector performed an
OAuth exchange it did not perform. The implementation must include a real MCP
server boundary test and a regression check that fails without the verification
guard. Follow REVIEW.md and the independent pre-PR review gate.

## Verification artifact — 2026-09-05

- The server regression suite uses a listening authenticated MCP server and observes
  `initialize`, `notifications/initialized`, then `tools/list` before an active account appears.
  It also covers unauthorized, timeout, transport-failure, repeat-poll, bounded-cleanup, and
  disconnect-during-probe outcomes. All 22 raw-MCP tests pass.
- Removing the probe outcome checks and the post-probe flow identity guard makes four tests fail:
  unauthorized, timeout, transport failure, and disconnect resurrection. Restoring the guard
  returns all 22 tests to green.
- The focused server/client set passes 76 tests. The Connections browser suite passes all three
  scenarios in test mode; the verification-only dialog shows no sign-in link. Screenshot evidence
  is at `.dork/flow/evidence/dor-738-verification-only-connect-dialog.png` in the worktree.
- Server, client, shared, test-utils, and e2e typechecks and lints pass (existing warnings only).
  Two full Node 24 `pnpm verify` runs reached the test sweep but hit unrelated load-sensitive tests;
  every reported failure passes when rerun alone.
- The Stage 1 review found that the REST and capability callers discarded the provider binding after
  the first terminal poll. Both public surfaces now replay a schema-sanitized terminal result from a
  100-entry LRU. Pending work stays bound to the exact provider instance that started it; completion
  drops that live provider reference. Route tests cover identical success replay, identical typed
  failure replay, abandoned-flow eviction, and disconnect invalidation.
- A follow-up Stage 1 probe found that evicting an in-flight binding could hide an account the raw
  provider created just before returning. In-flight polls are now pinned and single-flight. When
  every retained slot is polling, a new start receives HTTP 400 and asks the caller to wait and try
  again. The original poll and connected account remain visible through the flow route, routing
  cache, and account inventory.
  Mutating the retention policy to evict the in-flight record makes that boundary test fail.
- Stage 2 reproduced three more races at public boundaries. DorkOS now replaces every
  provider-local flow id with a globally opaque public id, so equal ids from two providers cannot
  redirect a poll. Repeating a raw MCP disconnect cancels an in-flight reconnect even before its
  active routing row exists. A revoked routing row keeps only the original provider ownership, so
  the public route treats account ids as opaque and never guesses or broadcasts them. Closing the
  dialog while a verification-only start is pending invalidates that request generation, so its
  late response cannot restart polling. The nine focused route, provider, routing, session,
  database, hook, and dialog files pass 117 tests. Removing each guard makes its exact regression
  test fail.
