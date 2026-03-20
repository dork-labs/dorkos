---
slug: tool-approval-timeout-visibility
number: 138
created: 2026-03-16
status: specification
authors: [Claude Code]
---

# Tool Approval Timeout Visibility

## Status

Specification

## Overview

Make the 10-minute tool approval timeout visible to users. When Claude requests tool approval, `ToolApproval.tsx` currently shows approve/deny buttons with zero indication that a timeout exists. When the timeout fires, the tool is silently auto-denied and the agent continues without explanation. This spec adds a linear progress bar countdown, warning states at 2 minutes and 1 minute remaining, and a clear denied-state message when timeout occurs.

## Background / Problem Statement

The Claude Agent SDK imposes a 10-minute timeout on tool approval requests (`SESSIONS.INTERACTION_TIMEOUT_MS = 600,000ms` in `apps/server/src/config/constants.ts`). When the timeout fires, `interactive-handlers.ts` silently resolves the deferred promise with `{ behavior: 'deny', message: 'Tool approval timed out after 10 minutes' }`. The client receives no notification — the approval card stays in its pending state while the agent moves on. Users who step away from their screen return to find the agent continued without approval, with no explanation of what happened.

The SDK audit (`.temp/agent-sdk-audit.md`) rates tool approval timeout UX at **2.5/5** and lists it as punch list item #16 (P2).

## Goals

- Show a draining progress bar in the approval card so users know time is limited
- Transition to amber warning at 2 minutes remaining with a text countdown
- Transition to red urgent at 1 minute remaining
- Replace the pending card with a denied-state explanation when timeout fires on the client
- Pass timeout duration from server to client via the `approval_required` event
- Meet WCAG accessibility requirements for timed interactions

## Non-Goals

- Timeout extension mechanism (deferred — raise `INTERACTION_TIMEOUT_MS` globally if too short)
- Configurable timeout duration via settings UI
- Cross-client approval sync indicator (separate concern)
- QuestionPrompt timeout handling (different interactive type)
- Changes to server-side timeout behavior

## Technical Dependencies

- **React 19** — hooks, refs (already in use)
- **Tailwind CSS 4** — styling, `@keyframes`, `prefers-reduced-motion` (already in use)
- **tailwind-variants** — `approvalState` variant (already in use)
- **motion/react** — fade/scale transitions (already in use)
- **Zod** — schema extension for `ApprovalEventSchema` (already in use)
- No new dependencies required

## Detailed Design

### 1. Schema Change — `ApprovalEventSchema`

Add `timeoutMs` to the approval event so the client knows the timeout duration.

**File:** `packages/shared/src/schemas.ts`

```typescript
export const ApprovalEventSchema = z
  .object({
    toolCallId: z.string(),
    toolName: z.string(),
    input: z.string(),
    timeoutMs: z.number().describe('Server-side approval timeout in milliseconds'),
  })
  .openapi('ApprovalEvent');
```

### 2. Server — Include `timeoutMs` in Event

**File:** `apps/server/src/services/runtimes/claude-code/interactive-handlers.ts`

In `handleToolApproval`, add `timeoutMs` to the event payload:

```typescript
session.eventQueue.push({
  type: 'approval_required',
  data: {
    toolCallId: toolUseId,
    toolName,
    input: JSON.stringify(input),
    timeoutMs: SESSIONS.INTERACTION_TIMEOUT_MS,
  },
});
```

### 3. Client — Stream Event Handler

**File:** `apps/client/src/layers/features/chat/model/stream-event-handler.ts`

Pass `timeoutMs` through to the tool call part. Add a new field to the tool call part type:

```typescript
case 'approval_required': {
  const approval = data as ApprovalEvent;
  const existingA = findToolCallPart(approval.toolCallId);
  if (existingA) {
    existingA.interactiveType = 'approval';
    existingA.input = approval.input;
    existingA.status = 'pending';
    existingA.timeoutMs = approval.timeoutMs;
  } else {
    currentPartsRef.current.push({
      type: 'tool_call',
      toolCallId: approval.toolCallId,
      toolName: approval.toolName,
      input: approval.input,
      status: 'pending',
      interactiveType: 'approval',
      timeoutMs: approval.timeoutMs,
    });
  }
  updateAssistantMessage(assistantId);
  break;
}
```

The `ToolCallPart` type (in `schemas.ts` or the client types) needs a new optional field: `timeoutMs?: number`.

### 4. Client — ToolApproval Component

**File:** `apps/client/src/layers/features/chat/ui/ToolApproval.tsx`

This is the primary change. Add countdown timer logic, progress bar, warning states, and timeout message.

#### 4.1 New Props

Add `timeoutMs` to the component props:

```typescript
interface ToolApprovalProps {
  sessionId: string;
  toolCallId: string;
  toolName: string;
  input: string;
  isActive: boolean;
  onDecided?: () => void;
  timeoutMs?: number; // Server-provided timeout duration
}
```

#### 4.2 Countdown State

Follow the `InferenceIndicator.tsx` pattern (lines 75-90):

```typescript
const [secondsRemaining, setSecondsRemaining] = useState<number | null>(null);
const expiresAtRef = useRef<number | null>(null);

useEffect(() => {
  if (decided || !timeoutMs) return;

  const expiresAt = Date.now() + timeoutMs;
  expiresAtRef.current = expiresAt;
  setSecondsRemaining(Math.ceil(timeoutMs / 1000));

  const interval = setInterval(() => {
    const remaining = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
    setSecondsRemaining(remaining);

    if (remaining <= 0) {
      clearInterval(interval);
    }
  }, 1000);

  return () => clearInterval(interval);
}, [timeoutMs, decided]);
```

#### 4.3 Timeout Detection

When countdown reaches 0, transition to denied state:

```typescript
useEffect(() => {
  if (secondsRemaining === 0 && !decided) {
    setDecided('denied');
    // Note: server-side timeout handles the actual denial.
    // This is a client-side visual update only.
  }
}, [secondsRemaining, decided]);
```

#### 4.4 Warning Thresholds

Define thresholds as constants:

```typescript
const WARNING_THRESHOLD_S = 120; // 2 minutes — amber
const URGENT_THRESHOLD_S = 60; // 1 minute — red
```

Derive the current phase:

```typescript
type ApprovalPhase = 'normal' | 'warning' | 'urgent' | 'expired';

const phase: ApprovalPhase = useMemo(() => {
  if (secondsRemaining === null) return 'normal';
  if (secondsRemaining <= 0) return 'expired';
  if (secondsRemaining <= URGENT_THRESHOLD_S) return 'urgent';
  if (secondsRemaining <= WARNING_THRESHOLD_S) return 'warning';
  return 'normal';
}, [secondsRemaining]);
```

#### 4.5 Progress Bar

A 4px tall div draining via CSS animation. The animation duration is set to `timeoutMs`:

```tsx
{
  timeoutMs && !decided && (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={Math.ceil(timeoutMs / 1000)}
      aria-valuenow={secondsRemaining ?? 0}
      aria-valuetext={formatAriaTimeRemaining(secondsRemaining)}
      className="bg-muted h-1 w-full overflow-hidden rounded-full"
    >
      <div
        className={cn(
          'h-full rounded-full transition-colors duration-500',
          phase === 'normal' && 'bg-muted-foreground/30',
          phase === 'warning' && 'bg-status-warning',
          phase === 'urgent' && 'bg-status-error',
          'motion-safe:animate-drain'
        )}
        style={{
          animationDuration: `${timeoutMs}ms`,
          animationTimingFunction: 'linear',
          animationFillMode: 'forwards',
        }}
      />
    </div>
  );
}
```

The `animate-drain` keyframe:

```css
/* In Tailwind config or a CSS file */
@keyframes drain {
  from {
    width: 100%;
  }
  to {
    width: 0%;
  }
}
```

With `motion-safe:` prefix, the animation only runs when `prefers-reduced-motion` is not `reduce`. When motion is reduced, the bar stays full but still changes color at thresholds.

#### 4.6 Text Countdown

Only appears when `phase` is `warning` or `urgent` (final 2 minutes):

```tsx
{
  (phase === 'warning' || phase === 'urgent') && secondsRemaining !== null && (
    <span
      className={cn(
        'text-2xs tabular-nums',
        phase === 'warning' && 'text-status-warning',
        phase === 'urgent' && 'text-status-error'
      )}
    >
      {formatCountdown(secondsRemaining)} remaining
    </span>
  );
}
```

Helper:

```typescript
function formatCountdown(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}:${String(s).padStart(2, '0')}` : `${s}s`;
}
```

#### 4.7 Timeout Message

When `decided === 'denied'` AND the denial was caused by timeout (not user action), show an explanation. Track whether the denial was a timeout via a ref:

```typescript
const timedOut = useRef(false);

// In the timeout effect:
if (secondsRemaining === 0 && !decided) {
  timedOut.current = true;
  setDecided('denied');
}
```

In the denied state render:

```tsx
{
  decided === 'denied' && timedOut.current && (
    <p className="text-2xs text-muted-foreground mt-1">
      Auto-denied — approval timed out after {Math.ceil((timeoutMs ?? 0) / 60000)} minutes. The
      agent continued without this tool.
    </p>
  );
}
```

#### 4.8 Accessibility — Screen Reader Announcements

A hidden live region announces at threshold crossings only (not per-second):

```tsx
const [announcement, setAnnouncement] = useState('');

useEffect(() => {
  if (secondsRemaining === WARNING_THRESHOLD_S) {
    setAnnouncement('Tool approval required. 2 minutes remaining.');
  } else if (secondsRemaining === URGENT_THRESHOLD_S) {
    setAnnouncement('Urgent: 1 minute to approve or deny.');
  } else if (secondsRemaining === 0) {
    setAnnouncement('Tool approval timed out. Execution denied.');
  }
}, [secondsRemaining]);

// In JSX:
<span role="status" aria-live="assertive" aria-atomic="true" className="sr-only">
  {announcement}
</span>;
```

### 5. Tailwind Keyframe

**File:** `apps/client/src/index.css` (or equivalent Tailwind v4 config)

Add the drain animation keyframe:

```css
@keyframes drain {
  from {
    width: 100%;
  }
  to {
    width: 0%;
  }
}
```

And register as a utility:

```css
@utility animate-drain {
  animation-name: drain;
}
```

## User Experience

### Normal State (0–8 minutes remaining)

The approval card looks nearly identical to today, with one addition: a thin progress bar below the header, slowly draining left-to-right. The bar is a subtle `muted-foreground/30` color — noticeable but not attention-grabbing.

### Warning State (2 minutes remaining)

The progress bar turns amber (`status-warning`). A text countdown appears below the bar: "1:42 remaining". This is the first explicit time indication — designed to alert without panic.

### Urgent State (1 minute remaining)

The progress bar turns red (`status-error`). The countdown continues. A screen reader announces "Urgent: 1 minute to approve or deny."

### Expired State (0 seconds)

The approval card transitions to the "denied" visual state (existing `approvalState({ state: 'denied' })` styling). Buttons are removed. A message appears: "Auto-denied — approval timed out after 10 minutes. The agent continued without this tool."

### Normal Approve/Deny Flow

Unchanged. If the user clicks Approve or Deny at any point during the countdown, the timer stops, the card transitions to approved/denied state as before, and no timeout message appears.

## Testing Strategy

### Unit Tests — ToolApproval.test.tsx

New test cases to add:

1. **Progress bar renders when timeoutMs provided** — Verify `role="progressbar"` element exists with correct aria attributes
2. **No progress bar when timeoutMs is undefined** — Backward compatibility
3. **Text countdown appears at warning threshold** — Use `vi.useFakeTimers()`, advance to 8 minutes, verify "2:00 remaining" text appears
4. **Text countdown absent before warning threshold** — Advance to 5 minutes, verify no countdown text
5. **Urgent phase styling** — Advance to 9 minutes, verify red styling applied
6. **Timeout transitions to denied state** — Advance full 10 minutes, verify "Auto-denied" message appears
7. **Timeout message NOT shown on manual deny** — Click deny, verify no timeout message
8. **Approve still works during countdown** — Click approve at 5 minutes, verify approved state, no timer
9. **Screen reader announcement at warning threshold** — Verify `aria-live` region updates at 2-minute mark
10. **Screen reader announcement at urgent threshold** — Verify update at 1-minute mark

**Timer testing pattern:**

```typescript
beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

it('shows countdown text at 2-minute warning threshold', () => {
  render(
    <ToolApproval
      sessionId="s1"
      toolCallId="tc1"
      toolName="Bash"
      input="{}"
      isActive={true}
      timeoutMs={600_000}
    />,
    { wrapper: Wrapper }
  );

  // Advance to 8 minutes (2 minutes remaining)
  vi.advanceTimersByTime(480_000);

  expect(screen.getByText(/remaining/)).toBeInTheDocument();
});
```

### Integration Tests

- Verify `approval_required` SSE event includes `timeoutMs` field
- Verify `stream-event-handler` passes `timeoutMs` through to tool call part

### E2E Tests

Not required for this change — the timer behavior is fully testable with unit tests and fake timers.

## Performance Considerations

- **CSS animation is GPU-composited** — the progress bar drain runs off the main thread for the entire 10-minute duration, zero JS cost
- **`setInterval(1000)` runs for full duration** but the callback is minimal (~5 microseconds per tick: `Date.now()` subtraction + `Math.max/ceil` + state setter). React batches the state update with other pending updates
- **No re-renders in normal phase** — the text countdown only renders in the final 2 minutes, so for the first 8 minutes only the interval tick + `setSecondsRemaining` fires (React skips re-render when value doesn't change the derived `phase`)
- **Cleanup on unmount** — `clearInterval` in the effect cleanup prevents memory leaks

## Security Considerations

- No security implications — this is a purely visual change
- The timeout behavior itself is unchanged; the server still enforces the 10-minute deadline
- The client-side countdown is cosmetic; the server-side `setTimeout` is the authoritative timeout

## Documentation

- Update `contributing/interactive-tools.md` to mention the visible countdown timer
- No external documentation changes needed

## Implementation Phases

### Phase 1: Core Implementation

1. Extend `ApprovalEventSchema` with `timeoutMs` field
2. Add `timeoutMs` to server event payload in `interactive-handlers.ts`
3. Pass `timeoutMs` through `stream-event-handler.ts`
4. Add countdown state, progress bar, and warning phases to `ToolApproval.tsx`
5. Add `@keyframes drain` and `animate-drain` utility to CSS
6. Add timeout expiration message
7. Add screen reader announcements
8. Update existing tests + add new countdown/timeout tests

This is a single-phase implementation — the feature is small enough to ship as one unit.

## Open Questions

No open questions — all decisions resolved during ideation.

## Related ADRs

- **ADR-0085: Agent Runtime Interface** — Confirms `interactive-handlers.ts` is the single source of truth for interactive tool logic
- **ADR-0135: Binding-Level Permission Mode** — Tool approval is critical across different trust contexts; timeout visibility improves all permission modes

## References

- Ideation: `specs/tool-approval-timeout-visibility/01-ideation.md`
- SDK Audit: `.temp/agent-sdk-audit.md` (punch list item #16)
- Architecture: `contributing/interactive-tools.md` (timeout handling section)
- Reference pattern: `InferenceIndicator.tsx` lines 75-90 (countdown implementation)
- WCAG 2.2.1: Timing Adjustable — 20-second warning requirement (satisfied by 2-minute threshold)
