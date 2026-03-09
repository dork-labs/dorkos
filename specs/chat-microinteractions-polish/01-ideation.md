---
slug: chat-microinteractions-polish
number: 104
created: 2026-03-09
status: ideation
---

# Chat Microinteractions & Animation Polish

**Slug:** chat-microinteractions-polish
**Author:** Claude Code
**Date:** 2026-03-09
**Branch:** preflight/chat-microinteractions-polish

---

## 1) Intent & Assumptions

- **Task brief:** Polish every microinteraction touchpoint in the DorkOS chat experience — sidebar session list state transitions, click feedback, message list session-switch animation, user message send animation, and AI streaming message entry.
- **Assumptions:** `motion` (motion.dev v12) is already installed and MotionConfig wraps the app with `reducedMotion="user"`. All changes are client-side only. The virtualized list (TanStack Virtual) constrains animation choices for MessageList. Existing `isNew` detection for new messages (historyCount gate) is sound and must be preserved.
- **Out of scope:** Non-chat UI areas (Pulse, Relay, Mesh panels), redesign of chat layout, performance profiling of streaming pipeline, new sound or haptic effects.

---

## 2) Pre-reading Log

- `contributing/animations.md`: Motion v12 patterns — fade-in-up (200ms ease-out), spring interactions, stagger on open (40ms delay, first 8 items), `layoutId` for selection indicators, `<MotionConfig reducedMotion="user">` wrapper in App.tsx.
- `contributing/design-system.md`: "Calm Tech" philosophy. Message entrance: fade + slide up 8px, 200ms ease-out. Tool card expand: 300ms ease-in-out. Hover: 150ms. Button press: scale to 0.97. Streaming cursor: blink animation.
- `contributing/styling-theming.md`: Tailwind v4 + CSS custom properties, `cn()` utility, semantic color tokens only.
- `meta/personas/the-autonomous-builder.md`: Primary persona (Kai Nakamura, 28-35, indie hacker/senior dev) — operates 10-20 agent sessions per week, lives in the chat UI. Polish matters disproportionately to power users who see every interaction dozens of times per day.
- `meta/personas/the-knowledge-architect.md`: Secondary persona — values calm, unobtrusive UI that doesn't distract from deep work.
- `apps/client/src/layers/features/chat/ui/ChatPanel.tsx`: Main chat container, 616 lines. Uses AnimatePresence for scroll-to-bottom/new-messages pills.
- `apps/client/src/layers/features/chat/ui/MessageList.tsx`: Virtualized message container (TanStack Virtual). Tracks `historyCount` to determine `isNew`. No motion.dev usage directly.
- `apps/client/src/layers/features/chat/ui/MessageItem.tsx`: Wraps each message in `motion.div`. Current entrance: `initial={isNew ? { opacity: 0, y: 8 } : false}`, `animate={{ opacity: 1, y: 0 }}`, `transition={{ duration: 0.2, ease: [0, 0, 0.2, 1] }}`.
- `apps/client/src/layers/features/session-list/ui/SessionItem.tsx`: Uses conditional `motion.div` for new-session highlight. Has expand/collapse spring (chevron). No click feedback, no active-state motion.
- `apps/client/src/layers/features/session-list/ui/SessionSidebar.tsx`: Renders session list with time groupings. Passes `isNew` flag. No layoutId or shared animation element.
- `apps/client/src/App.tsx`: Root MotionConfig wrapper confirmed.

---

## 3) Codebase Map

**Primary Components/Modules:**
- `apps/client/src/layers/features/chat/ui/ChatPanel.tsx` — Chat container; session switching triggers re-mount (key=activeSessionId)
- `apps/client/src/layers/features/chat/ui/MessageList.tsx` — TanStack Virtual list; historyCount tracks new vs history messages
- `apps/client/src/layers/features/chat/ui/MessageItem.tsx` — Per-message animator; already uses motion.div with isNew gate
- `apps/client/src/layers/features/chat/ui/StreamingText.tsx` — Renders markdown; blinking cursor via CSS `::after`
- `apps/client/src/layers/features/chat/ui/ToolCallCard.tsx` — Expand/collapse with spring (stiffness 400, damping 30)
- `apps/client/src/layers/features/session-list/ui/SessionItem.tsx` — Sidebar session row; needs layoutId bg + whileTap
- `apps/client/src/layers/features/session-list/ui/SessionSidebar.tsx` — Session list container; must use `layout` prop + host layoutId root

**Shared Dependencies:**
- `apps/client/src/layers/shared/lib/cn.ts` — Class merging utility
- `apps/client/src/layers/shared/lib/timing.ts` — `TIMING` constants (TOOL_CALL_AUTO_HIDE_MS etc.)
- `motion/react` — AnimatePresence, motion, MotionConfig, useAnimate, layoutId

**Data Flow for New Messages:**
```
User sends message
  → useChatSession appends optimistic user message to messages[]
  → messages[].length > historyCount → isNew=true
  → MessageItem: motion.div initial={opacity: 0, y: 8} → animate={opacity: 1, y: 0}

SSE stream arrives
  → text_delta events merge into currentPartsRef
  → assistant message created/updated in messages[]
  → First assistant message: isNew=true → same entrance animation
  → Subsequent streaming updates: isNew=false (same message index) → no re-animation
```

**Session Switch Flow:**
```
User clicks SessionItem
  → setActiveSession(sessionId)
  → URL updates → sessionId prop on ChatPanel changes
  → ChatPanel re-mounts (key={activeSessionId})
  → MessageList mounts fresh, historyCount resets to null
  → History fetch → messages populate → historyCount = messages.length
  → All history: isNew=false → no entrance animation
  → Currently: new MessageList appears instantly with no transition
```

**Component Hierarchy (animation-relevant):**
```
App
└── MotionConfig (reducedMotion="user")
    └── SessionSidebar [needs: layout root, layoutId bg host]
    │   └── SessionItem × N [needs: whileTap, layoutId bg child, smooth state transitions]
    └── ChatPanel [needs: AnimatePresence wrapper keyed by sessionId]
        └── MessageList
            └── MessageItem × N [needs: spring physics, user-message scale]
                └── StreamingText [no changes — cursor already correct]
```

**Potential Blast Radius:**
- **Direct changes (5 files):** ChatPanel.tsx, MessageItem.tsx, SessionItem.tsx, SessionSidebar.tsx, possibly index.css (spring token)
- **Indirect (no logic change):** MessageList.tsx (receives same props), ToolCallCard.tsx (spring already good)
- **Tests to review:** `__tests__/MessageItem.test.tsx`, `__tests__/ChatPanel.test.tsx`, `__tests__/SessionItem.test.tsx` — motion is already mocked in test setup

---

## 4) Root Cause Analysis

_Not a bug fix — section not applicable._

---

## 5) Research

**Potential Solutions Evaluated:**

**1. Per-token streaming animation (typing effect)**
- Description: Animate each token as it appears (fade in, slide up per word)
- Pros: Very theatrical, immediately obvious the content is "live"
- Cons: Causes severe jank at high token rates; degrades performance; makes text harder to read while streaming; no major production app does this
- Complexity: High | Maintenance: High
- **Verdict: Rejected**

**2. Message container spring entrance (current approach + improvements)**
- Description: Keep the isNew/historyCount gate; upgrade timing from duration to spring physics; add user-message scale
- Pros: Already proven correct; easy upgrade; matches iMessage/Slack/Claude.ai behavior exactly; virtualized list stays happy
- Cons: None identified
- Complexity: Low | Maintenance: Low
- **Verdict: Recommended**

**3. AnimatePresence session crossfade (ChatPanel level)**
- Description: Wrap MessageList render in `<AnimatePresence mode="wait">` keyed by sessionId
- Pros: Old session fades out → new fades in; 150ms duration; dramatically smoother than instant swap; zero impact on virtualized list internals
- Cons: Adds 300ms total to session switch (150ms out + 150ms in) — acceptable for a deliberate navigation action
- Complexity: Low (5 lines) | Maintenance: Low
- **Verdict: Recommended**

**4. Stagger history messages on session switch**
- Description: After crossfade, cascade history messages in with 20ms stagger
- Pros: More theatrical
- Cons: 100-message session = 2 seconds of cascade; looks broken on long sessions; conflicts with virtualized rendering (items at virtual positions, not sequential DOM)
- Complexity: High | Maintenance: High
- **Verdict: Rejected** (user confirmed)

**5. layoutId sliding active indicator (sidebar)**
- Description: Single `motion.div` with `layoutId="active-session-bg"` that slides between items as active session changes
- Pros: Flagship premium interaction — the exact pattern Linear, Notion, Vercel use; one animated element instead of N background toggles; spring-powered, feels physical
- Cons: Requires adding an absolutely-positioned child div to SessionItem; SessionSidebar needs `layout` prop; ~30 lines of targeted refactoring
- Complexity: Medium | Maintenance: Low
- **Verdict: Recommended** (user confirmed)

**6. CSS transition active indicator (per-item background)**
- Description: Keep CSS background class but add `transition-colors duration-150`
- Pros: Minimal change
- Cons: Each item independently transitions; no cross-item sliding; less premium
- Complexity: Low | Maintenance: Low
- **Verdict: Not chosen** (user selected layoutId approach)

**Industry findings:**
- iMessage, Slack, Claude.ai: All use opacity + translateY entrance, spring or ease-out, 150–250ms. No per-token animation.
- Linear/Notion/Vercel: layoutId shared background for list selection is the defining premium UX signature.
- Motion.dev recommendation: `mode="wait"` for session crossfade (not `mode="popLayout"`, which is for sibling reflow).
- Reduced motion: motion.dev's `MotionConfig reducedMotion="user"` automatically substitutes opacity fades for transforms — DorkOS already benefits from this at no extra cost.

**Recommended spring presets:**
```typescript
// Message entry (snappy, no bounce)
{ type: 'spring', stiffness: 320, damping: 28 }

// Sidebar active indicator (smooth slide)
{ type: 'spring', stiffness: 280, damping: 32 }

// Click/tap feedback
{ type: 'spring', stiffness: 400, damping: 30 }  // Already used for ToolCallCard chevron — reuse
```

---

## 6) Decisions

| # | Decision | Choice | Rationale |
|---|----------|--------|-----------|
| 1 | Sidebar active indicator animation | `layoutId` sliding background (premium) | Matches Linear/Notion/Vercel pattern — a single shared `motion.div` slides between sessions rather than N independent CSS toggles. User confirmed this approach. |
| 2 | Session switch animation scope | Simple ChatPanel-level crossfade only | `AnimatePresence mode="wait"` at ChatPanel level, keyed by sessionId. 150ms opacity fade each way. Research + user confirmed: staggered history entry rejected due to virtualized list complexity and chaos at 100+ messages. |

---

## 7) Full Scope of Changes (Proactive Discoveries)

Beyond what was explicitly requested, the exploration + research surfaced two additional high-value improvements with no downside:

**A. User message scale on send** _(not requested, high impact)_
Add `scale: 0.97` to the `isNew` initial state for user messages only. This creates the "sent from the input" physical impression that iMessage and modern messaging apps use. One additional prop in MessageItem's `motion.div`.

**B. Spring physics for ALL new message entry** _(small upgrade to current duration-based approach)_
Current: `transition={{ duration: 0.2, ease: [0, 0, 0.2, 1] }}` — duration-based easing.
Recommended: `transition={{ type: 'spring', stiffness: 320, damping: 28 }}` — spring physics.
Spring feels more physical and natural. Zero risk — motion.dev handles this identically under reduced motion.

**C. whileTap on SessionItem** _(not requested, one line)_
`whileTap={{ scale: 0.98 }}` on the SessionItem clickable surface. Gives physical press feedback. Imperceptible when reduced motion is enabled (motion.dev collapses scale transforms to instant).

---

## 8) Implementation Breakdown

Five targeted changes, ordered by visual impact:

### Change 1: ChatPanel — Session switch crossfade
**File:** `apps/client/src/layers/features/chat/ui/ChatPanel.tsx`
**What:** Wrap the `<MessageList>` render in `<AnimatePresence mode="wait">` with a keyed `motion.div` using sessionId.
**Lines changed:** ~5
```tsx
<AnimatePresence mode="wait">
  <motion.div
    key={sessionId}
    initial={{ opacity: 0 }}
    animate={{ opacity: 1 }}
    exit={{ opacity: 0 }}
    transition={{ duration: 0.15, ease: 'easeInOut' }}
    className="h-full"
  >
    <MessageList ... />
  </motion.div>
</AnimatePresence>
```

### Change 2: SessionItem + SessionSidebar — layoutId active indicator
**Files:** `SessionItem.tsx`, `SessionSidebar.tsx`
**What:** Add an absolutely-positioned `motion.div` with `layoutId="active-session-bg"` inside each SessionItem. It renders only when the item is active. Motion.dev automatically animates the shared element between positions.
**Lines changed:** ~30 (structured refactor, not complexity)
```tsx
// In SessionItem (active item only):
{isActive && (
  <motion.div
    layoutId="active-session-bg"
    className="absolute inset-0 rounded-md bg-accent/60"
    transition={{ type: 'spring', stiffness: 280, damping: 32 }}
  />
)}
// Container needs: position: relative, layout prop on SessionSidebar

// Remove: CSS active background class from SessionItem
```

### Change 3: SessionItem — tap feedback
**File:** `apps/client/src/layers/features/session-list/ui/SessionItem.tsx`
**What:** Add `whileTap={{ scale: 0.98 }}` to the clickable surface.
**Lines changed:** 1

### Change 4: MessageItem — spring physics + user-message scale
**File:** `apps/client/src/layers/features/chat/ui/MessageItem.tsx`
**What:** Replace duration-based transition with spring. Add `scale: 0.97` to initial state for user messages.
**Lines changed:** 3
```tsx
initial={isNew ? { opacity: 0, y: 8, scale: isUser ? 0.97 : 1 } : false}
animate={{ opacity: 1, y: 0, scale: 1 }}
transition={{ type: 'spring', stiffness: 320, damping: 28 }}
```

### Change 5: SessionItem — hover/active state CSS transitions
**File:** `apps/client/src/layers/features/session-list/ui/SessionItem.tsx`
**What:** Ensure text color, opacity, and non-background state changes use `transition-all duration-150`. Audit for any hard-coded state switches that should be transitions.
**Lines changed:** ~5

---

## 9) Persona Alignment

**Kai (The Autonomous Builder):** Runs 10-20 sessions/week. Every session switch, every message send — polished microinteractions compound. The layoutId sidebar and spring physics make the tool feel professional-grade, not prototype-grade. "I use this all day — it should feel like Linear."

**The Knowledge Architect:** Values calm. All animations are subtle (8px translate, 0.98 scale tap, 150ms fades). Nothing distracting. Reduced motion preference automatically respected via MotionConfig.

**What I asked for but shouldn't overlook:** The session switch crossfade is the most _visible_ improvement but the layoutId sidebar is the most _felt_ improvement — the physical sliding is immediately noticed without being consciously analyzed. That's the hallmark of great microinteraction design.
