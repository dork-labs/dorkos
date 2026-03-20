---
slug: interactive-tool-ux
number: 24
created: 2026-02-13
status: implemented
---

# Interactive Tool UX Improvements

**Slug:** interactive-tool-ux
**Author:** Claude Code
**Date:** 2026-02-13
**Branch:** preflight/interactive-tool-ux
**Related:** N/A

---

## 1) Intent & Assumptions

**Task brief:** Improve UX for interactive tool calls (ToolApproval for permissions, QuestionPrompt for AskUser) with three improvements:

1. **Format JSON data** — tool arguments currently display as raw `JSON.stringify(parsed, null, 2)` in a `<pre>` block; instead, render them as formatted key-value displays
2. **"Waiting for response" status** — when tools are waiting for user input, the InferenceIndicator still shows rotating inference verbs ("Contemplating...", "Reasoning..."); it should show a clear "Waiting for your response" message instead
3. **Keyboard shortcuts** — add shortcut keys for approve/deny (Enter/Esc), number keys (1-9) for selecting question options, and Next/Back for multi-question navigation; display shortcuts using a Kbd component hidden on mobile

**Assumptions:**

- No server-side changes needed — all improvements are client-side rendering changes
- The existing interactive tools architecture (deferred promise pattern, Transport abstraction) is stable and does not need modification
- We can create a new Kbd shadcn/ui component (none exists currently)
- `focus-trap-react` is not needed — we can solve focus management with React's existing event system and careful design (see Section 5 deep-dive)
- `react-json-view-lite` or similar library is NOT needed — we can build a simple custom key-value formatter using the existing `tool-labels.ts` pattern and a lightweight recursive renderer

**Out of scope:**

- Changes to the server, SDK, or transport layer
- Adding new interactive tool types
- Auto-approve/auto-deny based on rules
- Refactoring the interactive tools architecture
- Desktop-app-style command palette for tool actions

---

## 2) Pre-reading Log

- `guides/interactive-tools.md` — Full architecture walkthrough of the deferred promise pattern, Promise.race generator, and Transport abstraction. Shows how `approval_required` and `question_prompt` events flow from SDK to UI.
- `apps/client/src/components/chat/ToolApproval.tsx` — 92-line component. Shows raw JSON in `<pre>` via `JSON.stringify(JSON.parse(input), null, 2)`. Has Approve/Deny buttons with no keyboard shortcuts. No focus management.
- `apps/client/src/components/chat/QuestionPrompt.tsx` — 284-line component. Renders radio/checkbox options with tabs for multiple questions. Has submit button. No keyboard shortcuts, no number-key selection. Uses `<textarea>` for "Other" option which creates a focus conflict point.
- `apps/client/src/components/chat/ToolCallCard.tsx` — 70-line component. Shows tool call with expand/collapse. Also shows raw JSON in `<pre>` for input and result. Uses `getToolLabel()` for the header line.
- `apps/client/src/lib/tool-labels.ts` — Maps tool name + input to human-readable labels (e.g., `Read → "Read package.json"`). Covers 14 tool types. This is the existing pattern for making tool data human-readable.
- `apps/client/src/components/chat/InferenceIndicator.tsx` — 137-line component. Shows rotating verbs during streaming with elapsed time and token estimate. Does NOT distinguish between "AI is thinking" and "waiting for user response" — both show the same rotating verbs.
- `apps/client/src/components/chat/MessageItem.tsx` — Renders interactive components inline based on `interactiveType` field. `ToolApproval` for 'approval', `QuestionPrompt` for 'question'.
- `apps/client/src/hooks/use-chat-session.ts` — Manages chat state. Tracks `status: 'idle' | 'streaming' | 'error'` and `isTextStreaming`. The `status` stays `'streaming'` during interactive tool waits because the SSE connection is still open.
- `apps/client/src/components/chat/ChatInput.tsx` — Chat textarea with keyboard handling. Uses `handleKeyDown` for Enter (submit), Escape (clear/close palette), and arrow keys (palette navigation). This is the primary focus competition point.
- `apps/client/src/stores/app-store.ts` — Zustand store with settings like `expandToolCalls`, `autoHideToolCalls`, `showShortcutChips`.
- `apps/client/src/components/ui/` — No `kbd.tsx` exists. Will need to create one.

---

## 3) Codebase Map

**Primary Components/Modules:**

- `apps/client/src/components/chat/ToolApproval.tsx` — Permission approval UI (Approve/Deny buttons)
- `apps/client/src/components/chat/QuestionPrompt.tsx` — AskUser question form (radio/checkbox + tabs)
- `apps/client/src/components/chat/ToolCallCard.tsx` — Collapsible tool call display with raw JSON
- `apps/client/src/components/chat/InferenceIndicator.tsx` — Streaming status display with rotating verbs
- `apps/client/src/components/chat/MessageItem.tsx` — Routes tool calls to interactive or standard rendering
- `apps/client/src/components/chat/ChatInput.tsx` — Text input with keyboard event handling
- `apps/client/src/lib/tool-labels.ts` — Tool name → human-readable label mapping

**Shared Dependencies:**

- `apps/client/src/hooks/use-chat-session.ts` — Chat state, `ToolCallState` type, streaming status
- `apps/client/src/contexts/TransportContext.tsx` — `useTransport()` for calling approve/deny/submitAnswers
- `apps/client/src/stores/app-store.ts` — Zustand store for tool display preferences
- `apps/client/src/hooks/use-is-mobile.ts` — Mobile breakpoint detection (for hiding Kbd)
- `packages/shared/src/types.ts` — `QuestionItem`, `StreamEvent`, `ApprovalEvent` types

**Data Flow:**

```
SDK canUseTool → agent-manager pushes event → SSE stream → useChatSession adds ToolCallState
  → MessageItem renders ToolApproval or QuestionPrompt → user clicks → transport.approveTool/denyTool/submitAnswers
  → agent-manager resolves deferred promise → SDK resumes
```

**Feature Flags/Config:**

- `expandToolCalls` (app-store) — Whether tool cards are expanded by default
- `autoHideToolCalls` (app-store) — Whether completed tool calls fade out

**Potential Blast Radius:**

- Direct: 5 files (ToolApproval, QuestionPrompt, ToolCallCard, InferenceIndicator, new Kbd component)
- Indirect: 3 files (MessageItem, use-chat-session, ChatPanel — may need to propagate "waiting for response" state)
- Tests: 4 test files (ToolCallCard.test, QuestionPrompt.test, InferenceIndicator.test, plus new Kbd test)

---

## 4) Root Cause Analysis

N/A — this is a feature enhancement, not a bug fix.

---

## 5) Research

### Focus Management Deep-Dive

**The Core Challenge:**

The chat UI has a persistent `<textarea>` (ChatInput) that should normally have focus for typing. When an interactive tool appears (ToolApproval or QuestionPrompt), we want keyboard shortcuts to work _without_ requiring the user to explicitly click on the tool card first. But we also cannot steal focus from the textarea permanently, or typing breaks.

**Key Insight: Interactive tools appear during streaming, when the textarea is disabled.**

Looking at `ChatInput.tsx:191`, the textarea has `disabled={isLoading}`. When a tool call appears, `status === 'streaming'`, so the textarea is already disabled and cannot receive keyboard input. This means keyboard shortcuts can be activated globally without conflicting with text input — because text input is impossible while tools are waiting.

**When does the conflict arise?**

The conflict would only arise if:

1. A tool is waiting AND the textarea is enabled (impossible in current architecture — the SSE stream keeps `isLoading=true` until the SDK finishes)
2. The QuestionPrompt's "Other" textarea is focused (user is typing a free-text answer) while number-key shortcuts are active

**Proposed Focus Management Framework:**

```
┌────────────────────────────────────────────────────────┐
│                    FOCUS STATES                        │
├────────────────────────────────────────────────────────┤
│                                                        │
│  1. IDLE / TYPING                                      │
│     - ChatInput has focus                              │
│     - No global shortcuts active                       │
│     - Enter = submit, Esc = clear/close palette        │
│                                                        │
│  2. STREAMING (no interactive tool)                    │
│     - ChatInput disabled (isLoading=true)              │
│     - No interactive shortcuts needed                  │
│     - InferenceIndicator shows rotating verbs          │
│                                                        │
│  3. WAITING_FOR_APPROVAL                               │
│     - ChatInput disabled (isLoading=true)              │
│     - Global shortcuts: Enter=Approve, Esc=Deny        │
│     - InferenceIndicator shows "Waiting for approval"  │
│     - Kbd hints visible on desktop                     │
│                                                        │
│  4. WAITING_FOR_ANSWER                                 │
│     - ChatInput disabled (isLoading=true)              │
│     - Global shortcuts: 1-9=select option              │
│     - If "Other" textarea focused → disable number     │
│       shortcuts (user is typing)                       │
│     - Tab/Shift+Tab for multi-question navigation      │
│     - Enter=Submit (when all answered)                 │
│     - InferenceIndicator shows "Waiting for your       │
│       answer"                                          │
│                                                        │
└────────────────────────────────────────────────────────┘
```

**Implementation approach: `useInteractiveShortcuts` hook**

A custom hook that:

1. Reads current chat status and checks if any interactive tool is pending
2. Attaches a `document.addEventListener('keydown', ...)` listener ONLY when interactive tools are active
3. Filters out events from `<textarea>` and `<input>` elements (for the "Other" text field case)
4. Dispatches to the appropriate action (approve/deny/select option)
5. Removes the listener when the interactive state ends

```typescript
// Pseudo-code
function useInteractiveShortcuts({
  pendingApproval,  // ToolCallState | null
  pendingQuestion,  // ToolCallState | null
  onApprove,
  onDeny,
  onSelectOption,
  onSubmit,
}) {
  useEffect(() => {
    if (!pendingApproval && !pendingQuestion) return;

    function handleKeyDown(e: KeyboardEvent) {
      // Skip if user is typing in a text field (the "Other" textarea)
      const target = e.target as HTMLElement;
      if (['INPUT', 'TEXTAREA'].includes(target.tagName) && !target.hasAttribute('disabled')) {
        return;
      }

      if (pendingApproval) {
        if (e.key === 'Enter') { e.preventDefault(); onApprove(); }
        if (e.key === 'Escape') { e.preventDefault(); onDeny(); }
        return;
      }

      if (pendingQuestion) {
        const num = parseInt(e.key);
        if (num >= 1 && num <= 9) { e.preventDefault(); onSelectOption(num - 1); }
        if (e.key === 'Enter') { e.preventDefault(); onSubmit(); }
        // Next/Back for multi-question: Ctrl+→ / Ctrl+←
      }
    }

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [pendingApproval, pendingQuestion, ...]);
}
```

**Edge Cases:**

1. **Multiple approval requests simultaneously** — The SDK can call `canUseTool` multiple times before the user responds. We should handle the most recent one or the first pending one. The current UI already renders them all inline; shortcuts should target the first unanswered one and scroll to it.
2. **"Other" textarea in QuestionPrompt** — When the user clicks "Other" and starts typing, number-key shortcuts must be disabled. The `target.tagName === 'TEXTAREA'` check handles this.
3. **Rapid key presses** — The approve/deny handlers set `responding=true` which disables the buttons. The hook should also gate on this to prevent double-fire.
4. **Focus return after action** — After approving/denying, focus doesn't need to go anywhere specific since the textarea is still disabled (streaming continues). When streaming finishes, the textarea becomes enabled and the user can click to focus it.

### JSON Formatting Approach

**Current state:** Both `ToolApproval` and `ToolCallCard` use `JSON.stringify(JSON.parse(input), null, 2)` in a `<pre>` tag.

**Recommendation: Context-aware key-value renderer**

Instead of a generic JSON tree viewer (overkill for tool args which are typically flat objects), create a `ToolArgumentsDisplay` component that:

1. **For known tools** (Read, Write, Edit, Bash, Grep, Glob, etc.) — render a clean key-value layout using labels from `tool-labels.ts` pattern:

   ```
   ┌─────────────────────────────────────┐
   │ 📁 File    /src/components/App.tsx  │
   │ 📝 Action  Write                    │
   │ 📏 Lines   42                       │
   └─────────────────────────────────────┘
   ```

2. **For unknown tools or complex nested values** — render a simple indented key-value display with syntax highlighting for different types (string, number, boolean, null). No need for a full tree viewer.

3. **Progressive disclosure** — show the most important field (already done by `getToolLabel()` in the header) and put full details in the expandable body.

### "Waiting for Response" Status

**Current problem:** `InferenceIndicator` shows the same rotating verbs ("Contemplating...", "Reasoning...") whether the AI is thinking or waiting for user input. The `status` is `'streaming'` in both cases.

**Solution:** Add a new signal from `useChatSession` that indicates whether an interactive tool is pending:

```typescript
// In useChatSession, derive:
const pendingInteraction = messages
  .flatMap((m) => m.toolCalls || [])
  .find((tc) => tc.interactiveType && tc.status === 'pending');

// Expose: isWaitingForUser: boolean
```

Then in `InferenceIndicator` (or a new wrapper), when `isWaitingForUser` is true:

- Replace the rotating verb with a static "Waiting for your response" message
- Change the icon from shimmer to a static attention icon (e.g., `MessageSquare` or `Hand`)
- Optionally pulse the border or use amber color to draw attention

### Kbd Component

No Kbd component exists in the project. We'll create `apps/client/src/components/ui/kbd.tsx` following shadcn/ui patterns:

```tsx
function Kbd({ className, children, ...props }: React.ComponentProps<'kbd'>) {
  return (
    <kbd
      className={cn(
        'bg-muted text-muted-foreground pointer-events-none inline-flex h-5 items-center gap-1 rounded border px-1.5 font-mono text-[10px] font-medium select-none',
        className
      )}
      {...props}
    >
      {children}
    </kbd>
  );
}
```

Hidden on mobile via: `<Kbd className="hidden md:inline-flex">Enter</Kbd>`

### Potential Solutions

**Solution 1: Minimal — Format + Status Only**

- Format JSON as key-value in ToolApproval and ToolCallCard
- Add "Waiting for your response" status message
- No keyboard shortcuts
- Pros: Small scope, fast
- Cons: Doesn't address the main UX friction (clicking)

**Solution 2: Full Implementation (Recommended)**

- Format JSON as context-aware key-value display
- Add "Waiting for your response" status
- Keyboard shortcuts for approve/deny (Enter/Esc)
- Number keys for question selection
- Next/Back keyboard navigation for multi-question
- Kbd component with mobile hiding
- Custom hook `useInteractiveShortcuts` for focus management
- Pros: Complete solution, great UX
- Cons: Larger scope

**Solution 3: Phased**

- Phase 1: JSON formatting + status message + Kbd component + Enter/Esc for approve/deny
- Phase 2: Number keys for questions + Next/Back navigation
- Pros: Delivers value incrementally
- Cons: Two implementation passes

**Recommendation:** Solution 2 (Full Implementation). The scope is manageable — the focus management is simpler than it first appears because the textarea is disabled during interactive states. Implementing everything at once gives a cohesive experience and avoids touching the same files twice.

---

## 6) Clarification

1. **Shortcut keys for approve/deny:** Enter to approve, Escape to deny — does this feel right? Or would you prefer Y/N or something else? (Enter/Esc maps to the universal confirm/cancel pattern.)

2. **Number key behavior for questions:** Press `1` to select option 1, `2` for option 2, etc. For multi-select questions (checkboxes), should pressing the number toggle the checkbox? And should there be a separate "submit" shortcut after selecting?

3. **Multi-question navigation:** The current QuestionPrompt uses tab pills for multiple questions. For keyboard shortcuts, should we use `[` and `]` for prev/next question? Or arrow keys? Or something else? (Note: arrow keys might conflict with scrolling.)

4. **JSON formatting depth:** Should we only format the top-level keys of tool arguments (flat key-value), or should we recursively format nested objects? Most tool args are flat, but some (like `Task` with nested `prompt`) have deep values.

5. **"Waiting for response" indicator location:** Should the "Waiting for your response" message replace the InferenceIndicator entirely, or should it appear as an additional element (e.g., on the ToolApproval card itself)?

6. **Multiple pending approvals:** If multiple tool approvals are pending simultaneously, should Enter/Esc act on the first one? The most recent one? Or should we require the user to scroll to and interact with each one individually?

7. **Framework documentation:** You mentioned wanting a well-documented framework for keyboard shortcut handling. Should this be:
   - A developer guide (`guides/keyboard-shortcuts.md`) documenting the focus state machine and hook API?
   - Inline code documentation in the hook itself?
   - Both?
