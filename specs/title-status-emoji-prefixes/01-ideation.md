---
slug: title-status-emoji-prefixes
number: 29
created: 2026-02-13
status: implemented
---

# Title Status Emoji Prefixes

**Slug:** title-status-emoji-prefixes
**Author:** Claude Code
**Date:** 2026-02-13
**Related:** N/A

---

## 1) Intent & Assumptions

**Task brief:** Add emoji prefixes to the document title to communicate two session states when the user has tabbed away:

1. **Response complete (unseen):** Show a checkered flag emoji (🏁) before the cwd emoji when the AI has finished responding and the user hasn't returned to see it yet.
2. **Waiting for user input:** Show an attention emoji before the cwd emoji when the AI is blocked waiting for user action — tool approval, question prompt answer, etc.

**Assumptions:**

- Prefixes appear _before_ the existing cwd emoji in the title (e.g., `🏁 🐸 myproject — DorkOS`)
- The "unseen response" flag is cleared when the user returns to the tab (via Page Visibility API)
- The "waiting for input" flag is derived from existing `isWaitingForUser` state already computed in `useChatSession`
- Only one status prefix shows at a time (waiting > completion priority, since waiting is more actionable)
- Embedded mode (Obsidian) is excluded, matching existing `useFavicon`/`useDocumentTitle` behavior

**Out of scope:**

- Favicon changes for these states (favicon already has pulse animation for streaming)
- Desktop notifications / Notification API
- Sound/audio cues (handled by separate notification system)
- Mobile-specific behavior

## 2) Pre-reading Log

- `apps/client/src/hooks/use-document-title.ts`: Current title composition — `{emoji} {dirname} — {activeForm} — DorkOS`. Takes `{ cwd, activeForm }` options. Simple effect that sets `document.title`.
- `apps/client/src/hooks/__tests__/use-document-title.test.ts`: Tests for title structure, truncation, null cwd fallback.
- `apps/client/src/App.tsx` (L30-33): Integration point — `useDocumentTitle({ cwd: embedded ? null : selectedCwd, activeForm })`. Also reads `isStreaming` from Zustand store.
- `apps/client/src/hooks/use-chat-session.ts` (L524-534): Already computes `isWaitingForUser` (boolean) and `waitingType` ('approval' | 'question' | null) from pending interactive tool calls.
- `apps/client/src/hooks/use-chat-session.ts` (L144-165): Already tracks `isTabVisible` via `document.visibilitychange` for adaptive polling.
- `apps/client/src/hooks/use-session-status.ts`: Derives session status from chat state.
- `apps/client/src/hooks/use-idle-detector.ts`: Existing idle detector hook using `visibilitychange` + activity events. Returns `{ isIdle }`. Has `onIdle`/`onReturn` callbacks.
- `apps/client/src/stores/app-store.ts` (L63-66): Zustand store has `isStreaming`, `setIsStreaming`, `activeForm`, `setActiveForm`.
- `apps/client/src/components/chat/ChatPanel.tsx` (L217-225): Syncs `status` and `activeForm` from `useChatSession` into Zustand app store.
- `apps/client/src/lib/favicon-utils.ts`: `hashToEmoji()` used to get cwd emoji for title.

## 3) Codebase Map

**Primary components/modules:**

- `apps/client/src/hooks/use-document-title.ts` — Hook that will be extended with prefix logic
- `apps/client/src/App.tsx` — Mount point for hook, will pass additional props
- `apps/client/src/stores/app-store.ts` — Zustand store for cross-component state
- `apps/client/src/components/chat/ChatPanel.tsx` — Syncs chat state to app store

**Shared dependencies:**

- `apps/client/src/lib/favicon-utils.ts` — `hashToEmoji()` for cwd-based emoji
- `apps/client/src/hooks/use-chat-session.ts` — Source of `isWaitingForUser`, `waitingType`, `status`
- `apps/client/src/hooks/use-idle-detector.ts` — Existing visibility/idle detection

**Data flow:**
`useChatSession` computes `isWaitingForUser` + `status` → `ChatPanel` syncs to Zustand store → `App.tsx` reads from store → `useDocumentTitle` builds title with prefix

**Potential blast radius:**

- Direct: 3 files (`use-document-title.ts`, `app-store.ts`, `App.tsx`)
- Indirect: `ChatPanel.tsx` (new sync for `isWaitingForUser`)
- Tests: 2 test files (`use-document-title.test.ts`, possibly `ChatPanel.test.tsx`)

## 4) Research

### Potential Solutions

**1. Extend `useDocumentTitle` with new state props**

- Description: Add `isWaitingForUser`, `hasUnseenResponse` props to the existing hook. Add tab visibility tracking inside the hook. Compose title prefix based on state priority.
- Pros:
  - Minimal new code — extends existing hook
  - All title logic stays in one place
  - Visibility tracking is scoped to the hook that needs it
- Cons:
  - Hook grows in responsibility (title + visibility tracking)
  - Need to sync `isWaitingForUser` up to App.tsx level via Zustand
- Complexity: Low
- Maintenance: Low

**2. Create a separate `useTitleNotification` hook**

- Description: New hook manages just the prefix logic — tracks visibility, computes prefix, passes it to `useDocumentTitle`.
- Pros:
  - Clean separation of concerns
  - Title notification logic is isolated and testable
- Cons:
  - Another hook to coordinate
  - Ordering between hooks matters (prefix must be computed before title is set)
- Complexity: Medium
- Maintenance: Medium

**3. Inline visibility + prefix logic in `useDocumentTitle` (Recommended)**

- Description: Add `isWaitingForUser` and `isStreaming` to `useDocumentTitle` options. Track visibility state inside the hook. Compute "unseen response" by detecting the transition from streaming → idle while tab is hidden. Compute prefix and prepend to title.
- Pros:
  - Single hook, single responsibility (document title management)
  - Visibility tracking is an implementation detail, not exposed
  - "Unseen response" state is derived internally — no new Zustand state needed for it
  - Clean API: `useDocumentTitle({ cwd, activeForm, isStreaming, isWaitingForUser })`
- Cons:
  - Hook is slightly larger
- Complexity: Low
- Maintenance: Low

### Emoji Selection

Research indicates the following work well at small browser tab sizes:

| State                      | Emoji             | Rationale                                                                                  |
| -------------------------- | ----------------- | ------------------------------------------------------------------------------------------ |
| Response complete (unseen) | 🏁 Checkered Flag | User's explicit preference. Distinct, clear at small sizes.                                |
| Waiting for user input     | 🔔 Bell           | Universal notification symbol. High visibility. Well-established mental model from mobile. |

Alternative for "waiting": ⚠️ Warning — signals urgency but may feel alarming for routine approvals. 🔔 is friendlier.

### Clearing Strategy

- **Unseen response (🏁):** Clear when `document.visibilityState` transitions to `"visible"` (user returns to tab)
- **Waiting for user (🔔):** Clear when `isWaitingForUser` becomes false (user acted on it, or state resolved)
- **Priority:** 🔔 > 🏁 — if both states are true, show 🔔 because it requires action

### Performance

`document.title` changes are lightweight DOM operations that don't trigger layout/paint. No throttling needed. The prefix will change at most a few times per session — not rapidly.

## 5) Clarification

1. **Emoji for "waiting for input":** The user specified 🏁 for completion. For the "waiting" state, research suggests 🔔 (bell) as most recognizable. Is 🔔 the right choice, or would you prefer something else (⚠️, ⏳, 👋)?
2. **Priority when both states overlap:** If the AI finishes a response (unseen) and is also waiting for user input (e.g., tool approval at end of response), should we show 🔔 (more actionable) or 🏁?
3. **Should the prefix also show when the user IS on the tab?** The current spec says "user has tabbed away" for the checkered flag. Should the 🔔 "waiting for input" prefix show regardless of tab focus (since the user might not have noticed), or only when tabbed away?
