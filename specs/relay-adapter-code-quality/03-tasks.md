# Task Breakdown: Relay Adapter System Code Quality & DRY Remediation

Generated: 2026-03-18
Source: specs/relay-adapter-code-quality/02-specification.md
Last Decompose: 2026-03-18

## Overview

Structural code quality remediation of the Relay adapter system. No new features — only bringing existing implementations up to the project's quality standard. Addresses 6 DRY violations, 2 file size breaches (500-line limit), module-level mutable state shared across multi-instance adapters, an incomplete Telegram markdown formatter, and fragile `as unknown` API casts.

**Zero behavioral changes** — all existing tests must continue to pass. Zero breaking changes to the public `@dorkos/relay` API surface.

---

## Phase 1: Foundation

Shared utilities and base class improvements that later phases depend on.

### Task 1.1 — Extract envelope helpers to payload-utils.ts

**Size:** Small | **Priority:** High | **Parallel with:** 1.2, 1.3

Move `extractAgentIdFromEnvelope` and `extractSessionIdFromEnvelope` from both `telegram/outbound.ts` and `slack/outbound.ts` to the shared `packages/relay/src/lib/payload-utils.ts`. Delete local copies, update imports, add unit tests.

**Files modified:**

- `packages/relay/src/lib/payload-utils.ts` (add functions + RelayEnvelope import)
- `packages/relay/src/adapters/telegram/outbound.ts` (delete locals, add import)
- `packages/relay/src/adapters/slack/outbound.ts` (delete locals, add import)
- `packages/relay/src/lib/__tests__/payload-utils.test.ts` (add tests)

---

### Task 1.2 — Move callback factories to BaseRelayAdapter

**Size:** Small | **Priority:** High | **Parallel with:** 1.1, 1.3

Add `makeInboundCallbacks()` and `makeOutboundCallbacks()` as protected methods on `BaseRelayAdapter`. Define `AdapterInboundCallbacks` and `AdapterOutboundCallbacks` interfaces. Remove duplicate private methods from `TelegramAdapter` and `SlackAdapter`.

**Files modified:**

- `packages/relay/src/base-adapter.ts` (add interfaces + methods)
- `packages/relay/src/adapters/telegram/telegram-adapter.ts` (delete duplicates)
- `packages/relay/src/adapters/slack/slack-adapter.ts` (delete duplicates)
- `packages/relay/src/__tests__/base-adapter.test.ts` (add tests)

---

### Task 1.3 — Implement Telegram MarkdownV2 formatting

**Size:** Medium | **Priority:** High | **Parallel with:** 1.1, 1.2

Replace the passthrough TODO in `formatForPlatform('telegram')` with `markdownToTelegramHtml` — converts standard Markdown to Telegram's HTML subset (`<b>`, `<i>`, `<code>`, `<pre>`, `<a>`, `<s>`). Update Telegram outbound to use `parse_mode: 'HTML'`.

**Files modified:**

- `packages/relay/src/lib/payload-utils.ts` (add `markdownToTelegramHtml`, update switch case)
- `packages/relay/src/adapters/telegram/outbound.ts` (add `parse_mode: 'HTML'` to send calls)
- `packages/relay/src/lib/__tests__/payload-utils.test.ts` (11+ test cases)

---

## Phase 2: File Splitting

Bring oversized files under the 500-line hard limit.

### Task 2.1 — Split slack/outbound.ts into three files

**Size:** Large | **Priority:** High | **Depends on:** 1.1 | **Parallel with:** 2.2

Split `slack/outbound.ts` (975 lines) into:

- `outbound.ts` (~300 lines) — main delivery router
- `stream.ts` (~350 lines) — streaming delivery
- `approval.ts` (~250 lines) — tool approval handling

**Files created:**

- `packages/relay/src/adapters/slack/stream.ts`
- `packages/relay/src/adapters/slack/approval.ts`

**Files modified:**

- `packages/relay/src/adapters/slack/outbound.ts` (reduced to ~300 lines)
- `packages/relay/src/adapters/slack/index.ts` (barrel unchanged or updated)

---

### Task 2.2 — Split adapter-manager.ts into two files

**Size:** Medium | **Priority:** High | **Parallel with:** 2.1

Split `adapter-manager.ts` (590 lines) into:

- `adapter-manager.ts` (~350 lines) — adapter lifecycle
- `binding-subsystem.ts` (~250 lines) — binding initialization

**Files created:**

- `apps/server/src/services/relay/binding-subsystem.ts`

**Files modified:**

- `apps/server/src/services/relay/adapter-manager.ts` (reduced to ~350 lines)
- `apps/server/src/services/relay/index.ts` (barrel updated)

---

## Phase 3: State & Type Safety

Instance-scope mutable state and isolate streaming API casts.

### Task 3.1 — Instance-scope Telegram outbound state

**Size:** Medium | **Priority:** High | **Depends on:** 1.1, 1.2 | **Parallel with:** 3.2, 3.3

Move 4 module-level Maps (`typingIntervals`, `lastDraftUpdate`, `callbackIdMap`, `pendingApprovalTimeouts`) into a `TelegramOutboundState` container. Created per instance in `TelegramAdapter` constructor, passed via delivery options, cleared on `_stop()`.

**Files modified:**

- `packages/relay/src/adapters/telegram/outbound.ts` (remove module state, accept state param)
- `packages/relay/src/adapters/telegram/telegram-adapter.ts` (create state, pass to delivery, clear on stop)

---

### Task 3.2 — Instance-scope Slack outbound state

**Size:** Small | **Priority:** High | **Depends on:** 2.1, 1.2 | **Parallel with:** 3.1, 3.3

Move module-level `pendingApprovalTimeouts` Map into a `SlackOutboundState` container. Created per instance in `SlackAdapter` constructor, passed via delivery options, cleared on `_stop()`.

**Files modified:**

- `packages/relay/src/adapters/slack/approval.ts` or `outbound.ts` (remove module state, accept state param)
- `packages/relay/src/adapters/slack/slack-adapter.ts` (create state, pass to delivery, clear on stop)

---

### Task 3.3 — Create typed streaming API wrappers

**Size:** Medium | **Priority:** Medium | **Depends on:** 2.1 | **Parallel with:** 3.1, 3.2

Create `telegram/stream-api.ts` (typed `sendMessageDraft` wrapper) and `slack/stream-api.ts` (typed `startStream`, `appendStream`, `stopStream` wrappers). Remove all inline `as unknown` casts from delivery code.

**Files created:**

- `packages/relay/src/adapters/telegram/stream-api.ts`
- `packages/relay/src/adapters/slack/stream-api.ts`
- `packages/relay/src/adapters/telegram/__tests__/stream-api.test.ts`
- `packages/relay/src/adapters/slack/__tests__/stream-api.test.ts`

**Files modified:**

- `packages/relay/src/adapters/telegram/outbound.ts` (use wrapper)
- `packages/relay/src/adapters/slack/stream.ts` (use wrapper)

---

## Phase 4: Cleanup

Final type cleanup, WebhookAdapter migration, documentation, and regression testing.

### Task 4.1 — Eliminate PublishResultLike type alias

**Size:** Small | **Priority:** Medium | **Parallel with:** 4.2, 4.3

Move `PublishResult` from `relay-publish.ts` to `types.ts`. Delete `PublishResultLike`. Update all references.

**Files modified:**

- `packages/relay/src/types.ts` (add `PublishResult`)
- `packages/relay/src/relay-publish.ts` (import from types, delete alias)
- Any files referencing `PublishResultLike`

---

### Task 4.2 — Migrate WebhookAdapter to extend BaseRelayAdapter

**Size:** Medium | **Priority:** Medium | **Depends on:** 1.2 | **Parallel with:** 4.1, 4.3

Refactor `WebhookAdapter` to extend `BaseRelayAdapter`, eliminating ~80 lines of manual status tracking, start/stop idempotency, and `setLogger()`. Preserve `handleInbound()` as a public method for Express routes.

**Files modified:**

- `packages/relay/src/adapters/webhook/webhook-adapter.ts` (extend BaseRelayAdapter)

---

### Task 4.3 — Update relay-adapters.md and run full regression suite

**Size:** Small | **Priority:** Medium | **Depends on:** 3.1, 3.2, 3.3, 4.1, 4.2

Update `contributing/relay-adapters.md` with new patterns (callback factories on BaseRelayAdapter, shared envelope helpers, instance-scoped state guidance, streaming wrapper pattern). Verify barrel exports. Run full test suite, type checking, and linting.

**Files modified:**

- `contributing/relay-adapters.md`
- `packages/relay/src/index.ts` (verify exports)

---

## Dependency Graph

```
Phase 1 (all parallel):
  1.1  Extract envelope helpers
  1.2  Move callback factories
  1.3  Telegram markdown formatting

Phase 2 (parallel, after 1.1):
  2.1  Split slack/outbound.ts        [depends: 1.1]
  2.2  Split adapter-manager.ts       [no deps]

Phase 3 (parallel, after P1/P2):
  3.1  Telegram instance state        [depends: 1.1, 1.2]
  3.2  Slack instance state           [depends: 2.1, 1.2]
  3.3  Streaming API wrappers         [depends: 2.1]

Phase 4 (after P3):
  4.1  Eliminate PublishResultLike     [no deps]
  4.2  WebhookAdapter migration       [depends: 1.2]
  4.3  Docs + regression suite        [depends: 3.1, 3.2, 3.3, 4.1, 4.2]
```

## Summary

| Phase                   | Tasks  | Sizes                          |
| ----------------------- | ------ | ------------------------------ |
| P1: Foundation          | 3      | 2 small, 1 medium              |
| P2: File Splitting      | 2      | 1 large, 1 medium              |
| P3: State & Type Safety | 3      | 1 small, 2 medium              |
| P4: Cleanup             | 3      | 2 small, 1 medium              |
| **Total**               | **11** | **4 small, 5 medium, 1 large** |
