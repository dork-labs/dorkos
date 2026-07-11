---
slug: task-completion-notifications
linearIssue: DOR-240
status: Complete
lastUpdated: 2026-07-10
---

# Implementation Record — Automatic task-completion notifications

**Status:** Complete
**Author:** Chime (flow EXECUTE)
**Date:** 2026-07-10

## Session 1 — 2026-07-10

- **Worktree:** `.claude/worktrees/spec-task-completion-notifications`
- **Branch:** `spec-task-completion-notifications` (based on `origin/main`)

### What was built

A system-level notification actor that fires when any Task run reaches a terminal
status, resolves the linked agent's bound channel, and delivers a completion
message through the existing Relay pipeline — zero agent cooperation.

Implements Phase 1 (MVP/core) and the Phase 2 binding-UI toggle + bootstrap hint.
Per-task `notifyOnComplete` override (rest of Phase 2) and Phase 3 are deferred —
see Deviations.

### How it maps to the spec + recorded decisions

| Spec / decision                                                                                  | Implementation                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Single store-level terminal hook firing exactly once (DOR-248 chokepoint)                        | `TaskStore.setOnRunTerminal` + fire inside `updateRun` after the DB write, only on a non-terminal→terminal transition, dispatched `queueMicrotask` and wrapped in try/catch. `apps/server/src/services/tasks/task-store.ts` |
| `TaskCompletionNotifier` service consuming the hook                                              | `apps/server/src/services/tasks/task-completion-notifier.ts` — status policy, opt-in gate, target resolution, bounded publish; never throws                                                                                 |
| Binding/permission resolution EXTRACTED AND SHARED with `relay_notify_user`                      | `resolveNotifyTarget` in `apps/server/src/services/relay/notify-target.ts`; `createRelayNotifyUserHandler` refactored to call it (13 DOR-239 tests stay green)                                                              |
| Delivery via `RelayCore.publish` with a bounded budget (PR #210 gate)                            | `{ from: 'relay.system.tasks.notifier', budget: { maxHops: 2, ttl: now+30s, callBudgetRemaining: 1 } }`                                                                                                                     |
| Always notify failures / opt-in successes / never cancellations                                  | Status policy in `handle()`                                                                                                                                                                                                 |
| Telegram no-chat-session = silent no-op that never errors a run                                  | Every "cannot resolve" outcome returns silently, logged at debug; hook is try/catch + fire-and-forget                                                                                                                       |
| Decision 1: `notifyOnTaskComplete` defaults **true**, gated behind `canInitiate` (default false) | `AdapterBindingSchema.notifyOnTaskComplete: z.boolean().default(true)`; `canInitiate` remains the real gate                                                                                                                 |
| Decision 2: global agent-less tasks do not notify in v1                                          | `agentId == null` → return early                                                                                                                                                                                            |
| Decision 3: message copy (one emoji, name + duration + first output line, ~200 chars)            | `formatCompletionMessage`                                                                                                                                                                                                   |
| Surface the toggle in the ChannelsTab UI + bootstrap hint                                        | `BindingAdvancedSection` toggle "Message me when tasks finish" + "message your bot once" hint (gated on no observed chats); wired through `binding-form.ts`, `BindingDialog.tsx`, agent-settings `ChannelsTab.tsx`          |
| Wiring                                                                                           | `apps/server/src/index.ts` — after AdapterManager init, `taskStore.setOnRunTerminal(...)` covers both relay and direct paths (shared in-process `TaskStore`)                                                                |

### Files

- `packages/shared/src/relay-adapter-schemas.ts` — `notifyOnTaskComplete` on binding + update schemas
- `apps/server/src/services/relay/notify-target.ts` — shared resolver (new)
- `apps/server/src/services/tasks/task-completion-notifier.ts` — notifier + message formatter (new)
- `apps/server/src/services/tasks/task-store.ts` — terminal hook
- `apps/server/src/services/runtimes/claude-code/mcp-tools/relay-tools.ts` — refactor to shared resolver
- `apps/server/src/index.ts` — wiring
- Client: `binding-form.ts`, `BindingAdvancedSection.tsx`, `BindingDialog.tsx`, agent-settings `ChannelsTab.tsx`
- `packages/test-utils/src/mock-factories.ts` — `createMockBinding` includes the field
- Tests: `notify-target.test.ts`, `task-completion-notifier.test.ts`, `task-store-terminal-hook.test.ts`, `task-completion-notifier.integration.test.ts`

### Verification

- `notify-target` (8), `task-completion-notifier` (16), `task-store-terminal-hook` (5), integration (1), `task-store` regression (44) — all green.
- `mcp-relay-notify-tools` DOR-239 regression: 13/13 green after the resolver refactor.
- Client binding + agent-settings suites: 191/191 green.
- Server + client typecheck clean; server + client lint clean (2 pre-existing `max-lines` warnings only).
- Real Telegram delivery with a live bot token is **not** part of this merge — it stays on the founder's phone checklist (demo-claim gate). The reality-ledger update happens only after that live-token verification.

### Deviations

- **Per-task `notifyOnComplete` override deferred.** The spec's Phase 2 lists a per-task override
  (`task.notifyOnComplete ?? binding.notifyOnTaskComplete`). It needs a `pulse_schedules` DB column,
  a SKILL.md frontmatter key, and threading across create/update/mapRow. The recorded founder
  decisions and the acceptance criterion center on the one-toggle binding-level opt-in, so v1 ships
  the binding opt-in only; opt-in resolves to `binding.notifyOnTaskComplete`. Adding the per-task
  override later is additive.
