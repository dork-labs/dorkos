---
number: 96
title: Place AnimatePresence Session Crossfade at App Root, Not Inside ChatPanel
status: archived
created: 2026-03-09
spec: chat-microinteractions-polish
superseded-by: null
---

# 96. Place AnimatePresence Session Crossfade at App Root, Not Inside ChatPanel

## Status

Draft (auto-extracted from spec: chat-microinteractions-polish)

## Context

DorkOS renders `<ChatPanel key={activeSessionId}>` — the `key` prop forces ChatPanel to fully unmount and remount on every session switch. This is intentional: it resets all hooks (useChatSession, useTaskState, etc.) to a clean state for the new session.

To animate the session switch (fade out old session, fade in new session), `AnimatePresence` must observe the component's mount and unmount lifecycle. `AnimatePresence` can only capture exit animations if it wraps the _keyed_ component — if it is placed inside a component that is itself unmounting, the exit animation cannot fire.

An alternative approach was considered: remove `key={activeSessionId}` from `<ChatPanel>` and handle session reset via useEffect inside ChatPanel. This would allow AnimatePresence to live inside ChatPanel. However, this requires carefully auditing all hooks inside ChatPanel and useChatSession to ensure they reset correctly on sessionId prop changes — a larger, riskier change.

## Decision

`AnimatePresence mode="wait"` is placed in `App.tsx`, wrapping the session content area. The `key` prop migrates from `<ChatPanel key={activeSessionId}>` to a `<motion.div key={activeSessionId}>` wrapper. ChatPanel receives `sessionId` as a prop but no longer carries the `key` itself.

`mode="wait"` ensures the old session fully fades out (150ms) before the new session fades in (150ms), for a total 300ms transition. This prevents visual overlap and makes the switch feel intentional.

## Consequences

### Positive

- ChatPanel's reset-on-key behavior is preserved — no risk of stale hook state
- AnimatePresence correctly observes mount/unmount because it wraps the keyed element
- 150ms exit + 150ms enter is perceptibly fast for a deliberate navigation action

### Negative

- Change required in `App.tsx` (two render sites: desktop and mobile layouts) rather than just ChatPanel
- The 300ms total transition adds latency to session switching — acceptable for deliberate navigation, but could feel slow if users switch sessions rapidly. `mode="wait"` queues transitions so rapid switching works correctly but may feel sluggish.
- If `ChatEmptyState` (shown when `activeSessionId` is null) should also fade, it needs to be wrapped in the `AnimatePresence` with its own `key`
