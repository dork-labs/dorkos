---
slug: chat-markdown-rendering
---

# Chat Markdown Rendering

**Slug:** chat-markdown-rendering
**Author:** Claude Code
**Date:** 2026-02-07
**Branch:** preflight/chat-markdown-rendering

---

## 1) Intent & Assumptions

- **Task brief:** Chat messages from Claude should render markdown formatting (headers, code blocks, lists, bold, italic, tables, links, etc.) instead of displaying raw markdown text. The `StreamingText` component currently returns plain text with no parsing.
- **Assumptions:**
  - Only assistant messages need full markdown rendering; user messages can remain plain text or get light formatting
  - The app already has `streamdown: "latest"` in `package.json` (not yet installed/used)
  - Tailwind CSS 4 is in use via `@tailwindcss/vite` plugin (not via `tailwind.config.js`)
  - `@tailwindcss/typography` is NOT currently installed (no references found in codebase)
  - The `MessageItem` component already wraps content in `prose prose-sm dark:prose-invert max-w-none` classes (anticipating this feature)
  - Messages stream incrementally via SSE `text_delta` events, requiring handling of incomplete markdown during streaming
- **Out of scope:**
  - Markdown preview for user input
  - LaTeX/math rendering
  - Mermaid diagram support
  - Custom markdown extensions beyond GFM

## 2) Pre-reading Log

- `src/client/components/chat/StreamingText.tsx`: **THE core file.** Currently returns raw `content` string wrapped in `whitespace-pre-wrap`. Comment on line 10 explicitly mentions future Streamdown integration.
- `src/client/components/chat/MessageItem.tsx`: Renders avatar + label + `<StreamingText>` + `<ToolCallCard>` list. Already has `prose prose-sm dark:prose-invert max-w-none` classes on the content wrapper (line 30).
- `src/client/hooks/use-chat-session.ts`: SSE streaming hook. Text deltas accumulate in `currentAssistantRef.current` and update state via `setMessages`. Each delta triggers a re-render of the assistant message.
- `src/client/components/chat/MessageList.tsx`: Virtualised list using `@tanstack/react-virtual`. Renders `<MessageItem>` per row.
- `src/client/components/chat/ChatPanel.tsx`: Parent container, orchestrates input + message list.
- `src/client/components/chat/ToolCallCard.tsx`: Tool call rendering (not affected).
- `src/client/index.css`: Tailwind v4 import (`@import "tailwindcss"`), shadcn/ui CSS variables for zinc theme. No typography plugin import.
- `package.json`: Has `streamdown: "latest"` in dependencies. No `@tailwindcss/typography`. Uses Tailwind CSS v4, Vite 6, React 19.
- `vite.config.ts`: Uses `@tailwindcss/vite` plugin. Path aliases for `@/` and `@shared/`.
- `src/client/components/chat/__tests__/MessageList.test.tsx`: Tests render plain text and check with `screen.getByText()`. Will need updating since markdown rendering wraps text in HTML elements.

## 3) Codebase Map

**Primary Components/Modules:**

- `src/client/components/chat/StreamingText.tsx` - **Primary change target.** Plain text renderer to be replaced with Streamdown markdown renderer
- `src/client/components/chat/MessageItem.tsx` - Message container with prose classes already applied
- `src/client/hooks/use-chat-session.ts` - SSE streaming hook, accumulates text deltas
- `src/client/components/chat/MessageList.tsx` - Virtualised message list

**Shared Dependencies:**

- `tailwindcss` v4 (via `@tailwindcss/vite`)
- `streamdown` (in package.json but not yet installed/imported)
- `@tanstack/react-virtual` for virtualised list
- `zustand` for app state
- `@tanstack/react-query` for server state
- `lucide-react` for icons

**Data Flow:**

```
SSE text_delta → useChatSession (accumulates in ref) → setMessages (state update)
  → MessageList (virtualised) → MessageItem → StreamingText (renders content)
```

Each `text_delta` appends to `currentAssistantRef.current`, then calls `updateAssistantMessage()` which clones the full message array with updated content. StreamingText receives the new `content` string on each delta.

**Feature Flags/Config:** None

**Potential Blast Radius:**

- **Direct (must change):** `StreamingText.tsx` (replace plain text with Streamdown), `index.css` (add Streamdown CSS import), `package.json` (add `@tailwindcss/typography` if needed)
- **Indirect (may need adjustment):** `MessageItem.tsx` (prose class tuning), `MessageList.test.tsx` (tests check `getByText` which may break with HTML wrapping)
- **No change needed:** `use-chat-session.ts`, `ChatPanel.tsx`, `ToolCallCard.tsx`, server code

## 4) Root Cause Analysis

N/A - This is a new feature, not a bug fix.

## 5) Research

### Potential Solutions

**1. Streamdown (Vercel)**
- Description: Drop-in streaming markdown renderer built for AI chat, with Shiki code highlighting, GFM support, and unterminated syntax handling
- Pros:
  - Purpose-built for streaming AI chat (handles incomplete markdown gracefully)
  - Memoized block rendering (only re-renders changed portions)
  - Built-in Shiki syntax highlighting with copy/download buttons
  - GFM support out of the box (tables, task lists, strikethrough)
  - Already in `package.json`
  - v2 bundle is 83.5% smaller than v1 (CDN loading for languages/themes)
- Cons:
  - Newer library, less battle-tested than react-markdown
  - CDN dependency for syntax themes/languages (fine for online chat)
  - Less customizable than react-markdown + remark plugins
- Complexity: Low
- Maintenance: Low

**2. react-markdown + remark-gfm + react-syntax-highlighter**
- Description: Most popular React markdown renderer with plugin ecosystem
- Pros:
  - Most widely used (116K+ developers), very mature
  - Extensive remark/rehype plugin ecosystem
  - High customization via component overrides
  - No XSS risk (safe by default)
- Cons:
  - Does NOT handle unterminated/incomplete markdown during streaming
  - Re-parses entire document on every render (O(n^2) for streaming)
  - Larger bundle (42.6KB min+gz) + plugins
  - Requires manual memoization strategy for streaming performance
  - Requires separate syntax highlighting library
- Complexity: Medium
- Maintenance: Medium

**3. markdown-to-jsx**
- Description: Lightweight, fast markdown-to-React renderer
- Pros:
  - Smaller bundle than react-markdown
  - Component-based API
  - Faster raw parsing
- Cons:
  - No streaming-specific handling
  - Less plugin support
  - Still requires manual incomplete syntax handling
- Complexity: Medium
- Maintenance: Medium

### Recommendation

**Streamdown** is the clear choice:
1. It's already a dependency in `package.json`
2. Purpose-built for exactly this use case (streaming AI chat)
3. Handles the hardest problem (incomplete markdown during streaming) automatically
4. Minimal integration work (the `StreamingText` component comment literally mentions it)
5. Built-in Shiki syntax highlighting eliminates a separate dependency

## 6) Clarification

1. **User message rendering:** Should user messages also render markdown (e.g., if user types code blocks or bold text), or stay as plain text?
2. **Typography plugin:** Tailwind CSS v4 uses `@import "tailwindcss"` instead of `tailwind.config.js`. Do we need `@tailwindcss/typography` for the prose classes to work, or does Streamdown provide its own CSS? (Streamdown ships `streamdown/dist/index.css` which may handle styling independently.)
3. **Code block theme:** Should code blocks use a dark theme (matches dark mode) or adapt to light/dark automatically? Streamdown supports Shiki themes.
4. **Max width:** The prose wrapper has `max-w-none`. Should long messages have a max-width for readability, or remain full-width?
