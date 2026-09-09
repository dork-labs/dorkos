# Implementation Summary: Connections runtime-turn lease renewal

**Created:** 2026-09-08
**Last Updated:** 2026-09-08
**Spec:** specs/connections-runtime-turn-renewal/02-specification.md

## Progress

**Status:** Complete; awaiting independent implementation review
**Tasks Completed:** 3 / 3

## Tasks Completed

### Session 1 - 2026-09-08

**Workers:** _(none; implementation is proceeding in the owned isolated worktree)_

#### Task 1.1 - Process-owned renewal authority

- Added an opaque, exact-identity renewal permit and an adapter-owned active-turn guard to the internal runtime principal port.
- Opening rechecks the exact runtime owner after awaited authority setup. Renewal revalidates authority, then performs a fresh synchronous row, clock, permit, tombstone, and owner check before an expiry-only SQLite compare-and-set.
- Renewal keeps the bearer, token hash, and immutable claims unchanged. Revocation, boot invalidation, authority loss, and active-owner replacement remove process-local renewal authority before durable work.
- Added deterministic coverage for exact and late expiry, copied permits, authority and owner changes across awaited work, owner-loss persistence failure, restart, concurrent renewal convergence, and a competing expiry committed between the final read and compare-and-set.

#### Task 2.1 - Shared supervisor and runtime ownership

- Added one shared one-shot supervisor with the approved hourly cadence, bounded one/five/fifteen-minute storage retry policy, unref'ed timers, and terminal `active`/`stopped`/`lost` state.
- Terminal metadata contains only binding ID, runtime, safe reason, last committed expiry, and observation time. Loopback refusal uses one safe start-a-new-turn instruction for every denial reason.
- Claude Code starts supervision after lazy principal resolution. Codex binds it to the exact active controller while retaining its fixed child environment. OpenCode starts only after its directory-scoped registration is applied.
- All adapters stop supervision before revocation and resource release. Setup failure never leaves a supervisor behind, and queued callbacks cannot renew after stop or cancellation.

#### Task 3.1 - Composed authority proof

- Added a deterministic 72-hour renewal run, real loopback MCP initialize/list/call coverage, and file-backed SQLite close/reopen proof that neither the old bearer nor permit survives restart.
- Proved that stored sessions, resumed threads, warm processes, reused sidecars, and bearer traffic cannot renew or reconstruct authority. Each subsequent message gets a fresh binding and permit.
- Proved that provider work which has already crossed the final authorization fence may settle once across expiry, while expiry or revocation before a retry prevents a second provider command and uncertain writes remain unretried.
- Documented the runtime lifecycle and accepted same-bearer tradeoff, and added a user-facing changelog fragment.

## Files Modified/Created

**Source files:**

- `apps/server/src/services/connectors/runtime-principal-port.ts`
- `apps/server/src/services/connectors/principal/runtime-principal-service.ts`
- `apps/server/src/index.ts`
- `apps/server/src/services/runtimes/connectors/connector-turn-lease-supervisor.ts`
- `apps/server/src/services/runtimes/connector-tools.ts`
- `apps/server/src/services/runtimes/claude-code/connector-turn-context.ts`
- `apps/server/src/services/runtimes/codex/codex-runtime.ts`
- `apps/server/src/services/runtimes/opencode/opencode-runtime.ts`
- `apps/server/src/services/runtimes/connector-mcp/auth.ts`
- `apps/server/src/services/runtimes/connector-mcp/router.ts`

**Test files:**

- `apps/server/src/services/connectors/principal/__tests__/runtime-principal-service.test.ts`
- Existing execution broker and runtime MCP fixtures now supply explicit test-owned turn guards.
- `apps/server/src/services/runtimes/connectors/__tests__/connector-turn-lease-supervisor.test.ts`
- Focused lifecycle coverage in the Claude Code, Codex, OpenCode, and loopback-listener test files.

## Known Issues

_(None yet)_

## Implementation Notes

### Session 1

- The frozen, independently reviewed design is checkpoint 3 with result tree `eee6907515a903a20a8bf16281a535d73285509f`.
- Implementation starts at the process-local permit and expiry compare-and-set boundary before runtime supervisor wiring.
- The final focused renewal cohort passes 244 tests across the principal, supervisor, execution broker, loopback MCP boundary, and all three runtime adapters. Server TypeScript compilation also passes under Node 24.
- Phase 2 is complete. The runtime supervisor and all three adapter ownership boundaries are covered by focused lifecycle tests and remain subject to final independent review.
- Each runtime's actual attachment test now owns a real principal service and real supervisor for a deterministic 72-hour turn. The Claude context, Codex child environment, and OpenCode directory registration retain their established transport shapes while the shared lease is renewed and torn down.
- Phase 3 is complete with real loopback initialize/list/call coverage, a file-backed SQLite restart proof, execution-broker expiry/retry boundaries, and fresh-turn proofs for every runtime adapter.
