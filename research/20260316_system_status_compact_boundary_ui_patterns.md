---
title: 'System Status Messages & Compact Boundary UI Patterns — Surfacing SDK Events in Chat'
date: 2026-03-16
type: external-best-practices
status: active
tags:
  [
    chat-ui,
    system-status,
    context-compaction,
    compact-boundary,
    ephemeral-notifications,
    chat-dividers,
    agent-status,
    sdk-events,
  ]
feature_slug: system-status-compact-boundary
searches_performed: 11
sources_count: 22
---

# System Status Messages & Compact Boundary UI Patterns

## Research Summary

The SDK emits two currently-silenced event classes: `system` messages with `subtype: "status"` (ephemeral operational status like "Compacting context...") and `system` messages with `subtype: "compact_boundary"` (persistent conversation state transitions). Industry analysis — VS Code Copilot, Cursor, Slack, iMessage, Stream Chat — reveals a strong consensus pattern: ephemeral system events belong in a transient status layer (not the message history), while compact boundaries belong as persistent but visually subdued horizontal dividers inside the message list. DorkOS already has the structural scaffolding (`messageType: 'compaction'` on `ChatMessage`, a `session_status` stream event type) but no pipeline from the SDK system messages to the client.

---

## Key Findings

### 1. SDK Event Structure (Authoritative)

The Claude Code Agent SDK emits the following system message subtypes in its stream:

**`system` / `init`** — already handled; yields `session_status` event.

**`system` / `compact_boundary`** — fires after automatic or manual compaction. Shape:

```typescript
{
  type: "system",
  subtype: "compact_boundary",
  uuid: string,
  session_id: string,
  compact_metadata: {
    trigger: "manual" | "auto",
    pre_tokens: number
  }
}
```

Currently falls through `mapSdkMessage` without any yield — silently dropped.

**`system` / `status`** — ephemeral operational messages like "Compacting context...", permission mode changes. Shape is underdocumented in the public SDK reference but observed in practice. Currently falls through `mapSdkMessage` without any yield — silently dropped.

**`PreCompact` hook** — fires _before_ compaction (in hook system), separate from the stream event. Can be used to archive transcript. Not directly useful for UI feedback but confirms the two-event model (pre-hook + post-stream-event).

### 2. VS Code Copilot Chat — The Closest Industry Reference

VS Code Copilot (February 2026 release) is the most direct comparable. Their approach:

- **Context compaction**: After automatic summarization, a `"✅ Summarized conversation history"` message appears inline in the chat — rendered as a special system message row, not a user/assistant bubble.
- **User feedback was mixed**: Multiple GitHub issues (166415, related discussions) show users found this appearing "after almost every single action" to be visually cluttered. One user's exact complaint: it "distracts from my workflow." VS Code added a toggle to disable it.
- **The lesson**: VS Code made compaction visible but overshot on frequency — the marker appeared too often and too prominently. The correct balance is: _one_ persistent marker at the boundary location, with low visual weight.
- **Context window indicator**: A fill gauge showing `15K/128K` tokens used in the chat input area. Hoverable for breakdown by category. Made toggleable after user complaints about "anxiety-inducing" anxiety about the token budget.

### 3. Cursor AI — Context Indicator Trajectory

Cursor went through a visible regression arc with their context indicator:

- **Early versions**: A circle/gauge showing `45k/200k` tokens used, positioned in the chat input area.
- **v2.2.44**: The indicator was _removed entirely_ — multiple community forum posts requesting it back (threads: "Bring back context usage indicator", "Diminishing transparency in context usage indicator").
- **Current**: Context usage shown inline in chat when approaching limits, `/summarize` command available. Auto-compaction happens with no persistent UI marker — purely transparent.
- **The lesson from Cursor's removal**: Their mistake was removing the indicator rather than tuning its visibility. The community strongly prefers having _some_ signal, even minimal.

### 4. Slack — The Canonical Ephemeral System Message Pattern

Slack's inline system messages ("Dorian joined #general", "Pinned a message") are the industry gold standard for non-intrusive persistent system events in chat:

- Centered horizontally with a hairline rule on each side
- Muted text color (approximately 60% opacity of body text)
- No avatar, no bubble, no timestamp prominence
- Small font (approximately 12px / `text-xs`)
- ARIA: `role="status"` or `role="separator"` with `aria-label`
- They are _persistent_ — they stay in history — but visually recessive

For _ephemeral_ system events (typing indicators, presence), Slack uses a completely different channel: the status bar beneath the message list, above the input. These never touch the message history.

### 5. iMessage / WhatsApp — Date Separator Pattern

Date separators ("Today", "Yesterday", "March 15") in iMessage and WhatsApp follow the same visual language as Slack system messages:

- Centered text
- Hairline rules (or just spacing)
- Muted, smaller type
- Fully persistent in message history

This is the exact visual treatment appropriate for compact boundaries — they are analogous to date separators: a dividing moment in the conversation's timeline with metadata about what occurred.

### 6. Stream Chat React SDK — Technical Implementation Reference

Stream Chat's `DateSeparator` component provides a direct implementation reference:

- Injected automatically into `VirtualizedMessageList` as a list item
- Three position variants: `left`, `center`, `right`
- Customizable `formatDate` function — can return arbitrary React content, not just dates
- The pattern is: separator items live in the same flat array as message items, differentiated by a `type` discriminant, rendered by a component lookup map
- This is exactly the data model DorkOS should use for `CompactBoundaryDivider`

### 7. Carbon Design System — Notification Pattern Guidance

IBM's Carbon Design System provides the authoritative classification matrix:

- **Toast**: Fixed-position, auto-dismissing, for real-time operational alerts. "Toasts are for ephemeral, live actions (save complete, something just finished _right now_)." Never for historical events.
- **Inline notification**: Appears near the relevant content, persists until dismissed. For contextual status.
- **Banner**: Top of primary content area. For ongoing system-wide state.
- **The gap**: None of these are designed for _mid-conversation_ status moments. The chat-native equivalent is the "system message row" pattern (Slack, iMessage), which is not a toast.

---

## Detailed Analysis

### The Two-Pattern Split

The most important insight is that these two event types require **fundamentally different treatments** because they have different temporal semantics:

| Attribute                    | System Status (`status`)                  | Compact Boundary (`compact_boundary`)  |
| ---------------------------- | ----------------------------------------- | -------------------------------------- |
| Duration                     | Ephemeral — describes current agent state | Permanent — records a historical event |
| Location                     | Outside message list                      | Inside message list                    |
| Scrollback persistence       | No                                        | Yes                                    |
| Affects conversation history | No                                        | Yes                                    |
| Analogy                      | Typing indicator                          | Date separator                         |
| Pattern                      | Status bar / transient overlay            | Inline system message row              |

Mixing these two into the same treatment (e.g., both as chat messages) would be wrong. VS Code's mistake was rendering compaction as a chat message that appeared too often and cluttered the thread.

### Pattern A — Ephemeral System Status

**Recommended treatment: Chat panel status sub-line**

DorkOS already has a `StatusLine` component at the feature level. The recommended pattern is a transient status message that:

1. Appears in a dedicated status zone _below the message list, above the input field_ (or optionally in the existing status line)
2. Fades in via `motion` (150ms ease-out)
3. Auto-dismisses after 4 seconds via a timer, OR is replaced when the next status arrives
4. Does NOT create a `ChatMessage` record in the conversation store
5. Is driven by a new `system_status` stream event type emitted by the server

**Visual spec:**

```
┌─────────────────────────────────────────┐
│  [message list]                         │
│                                         │
│                                         │
├─────────────────────────────────────────┤
│  ⟳  Compacting context...               │  ← status zone (ephemeral)
├─────────────────────────────────────────┤
│  [chat input]                           │
└─────────────────────────────────────────┘
```

**Alternative: merge with existing InferenceIndicator / StatusLine** — if the status is operational ("Compacting context..."), it could replace the "Thinking..." indicator pattern already used during streaming. This is the lowest-friction path.

**What NOT to do:**

- Toast (fixed-position overlay) — wrong context, chat already has a spatial region for these
- Inline chat message — pollutes history, VS Code proved this is disliked
- Ignored — the "looks like a freeze" problem is real for users

### Pattern B — Compact Boundary Divider

**Recommended treatment: Inline system message row in the message list**

This is a persistent record. When compaction occurs, the old messages above it are summarized — the boundary marks where memory was compressed. Users deserve a clear signal.

**Visual spec:**

```
│  [older messages — summarized]          │
│                                         │
├──────────── ⟳ Context compacted ────────┤  ← CompactBoundaryDivider
│                                         │
│  [newer messages — full fidelity]       │
```

Precise visual treatment:

- Full-width row, centered text
- Hairline rules (`border-t border-border/40`) on both sides
- Icon: a circular arrow or compress icon (12–14px)
- Text: "Context compacted" (auto) or "Context compacted manually" (manual trigger)
- Text color: `text-muted-foreground` (same as Slack system messages)
- Font: `text-xs` (11–12px)
- Vertical spacing: `py-3` (12px top/bottom, generous enough to read as a section break)
- Optional: show `pre_tokens` as a hover tooltip ("Compacted at ~128K tokens")
- No click target, no dismiss, no avatar

**Data model**: A `ChatMessage` with `messageType: 'compaction'` already exists in `chat-types.ts`. This slot should be used — the boundary becomes a list item with no `role`, no `content`, just a divider row.

### Pattern C — Augmenting the Status Line (Alternative for Status Messages)

An alternative for system status is to route it into the existing status line chip architecture rather than a separate sub-zone. This has lower implementation cost but couples system status to the status line's existing layout constraints.

For "Compacting context...", the status line could show a spinner + message in place of (or alongside) the existing token count chip. This:

- Reuses existing component infrastructure
- Is immediately visible without new layout
- Auto-clears when the `compact_boundary` event arrives (confirming completion)

This approach creates a nice state machine: "Compacting context..." appears in the status line → `compact_boundary` fires → the status line clears the message → a `CompactBoundaryDivider` is injected into the message list.

---

## Solution Comparison

### Solution 1: Status Sub-Zone + Inline Divider (Recommended)

**Description**: New `system_status` SSE event → render in a dedicated ephemeral status zone below message list. New `compact_boundary` SSE event → inject a `CompactBoundaryDivider` ChatMessage row.

**Pros:**

- Cleanest separation of ephemeral vs persistent
- Matches industry pattern (Slack, iMessage for dividers; typing indicator zone for status)
- Zero pollution of message history with ephemeral events
- `messageType: 'compaction'` already exists in `ChatMessage` — minimal schema work
- Matches Dieter Rams "good design is as little design as possible" — subtle, functional

**Cons:**

- Requires new layout region in `ChatPanel.tsx`
- Two new stream event types needed (`system_status`, `compact_boundary`)
- Two new components needed (`SystemStatusBanner`, `CompactBoundaryDivider`)

**Complexity**: Medium. Server: 2 new event yields in `mapSdkMessage`. Client: 2 new components, 1 new layout zone, 1 new chat state field.

---

### Solution 2: Route Both Through StatusLine (Lower Effort)

**Description**: Both events route to the existing `StatusLine` component. Status messages appear as a transient chip. Compact boundary appears as a longer-lived chip that only clears on next message.

**Pros:**

- Minimal new code — reuses existing StatusLine infrastructure
- No new layout changes
- Fast to implement

**Cons:**

- Compact boundary is not persistent — scrolling up won't show where compaction happened
- The status line is not visible when scrolled up in the chat
- Loses the semantic distinction between the two event types
- Doesn't solve the "looks like a freeze" problem for users mid-scroll

**Complexity**: Low. But undershoots on the compact boundary — fails to create a persistent historical marker.

---

### Solution 3: Both as Inline Chat Messages (Avoid)

**Description**: Both events generate `ChatMessage` entries and appear as special message rows in the message list.

**Pros:**

- Simplest data model — one rendering path for everything
- Persistent by default
- VS Code Copilot did this

**Cons:**

- VS Code Copilot received user complaints about clutter
- Ephemeral status messages should not be permanent in history
- "Compacting context..." appearing as a chat message is semantically wrong — it's not a message from the agent, it's infrastructure noise
- Violates the design principle: "Every element should justify its existence"

**Complexity**: Low. But produces a worse UX than Solution 1.

---

## Recommendation

**Implement Solution 1 with the StatusLine augmentation from Pattern C as the entry point for system status messages.**

Specifically:

1. **Server — `mapSdkMessage`**: Add two new cases:
   - `subtype === 'compact_boundary'` → yield new `compact_boundary` stream event with `trigger` and `preTokens`
   - `subtype === 'status'` → yield new `system_status` stream event with the status text

2. **Shared schemas**: Add `compact_boundary` and `system_status` to `StreamEventTypeSchema`. Add `CompactBoundaryEvent` and `SystemStatusEvent` Zod schemas.

3. **Client — stream event handler**:
   - `compact_boundary` events → inject a `ChatMessage` with `messageType: 'compaction'`, `id: uuid`, `content: ''`, `timestamp: now()`, and `parts: []`. The trigger (`auto` vs `manual`) and `preTokens` go in a new optional field.
   - `system_status` events → update a new ephemeral state field `systemStatus: string | null` on the chat store, with auto-clear after 4 seconds.

4. **Client — `ChatPanel.tsx`**: Render `systemStatus` in a slim sub-zone between the message list and chat input. Use `motion/div` for fade-in/fade-out animation. Keep it to one line: icon + text.

5. **Client — `MessageList.tsx` / `MessageItem.tsx`**: Add rendering branch for `messageType === 'compaction'` → render `<CompactBoundaryDivider>` instead of a message bubble.

6. **New components**:
   - `CompactBoundaryDivider.tsx` — the horizontal rule with centered text
   - Optionally extracted `SystemStatusLine.tsx` or merged into existing `StatusLine`

### Design Spec for CompactBoundaryDivider

```tsx
// Visual: ──────── ↻ Context compacted ─────────
// Tailwind classes:
'flex items-center gap-2 py-3 text-xs text-muted-foreground';
// Left/right lines:
'flex-1 border-t border-border/40';
// Icon: RotateCcw or Compress from lucide-react, size 12
// Text: "Context compacted" (auto) | "Context compacted manually" (manual)
// Hover tooltip: "Compacted at ~{preTokens.toLocaleString()} tokens"
```

### Design Spec for SystemStatus Zone

```tsx
// Positioned: between MessageList and ChatInput, AnimatePresence wrapper
// Height: 28px collapsed, 0px when null
// Content: "⟳ Compacting context..." in text-xs text-muted-foreground
// Animation: opacity 0→1 in 150ms, then auto-fade after 4s
// Does NOT create a ChatMessage — purely ephemeral UI state
```

---

## Security Considerations

- System status message content comes from the SDK, which is running locally (not from a network adversary). Content is informational strings, not user-controlled.
- No XSS risk if rendered via React's standard text rendering (no `dangerouslySetInnerHTML`).
- `pre_tokens` is a number — safe to display as formatted integer.
- No security concerns specific to this feature.

---

## Performance Considerations

- `compact_boundary` events are rare (O(1) per long session, typically 0-2 per hour of active use). No performance impact.
- `system_status` events may fire more frequently during heavy agent operation (e.g., "Compacting context..." could precede every compact boundary). The 4-second auto-clear with debounce/replace semantics ensures no accumulation.
- The ephemeral status zone uses CSS `height` animation (not `max-height`) via Motion's `AnimatePresence` — no reflow issues.
- Injecting a `ChatMessage` with `messageType: 'compaction'` into the messages array is O(1) append — negligible.
- No concerns with React Virtuoso (used for message list) — virtual list handles arbitrary item types via the `itemContent` render function.

---

## Research Gaps & Limitations

- The exact shape of `system` / `status` messages from the Claude Code SDK is not fully documented in public references. The `subtype: 'status'` path should be confirmed by logging actual SDK output during a compacting session before finalizing the schema.
- No direct screenshot evidence was obtainable of Devin's or GitHub Copilot Agent's inline compact boundary treatment (tools didn't return visual captures).
- The `compact_metadata.pre_tokens` field was confirmed from SDK changelog analysis — should be verified against the TypeScript SDK's actual exported types before using.

---

## Contradictions & Disputes

- **VS Code Copilot Chat**: Their approach of rendering `"✅ Summarized conversation history"` as an inline chat message is the direct industry precedent — but it received user complaints about clutter and was made toggleable. This argues _for_ using a compact, low-weight divider (Solution 1) rather than a full system message row (Solution 3).
- **Cursor**: Removed their context indicator entirely after user feedback, then had community requests to restore it. The lesson is ambiguous — some users want this information, some don't. Solution 1's low-weight treatment threads this needle without adding cognitive load.

---

## Sources & Evidence

- "The SDK emits a `SystemMessage` with subtype `compact_boundary` in the stream when this happens" — [How the agent loop works](https://platform.claude.com/docs/en/agent-sdk/agent-loop) (Anthropic, 2026)
- VS Code compact notation `"✅ Summarized conversation history"` appearing in chat — [GitHub Copilot Conversation (166415)](https://github.com/orgs/community/discussions/166415)
- Cursor removed their context usage indicator in v2.2.44 — [Cursor Community Forum](https://forum.cursor.com/t/bring-back-context-usage-indicator-token-counter-circle/147515)
- VS Code context indicator causes "anxiety-inducing" stress — [VS Code GitHub Issue #293578](https://github.com/microsoft/vscode/issues/293578)
- "Toasts are for ephemeral, live actions (save complete, something just finished right now)" — [LogRocket Toast Notifications UX Guide](https://blog.logrocket.com/ux-design/toast-notifications/)
- DateSeparator component pattern for chat separators — [Stream Chat React SDK DateSeparator](https://getstream.io/chat/docs/sdk/react/components/utility-components/date_separator/)
- Carbon Design System: inline vs toast vs banner notification taxonomy — [Carbon Design System Notification Pattern](https://carbondesignsystem.com/patterns/notification-pattern/)
- Cursor AI context window usage guide — [Cursor AI Complete Guide 2025](https://medium.com/@hilalkara.dev/cursor-ai-complete-guide-2025-real-experiences-pro-tips-mcps-rules-context-engineering-6de1a776a8af)
- VS Code `/compact` command and auto-compaction UI — [GitHub Copilot in VS Code v1.110 (February 2026)](https://github.blog/changelog/2026-03-06-github-copilot-in-visual-studio-code-v1-110-february-release/)
- OpenAI compaction: backend-only, no UI guidance — [OpenAI API Compaction Guide](https://developers.openai.com/api/docs/guides/compaction/)
- LibreChat context compaction discussion (architectural, no UI detail) — [LibreChat Discussion #7484](https://github.com/danny-avila/LibreChat/discussions/7484)

---

## Search Methodology

- Searches performed: 11
- Most productive search terms: `"compact_boundary" SDK event types`, `VS Code Copilot "summarized conversation history"`, `chat conversation divider date separator React`, `Cursor AI context usage indicator`
- Primary information sources: Anthropic SDK docs, GitHub issues/discussions (VS Code, Cursor community), stream chat library docs, design system docs (Carbon)
