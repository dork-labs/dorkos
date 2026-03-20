# Prompt Suggestion Chips — Task Breakdown

**Spec:** `specs/prompt-suggestion-chips/02-specification.md`
**Generated:** 2026-03-16
**Mode:** Full decomposition

---

## Phase 1: Foundation

### Task 1.1 — Add PromptSuggestionEvent schema and type to shared package

**Size:** Small | **Priority:** High | **Dependencies:** None

Add `'prompt_suggestion'` to `StreamEventTypeSchema`, create `PromptSuggestionEventSchema` with a `suggestions: z.array(z.string())` field, add it to the `StreamEventSchema` data union, and re-export the type from `types.ts`.

**Files:**

- `packages/shared/src/schemas.ts` — new enum value, new schema, union addition
- `packages/shared/src/types.ts` — type re-export

**Tests:** Schema validation tests (valid object, missing field, non-array, empty array, full StreamEvent acceptance).

---

### Task 1.2 — Enable SDK prompt suggestions and map event in server

**Size:** Medium | **Priority:** High | **Dependencies:** 1.1

Add `promptSuggestions: true` to `sdkOptions` in `message-sender.ts`. Add a `prompt_suggestion` branch to `sdk-event-mapper.ts` that yields `{ type: 'prompt_suggestion', data: { suggestions } }` when suggestions is a non-empty array.

**Files:**

- `apps/server/src/services/runtimes/claude-code/message-sender.ts` — SDK option
- `apps/server/src/services/runtimes/claude-code/sdk-event-mapper.ts` — new branch

**Tests:** Three test cases in `sdk-event-mapper.test.ts`: valid suggestions, empty array (dropped), non-array (dropped).

---

## Phase 2: Client Integration

### Task 2.1 — Add prompt_suggestion case to stream event handler

**Size:** Medium | **Priority:** High | **Dependencies:** 1.1

Add `PromptSuggestionEvent` import, `setPromptSuggestions` to `StreamEventDeps`, and a `prompt_suggestion` switch case that calls `deps.setPromptSuggestions(suggestions)`. Update all existing stream-event-handler test files to include `setPromptSuggestions: vi.fn()` in their deps.

**Files:**

- `apps/client/src/layers/features/chat/model/stream-event-handler.ts` — import, deps, case
- `apps/client/src/layers/features/chat/model/__tests__/stream-event-handler-suggestions.test.ts` — new test file
- 5 existing test files — add `setPromptSuggestions` to deps

---

### Task 2.2 — Add promptSuggestions state to use-chat-session hook

**Size:** Small | **Priority:** High | **Dependencies:** 2.1

Add `useState<string[]>([])` for `promptSuggestions`, wire `setPromptSuggestions` into stream handler deps, clear on `executeSubmission`, return from hook.

**Files:**

- `apps/client/src/layers/features/chat/model/use-chat-session.ts` — state, deps wiring, clear, return

---

### Task 2.3 — Create PromptSuggestionChips component

**Size:** Medium | **Priority:** High | **Dependencies:** None | **Parallel with:** 2.1, 2.2

Create `PromptSuggestionChips.tsx` following `ShortcutChips.tsx` pattern. Shows up to 4 chips with `Sparkles` icon, fade animation, `role="group"`, truncation for long text.

**Files:**

- `apps/client/src/layers/features/chat/ui/PromptSuggestionChips.tsx` — new component
- `apps/client/src/layers/features/chat/ui/__tests__/PromptSuggestionChips.test.tsx` — 6 test cases

---

## Phase 3: Wiring

### Task 3.1 — Wire PromptSuggestionChips into ChatPanel and ChatStatusSection

**Size:** Large | **Priority:** High | **Dependencies:** 2.2, 2.3

Destructure `promptSuggestions` from `useChatSession` in `ChatPanel`. Create `handleSuggestionClick` callback (setInput + focus). Compute `showSuggestions` flag. Pass through `ChatInputContainer` to `ChatStatusSection`. Render `PromptSuggestionChips` in both mobile and desktop paths alongside `ShortcutChips`, wrapped in `AnimatePresence`.

**Files:**

- `apps/client/src/layers/features/chat/ui/ChatPanel.tsx` — destructure, handler, flag, props
- `apps/client/src/layers/features/chat/ui/ChatInputContainer.tsx` — pass-through props
- `apps/client/src/layers/features/chat/ui/ChatStatusSection.tsx` — import, props, render

---

### Task 3.2 — Update API reference documentation with prompt_suggestion event

**Size:** Small | **Priority:** Low | **Dependencies:** 1.1 | **Parallel with:** 3.1

Add `prompt_suggestion` to the SSE event types list on line 62 of `contributing/api-reference.md`.

**Files:**

- `contributing/api-reference.md` — event type list update

---

## Dependency Graph

```
1.1 (schema + types)
 ├── 1.2 (server SDK option + mapper)
 ├── 2.1 (stream event handler)
 │    └── 2.2 (hook state)
 │         └── 3.1 (wiring)
 ├── 2.3 (component) ──┘
 └── 3.2 (docs)
```

## Summary

| Phase                  | Tasks | Size              |
| ---------------------- | ----- | ----------------- |
| 1 — Foundation         | 2     | 1 small, 1 medium |
| 2 — Client Integration | 3     | 1 small, 2 medium |
| 3 — Wiring             | 2     | 1 large, 1 small  |
| **Total**              | **7** |                   |
