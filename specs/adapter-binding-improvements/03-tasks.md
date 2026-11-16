# Relay Binding Robustness & Multi-Instance Routing — Task Breakdown

**Spec:** `specs/adapter-binding-improvements/02-specification.md`
**Generated:** 2026-03-22

## Overview

8 tasks across 2 phases fixing four interrelated issues in the relay binding and adapter routing system: empty-ID bindings silently dropping messages, incorrect `builtin` flags, missing server-side validation, and multi-instance adapter routing.

---

## Phase 1: Critical Fixes

Foundation fixes for schema validation, data migration, and routing visibility. Tasks 1.1, 1.3, and 1.4 can run in parallel. Task 1.2 depends on 1.1. Task 1.5 is independent of all others.

### Task 1.1 — Add `.min(1)` constraints to AdapterBindingSchema IDs

**Size:** Small | **Priority:** High | **Parallel with:** 1.3, 1.4

Add `.min(1)` to `agentId` and `adapterId` in `AdapterBindingSchema` (`packages/shared/src/relay-adapter-schemas.ts`). This is the single highest-impact fix — prevents invalid bindings at every entry point. `CreateBindingRequestSchema` inherits the constraint automatically via `.omit()`.

**Tests:** Extend `packages/shared/src/__tests__/relay-adapter-schemas.test.ts` — reject empty agentId, reject empty adapterId, accept valid non-empty IDs.

---

### Task 1.2 — Add per-entry validation in BindingStore.load() for data migration

**Size:** Medium | **Priority:** High | **Depends on:** 1.1

Modify `BindingStore.load()` (`apps/server/src/services/relay/binding-store.ts`) to validate entries individually using `AdapterBindingSchema.safeParse()` instead of parsing the entire file with `BindingsFileSchema.parse()`. Invalid entries are discarded and logged, and the cleaned file is auto-saved.

**Tests:** Extend `apps/server/src/services/relay/__tests__/binding-store.test.ts` — mixed valid/invalid entries, all-valid entries, malformed JSON.

---

### Task 1.3 — Add server-side agent existence validation on binding creation

**Size:** Medium | **Priority:** High | **Parallel with:** 1.1, 1.4

Add `getMeshCore()` getter to `AdapterManager`. In `POST /bindings` route (`apps/server/src/routes/relay-adapters.ts`), validate that the referenced adapter exists and the agent ID resolves in the mesh registry before creating the binding.

**Tests:** Route-level tests — 400 for non-existent adapter, 400 for non-existent agent, 201 for valid data.

---

### Task 1.4 — Fix builtin flag on user-created adapters with startup migration

**Size:** Medium | **Priority:** High | **Parallel with:** 1.1, 1.3

In `AdapterManager.addAdapter()` and `testConnection()`, set `builtin: false` instead of `manifest.builtin`. Add startup migration in `initialize()` that corrects existing `builtin: true` on non-`claude-code` adapters.

**Tests:** Extend `apps/server/src/services/relay/__tests__/adapter-manager.test.ts` — new adapters get `builtin: false`, migration corrects existing, claude-code preserved.

---

### Task 1.5 — Add routing failure event recording in BindingRouter

**Size:** Medium | **Priority:** Medium | **Parallel with:** all P1 tasks

Add optional `eventRecorder` to `BindingRouterDeps`. When a binding's agent is not found during routing, record a `binding.routing_failed` event via the recorder. Wire the recorder through `BindingSubsystemDeps` from `AdapterManager`.

**Tests:** Extend `apps/server/src/services/relay/__tests__/binding-router.test.ts` — event recorded on routing failure, no event on success.

---

## Phase 2: Multi-Instance Routing

Instance-aware subject encoding and routing. Tasks must run sequentially: 2.1 -> 2.2 -> 2.3 -> 2.4.

### Task 2.1 — Make ThreadIdCodec constructors accept optional instance ID

**Size:** Medium | **Priority:** High

Modify all three codec implementations (`TelegramThreadIdCodec`, `SlackThreadIdCodec`, `ChatSdkTelegramThreadIdCodec`) in `packages/relay/src/lib/thread-id.ts` to accept an optional `instanceId` parameter. When provided, the prefix becomes `relay.human.<platform>.<instanceId>`. When omitted, legacy format is preserved.

**Tests:** Extend `packages/relay/src/lib/__tests__/thread-id.test.ts` — instance-aware encoding, round-trip, cross-instance isolation, backward compat.

---

### Task 2.2 — Update adapters to pass instance ID to codec and subject prefix

**Size:** Large | **Priority:** High | **Depends on:** 2.1

Update `TelegramAdapter`, `SlackAdapter`, and `ChatSdkTelegramAdapter` constructors to pass `id` to the codec and use `codec.prefix` as the `BaseRelayAdapter` subject prefix. Remove module-level singleton codecs from inbound/outbound modules and parameterize handler functions to accept the codec.

**Files:**

- `packages/relay/src/adapters/telegram/telegram-adapter.ts`
- `packages/relay/src/adapters/telegram/inbound.ts`
- `packages/relay/src/adapters/slack/slack-adapter.ts`
- `packages/relay/src/adapters/slack/inbound.ts`
- `packages/relay/src/adapters/telegram-chatsdk/inbound.ts`
- `packages/relay/src/adapters/telegram-chatsdk/outbound.ts`

---

### Task 2.3 — Update BindingRouter.parseSubject() and remove resolveAdapterInstanceId

**Size:** Large | **Priority:** High | **Depends on:** 2.2, 1.5

Rewrite `parseSubject()` in `BindingRouter` to extract the adapter instance ID from the new subject format. Remove `resolveAdapterInstanceId` from `BindingRouterDeps`, `BindingSubsystemDeps`, and the closure in `AdapterManager.initBindingSubsystem()`. Delete or update `subject-resolver.test.ts`.

---

### Task 2.4 — Update documentation for instance-aware subject format

**Size:** Small | **Priority:** Low | **Depends on:** 2.3

Update `contributing/relay-adapters.md` with the new instance-aware subject format and `contributing/adapter-catalog.md` with corrected `builtin` flag semantics.

---

## Dependency Graph

```
1.1 ──→ 1.2
1.3 ─┐
1.4 ─┤ (parallel)
1.5 ─┘
2.1 ──→ 2.2 ──→ 2.3 ──→ 2.4
                  ↑
                 1.5
```
