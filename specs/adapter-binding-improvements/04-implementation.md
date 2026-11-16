# Implementation Summary: Relay Binding Robustness & Multi-Instance Routing

**Created:** 2026-03-22
**Last Updated:** 2026-03-22
**Spec:** specs/adapter-binding-improvements/02-specification.md

## Progress

**Status:** Complete
**Tasks Completed:** 8 / 8

## Tasks Completed

### Session 1 - 2026-03-22

**Batch 1** (parallel):

- Task #1: Add .min(1) constraints to AdapterBindingSchema IDs
- Task #3: Add server-side agent existence validation on binding creation
- Task #4: Fix builtin flag on user-created adapters with startup migration
- Task #5: Add routing failure event recording in BindingRouter

**Batch 2** (parallel):

- Task #2: Add per-entry validation in BindingStore.load() for data migration
- Task #6: Make ThreadIdCodec constructors accept optional instance ID

**Batch 3**:

- Task #7: Update adapters to pass instance ID to codec and subject prefix

**Batch 4**:

- Task #8: Update BindingRouter.parseSubject() and remove resolveAdapterInstanceId

## Files Modified/Created

**Source files:**

- `packages/shared/src/relay-adapter-schemas.ts` — Added `.min(1)` to `adapterId` and `agentId`
- `apps/server/src/services/relay/adapter-manager.ts` — Fixed `builtin` flag in `addAdapter()`/`testConnection()`, added startup migration, added `getMeshCore()` getter, wired `eventRecorder` to `BindingSubsystem`, removed `resolveAdapterInstanceId` closure
- `apps/server/src/routes/relay-adapters.ts` — Added adapter/agent existence validation in `POST /bindings`
- `apps/server/src/services/relay/binding-router.ts` — Updated `parseSubject()` to extract instance ID from subject, removed `resolveAdapterInstanceId` from deps, added `eventRecorder` for routing failures
- `apps/server/src/services/relay/binding-subsystem.ts` — Removed `resolveAdapterInstanceId` from deps, added `eventRecorder` passthrough
- `apps/server/src/services/relay/binding-store.ts` — Rewrote `load()` with per-entry validation via `BindingsFileShellSchema`, auto-save on cleanup
- `packages/relay/src/lib/thread-id.ts` — All 3 codec classes accept optional `instanceId` in constructor
- `packages/relay/src/adapters/telegram/telegram-adapter.ts` — Constructs codec with instance ID, passes to super() and handlers
- `packages/relay/src/adapters/telegram/inbound.ts` — Removed singleton codec, parameterized functions
- `packages/relay/src/adapters/telegram/outbound.ts` — Parameterized codec in deliver/typing functions
- `packages/relay/src/adapters/slack/slack-adapter.ts` — Same pattern: instance-aware codec
- `packages/relay/src/adapters/slack/inbound.ts` — Removed singleton codec, parameterized functions
- `packages/relay/src/adapters/slack/outbound.ts` — Parameterized codec in deliver options
- `packages/relay/src/adapters/telegram-chatsdk/adapter.ts` — Instance-aware codec, passes to handlers
- `packages/relay/src/adapters/telegram-chatsdk/inbound.ts` — Removed singleton codec, parameterized functions
- `packages/relay/src/adapters/telegram-chatsdk/outbound.ts` — Removed singleton codec, parameterized functions

**Test files:**

- `packages/shared/src/__tests__/relay-adapter-schemas.test.ts` — 3 new tests for empty ID rejection
- `apps/server/src/routes/__tests__/relay.test.ts` — Updated mock with `getMeshCore`
- `apps/server/src/services/relay/__tests__/binding-store.test.ts` — 3 new tests for per-entry validation
- `apps/server/src/services/relay/__tests__/binding-router.test.ts` — Updated subjects to instance-aware format, 6 new parseSubject tests
- `packages/relay/src/lib/__tests__/thread-id.test.ts` — 30 new tests for instance-aware codec behavior
- `packages/relay/src/adapters/telegram/__tests__/*` — Updated for instance-aware codec
- `packages/relay/src/adapters/slack/__tests__/*` — Updated for instance-aware codec
- `packages/relay/src/adapters/telegram-chatsdk/__tests__/*` — Updated for instance-aware codec

## Known Issues

_(None)_

## Implementation Notes

### Session 1

- Batch 1 completed: Tasks #1, #3, #4, #5 (4 parallel agents)
- Batch 2 completed: Tasks #2, #6 (2 parallel agents)
- Batch 3 completed: Task #7 (1 agent + follow-up fix agent for test failures)
- Batch 4 completed: Task #8 (parseSubject update + remove resolveAdapterInstanceId)
- Final state: 1174+ relay tests passing, 229 server tests passing, typecheck clean
