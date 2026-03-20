---
slug: inference-status-indicator
number: 8
created: 2026-02-12
status: implemented
---

# Inference Status Indicator

**Slug:** inference-status-indicator
**Author:** Claude Code
**Date:** 2026-02-12
**Branch:** preflight/inference-status-indicator
**Related:** N/A

---

## 1) Intent & Assumptions

**Task brief:** Add a web-native inference status indicator inspired by Claude Code CLI's animated spinner. The indicator appears at the bottom of the message history, shows animated visual feedback + rotating witty messages + elapsed time + token count while Claude is processing, and displays a completion summary afterward. The system should be pluggable so themes/variants can be swapped in the future (holidays, user preferences).

**Assumptions:**

- Streaming state (`status: 'idle' | 'streaming' | 'error'`) is already tracked in `useChatSession`
- `session_status` SSE events provide `contextTokens` and `costUsd` but NOT per-response token deltas — we'll estimate from text chunks
- The server does not emit elapsed time; this must be computed client-side
- We'll use the existing `motion` library (already configured with `reducedMotion="user"`)
- The indicator renders in the chat scroll area, not in a fixed position

**Out of scope:**

- User-selectable themes UI (future — we just need the pluggable architecture)
- Holiday auto-detection (future)
- Server-side timing or token counting changes
- Progress estimation / progress bars

---

## 2) Pre-reading Log

- `apps/client/src/hooks/use-chat-session.ts`: Core streaming hook. Tracks `status`, `sessionStatus`, processes SSE events via `handleStreamEvent()`. Returns `{ messages, status, sessionStatus, stop, ... }`
- `apps/client/src/components/chat/ChatPanel.tsx`: Layout wrapper. Renders `MessageList` → `TaskListPanel` → `ChatInput` → `StatusLine`
- `apps/client/src/components/chat/MessageList.tsx`: Virtualized message list (TanStack Virtual). Has auto-scroll logic. `status` prop already passed in
- `apps/client/src/components/chat/MessageItem.tsx`: Per-message renderer with `isStreaming` prop for last assistant message
- `apps/client/src/components/chat/StreamingText.tsx`: Blinking cursor animation during streaming
- `apps/client/src/components/chat/ToolCallCard.tsx`: Uses `Loader2 animate-spin` for running state, Motion for expand/collapse
- `apps/client/src/components/status/StatusLine.tsx`: Footer toolbar showing cwd, permission, model, cost, context
- `apps/client/src/stores/app-store.ts`: Zustand store for UI state
- `packages/shared/src/schemas.ts`: `StreamEventSchema` with types: `text_delta`, `tool_call_start/delta/end`, `tool_result`, `session_status`, `done`, etc. `SessionStatusEventSchema` has `model`, `costUsd`, `contextTokens`, `contextMaxTokens`
- `apps/client/src/lib/http-transport.ts`: SSE parsing loop — events arrive via `onEvent` callback
- `apps/client/src/index.css`: Design tokens, existing `@keyframes typing-dot` and `blink-cursor`, mobile scale system
- `apps/client/src/App.tsx`: `<MotionConfig reducedMotion="user">` wraps entire app
- `guides/design-system.md`: Calm Tech philosophy, 8pt grid, animation timings (100-300ms), neutral gray palette, single blue accent

---

## 3) Codebase Map

**Primary components/modules:**

- `apps/client/src/hooks/use-chat-session.ts` — Streaming state machine, SSE event handler
- `apps/client/src/components/chat/ChatPanel.tsx` — Layout orchestrator
- `apps/client/src/components/chat/MessageList.tsx` — Virtualized message display + auto-scroll
- `apps/client/src/components/chat/MessageItem.tsx` — Per-message rendering
- `apps/client/src/components/status/StatusLine.tsx` — Session metadata display

**Shared dependencies:**

- `motion/react` — Animation library (already integrated, `MotionConfig` at app level)
- `@tanstack/react-virtual` — List virtualization in MessageList
- Zustand `app-store.ts` — Cross-component UI state
- CSS custom properties in `index.css` — Design tokens, mobile scale

**Data flow:**

```
User submits → useChatSession.handleSubmit() → transport.sendMessage()
  → SSE events arrive → handleStreamEvent() dispatches per type
  → status='streaming' → components re-render
  → 'done' event → status='idle'
```

**Available streaming data:**

- `status`: 'idle' | 'streaming' | 'error' (from hook)
- `sessionStatus.contextTokens`: Current context window usage (from `session_status` events)
- `sessionStatus.costUsd`: Cumulative cost
- Text delta content (can estimate token count from character length)
- No built-in start/end timestamps or per-turn token counts

**Potential blast radius:**

- `useChatSession` — Add timing + token tracking refs
- `ChatPanel` or `MessageList` — Render the indicator component
- New component files — The indicator itself + hooks + verb data
- `index.css` — Possibly new keyframes if using CSS animations

---

## 4) Root Cause Analysis

N/A — this is a new feature, not a bug fix.

---

## 5) Research

### How Claude Code CLI Does It

The CLI uses an ASCII spinner character (rotating `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏` braille pattern) paired with one of ~100 witty verbs that rotate randomly. The display format is:

```
⠹ Cerebrating... (5m 44s · 2.0k tokens)
```

On completion:

```
⠿ Churned for 6m 14s
```

The 100 verbs fall into categories:

- **Cerebral:** Cerebrating, Cogitating, Contemplating, Pondering, Ruminating, Musing...
- **Creative:** Brewing, Concocting, Conjuring, Crafting, Hatching, Synthesizing...
- **Active:** Churning, Computing, Crunching, Spinning, Whirring...
- **Whimsical:** Combobulating, Discombobulating, Noodling, Spelunking, Wibbling, Clauding...

Users can customize verbs via `~/.claude/settings.json` with a `spinnerVerbs` config.

### Web AI Chat Indicators (Industry)

- **ChatGPT:** Pulsing dot animation
- **Claude.ai:** Shimmer/gradient sweep across placeholder text
- **Open WebUI:** Detailed metrics: `10.90s | Req: 175 | Resp: 439 | 40.18 T/s`

### Potential Approaches

**1. Ambient Shimmer (CSS-only)**

- Subtle gradient sweep across the indicator area
- Pros: Very calm, CSS-only, GPU-accelerated
- Cons: May be too subtle, doesn't convey personality
- Complexity: Low

**2. Pulsing Dot/Icon**

- Small icon that breathes with scale + opacity
- Pros: Noticeable, familiar "live" indicator pattern
- Cons: Can feel generic, limited entertainment value
- Complexity: Low

**3. Rotating Text + Subtle Icon (Hybrid) — RECOMMENDED**

- Witty rotating messages paired with a gentle icon animation
- Format: `[animated icon] Cerebrating... 2m 14s · 1.2k tokens`
- Completion: `[static icon] Churned for 6m 14s`
- Pros: Entertaining, informative, matches CLI personality, flexible
- Cons: More complex, text length variation needs handling
- Complexity: Medium

**4. Particle/Morphing SVG**

- Abstract shapes that morph or orbit
- Pros: Visually unique, premium feel
- Cons: High complexity, may clash with Calm Tech, performance risk
- Complexity: High

### Recommendation

**Hybrid indicator (approach #3)** — It captures the CLI's personality and entertainment value while leveraging web capabilities for smoother animations. The Motion.dev variant system makes it naturally pluggable. Key design decisions:

- **Icon animation:** Gentle opacity pulse (0.5→1→0.5) on a small icon, 2.5s cycle
- **Verb rotation:** Random selection from pool, crossfade transition, 3-4s per verb
- **Layout:** Single line, left-aligned below last message, uses `text-muted-foreground`
- **Completion summary:** Fade transition from streaming → summary, holds for ~5s then fades out
- **Reduced motion:** Static icon + text rotation only (no animation), still shows time/tokens

### Pluggable Architecture

Use a **theme object pattern** — each theme defines its icon component, animation variants, verb list, and color overrides:

```typescript
interface IndicatorTheme {
  name: string;
  icon: React.ComponentType<{ className?: string }>;
  iconAnimation: MotionProps; // Motion animate/transition config
  verbs: string[];
  verbInterval: number; // ms between rotations
  completionVerb?: string; // e.g. "Churned" — defaults to random
}
```

Themes are stored as plain objects. A `useIndicatorTheme()` hook or simple prop selects the active theme. Future: user preference in localStorage, seasonal auto-detection.

---

## 6) Resolved Decisions

1. **Placement:** Inside the message scroll area, below the last message. Feels like a natural part of the conversation. Auto-scroll keeps it visible.

2. **Completion behavior:** Collapse in-place to a compact summary line (e.g., "2m 14s · 3.2k tokens"). Same vertical space — no layout shift. Persists as a subtle timestamp on the turn.

3. **Token counting:** Estimate from text delta character count (chars / ~4). Shows "~1.2k tokens" — not perfectly accurate but gives useful real-time feedback.

4. **Icon:** Styled asterisk `*` with a CSS shimmer/pulse effect. Closest to the CLI's visual identity. Minimal, typographic, fits Calm Tech.

5. **Verb set:** 50 custom phrases (NOT reusing Claude Code CLI verbs). A mix of:
   - 70s Black slang / jive talk ("Jive Turkeying", "Talking Jive", etc.)
   - 90s hip-hop slang and culture references
   - Mix of single verbs and short phrases
   - Stored in a dedicated file for easy editing
   - Smooth crossfade animation between verb transitions (AnimatePresence with opacity + slight y-shift)
