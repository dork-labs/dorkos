# Agent teams: hand-off report preflight

This branch implements DOR-3817 Part A from the November 15 Security design. It preserves every allowed chat origin. A drafting chat that cannot receive messages gets no notice and no warning. Its receipt directs the agent to `room_handoff_status`. Interactive drafting chats continue to receive notices.

Root owns tracker updates, PR preparation and pre-PR review coordination. DorkOS Code owns Security routing, reviewer labels, arming, releases and Done checks. The PR must retain `hold` and `review:deep`. Part A does not complete the broader DOR-3817 or DOR-4472 scope.

## Implementation

Worktree: `/Users/doriancollier/Keep/dork-os/dorkos-worktrees/codex-at-dor-3817`. Branch: `codex/at-dor-3817`. Base: `a0e0d370e618b146741f4644601e8656561bfc6d`. The analysis and implementation worker used the gpt-6.1-sol workhorse mapping.

The pure `isChatSendable(facts)` predicate serves both ordinary target admission and handoff report preflight. The handoff reads current facts before composing its receipt and checks again before sending its terminal answer. Non-receiving chats get a debug log and the existing status reader. Room-origin notices retain their existing route. A failed facts lookup does not promise a reply. The asynchronous gate captures the draft's carried marks before awaiting its facts.

No origins, forwarding paths, room-post checks or permission policies were widened. No ancestor routing or server-only exemption was added. The unchanged verbatim input schema moved into the existing room-post argument helper to keep the oversized capability file from growing.

## Verification

Dependencies were prepared with `pnpm install --ignore-scripts --frozen-lockfile`, `pnpm rebuild better-sqlite3` and `pnpm turbo run build --filter='@dorkos/server^...'`. An initial test startup failed because shared build output was missing; that failure is not counted as regression evidence. Load was checked before runs and stayed below 16.

The final M1 tests use real `session_metadata` rows in the room harness's temporary SQLite database and the actual runtime registry. They cover `heartbeat`, `schedule`, `relay-binding` and null origins, with both posted and declined outcomes. They invoke the actual `rooms.handoff_status` capability. Interactive chats are covered by the existing notice-delivery test.

- **M1, fix reverted:** restore only the three production files from the pinned base, run `pnpm vitest run apps/server/src/services/rooms/__tests__/room-handoff.test.ts -t 'does not send or warn'`, then restore the fixed bytes in `finally`. All eight cases fail because `send` is called once. The command exits 1, with eight failures and 16 skipped tests. Log: `/tmp/dor3817-real-fixture-reverted-red.log`.
- **M6, unsafe-origin mutation:** temporarily add `heartbeat` to `CHAT_SENDABLE_ORIGINS`, run `pnpm vitest run apps/server/src/services/session/chat-messages/__tests__/chat-sendable-origins.test.ts -t 'pins the exact origins'`, then restore the exact bytes in `finally`. The snapshot fails and the command exits 1. Log: `/tmp/dor3817-real-fixture-unsafe-origin-red.log`.
- **M6, baseline:** the exact-origin snapshot already passes before the fix. Its mutation failure proves that it detects an unsafe allowlist change; it is not a claim that baseline admission was broken.
- **Final fixed run:** the command below passes all 119 tests across four files in 15.46 seconds. Log: `/tmp/dor3817-real-fixture-final-green.log`.

```bash
pnpm vitest run apps/server/src/services/rooms/__tests__/room-handoff.test.ts apps/server/src/services/rooms/__tests__/room-handoff-status.test.ts apps/server/src/services/session/chat-messages/__tests__/chat-sendable-origins.test.ts apps/server/src/services/session/chat-messages/__tests__/chat-message-service.test.ts
```

`NODE_OPTIONS=--max-old-space-size=8192 pnpm --filter @dorkos/server typecheck` passes both the server and spaces compilers with exit 0. Root coordinated sequential compilation. The default 4 GB run previously exhausted Node's heap without reporting a TypeScript diagnostic. Logs: `/tmp/dor3817-typecheck-8gb.log` and `/tmp/dor3817-typecheck.log`.

Targeted ESLint reports no errors and only the existing capability-file size warning. `git diff --check` is clean. The own-module mock and file-size checks both pass against the pinned base, with no new mocks and no oversized files growing.

The first push was correctly refused because the capability file grew by two lines and the initial facts-factory mock exceeded the mock limit. Both were corrected, with no baseline increase or gate bypass. The final normal commit and push hooks passed. The branch was pushed at `6591ea5543f8f442d5df1105932a940355753659`, and the remote matched that SHA.

A fresh independent review passed specification and code quality with zero findings at that SHA. The reviewer independently ran all 119 tests and traced notification liveness. The final preparation changes only this plan's prose and squashes the history; source and test content must remain identical to the reviewed SHA.

## Limits and follow-up

No live runtime or production-log reads were performed, and live QA remains with DorkOS Code. This change stops impossible notice attempts and corrects the receipt. It does not make handoffs durable across restarts or repair busy and failed seats. The separate DOR-3535 and outbox work remains suspended at commit `a22bcb8694`.
