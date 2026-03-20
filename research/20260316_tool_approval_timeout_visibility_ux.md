---
title: 'Tool Approval Timeout Visibility — Countdown UX Patterns for Chat UI'
date: 2026-03-16
type: external-best-practices
status: active
tags: [tool-approval, countdown, timer, ux, accessibility, react, animation, timeout]
feature_slug: tool-approval-timeout-visibility
searches_performed: 9
sources_count: 22
---

# Tool Approval Timeout Visibility — Countdown UX Patterns for Chat UI

**Date:** 2026-03-16
**Research Depth:** Focused Investigation
**Context:** The `ToolApproval` component shows approve/deny buttons with no indication that a 10-minute server-side timeout (`SESSIONS.INTERACTION_TIMEOUT_MS = 10 * 60 * 1000`) exists. When it fires, the tool is silently auto-denied. This research covers the best approaches for making the countdown visible, warning states, accessibility, and timeout extension feasibility.

---

## Research Summary

The 10-minute timeout is already defined in `SESSIONS.INTERACTION_TIMEOUT_MS` and is communicated from the server only at interaction-creation time — there is currently no "N seconds remaining" event surfaced over SSE. The client must run its own countdown clock seeded at the moment the `approval_required` event arrives. A **text countdown with a color-transitioning progress bar** is the most practical, accessible, and on-brand approach for DorkOS — it conveys urgency, degrades gracefully under `prefers-reduced-motion`, and avoids the visual noise of a circular ring in a dense chat stream. Warnings should trigger at the 2-minute mark (20% remaining), switching to urgent amber at 60 seconds. Timeout extension is architecturally feasible via `setPermissionMode()` but requires a server-side API endpoint and careful multi-client handling; it should be treated as a future enhancement, not part of the initial ship.

---

## Key Findings

### 1. Existing Architecture — What the Client Already Knows

The server creates a `setTimeout` for `INTERACTION_TIMEOUT_MS` (10 minutes) the instant `handleToolApproval` runs. The client receives the `approval_required` event shortly after (SSE delivery latency is negligible). The `ApprovalEvent` schema has **no `expiresAt` field** — the client must infer the deadline from event receipt time:

```typescript
// packages/shared/src/schemas.ts
export const ApprovalEventSchema = z.object({
  toolCallId: z.string(),
  toolName: z.string(),
  input: z.string(),
  // No expiresAt, no timeoutMs — client must seed from INTERACTION_TIMEOUT_MS constant
});
```

**Recommendation:** Add `timeoutMs: z.number()` to `ApprovalEventSchema` and pass `SESSIONS.INTERACTION_TIMEOUT_MS` from the handler. This lets the constant live in one place and lets the client start an accurate countdown without hardcoding the timeout value.

### 2. Visual Approach Comparison

Four candidate approaches evaluated for DorkOS context.

#### Approach A: Linear Progress Bar (Recommended)

A thin horizontal bar below the tool header, draining left-to-right over 10 minutes, with color transitioning from neutral → amber → red in warning phases.

**Pros:**

- Compact — adds ~4px of height to the card, doesn't dominate the chat stream
- Familiar: CI pipelines (Jenkins, CircleCI), file transfers, and download UIs all use horizontal progress for time-limited operations
- Color transition is the primary urgency signal, not animation speed — less anxiety-inducing
- Natural `prefers-reduced-motion` fallback: static tint on the card border instead of animated bar
- CSS `transition` on `width` is GPU-composited — negligible performance cost

**Cons:**

- Less "at a glance" than a circular ring for very short remaining times

**Complexity:** Low
**Maintenance:** Very low — no external dependency needed

#### Approach B: Text Countdown Only ("9:42 remaining")

A small text label showing MM:SS format, updating every second.

**Pros:**

- Maximally clear — unambiguous to screen readers and sighted users alike
- No animation means no `prefers-reduced-motion` concern
- Zero implementation complexity

**Cons:**

- No immediate visual urgency — users can ignore text more easily than color change
- Ticking every second creates visual noise in a chat stream
- On its own, fails the UX test of "urgency without anxiety" — feels like a bomb timer

**Complexity:** Very low
**Maintenance:** Very low

**Verdict:** Best used as a complement to Approach A, not standalone. Show text only when < 2 minutes remain.

#### Approach C: Circular Progress Ring

An SVG `circle` with `strokeDashoffset` animating the arc, as seen in GitHub Actions job status indicators and `react-countdown-circle-timer`.

**Pros:**

- Highly glanceable — percentage-remaining is instantly readable
- Visually distinctive — users immediately recognize "this is time-limited"
- `react-countdown-circle-timer` uses a single RAF loop for smooth animation

**Cons:**

- Oversized for a chat tool approval card — draws too much attention relative to the content
- A 10-minute countdown on a small ring is visually indistinguishable from 8 minutes for most of the duration
- Adds a dependency (`react-countdown-circle-timer` ~37k weekly downloads, relatively niche)
- In a dense session with multiple pending approvals, multiple spinning rings create visual chaos

**Complexity:** Low-Medium (library or custom SVG)
**Maintenance:** Medium (dependency)

**Verdict:** Good for dashboards and standalone modals; wrong for inline chat cards.

#### Approach D: Badge/Pill Approach

A colored badge showing "10:00" → "2:00" that transitions from `bg-muted` to `bg-status-warning` to `bg-status-error`.

**Pros:**

- Compact — fits inline next to "Tool approval required" text
- Color state machine is simple to implement
- Works well as the _only_ indicator if screen real estate is constrained

**Cons:**

- Less granular urgency communication than a draining bar
- Updating the displayed time every second is jarring without animation

**Complexity:** Very low
**Maintenance:** Very low

**Verdict:** Good for space-constrained contexts (mobile, collapsed card states). Use as a complement to Approach A.

### 3. Warning State Thresholds

Based on WCAG 2.2.1 (minimum 20 seconds before timeout to allow action), UK Government Design System patterns, and the DigitalA11Y timeout modal research:

| Threshold | Elapsed   | Action                                                                                                                              |
| --------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Initial   | 0:00–8:00 | Neutral progress bar draining silently. No text countdown. Status: info.                                                            |
| Warning   | 8:01–9:00 | Bar color transitions to `status-warning` (amber). "2 minutes remaining" text appears.                                              |
| Urgent    | 9:01–9:40 | Bar color transitions to `status-error` (red). Text updates to seconds: "20 seconds remaining". `aria-live="assertive"` fires once. |
| Critical  | 9:41–9:59 | Brief pulse animation on the bar (skipped under `prefers-reduced-motion`).                                                          |
| Timeout   | 10:00     | Component transitions to "Timed out — auto-denied" state. Clear explanation message.                                                |

**Design rationale for 2-minute threshold (not 1 minute or 10%):**

- 10% of 10 minutes = 1 minute — too short for a user who stepped away
- The UK Government's "5-minute warning at 30 minutes of session" pattern (17% threshold) suggests that 20% (2 minutes) is the right balance for shorter sessions
- 2 minutes gives enough time to read the warning, understand the tool call, and make a decision

### 4. Timer Implementation — RAF vs setInterval vs CSS

**For the progress bar animation (visual drain):**
Use a **CSS `transition` on `width`** with `transition-duration` equal to the full timeout duration. This lets the browser compositor handle the animation entirely off the main thread. No JavaScript timer needed for the visual aspect.

```css
/* Keyframe approach for guaranteed completion at exact time */
.approval-progress-bar {
  animation: drain var(--timeout-duration) linear forwards;
}
@keyframes drain {
  from {
    width: 100%;
  }
  to {
    width: 0%;
  }
}
```

**For the text countdown and warning state triggers:**
Use a **`setInterval` at 1000ms** only during the warning phase (< 2 minutes remaining). Using RAF for a seconds-accurate countdown is overkill and causes unnecessary re-renders at 60fps. `setInterval` at 1s is sufficient and correct for a countdown where the unit is seconds.

```typescript
// Only start the expensive interval in the warning window
useEffect(() => {
  if (secondsRemaining > 120) return; // Before warning threshold — CSS handles visual
  const id = setInterval(() => {
    setSecondsRemaining((s) => s - 1);
  }, 1000);
  return () => clearInterval(id);
}, [secondsRemaining > 120]);
```

**Critical drift concern:** `setInterval` drifts. For a countdown that must expire in sync with the server-side `setTimeout`, use `Date.now()` anchoring:

```typescript
const expiresAt = useRef(Date.now() + timeoutMs);
// In interval: Math.max(0, Math.round((expiresAt.current - Date.now()) / 1000))
```

This prevents the client countdown from displaying "0 seconds" while the server still has 3 seconds on its timer (or vice versa).

**For the progress bar color transition:**
Use Tailwind's `transition-colors` class with duration-300ms between color states. Avoid abrupt color jumps.

### 5. Accessibility Considerations

**ARIA roles:**

- The countdown container needs `role="timer"` (implicit `aria-live="off"`)
- Do NOT use `aria-live="polite"` on the bar — it would announce every second
- Use a separate hidden `role="status"` element that announces only at threshold crossings:
  - "Tool approval required. 2 minutes remaining." (on warning trigger)
  - "Urgent: 20 seconds to approve or deny." (on urgent trigger)
  - "Tool approval timed out. Execution denied." (on timeout)

**`prefers-reduced-motion`:**

- Under reduced motion: skip the draining animation on the bar, show only the color state change
- The text countdown should still update — it's not an animation
- The CSS `animation` approach makes this trivial: `@media (prefers-reduced-motion: reduce) { animation: none; }`

**Color alone is insufficient:**

- The progress bar changes color AND the text label appears — two independent signals
- This satisfies WCAG 1.4.1 (Use of Color)

**Keyboard:**

- No new keyboard interactions introduced (existing Approve/Deny shortcut system handles this)
- The timeout state should not steal focus

**Time limit extension (WCAG 2.2.1):**

- WCAG requires that users can extend the time limit OR be warned with at least 20 seconds remaining
- The 2-minute warning satisfies the "20 seconds" minimum by a large margin
- A "Request more time" button in the warning state would satisfy the "extend" requirement

### 6. Cross-Client Timeout Scenarios

If another client (or the Obsidian plugin via DirectTransport) approves the tool while this client's countdown is running:

**What actually happens:** `runtime.approveTool()` resolves the deferred promise and removes the interaction from `pendingInteractions`. The server then emits a `tool_result` event on the SSE stream. This event triggers `status: 'complete'` on the tool call in `useChatSession`.

**Current gap:** The `ToolApproval` component does not react to the `tool_result` event — it only changes state when the local user clicks Approve/Deny. If another client approves, this client's countdown will continue running and display "X seconds remaining" even after the tool has already executed.

**Fix:** The `ToolApproval` component should watch the `toolCallState.status` prop (passed from `MessageItem`). When `status` changes from `'pending'` to `'complete'` or `'error'` externally, the component should enter the decided state:

```typescript
useEffect(() => {
  if (status !== 'pending' && !decided) {
    setDecided('approved'); // or derive from actual result
  }
}, [status]);
```

This is a separate bug from the timeout visibility feature but should be filed alongside it.

### 7. Timeout Extension Feasibility

**Server side:** The Claude Agent SDK exposes `query.setPermissionMode()` which can be called mid-session. However, resetting a specific interaction's timeout is not directly supported — the timeout is a plain `setTimeout` in `handleToolApproval`. Extending it would require:

1. Storing the `timeout` handle in `pendingInteractions` (it already is — `pending.timeout`)
2. Exposing a new route `POST /api/sessions/:id/extend-approval` that calls `clearTimeout(pending.timeout)` and starts a new timeout
3. Sending a new SSE event `approval_extended` with the new `expiresAt` so all clients reset their countdown

**Client side:** The countdown component would reset to the new `expiresAt`.

**Multi-client concern:** If two clients are watching the same approval and both click "Extend", only one request would be meaningful (the second would re-clear-and-restart the same timer). This is safe but slightly wasteful. A server-side guard ("only extend if > 60 seconds remain") prevents extension spam.

**Recommendation:** Defer timeout extension to a follow-up feature. The initial ship should focus on visibility (countdown) and clear messaging on timeout. Extension adds significant backend complexity for a use case (10-minute timeout feels too short) that is better solved by raising `INTERACTION_TIMEOUT_MS` rather than letting users extend per-approval.

### 8. Timeout State — What to Show After Expiry

When the timeout fires on the client (countdown reaches zero):

1. Transition the card to a "timed out" state (similar to the existing `decided` state)
2. Show a clear, honest message: **"Auto-denied — timed out after 10 minutes"**
3. The card coloring should match the "denied" state (`approvalState({ state: 'denied' })`)
4. Do NOT show the countdown card frozen at "0:00" — replace it immediately

The server will resolve the promise with `{ behavior: 'deny', message: 'Tool approval timed out after 10 minutes' }`, and a `tool_result` event will follow on the SSE stream. The client may receive this event _after_ the local countdown fires — the `useEffect` watching `status` handles this gracefully.

---

## Detailed Analysis

### Progress Bar Implementation Sketch

The component should:

1. Receive `timeoutMs` as a prop (from `ApprovalEvent.timeoutMs` — field to add to schema)
2. Seed `expiresAt = Date.now() + timeoutMs` on mount
3. Use a CSS animation for the bar drain (GPU-composited, no JS)
4. Use `setInterval(1000)` only when `secondsRemaining <= 120` for text countdown
5. Use `Date.now()` anchoring to avoid drift

```typescript
// Rough structure
function ApprovalCountdown({ timeoutMs, onTimeout }: Props) {
  const expiresAt = useRef(Date.now() + timeoutMs);
  const [secondsRemaining, setSecondsRemaining] = useState(Math.round(timeoutMs / 1000));
  const prefersReducedMotion = usePrefersReducedMotion();

  // Text countdown — only active in warning zone
  useEffect(() => {
    if (secondsRemaining > 120) return;
    const id = setInterval(() => {
      const remaining = Math.max(0, Math.round((expiresAt.current - Date.now()) / 1000));
      setSecondsRemaining(remaining);
      if (remaining <= 0) onTimeout();
    }, 1000);
    return () => clearInterval(id);
  }, [secondsRemaining <= 120]);

  // Phase: 'idle' | 'warning' | 'urgent' | 'critical'
  const phase = getPhase(secondsRemaining);

  return (
    <div>
      {/* CSS-animated bar — browser handles drain, no JS needed */}
      <div
        className={cn('h-0.5 rounded-full transition-colors duration-300', barColor(phase))}
        style={{
          animationDuration: `${timeoutMs}ms`,
          animation: prefersReducedMotion ? 'none' : 'drain linear forwards',
        }}
      />
      {/* Text: only show in warning zone */}
      {secondsRemaining <= 120 && (
        <span role="status" className={cn('text-xs', textColor(phase))}>
          {formatRemaining(secondsRemaining)}
        </span>
      )}
      {/* Screen reader announcements at thresholds */}
      <span className="sr-only" aria-live="assertive" aria-atomic="true">
        {phase === 'urgent' ? `Urgent: ${formatRemaining(secondsRemaining)} to approve or deny.` : ''}
      </span>
    </div>
  );
}
```

### Schema Change Required

`ApprovalEventSchema` in `packages/shared/src/schemas.ts` needs one field addition:

```typescript
export const ApprovalEventSchema = z.object({
  toolCallId: z.string(),
  toolName: z.string(),
  input: z.string(),
  timeoutMs: z.number().default(SESSIONS.INTERACTION_TIMEOUT_MS), // NEW
});
```

And in `interactive-handlers.ts` when pushing the event:

```typescript
session.eventQueue.push({
  type: 'approval_required',
  data: {
    toolCallId: toolUseId,
    toolName,
    input: JSON.stringify(input),
    timeoutMs: SESSIONS.INTERACTION_TIMEOUT_MS, // NEW
  },
});
```

This approach avoids hardcoding the timeout in the client and keeps the constant as the single source of truth in `constants.ts`.

### Color Token Mapping

Using existing DorkOS color tokens:

| Phase             | Bar color                | Text color            | Border                     |
| ----------------- | ------------------------ | --------------------- | -------------------------- |
| Idle (> 2 min)    | `bg-muted-foreground/20` | —                     | unchanged                  |
| Warning (1–2 min) | `bg-status-warning`      | `text-status-warning` | `border-status-warning/30` |
| Urgent (< 1 min)  | `bg-status-error`        | `text-status-error`   | `border-status-error/30`   |
| Timed out         | `bg-status-error/30`     | `text-status-error`   | `border-status-error`      |

The card border color change is a second visual signal beyond the bar itself, aiding colorblind users.

---

## Recommendation

**Ship in this order:**

1. **Add `timeoutMs` to `ApprovalEventSchema`** — one-line schema change + handler update
2. **Build `ApprovalCountdown` component** — encapsulated, testable, no external dependencies
3. **Integrate into `ToolApproval`** — render countdown below the header section
4. **Add timeout state to `ToolApproval`** — "Auto-denied — timed out" post-countdown state
5. **Fix cross-client stale countdown** (the `status` watch `useEffect`) — file as companion bug
6. **Defer timeout extension** — too much backend complexity for v1

**Chosen approach: Linear progress bar + text countdown in warning zone**

The bar drain is handled entirely by CSS animation (no JS cost, GPU-composited). The text countdown only runs via `setInterval` in the last 2 minutes. Screen readers get threshold announcements via `aria-live="assertive"`, not per-second updates. `prefers-reduced-motion` users see only color transitions, which remain meaningful. The total JS overhead is a single 1-second interval for the final 120 seconds of a 600-second window — effectively zero.

---

## Sources & Evidence

- [react-countdown-circle-timer - npm](https://www.npmjs.com/package/react-countdown-circle-timer) — RAF-based animation, accessibility notes
- [The best React countdown timer libraries of 2026 | Croct Blog](https://blog.croct.com/post/best-react-countdown-timer-libraries) — Library comparison table, download counts
- [Addressing Timeout Modals: Navigating the Nuances for Inclusive Web Design • DigitalA11Y](https://www.digitala11y.com/addressing-timeout-modals-navigating-the-nuances-for-inclusive-web-design/) — WCAG 2.2.1 requirements, ARIA timer role, `aria-live="assertive"` timing
- [ARIA: timer role - MDN](https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Reference/Roles/timer_role) — `role="timer"` has implicit `aria-live="off"`, must use separate live region for announcements
- [Help users to stop a service timing out - Home Office Design System](https://design.homeoffice.gov.uk/patterns/stop-a-service-timing-out) — Warning threshold patterns from UK government services
- [Timeout warning - MOJ Design System](https://design-patterns.service.justice.gov.uk/components/timeout-warning/) — Button design, single-action modal, no cancel button
- [Accessible Animations in React with "prefers-reduced-motion" • Josh W. Comeau](https://www.joshwcomeau.com/react/prefers-reduced-motion/) — `usePrefersReducedMotion` hook pattern
- [CSS and JavaScript animation performance - MDN](https://developer.mozilla.org/en-US/docs/Web/Performance/Guides/CSS_JavaScript_animation_performance) — GPU compositing for CSS transforms/animations
- [Clocks & Countdowns: Timing in CSS and JavaScript - DEV Community](https://dev.to/madsstoumann/clocks-countdowns-timing-in-css-and-javascript-554n) — CSS animation vs setInterval comparison
- [Stop Using setInterval. Use requestAnimationFrame - WebDevSimplified](https://blog.webdevsimplified.com/2021-12/request-animation-frame/) — RAF vs setInterval analysis; conclusion: use CSS animation where possible, RAF for visual frame-accurate work, setInterval for 1-second ticks is fine
- [ProgressBar – React Aria](https://react-spectrum.adobe.com/react-aria/ProgressBar.html) — ARIA progressbar pattern, `aria-valuenow`, `aria-valuetext`
- [The Urgency Advantage in UX](https://www.numberanalytics.com/blog/urgency-advantage-in-ux) — Urgency without anxiety: genuine limitations + honest communication
- [Concurrent Optimistic Updates in React Query](https://tkdodo.eu/blog/concurrent-optimistic-updates-in-react-query) — Cross-client race condition patterns
- DorkOS source: `apps/server/src/config/constants.ts` — `SESSIONS.INTERACTION_TIMEOUT_MS = 10 * 60 * 1000`
- DorkOS source: `apps/client/src/layers/features/chat/ui/ToolApproval.tsx` — Current component with no timeout awareness
- DorkOS source: `packages/shared/src/schemas.ts` — `ApprovalEventSchema` (no `timeoutMs` field currently)
- DorkOS docs: `contributing/interactive-tools.md` — Full architecture of the deferred promise pattern, timeout handling, cross-client `markToolCallResponded`

---

## Research Gaps & Limitations

- The exact behavior when `handleToolApproval` fires but the SSE stream is briefly disconnected (network blip) was not investigated — the client countdown would continue accurately but the server timeout and client countdown may desync if reconnection takes > 30 seconds
- GitHub Actions and Vercel deployment approval UIs do not show per-job countdown timers in the UI — they simply say "Expires in 30 days". No real-world precedent for sub-hour approval countdowns in CI/CD tooling was found
- `react-countdown-circle-timer` package security posture was not audited

---

## Search Methodology

- Searches performed: 9
- Most productive search terms: "timeout modal UX WCAG aria-live assertive", "react-countdown-circle-timer accessibility", "prefers-reduced-motion countdown React fallback"
- Primary sources: DorkOS codebase (constants.ts, ToolApproval.tsx, schemas.ts, interactive-handlers.ts documentation), MDN (ARIA timer role), DigitalA11Y (WCAG timeout modal guidance), Croct Blog (React timer library comparison)
- Secondary sources: Josh Comeau (reduced motion hook), UK Government Design System patterns, WebDevSimplified (setInterval vs RAF)
