---
slug: auto-hide-tool-calls
---

# Auto-Hide Completed Tool Calls

**Slug:** auto-hide-tool-calls
**Author:** Claude Code
**Date:** 2026-02-12
**Related:** N/A

---

## 1) Intent & Assumptions

- **Task brief:** Add a setting that makes tool call components fade out and disappear from the chat shortly after they complete. Tool calls are visible while in-progress but auto-hide ~5 seconds after completion. The default behavior should be to auto-hide (setting ON by default). The exit animation should feel polished and elegant — no abrupt jumps or layout shifts.

- **Assumptions:**
  - Only non-interactive tool calls (ToolCallCard) auto-hide. Interactive tools (ToolApproval, QuestionPrompt) never auto-hide.
  - Tool calls already loaded from history (status already `complete`) should not be shown at all when the setting is on — they were already hidden.
  - The "Expand tool calls" setting becomes irrelevant for hidden tool calls (expand only matters for visible ones).
  - The animation happens *inside* each MessageItem, not at the virtualized list level. TanStack Virtual doesn't need to know about the animation.

- **Out of scope:**
  - Changing how tool calls are stored in JSONL transcripts
  - Server-side filtering of tool calls
  - Any changes to ToolApproval or QuestionPrompt behavior
  - A "show all hidden tool calls" button (could be future work)

## 2) Pre-reading Log

- `apps/client/src/components/chat/ToolCallCard.tsx`: Renders individual tool call with expandable details. Already uses AnimatePresence for expand/collapse animation. Accepts `toolCall: ToolCallState` with `status` field and `defaultExpanded` prop.
- `apps/client/src/components/chat/MessageItem.tsx`: Renders message parts via `parts.map()`. Routes to ToolCallCard, ToolApproval, or QuestionPrompt based on part type/interactiveType. Reads `expandToolCalls` from app-store.
- `apps/client/src/components/chat/MessageList.tsx`: Virtualized list using TanStack Virtual. Each message is a virtual item. Animation of tool calls happens *inside* each message item — the virtualizer doesn't need to know.
- `apps/client/src/components/chat/ChatPanel.tsx`: Already imports `AnimatePresence` from `motion/react` for the scroll-to-bottom button.
- `apps/client/src/hooks/use-chat-session.ts`: Manages tool call lifecycle. `ToolCallState.status` transitions: `pending` -> `running` -> `complete` (or `error`). The status is already tracked — no changes needed.
- `apps/client/src/stores/app-store.ts`: Zustand store with localStorage persistence. Pattern: boolean setting with `gateway-*` key prefix. `expandToolCalls` is the closest analog.
- `apps/client/src/components/settings/SettingsDialog.tsx`: Settings dialog with Preferences section. Each setting uses `SettingRow` component with `Switch` control.
- `apps/client/src/components/chat/__tests__/ToolCallCard.test.tsx`: Tests mock `motion/react` (renders plain elements) and `AnimatePresence` (renders children directly).
- `apps/client/src/components/chat/__tests__/MessageItem.test.tsx`: Tests mock motion, Streamdown, ToolApproval, QuestionPrompt. Tests tool call rendering.
- `developer-guides/07-animations.md`: Documents motion library patterns including AnimatePresence exit animations and anti-patterns.

## 3) Codebase Map

**Primary Components/Modules:**
- `apps/client/src/components/chat/ToolCallCard.tsx` — Tool call display with expand/collapse
- `apps/client/src/components/chat/MessageItem.tsx` — Message renderer, dispatches to tool components
- `apps/client/src/stores/app-store.ts` — Client preferences store
- `apps/client/src/components/settings/SettingsDialog.tsx` — Settings UI

**Shared Dependencies:**
- `motion/react` — AnimatePresence, motion.div (already used in ToolCallCard, ChatPanel)
- `apps/client/src/hooks/use-chat-session.ts` — ToolCallState type with status field

**Data Flow:**
SSE stream -> useChatSession (tracks tool status transitions) -> MessageItem (renders parts) -> ToolCallCard (displays tool call, reads autoHide setting, manages hide timer)

**Feature Flags/Config:**
- New: `autoHideToolCalls` boolean in Zustand store (localStorage key: `gateway-auto-hide-tool-calls`)

**Potential Blast Radius:**
- Direct: 4 files (ToolCallCard, MessageItem, app-store, SettingsDialog)
- Tests: 3 test files (ToolCallCard.test, MessageItem.test, app-store.test)
- No server changes, no shared package changes

## 4) Root Cause Analysis

N/A — this is a new feature, not a bug fix.

## 5) Research

### Animation Approach: AnimatePresence Inside MessageItem

The key architectural insight is that tool calls animate *within* their parent message container, not as list items being removed from the virtualized list. This means:

- **No conflict with TanStack Virtual** — the virtualizer manages message-level items; tool call visibility is an internal concern of each MessageItem
- **No `layout` prop needed** — we're not reordering siblings across different messages
- **AnimatePresence works naturally** — each ToolCallCard can be conditionally rendered inside an AnimatePresence wrapper

### Recommended Animation Pattern: Nested Div (Outer Height + Inner Opacity)

The consensus best practice from multiple sources:

```tsx
<AnimatePresence>
  {visible && (
    <motion.div
      key={toolCallId}
      initial={{ height: 'auto', opacity: 1 }}
      exit={{ height: 0, opacity: 0 }}
      transition={{ duration: 0.3, ease: [0.4, 0, 0.2, 1] }}
      className="overflow-hidden"
    >
      <ToolCallCard ... />
    </motion.div>
  )}
</AnimatePresence>
```

Why this works:
- Height collapses smoothly (motion measures actual height, interpolates to 0)
- Opacity fades simultaneously
- `overflow-hidden` prevents content from overflowing during collapse
- No layout jump for siblings — the space naturally closes as height → 0

### Naming Research

| Option | Assessment |
|--------|-----------|
| "Auto-hide tool calls" | Clear, uses familiar "auto-hide" UX pattern (VS Code, browser toolbars) |
| "Fade completed tools" | Describes the visual effect but sounds decorative |
| "Minimize completed tools" | Implies collapsing rather than hiding |
| "Clean chat" | Too vague — what does "clean" mean? |
| "Compact mode" | Usually means density/spacing, not hiding elements |

**Recommendation: "Auto-hide tool calls"**
- Internal name: `autoHideToolCalls`
- Setting label: **"Auto-hide tool calls"**
- Setting description: **"Fade out completed tool calls after a few seconds"**

### Default State: The Naming Paradox

The user wants auto-hide ON by default. But all other preferences default to OFF (false). Two options:

**Option A: Store as `autoHideToolCalls` (default true)**
- Setting label: "Auto-hide tool calls"
- Toggle ON = tool calls hide (default)
- Toggle OFF = tool calls persist
- Pro: Matches the mental model ("turn on auto-hide")
- Con: Breaks the pattern where all prefs default to false

**Option B: Store as `showCompletedToolCalls` (default false)**
- Setting label: "Show completed tool calls"
- Toggle ON = tool calls persist
- Toggle OFF = tool calls hide (default)
- Pro: All prefs consistently default to false/off
- Con: Double-negative logic ("don't show" = hide), less intuitive

**Recommendation: Option A** — The UX clarity of "Auto-hide tool calls: ON" outweighs the internal consistency of all-false defaults. Users will immediately understand what this does. The fact that one preference has a different default is a minor implementation detail.

### Handling Historical Messages

When a user opens a session with history, completed tool calls are already `status: 'complete'`. Three options:

1. **Don't show them at all** — if `autoHideToolCalls` is on, filter them out during render. No animation needed for already-hidden items.
2. **Show them briefly, then hide** — animate every historical tool call on load. Terrible UX — the whole chat would be shimmering.
3. **Show them collapsed/dimmed** — show a minimal indicator. Adds complexity.

**Recommendation: Option 1** — Simply don't render completed non-interactive tool calls from history when the setting is on. Only animate the exit for tool calls that *become* complete during the current session (i.e., the user watches them transition from running → complete → fade out).

## 6) Clarifications

1. **Delay duration**: The prompt says "5 seconds." Should this be configurable, or is 5s fixed? (Recommendation: fixed at 5s for simplicity; can add a slider later if users request it.)

2. **Error state**: Should tool calls with `status: 'error'` also auto-hide? (Recommendation: No — errors should remain visible so the user can see what went wrong.)

3. **Toggle interaction with "Expand tool calls"**: When auto-hide is ON and expand is also ON, tool calls would briefly show expanded then fade out. This is fine — it's 5 seconds of expanded detail before hiding. Should we address this explicitly or let the two settings compose naturally? (Recommendation: let them compose naturally.)

4. **Re-showing hidden tool calls**: Should there be any way to see tool calls that were hidden? The "Expand tool calls" toggle only controls the default expansion state for visible tool calls. (Recommendation: Not in v1. Users can toggle auto-hide OFF to see all tool calls. Future work could add a "Show hidden" per-message button.)

5. **Mid-stream toggle**: If the user turns auto-hide OFF while tool calls are in the process of fading, should the animation reverse? (Recommendation: No — let any in-progress animations complete. The setting change applies to future completions only.)
