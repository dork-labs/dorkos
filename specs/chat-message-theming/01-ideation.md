---
slug: chat-message-theming
number: 105
created: 2026-03-09
status: ideation
---

# Chat Message Theming & MessageItem Architecture

**Slug:** chat-message-theming
**Author:** Claude Code
**Date:** 2026-03-09
**Branch:** preflight/chat-message-theming

---

## 1) Intent & Assumptions

- **Task brief:** Redesign the chat message theming system and MessageItem.tsx architecture to be world-class in both UX and DX. Introduce semantic design tokens beyond colors (spacing, typography, shape, motion, status). Decompose the monolithic MessageItem into intuitive, composable sub-components. Add tailwind-variants for multi-slot variant styling. Replace hardcoded colors in ToolApproval/ToolCallCard with semantic status tokens.
- **Assumptions:**
  - The MessageItem public props API stays compatible (MessageList doesn't need changes)
  - tailwind-variants is added as a new dependency for multi-slot message components
  - CVA remains for shadcn primitives — TV is for feature-level multi-slot components
  - Density tokens are defined in CSS but no UI toggle is added yet (groundwork for future)
  - The Calm Tech design language remains the guiding philosophy
- **Out of scope:**
  - Density settings UI toggle (tokens only, toggle is a future feature)
  - Avatar/profile pictures for messages (no bubble-style redesign)
  - MessageList refactoring (virtual scroll logic is clean)
  - New message types (system messages, pinned messages, etc.)
  - Changes to useChatSession or chat state management

## 2) Pre-reading Log

- `contributing/design-system.md`: Calm Tech philosophy, 8pt grid, shadow hierarchy, color palette (neutrals only). Message styling spec says user messages use `bg-secondary` (now `bg-user-msg`), assistant has no background.
- `contributing/styling-theming.md`: Tailwind v4 + semantic tokens pattern. Always use semantic tokens over arbitrary values. Dark mode via class-based `.dark` selector.
- `contributing/animations.md`: Spring presets documented. Message entrance: `{ stiffness: 320, damping: 28 }`. Session crossfade, sidebar indicator, tap feedback all documented.
- `specs/chat-ui-aesthetic-refinement/02-specification.md`: Full spec for color palette, motion, micro-interactions (implemented).
- `specs/chat-message-area-improvements/02-specification.md`: Auto-scroll, deferred assistant message (implemented).
- `specs/chat-microinteractions-polish/02-specification.md`: Spring physics, layoutId, session crossfade (implemented).
- `apps/client/src/index.css`: HSL tokens defined — `--user-msg` is the only message-specific token. `.msg-assistant` CSS class handles markdown typography. No status color tokens exist.
- `apps/client/src/layers/features/chat/ui/MessageItem.tsx`: 272 lines. Monolithic render with nested ternaries for message type branching. Role-based styling via inline `cn()` conditionals. No variant system. Mixed concerns (layout + styling + content routing + animation).
- `apps/client/src/layers/features/chat/ui/ToolCallCard.tsx`: 70 lines. Status colors hardcoded (`text-blue-500`, `text-green-500`, `text-red-500`). No semantic tokens.
- `apps/client/src/layers/features/chat/ui/ToolApproval.tsx`: 127 lines. Approval/denied state colors hardcoded (`border-emerald-500/20 bg-emerald-500/10`, `border-red-500/20 bg-red-500/10`). Template literal string concatenation for conditional classes instead of `cn()`.
- `apps/client/src/layers/features/chat/ui/QuestionPrompt.tsx`: 250+ lines. Clean interaction logic, shadcn primitives. No special theming concerns.
- `apps/client/src/layers/features/chat/ui/StreamingText.tsx`: Single-purpose, clean. Renders markdown via Streamdown.
- `apps/client/src/layers/features/chat/ui/MessageList.tsx`: 310 lines. Virtual scrolling via @tanstack/react-virtual. Clean — no changes needed.
- `research/20260309_chat_message_theming_architecture.md`: Comprehensive research on semantic tokens, CVA vs tailwind-variants, component architecture patterns, and industry best practices.

## 3) Codebase Map

**Primary Components/Modules:**

- `features/chat/ui/MessageItem.tsx` — Main refactoring target (272 lines, mixed concerns)
- `features/chat/ui/ToolCallCard.tsx` — Tool call display (hardcoded status colors)
- `features/chat/ui/ToolApproval.tsx` — Interactive approval UI (hardcoded state colors)
- `features/chat/ui/StreamingText.tsx` — Markdown rendering wrapper (no changes needed)
- `features/chat/ui/QuestionPrompt.tsx` — Question prompt UI (minimal changes)
- `features/chat/ui/MessageList.tsx` — Virtual scroll container (no changes needed)
- `apps/client/src/index.css` — Design token definitions (needs new tokens)

**Shared Dependencies:**

- `shared/lib/cn` — Class merging utility
- `shared/lib/TIMING` — Animation timing constants
- `shared/model/app-store` — Zustand store (showTimestamps, expandToolCalls, autoHideToolCalls)
- `motion/react` — Animation library
- `lucide-react` — Icons (ChevronRight, Check, X, Loader2)

**Data Flow:**
`useChatSession` → `MessageList` (virtual scroll) → `MessageItem` (render per message) → role-based content branching → `StreamingText` | `ToolCallCard` | `ToolApproval` | `QuestionPrompt`

**Feature Flags/Config:**

- `showTimestamps` (app store) — controls timestamp visibility
- `expandToolCalls` (app store) — controls tool card default expand state
- `autoHideToolCalls` (app store) — controls auto-hide of completed tool calls

**Potential Blast Radius:**

- Direct: MessageItem.tsx, ToolCallCard.tsx, ToolApproval.tsx, index.css (4 files modified + new sub-component files)
- Indirect: None — MessageList passes props unchanged, useChatSession is unaffected
- Tests: MessageItem tests need updates for new component structure

## 5) Research

### Potential Solutions

**1. Semantic Tokens + tailwind-variants + Sub-component Decomposition (Full approach)**

- Description: Add 7 categories of semantic tokens (color, typography, spacing, shape, motion, interactive, elevation) to index.css. Use tailwind-variants for multi-slot message styling with `role` and `position` variant axes. Decompose MessageItem into focused sub-components.
- Pros:
  - Complete theming surface — any visual aspect changeable via CSS variables
  - tailwind-variants slots let one variant call style multiple elements simultaneously
  - Sub-components are independently testable and readable
  - Scales to future message types (system, pinned, etc.) via new variant values
  - Compound variants express complex state combinations declaratively
- Cons:
  - New dependency (tailwind-variants, ~4KB)
  - Learning curve for developers unfamiliar with TV slots
  - More files to navigate (though each is much simpler)
- Complexity: Medium
- Maintenance: Low (token changes don't touch components)

**2. CVA-only with decomposition**

- Description: Use CVA for per-element variant definitions. No multi-slot support — separate CVA call for root, content, timestamp, etc.
- Pros: No new dependency, consistent with shadcn primitives
- Cons: Verbose — must coordinate multiple CVA calls for one component. Can't express "when role is user, style root AND content AND timestamp" in one definition.
- Complexity: Medium
- Maintenance: Medium

**3. Tokens + clean cn() (no variant library for messages)**

- Description: Keep current approach but reorganize cn() calls and add semantic tokens.
- Pros: Minimal change, no learning curve
- Cons: Doesn't solve the core DX problem. Nested ternaries remain. New variants require new conditionals.
- Complexity: Low
- Maintenance: Higher over time

### Industry Best Practices

- **Nuxt UI ChatMessage**: Exposes `role`, `variant` (solid/outline/soft/subtle/naked), `side`, `compact` props. Uses tailwind-variants with slots (root, container, leading, content, actions). Compound variants coordinate styling.
- **shadcn AI components**: 25+ composable React components. Message component delegates to specialized sub-components per content type. Parts-based rendering (text, tool-call, reasoning).
- **Stream Chat React**: Named sub-components behind a context provider. Not compound components exposed to consumers — internal decomposition for DX.
- **Material 3 (2025)**: Expanded token system includes motion, shape, density, elevation tokens alongside color/typography/spacing.

### Recommendation

**Recommended Approach:** Semantic Tokens + tailwind-variants + Sub-component Decomposition

**Rationale:** The DorkOS chat interface is the core product surface. The current architecture (one file, inline ternaries, hardcoded colors) creates friction for every styling change. tailwind-variants' slot system is purpose-built for this exact problem — a multi-part component where multiple elements need to respond to the same variant axis. The sub-component decomposition is driven by readability (the user's primary goal), not by line count reduction. Each sub-component has a single, obvious purpose.

**Caveats:**

- tailwind-variants is a new dependency. It's tiny (~4KB) and well-maintained, but it's another thing in the bundle.
- The decomposition should be **internal** (not a public compound component API). MessageList should keep rendering `<MessageItem>` — the sub-components are implementation detail.

## 6) Decisions

| #   | Decision                     | Choice                            | Rationale                                                                                                                                                                                            |
| --- | ---------------------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Variant library for messages | Add tailwind-variants             | CVA can only style one element per call. TV's slot system was built for multi-part components like MessageItem. Keep CVA for shadcn primitives.                                                      |
| 2   | Decomposition depth          | Readability-driven                | Goal is ultra-intuitive code, not shorter files. Decompose wherever it makes the code easier to understand. Extract where a sub-component has a single obvious purpose.                              |
| 3   | Density support              | Design tokens only (no UI toggle) | Define CSS variables for spacing/padding so a future density toggle requires zero component changes. Keeps this spec focused on theming infrastructure, not new features.                            |
| 4   | Status tokens                | Full semantic token set           | Add --status-success, --status-error, --status-warning, --status-info, --status-pending with bg/fg/border variants. Replaces all hardcoded emerald/red/blue colors in ToolApproval and ToolCallCard. |
