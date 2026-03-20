---
slug: dev-playground-chat-simulator
number: 151
created: 2026-03-19
status: ideation
---

# Dev Playground Chat Simulator

**Slug:** dev-playground-chat-simulator
**Author:** Claude Code
**Date:** 2026-03-19
**Branch:** preflight/dev-playground-chat-simulator

---

## 1) Intent & Assumptions

- **Task brief:** Add a new Dev Playground page that simulates the full ChatPanel with items being streamed into the MessageList. The goal is to observe how new items look together, how they animate in, and validate visual behavior in a controlled environment — without needing a live server or real SDK session.

- **Assumptions:**
  - The simulator renders the same components as production (MessageList, ChatInputContainer) — not a simplified recreation
  - Scenarios are TypeScript-defined, not recorded JSONL replays (programmatic first, recordings later if needed)
  - Interactive elements (ToolApproval, QuestionPrompt) render visually but auto-advance through states — no real transport calls
  - The input bar is visible but cosmetic (typing doesn't trigger real SDK queries)
  - The page lives at `/dev/simulator` as a new Dev Playground page

- **Out of scope:**
  - Real transport/SDK integration — this is purely client-side simulation
  - JSONL transcript replay (valuable but secondary — can be layered later)
  - CelebrationOverlay and TaskListPanel simulation (these are independent of message streaming)
  - Persisting simulator state across page navigations

## 2) Pre-reading Log

- `apps/client/src/dev/DevPlayground.tsx`: Main shell — routes pages via `Page` type, sidebar nav groups, history pushState routing
- `apps/client/src/dev/playground-registry.ts`: Registry pattern — `Page` union type, `PlaygroundSection` interface, section arrays per page
- `apps/client/src/dev/playground-transport.ts`: Proxy-based no-op Transport for playground — every method returns `{ ok: true, messages: [] }`
- `apps/client/src/dev/mock-chat-data.ts`: Factory functions (`createUserMessage`, `createAssistantMessage`, `createToolCall`) + pre-built mock data (SAMPLE_MESSAGES, TOOL_CALLS, TOOL_CALL_APPROVAL, etc.)
- `apps/client/src/layers/features/chat/ui/ChatPanel.tsx`: Top-level chat view — deeply coupled to `useChatSession` hook, renders MessageList + ChatInputContainer + TaskListPanel + CelebrationOverlay
- `apps/client/src/layers/features/chat/ui/MessageList.tsx`: Virtualized message list (TanStack React Virtual), auto-scroll, message grouping, delegates to MessageItem per row
- `apps/client/src/layers/features/chat/model/chat-types.ts`: `ChatMessage` interface (id, role, content, parts, toolCalls), `ToolCallState`, `ChatStatus`
- `apps/client/src/layers/features/chat/ui/message/MessageItem.tsx`: Spring entry animation — `initial={{ opacity: 0, y: 8 }}`, user messages also have `x: 12, scale: 0.97`
- `apps/client/src/layers/features/chat/ui/message/AssistantMessageContent.tsx`: Renders parts array — text, tool_call, subagent, error, thinking parts with AnimatePresence
- `research/20260311_agent_sdk_simulation_testing.md`: Prior research on simulation infrastructure — confirms programmatic async generators as the right approach

## 3) Codebase Map

**Primary components/modules:**

- `apps/client/src/layers/features/chat/ui/ChatPanel.tsx` — Top-level chat view (tightly coupled to useChatSession)
- `apps/client/src/layers/features/chat/ui/MessageList.tsx` — Virtualized message renderer
- `apps/client/src/layers/features/chat/ui/ChatInputContainer.tsx` — Input bar with file upload, queue, autocomplete
- `apps/client/src/layers/features/chat/model/use-chat-session.ts` — Session hook managing messages, streaming, transport
- `apps/client/src/dev/DevPlayground.tsx` — Playground shell
- `apps/client/src/dev/mock-chat-data.ts` — Mock data factories

**Shared dependencies:**

- `@dorkos/shared/types` — MessagePart, QuestionItem, SubagentPart, ErrorPart, HookPart
- `motion/react` — All message animations (motion.div, AnimatePresence)
- `@tanstack/react-virtual` — Virtualizer in MessageList
- `@/layers/shared/model` — TransportProvider (required context for ToolApproval/QuestionPrompt)

**Data flow (production):**
User message → Transport.sendMessage → SSE stream → StreamEventHandler → ChatMessage[] state → MessageList → MessageItem

**Data flow (simulator):**
Scenario steps → useSimulator reducer → ChatMessage[] state → MessageList → MessageItem

**Potential blast radius:**

- Direct: New files only (simulator page, hook, scenarios)
- Indirect: `playground-registry.ts` (add page type), `DevPlayground.tsx` (add route), `playground-transport.ts` (may need to handle `approveTool`/`denyTool` gracefully)

## 4) Root Cause Analysis

N/A — this is a new feature, not a bug fix.

## 5) Research

**Potential solutions:**

**1. Scripted Scenario Playback (Recommended)**

- Description: TypeScript arrays of `SimStep` objects driven by a `useReducer` state machine with `setTimeout`-based tick engine
- Pros: Full control over timing, easy to add scenarios, no server dependency, exercises real components
- Cons: Scenarios must be manually authored, text streaming requires chunk-splitting helper
- Complexity: Medium
- Maintenance: Low — scenarios are plain TypeScript

**2. JSONL Transcript Replay**

- Description: Parse real `.jsonl` session files and replay events
- Pros: Uses real production data, catches edge cases naturally
- Cons: Requires file I/O or bundling fixtures, events don't map 1:1 to ChatMessage mutations, fragile to schema changes
- Complexity: High
- Maintenance: High — fixtures need updating as schemas evolve

**3. Mock Transport Interception**

- Description: Create a simulator transport that intercepts `sendMessage` and feeds back synthetic StreamEvents through the `onEvent` callback, allowing the real `useChatSession` hook to run
- Pros: Most authentic — exercises the full data pipeline
- Cons: Very complex to implement correctly, must mock every transport method, brittle to hook changes
- Complexity: High
- Maintenance: High — tightly coupled to internal hook implementation

**Recommendation:** Approach 1 (Scripted Scenario Playback). It provides the right balance of authenticity (real components render) and control (precise timing, easy to compose). The simulator manages `ChatMessage[]` state directly, feeding it to the real `MessageList`. This sidesteps the complexity of mocking the full transport/hook pipeline while still exercising every rendering path.

## 6) Decisions

| #   | Decision             | Choice                    | Rationale                                                                                                                                                                                              |
| --- | -------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Render scope         | Full ChatPanel layout     | User wants to see input bar, status area, and scroll behavior alongside message rendering. Build a SimulatedChatPanel that mirrors ChatPanel's layout but uses useSimulator instead of useChatSession. |
| 2   | Interactive elements | Visual only, auto-advance | Scenarios auto-transition ToolApproval/QuestionPrompt through states. No real transport calls. Simpler and sufficient for visual QA.                                                                   |
| 3   | Playback controls    | Full transport controls   | Play/Pause, Step Forward, Speed selector (0.5x-4x), Scrub/timeline bar, Reset. Allows frame-by-frame inspection of animations.                                                                         |
