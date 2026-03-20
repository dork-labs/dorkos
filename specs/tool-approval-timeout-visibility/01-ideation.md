---
slug: tool-approval-timeout-visibility
number: 138
created: 2026-03-16
status: ideation
---

# Tool Approval Timeout Visibility

**Slug:** tool-approval-timeout-visibility
**Author:** Claude Code
**Date:** 2026-03-16
**Branch:** preflight/tool-approval-timeout-visibility

---

## 1) Intent & Assumptions

- **Task brief:** When Claude requests tool approval, `ToolApproval.tsx` shows approve/deny buttons but gives zero indication that a 10-minute timeout exists. When the timeout fires, the tool is silently auto-denied and the agent continues without explanation. Add a countdown timer to the approval UI, show a warning when time is running low, and display a clear message when timeout occurs.

- **Assumptions:**
  - This is a client-only UX fix with a small server-side schema addition (passing `timeoutMs`)
  - The server-side 10-minute timeout behavior (`interactive-handlers.ts`) remains unchanged
  - Users should not be able to extend the timeout (deferred scope)
  - The countdown should follow existing UI patterns (InferenceIndicator countdown reference)
  - Cross-client scenarios are out of scope for this spec (separate concern)

- **Out of scope:**
  - Timeout extension mechanism (new route + timer reset)
  - Configurable timeout duration (settings UI)
  - Cross-client approval sync indicator
  - Changes to the server-side timeout behavior itself
  - QuestionPrompt timeout (different interactive type, separate spec if needed)

## 2) Pre-reading Log

- `apps/client/src/layers/features/chat/ui/ToolApproval.tsx`: Current approval card with approve/deny buttons. No timer state, countdown, or timeout handling. ~140 lines, well under complexity threshold. Uses `approvalState` variant from `message-variants.ts`.
- `apps/server/src/services/runtimes/claude-code/interactive-handlers.ts`: Server-side timeout defined as `SESSIONS.INTERACTION_TIMEOUT_MS = 10 * 60 * 1000` (600,000ms). On timeout: silently calls `resolve({ behavior: 'deny', message: 'Tool approval timed out after 10 minutes' })`. Client never notified.
- `apps/client/src/layers/features/chat/ui/InferenceIndicator.tsx`: **Reference pattern** — already implements countdown for rate-limit state (lines 75-90). Uses `useState<number | null>()` + `useEffect` with `setInterval(1000)` to tick down. Shows amber hourglass + "Rate limited -- retrying in {countdown}s".
- `apps/client/src/layers/features/chat/model/stream-event-handler.ts`: Processes `approval_required` event (line 224+). Creates tool call state with `interactiveType: 'approval'`. No handling for timeout-related data.
- `apps/client/src/layers/shared/model/use-elapsed-time.ts`: Reusable elapsed/countdown timer hook. Returns `{ formatted: string, raw: number }`. Used by InferenceIndicator.
- `packages/shared/src/schemas.ts`: Defines `ApprovalEventSchema` — currently has `toolCallId`, `toolName`, `input`. Needs `timeoutMs` field.
- `contributing/interactive-tools.md`: Full architecture guide. Interactive tools use deferred promise pattern with timeout stored in `pendingInteractions` Map.
- `contributing/design-system.md`: Status colors (`status-warning`, `status-error`), 8pt spacing grid, motion specs.
- `contributing/animations.md`: Motion library patterns — fade-in, scale, opacity transitions with spring presets.
- `.temp/agent-sdk-audit.md`: Rates approval timeout UX at **2.5/5**. Punch list item #16 (P2). "10-minute timeout completely invisible to user. No countdown, no warning. Silent denial on timeout."

## 3) Codebase Map

- **Primary components/modules:**
  - `apps/client/src/layers/features/chat/ui/ToolApproval.tsx` — Approval card UI. Props: `sessionId`, `toolCallId`, `toolName`, `input`, `isActive`, `onDecided`, `ref`. Tracks `responding` (boolean), `decided` ('approved' | 'denied' | null).
  - `apps/server/src/services/runtimes/claude-code/interactive-handlers.ts` — Server-side approval handler. Creates deferred promise with `setTimeout(600000ms)`. On timeout: resolve deny + remove from `pendingInteractions`.
  - `apps/client/src/layers/features/chat/model/stream-event-handler.ts` — Processes `approval_required` event, creates tool call state with `interactiveType: 'approval'`.
  - `packages/shared/src/schemas.ts` — Defines `ApprovalEventSchema` and `ApprovalRequiredEvent` type.

- **Shared dependencies:**
  - `apps/client/src/layers/shared/lib/constants.ts` — TIMING object for UI delays. Could add warning threshold constant.
  - `apps/client/src/layers/shared/model/use-elapsed-time.ts` — Reusable timer hook (reference pattern).
  - `motion/react` — Animation library used by ToolApproval for decided state transitions.
  - `lucide-react` — Icons: Check, X, Shield (current); Clock, AlertTriangle for timeout states.
  - `tailwind-variants` — `approvalState` variant in `message-variants.ts`.

- **Data flow:**

  ```
  Server: handleToolApproval()
    → setTimeout(INTERACTION_TIMEOUT_MS)
    → emits approval_required SSE event (+ new timeoutMs field)
    → Client receives event
    → stream-event-handler creates approval part with timeoutMs
    → ToolApproval renders with countdown from timeoutMs
    → On timeout: client shows denied state + explanation message
    → Server timeout fires: resolve({ behavior: 'deny' })
  ```

- **Feature flags/config:**
  - `SESSIONS.INTERACTION_TIMEOUT_MS = 600000` in server constants
  - No feature flags; always enabled

- **Potential blast radius:**
  - Direct: 3 files (`ToolApproval.tsx`, `schemas.ts`, `interactive-handlers.ts`)
  - Indirect: `stream-event-handler.ts` (pass through new field), `message-variants.ts` (possible warning variant)
  - Tests: `ToolApproval.test.tsx` needs new cases for countdown, warning, timeout states

## 4) Root Cause Analysis

N/A — this is a UX enhancement, not a bug fix.

## 5) Research

### Potential Solutions

**1. Linear Progress Bar + Late Text Countdown**

- Description: Thin 4px bar below the header draining over 10 minutes via CSS `animation: drain linear forwards` (GPU-composited, zero JS cost). Color transitions: neutral -> amber (2 min remaining) -> red (1 min). Text countdown ("1:42 remaining") appears only in final 2 minutes via `setInterval(1000)` anchored to `Date.now()`.
- Pros:
  - Compact, fits naturally in the approval card
  - Zero JS cost for the first 8 minutes (pure CSS animation)
  - `setInterval` only active for final 120 ticks
  - Follows familiar CI/deployment approval patterns
  - Two independent urgency signals (color + text) satisfy WCAG 1.4.1
  - `prefers-reduced-motion` fallback: remove animation, keep color thresholds
- Cons:
  - Progress draining is less glanceable than a ring in the final seconds
- Complexity: Low
- Maintenance: Very low — no dependencies

**2. Circular Progress Ring**

- Description: SVG circle with `strokeDashoffset` animation. Could use `react-countdown-circle-timer` library.
- Pros: Highly glanceable, distinctive
- Cons: Visually heavy for inline chat cards, multiple concurrent approvals = visual chaos, adds dependency, imperceptible change for first 8 of 10 minutes
- Complexity: Low-Medium
- Maintenance: Medium (library dependency)

**3. Text Countdown Only**

- Description: Simple MM:SS label updating every second.
- Pros: Zero complexity, screen-reader native
- Cons: Users ignore ticking text, reads as "bomb timer" rather than calm indicator, fails urgency-without-anxiety test
- Complexity: Very low
- Maintenance: Very low

**4. Badge/Pill with Color Transition**

- Description: Inline colored badge transitioning neutral -> amber -> red.
- Pros: Compact, zero animation, mobile-friendly
- Cons: Less granular than a bar, jarring number updates inside badge
- Complexity: Very low
- Maintenance: Very low
- Best as: Complement to Approach 1

### Accessibility Considerations

- Progress bar needs `role="progressbar"` with `aria-valuemin="0"`, `aria-valuemax`, `aria-valuenow={secondsRemaining}`, `aria-valuetext="X minutes Y seconds remaining"`
- Separate hidden `role="status"` element with `aria-live="assertive"` fires announcements only at threshold crossings (not per-second)
- Announcements: 2 minutes -> "Tool approval required. 2 minutes remaining." | 60 seconds -> "Urgent: 1 minute to approve or deny." | Timeout -> "Tool approval timed out. Execution denied."
- WCAG 2.2.1 requires 20-second warning before expiry; 2-minute threshold satisfies by 6x
- `prefers-reduced-motion`: disable CSS animation, keep color state transitions

### Performance Considerations

- CSS `animation` on `width` is GPU-composited (off main thread for full 10 minutes)
- `setInterval(1000)` only active in final 2 minutes (120 ticks max)
- `Date.now()` anchoring prevents clock drift
- No external dependencies

### Recommendation

**Linear progress bar + late text countdown.** Pass `timeoutMs` from the server in the `approval_required` event so the client stays in sync with the actual timeout duration. Two warning thresholds: 2 minutes (amber + text appears) and 1 minute (red + assertive screen reader announcement). On timeout: replace with denied-style card + explanation message.

## 6) Decisions

| #   | Decision            | Choice                                       | Rationale                                                                                                                                                                                     |
| --- | ------------------- | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Timer display style | Linear progress bar + late text              | Compact, zero-dependency, GPU-composited CSS animation. Text only appears in final 2 minutes to avoid "bomb timer" anxiety. Follows InferenceIndicator countdown pattern already in codebase. |
| 2   | Timeout source      | Server sends `timeoutMs` in approval event   | Future-proof — if timeout becomes configurable, client adapts automatically. Small schema change to `ApprovalEventSchema`.                                                                    |
| 3   | Timeout extension   | Deferred — no extension for now              | Extension requires new route + SSE event + server-side timer reset. If 10 minutes is too short, raise `INTERACTION_TIMEOUT_MS` globally instead.                                              |
| 4   | Timeout visual      | Replace with denied-style card + explanation | Reuses existing "denied" visual state. Message: "Auto-denied -- approval timed out after 10 minutes. The agent continued without this tool." Clear, honest, minimal new UI.                   |
