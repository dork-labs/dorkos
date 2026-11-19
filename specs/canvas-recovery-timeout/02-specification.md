---
slug: canvas-recovery-timeout
number: 261119-052319
created: 2026-11-19
status: specified
---

# Bound the canvas recovery test timeout

**Status:** Specified. Implementation and verification pending.

**Author:** Codex

**Date:** 2026-11-19

**Issue:** DOR-4757

## Overview

Use the existing bounded timeout helper for the three canvas recovery tests that hold accepted work behind a durable identity intent. Keep the recovery procedure and every assertion intact.

## Background / Problem Statement

Full DOR-4534 verification at candidate `cdd77fdb71e3aed4d714dba2a75328f22680e01d` exited 1 with 47,635 server tests passing. Its only failing case, `in_doubt`, exceeded Vitest's default 5,000 ms timeout and reported 5,660 ms elapsed. The immutable test blob `3cfaf287c380ac1b2ae6570843298313e6f9adf8` matches the candidate, its base `58919179e89e89944199f9cc991074e53e418e66`, and published main `8ee317547876f16ded66d271016c515e88e14fe0`. The red log is `.dork/flow/tmp/4534-verification-002/verify.stdout.log` in the DOR-4534 worktree.

A separate guarded, one-worker, zero-retry run of that unchanged file passed all 14 tests, including the same case in 431 ms. These observations establish an intermittent timeout and leave its exact cause unresolved. All three intent states execute the same recovery sequence.

## Goals

- Apply the shared finite timeout to the `pending`, `in_doubt` and `failed` cases of the first identity-hold test group.
- Preserve evidence that an identity hold retains accepted work and that release permits exactly one delivery with the staged context intact.
- Verify the changed candidate with its actual focused test census and collect separate full verification evidence.

## Non-Goals

Production, authorization, billing, fixture sequencing, helper policy, default timeouts, retries, CI settings, and unrelated test groups are outside scope. Replacing the existing settle waits would require separate analysis of the asynchronous assertions and teardown.

## Technical Dependencies

Use the existing `@dorkos/shared/test-budget` export and the installed Vitest 4.1.11 `EachFunctionReturn` overload `(name, options: TestCollectorOptions, fn)`. The installed runner declares it in `node_modules/.pnpm/@vitest+runner@4.1.11/node_modules/@vitest/runner/dist/tasks.d-DEYaIMIu.d.ts:691–699`. The alternate callback-second overload accepts a numeric timeout as its third argument. The repository already uses the options-object overload with `loadCeilingMs` in `reservation-bridge.test.ts:735–739`. Dependency versions stay as pinned.

## Detailed Design

Edit only [pump-recovery-authority.test.ts](../../apps/server/src/services/canvas/doc-channel/__tests__/pump-recovery-authority.test.ts). Import `loadCeilingMs` from `@dorkos/shared/test-budget`. In the `accepted pump source-aware recovery refusal` suite's first `it.each(['pending', 'in_doubt', 'failed'] as const)`, insert `{ timeout: loadCeilingMs(5_000) }` between the unchanged test title and its callback. This group starts at line 79 in the pinned source. The second group with the same status array, at line 260, keeps its existing budget.

The helper multiplies the 5,000 ms base by the current maximum factor of four and gives Vitest a fixed 20,000 ms per-case ceiling. The fixture clock still advances by 60,000 ms when retrying. API, schema and data-model changes are unnecessary.

Keep the existing callback and cleanup intact. It must still admit the work, insert the real hold, and check retryable refusal plus retention of receipt, queue, staged context, batch and input events. It must still clear the hold without installing an alias, race the two pumps, ensure zero sends before closing the turn, and verify one nudge, one send, staged context delivery, receipt settlement and empty queue and staged rows.

## User Experience

This changes how long the repository's test runner permits the three cases to finish. The application has no user-facing change.

## Testing Strategy

1. Inspect the patch to confirm the only implementation changes are the import and one options argument. Check formatting and whitespace.
2. Run the entire existing test file through the normal admitted offline test path with one worker and zero retries.

   ```sh
   pnpm exec vitest run --project server --maxWorkers=1 --retry=0 apps/server/src/services/canvas/doc-channel/__tests__/pump-recovery-authority.test.ts
   ```

   Record the source identity, command, exit code, 14-test census and timings for the three affected cases. The fixture uses file-backed SQLite and the existing fake runtime.

3. Record actual ordinary full repository verification separately on the final implementation candidate, including its exit and server census. Use normal admission and concurrency, without artificial load. A focused pass establishes the assertions for that run. Full verification establishes the result under its own conditions. If full admission is pending, retain that state explicitly. If another timeout occurs, capture the unfinished phase before changing test policy again.

A new unit or E2E test is unnecessary because the change applies to the existing integration fixture and all of its assertions.

## Performance Considerations

A successful test returns when its current work and assertions finish. A stalled case still fails at the finite ceiling. The wider timeout applies to exactly three cases. No suite-level timing improvement is claimed from an isolated run.

## Security Considerations

The fixture's hold and authority assertions remain. Runtime credentials, network access and permission changes are outside scope.

## Documentation

The specification and verification receipt record the evidence. User documentation and release notes are unnecessary for this test-only change.

## Implementation Phases

Apply the scoped timeout, review the exact diff, then capture the focused and full verification results independently.

## Open Questions

- ~~(RESOLVED) Which cases receive the timeout?~~ All three in the first identity-hold group, because each runs the same SQLite and dispatch work.
- ~~(RESOLVED) Which budget and synchronization design apply?~~ Use the existing bounded helper with a 5,000 ms base. A global timeout would affect unrelated cases, and rewriting the current waits would also change the fixture's asynchronous proof.

## Related ADRs

No architecture decision is introduced. This applies an existing test utility to one existing fixture.

## References

- [DOR-4757](https://linear.app/dorkspace/issue/DOR-4757)
- [DOR-4534](https://linear.app/dorkspace/issue/DOR-4534)
- [Accepted ideation](01-ideation.md)
- [Shared timeout helper](../../packages/shared/src/test-budget.ts)
- [Existing timeout pattern](../../apps/server/src/services/canvas/doc-channel/writes/__tests__/reservation-bridge.test.ts)
