---
slug: terminal-reason-chip
number: 247
created: 2026-04-17
status: specified
---

# Terminal Reason Chip for Non-Completed Session Terminations

**Status**: Specified
**Authors**: Claude Code (2026-04-17)
**Related Ideation**: None — this spec extracts a deferred UI task (3.3) from spec 245 (`claude-agent-sdk-upgrade-0.2.112`).
**Related Spec**: `specs/claude-agent-sdk-upgrade-0.2.112/02-specification.md` (completed Phase 3; plumbing landed, rendering deferred here).

---

## 1) Overview

When the Claude Agent SDK query loop terminates for any reason other than clean `completed` (e.g. the model hit `max_turns`, the user aborted streaming, a stop-hook intervened, the context exploded past `prompt_too_long`, or the rate-limit breaker tripped), the SDK now surfaces a structured `terminal_reason` field on the final `result` message. Spec 245 wired that value end-to-end through `session_status.terminalReason`; we have the signal on the client but are not surfacing it visually.

This spec adds a small, informational Shadcn Badge ("terminal reason chip") to the chat view that renders exactly when a session ends with a non-`completed` reason. The chip is session-level (not per-message), persistent across scroll, cleared when the next stream starts, and strictly informational — no click behavior, no dialogs, no tooltips.

## 2) Background / Problem Statement

### What exists today

- **Server → shared**: `apps/server/src/services/runtimes/claude-code/sdk-event-mapper.ts:507-527` reads `result.terminal_reason` and forwards it via conditional spread onto the `session_status` event.
- **Shared schema**: `packages/shared/src/schemas.ts:377-412` defines `TerminalReasonSchema` (closed 12-member enum plus `string` fallback) and attaches it as an optional field to `SessionStatusEventSchema`.
- **Client stream handler**: `apps/client/src/layers/features/chat/model/stream/stream-event-handler.ts:213-229` merges incoming `session_status` events into `sessionStatusRef.current`, so `sessionStatus.terminalReason` is reliably present on the `SessionStatusEvent` object returned from `useChatSession`.
- **Client data flow**: `ChatPanel.tsx:110, 279` threads `sessionStatus` into `ChatStatusSection` and `ChatInputContainer` but nothing consumes `terminalReason` today.

### What's missing

No UI affordance surfaces non-`completed` terminations. Users see the streaming cursor disappear, token count settle, and nothing else — they cannot distinguish "done" from "aborted at max_turns" from "stopped by a hook" without opening the SDK transcript. This creates three user-visible gaps:

1. **Silent rate-limit breakers** (`rapid_refill_breaker`) look identical to successful completion.
2. **`max_turns` truncation** leaves unclear state — the model may have been mid-task.
3. **Hook-driven stops** (`stop_hook_prevented`, `hook_stopped`) are invisible, so users cannot self-diagnose why the loop ended prematurely.

### Why a chip, not a dialog

A chip is the minimum-viable affordance: it announces the terminal state without demanding attention. Interactive follow-ups (a "Continue" button on `max_turns`, a tooltip explaining each reason) are explicitly deferred — they warrant their own design pass and belong in a future spec.

## 3) Goals

- Render a small Shadcn `Badge` component below the chat message area (above the status strip) whenever `sessionStatus.terminalReason` is set and is not `'completed'`.
- Provide a stable English-language label per known `TerminalReason` value.
- Fall back gracefully to a human-readable derivation of the raw string for forward-compat when the SDK introduces new reason values.
- Clear the chip automatically when a new stream starts (i.e. when `sessionStatus.terminalReason` transitions back to `undefined` or `'completed'` via the next `session_status` event).
- Ship a component-level unit test that covers: undefined case, `'completed'` case, each known non-`completed` reason, and an unknown future reason (fallback path).
- Preserve existing test coverage for `MessageList` and `ChatStatusSection` with zero regressions.

## 4) Non-Goals

- **Dialogs, tooltips, or popovers** — the chip is label-only. Hovering it shows nothing additional. This is explicitly constrained by the spec 245 Task 3.3 deferral note.
- **Contextual actions** — no "Retry", "Continue from max_turns", "Override rate limit" affordances. Those belong in a follow-up spec (`terminal-reason-actions` — not yet created).
- **Retroactive badges on historical messages** — only the _current_ session's final `terminalReason` is rendered. If a user loads a session with a prior non-`completed` termination, the badge does **not** re-appear (SDK JSONL history does not reliably persist `terminal_reason` across reloads, and the value on `sessionStatus` is only what the active stream last emitted).
- **Per-message badging** — the chip is session-level, not attached to a specific assistant message. Plumbing it through the virtualized `MessageList` would require new props on every message, for no semantic gain (a terminal reason describes the session turn, not a single message).
- **i18n / translations** — labels ship as English-only strings. If/when DorkOS adds a translation pipeline, this component becomes a straightforward candidate.
- **Styling variants per severity** — all reasons render with the same Badge variant (`secondary`). Color-coding "severe" reasons (`model_error`) differently from "soft" ones (`max_turns`) is a polish pass, not MVP.

## 5) Technical Dependencies

### External

None. The feature uses only what already ships in DorkOS:

- `@dorkos/shared` — `SessionStatusEvent` type, `TerminalReason` type (added in spec 245).
- Shadcn `Badge` primitive at `apps/client/src/layers/shared/ui/badge.tsx` (already exported from `@/layers/shared/ui`).
- `motion` — optional; used only if we animate the chip's mount/unmount transition (decided below to use `AnimatePresence` for parity with neighbouring UI).

### Internal Abstraction Boundary

- `SessionStatusEvent.terminalReason` is the sole data source. No SDK types cross the boundary — the `TerminalReason` type is defined in `@dorkos/shared`, not re-exported from the SDK (ADR-0089).
- The component lives entirely in the `features/chat` FSD module (`apps/client/src/layers/features/chat/ui/status/`). It imports only from `@/layers/shared/ui`, `@/layers/shared/lib`, and `@dorkos/shared/types` — fully compliant with the FSD layer rule.

### Documentation

- Spec 245 implementation summary: `specs/claude-agent-sdk-upgrade-0.2.112/04-implementation.md` (Task 3.3 deferral note).
- Shadcn Badge docs (internal): `apps/client/src/layers/shared/ui/badge.tsx` — the component supports `default | secondary | destructive | outline` variants.
- Motion/React: https://motion.dev/docs/react (used for `AnimatePresence` consistency).

## 6) Detailed Design

### 6.1 Placement decision: under the message list, above the status strip

**Decision**: render the chip as a new standalone component inside `ChatPanel`, positioned between `<ChatMessageArea>` and `<ChatStatusStrip>`. Name: `TerminalReasonChip`.

**Rationale**:

| Option                                                                       | Pros                                                                                                                             | Cons                                                                                                                                                                                                                                                      |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Inside `ChatStatusStrip` (new state)**                                     | Reuses existing state machine; auto-hides                                                                                        | `complete` state auto-dismisses after 8s (would require disabling); conflates streaming-telemetry with terminal-state info                                                                                                                                |
| **On the last assistant message (inside `AssistantMessageContent`)**         | Stays with the message on scroll                                                                                                 | Requires threading `terminalReason` through the virtualized `MessageList → MessageItem → AssistantMessageContent` chain; pollutes message model with session-level concern; regresses existing `MessageList.test.tsx` (which the spec explicitly forbids) |
| **Standalone slot between `ChatMessageArea` and `ChatStatusStrip` ← chosen** | Zero new props on `MessageList`; zero changes to `ChatStatusSection`; session-level semantic is correct; readable and persistent | One extra DOM node in the chat panel                                                                                                                                                                                                                      |

The chosen layout:

```
ChatPanel
├── ChatMessageArea (MessageList)
├── TerminalReasonChip       ← NEW — renders null unless non-completed reason
├── ChatStatusStrip          ← existing streaming/complete/idle strip
├── PromptSuggestionChips
├── CelebrationOverlay
├── TaskListPanel
└── ChatInputContainer
```

The chip sits just above the status strip so it appears in the user's natural reading path (last message → terminal state → live status → input).

### 6.2 Component: `TerminalReasonChip`

**Location**: `apps/client/src/layers/features/chat/ui/status/TerminalReasonChip.tsx`

**Public API**:

```ts
interface TerminalReasonChipProps {
  /**
   * The session's current terminal reason, as merged from the latest
   * `session_status` StreamEvent. Passing `undefined` or `'completed'`
   * causes the component to render nothing.
   */
  terminalReason?: TerminalReason;
}

export function TerminalReasonChip({
  terminalReason,
}: TerminalReasonChipProps): React.ReactElement | null;
```

**Implementation sketch** (not binding — actual implementation may refine):

```tsx
import { motion, AnimatePresence } from 'motion/react';
import type { TerminalReason } from '@dorkos/shared/types';
import { Badge } from '@/layers/shared/ui';
import { formatTerminalReason, isVisibleReason } from './terminal-reason-labels';

interface TerminalReasonChipProps {
  terminalReason?: TerminalReason;
}

/**
 * Informational chip surfaced below the message list when a session ends
 * with a non-`completed` terminal reason. Renders nothing for undefined or
 * `'completed'` values.
 *
 * Data source: `sessionStatus.terminalReason` on the latest `session_status`
 * StreamEvent. Plumbing landed in spec 245; this component surfaces it.
 */
export function TerminalReasonChip({ terminalReason }: TerminalReasonChipProps) {
  const visible = isVisibleReason(terminalReason);
  const label = visible ? formatTerminalReason(terminalReason) : '';

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          key={terminalReason}
          initial={{ opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -4 }}
          transition={{ duration: 0.2, ease: 'easeOut' }}
          className="flex justify-center px-4 py-1 md:justify-start"
          data-testid="terminal-reason-chip"
        >
          <Badge variant="secondary" aria-label={`Session ended: ${label}`}>
            {label}
          </Badge>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
```

### 6.3 Label module: `terminal-reason-labels.ts`

**Location**: `apps/client/src/layers/features/chat/ui/status/terminal-reason-labels.ts`

Pure logic extracted so it can be unit-tested without a DOM:

```ts
import type { TerminalReason } from '@dorkos/shared/types';

/** Fixed English labels for each known SDK TerminalReason value. */
const KNOWN_LABELS: Readonly<Record<string, string>> = Object.freeze({
  completed: 'Completed',
  aborted_tools: 'Tool aborted',
  aborted_streaming: 'Stream aborted',
  max_turns: 'Max turns reached',
  blocking_limit: 'Blocking limit',
  rapid_refill_breaker: 'Rate limit',
  prompt_too_long: 'Prompt too long',
  image_error: 'Image error',
  model_error: 'Model error',
  stop_hook_prevented: 'Stopped by hook',
  hook_stopped: 'Hook stopped',
  tool_deferred: 'Tool deferred',
});

/**
 * True when the reason is present and non-completed. `undefined` and
 * `'completed'` return false (the chip should render nothing).
 */
export function isVisibleReason(reason?: TerminalReason): reason is TerminalReason {
  return reason !== undefined && reason !== 'completed';
}

/**
 * Map a TerminalReason value to a user-facing label. Known enum members
 * return a curated label; unknown future values (SDK forward-compat via
 * the `string` fallback in TerminalReasonSchema) fall back to a humanised
 * transformation of the raw value (snake_case → Sentence case).
 */
export function formatTerminalReason(reason: TerminalReason): string {
  const known = KNOWN_LABELS[reason];
  if (known !== undefined) return known;
  return humaniseRawReason(reason);
}

/** Best-effort humanisation for forward-compat unknown values. */
function humaniseRawReason(raw: string): string {
  if (raw.length === 0) return 'Ended';
  const words = raw.replace(/[_-]+/g, ' ').trim().split(/\s+/);
  if (words.length === 0) return 'Ended';
  const [first, ...rest] = words;
  const titled = first.charAt(0).toUpperCase() + first.slice(1).toLowerCase();
  return [titled, ...rest.map((w) => w.toLowerCase())].join(' ');
}
```

**Copy table (authoritative)** — matches the proposal in the task description, with `'blocking_limit'` corrected from the truncated input:

| `TerminalReason`       | Label                                              |
| ---------------------- | -------------------------------------------------- |
| `completed`            | `Completed` _(not shown; listed for completeness)_ |
| `aborted_tools`        | `Tool aborted`                                     |
| `aborted_streaming`    | `Stream aborted`                                   |
| `max_turns`            | `Max turns reached`                                |
| `blocking_limit`       | `Blocking limit`                                   |
| `rapid_refill_breaker` | `Rate limit`                                       |
| `prompt_too_long`      | `Prompt too long`                                  |
| `image_error`          | `Image error`                                      |
| `model_error`          | `Model error`                                      |
| `stop_hook_prevented`  | `Stopped by hook`                                  |
| `hook_stopped`         | `Hook stopped`                                     |
| `tool_deferred`        | `Tool deferred`                                    |

### 6.4 Wiring into `ChatPanel`

`apps/client/src/layers/features/chat/ui/ChatPanel.tsx` — insert one line after `<ChatMessageArea .../>` and before `<ChatStatusStrip .../>`:

```tsx
<ChatMessageArea ... />

<TerminalReasonChip terminalReason={sessionStatus?.terminalReason} />

<ChatStatusStrip ... />
```

No other props required — `sessionStatus` already exists in `ChatPanel` scope at line 110 and is reactively updated by `useChatSession`.

### 6.5 Barrel export

`apps/client/src/layers/features/chat/ui/status/index.ts` — append:

```ts
export { TerminalReasonChip } from './TerminalReasonChip';
```

Then `ChatPanel.tsx` imports from the barrel:

```ts
import { TerminalReasonChip } from './status';
```

(Matching the existing pattern for `ChatStatusStrip` and `ChatStatusSection`.)

### 6.6 Lifecycle / clearing behavior

The chip's visibility derives entirely from `sessionStatus.terminalReason`. No local state, no timers. The clearing contract:

- **On new user message submission**: `useChatSession` starts a new stream. The server does not emit a `session_status` event at stream start (it's emitted on the `result` message), so the chip remains visible _during_ the next stream until the new terminal reason arrives. This is acceptable — the chip reflects the **last known** terminal state.
- **On session switch**: `sessionStatusRef` is reset inside `useChatSession` to match the new session's state. If the new session has never streamed, `terminalReason` is undefined and the chip renders nothing.
- **On the next `result` message**: the incoming `session_status` event is merged (see `stream-event-handler.ts:213-229`). If the new reason is `'completed'` or absent, the chip hides via `AnimatePresence` exit animation. If the new reason is a different non-`completed` value, the chip's `key={terminalReason}` causes `AnimatePresence` to re-mount with the new label.

This matches the "Acceptance: No chip on normal completions; no retroactive badges on historical messages" contract.

### 6.7 Accessibility

- The Badge uses an `aria-label` prefixed with `"Session ended: "` so screen readers announce context, not just the bare label.
- The chip is announced once on mount (default `aria-live="off"` — the surrounding message list is already `aria-live="polite"`; adding another live region would cause duplicate announcements). If user research later shows announce-on-appearance is needed, wrap in a `role="status"` container — explicitly deferred for MVP.
- No interactive elements → no keyboard focus requirements.

### 6.8 Visual design

- Variant: `secondary` (neutral grey, matches non-urgent informational affordances).
- Positioning: centered on mobile (matches `ChatStatusStrip` layout), left-aligned on `md+` (matches status strip's `md:justify-start`).
- Vertical breathing: `py-1` to match the strip's density.
- Motion: 200ms fade + 4px y-translate, easing `easeOut`. Matches the existing `ChatStatusStrip` `AnimatePresence` pattern.

### 6.9 End-to-end data flow

```
[SDK result message]
    └─► sdk-event-mapper.ts:512 (reads result.terminal_reason)
        └─► session_status StreamEvent { terminalReason: TerminalReason }
            └─► SSE transport
                └─► stream-event-handler.ts:213 (merges into sessionStatusRef)
                    └─► useChatSession exposes sessionStatus
                        └─► ChatPanel renders <TerminalReasonChip terminalReason={...} />
                            ├─► isVisibleReason() → false  → returns null
                            └─► isVisibleReason() → true   → Badge with formatted label
```

No new state, no new events, no new contracts. This is a pure display layer addition.

## 7) User Experience

### Happy path (normal completion)

1. User submits a message.
2. Stream plays out; `ChatStatusStrip` shows streaming verbs, elapsed time, tokens.
3. Stream completes cleanly (`terminal_reason: 'completed'`).
4. `ChatStatusStrip` shows its `complete` summary for 8s, then auto-dismisses.
5. `TerminalReasonChip` renders nothing throughout. **No visible change from today.**

### Non-completed termination (`max_turns`)

1. User submits a message.
2. Stream plays out to the SDK's turn cap.
3. SDK emits `result` with `terminal_reason: 'max_turns'`.
4. `ChatStatusStrip` shows its `complete` summary (unchanged).
5. Below the message list, a grey Badge fades in reading "Max turns reached".
6. The chip stays until the user sends their next message and that stream resolves with a different reason (or `'completed'`).

### Forward-compat: SDK adds a new reason

1. Hypothetical future SDK emits `terminal_reason: 'some_new_reason'`.
2. `TerminalReasonSchema`'s `string` fallback accepts the raw value.
3. `TerminalReasonChip` renders `"Some new reason"` (via `humaniseRawReason`).
4. No runtime error, no missing UI — graceful degradation. A follow-up PR can add the curated label once we learn the semantic.

## 8) Testing Strategy

### 8.1 New component test: `TerminalReasonChip.test.tsx`

**Location**: `apps/client/src/layers/features/chat/__tests__/TerminalReasonChip.test.tsx`

Use `@vitest-environment jsdom`, `@testing-library/react`, `@testing-library/jest-dom`. No Transport mock required — the component has no data dependencies beyond props.

**Test cases** (each with a `// Purpose:` comment per the project testing convention):

```tsx
/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom';
import { TerminalReasonChip } from '../ui/status/TerminalReasonChip';

afterEach(cleanup);

describe('TerminalReasonChip', () => {
  // Purpose: when no reason is set, the chip must render nothing — no empty
  // Badge, no placeholder. Verifies the default no-op path.
  it('renders nothing when terminalReason is undefined', () => {
    const { container } = render(<TerminalReasonChip terminalReason={undefined} />);
    expect(container).toBeEmptyDOMElement();
  });

  // Purpose: `'completed'` is the success case and must never show a chip.
  // Guards against accidentally labelling clean completions as terminations.
  it('renders nothing when terminalReason is "completed"', () => {
    const { container } = render(<TerminalReasonChip terminalReason="completed" />);
    expect(container).toBeEmptyDOMElement();
  });

  // Purpose: each curated label from the copy table must render exactly
  // as specified. Driven table-style so new SDK reasons can be added without
  // adding a new test block.
  it.each([
    ['aborted_tools', 'Tool aborted'],
    ['aborted_streaming', 'Stream aborted'],
    ['max_turns', 'Max turns reached'],
    ['blocking_limit', 'Blocking limit'],
    ['rapid_refill_breaker', 'Rate limit'],
    ['prompt_too_long', 'Prompt too long'],
    ['image_error', 'Image error'],
    ['model_error', 'Model error'],
    ['stop_hook_prevented', 'Stopped by hook'],
    ['hook_stopped', 'Hook stopped'],
    ['tool_deferred', 'Tool deferred'],
  ] as const)('renders label "%s" → "%s"', (reason, expected) => {
    render(<TerminalReasonChip terminalReason={reason} />);
    expect(screen.getByText(expected)).toBeInTheDocument();
  });

  // Purpose: forward-compat — when the SDK adds a future reason the
  // TerminalReasonSchema's string fallback accepts it; the component must
  // humanise it rather than crash or render the raw snake_case.
  it('humanises unknown raw string reasons (forward-compat)', () => {
    render(<TerminalReasonChip terminalReason="some_future_reason" />);
    expect(screen.getByText('Some future reason')).toBeInTheDocument();
  });

  // Purpose: the chip surfaces a screen-reader context prefix so assistive
  // tech announces "Session ended: …" rather than just the bare label.
  it('exposes an aria-label with "Session ended:" prefix', () => {
    render(<TerminalReasonChip terminalReason="max_turns" />);
    expect(screen.getByLabelText('Session ended: Max turns reached')).toBeInTheDocument();
  });

  // Purpose: stable test id is part of the component's test contract —
  // higher-level integration tests can key off it without relying on text.
  it('exposes data-testid="terminal-reason-chip" when visible', () => {
    render(<TerminalReasonChip terminalReason="model_error" />);
    expect(screen.getByTestId('terminal-reason-chip')).toBeInTheDocument();
  });
});
```

### 8.2 Pure-function test: `terminal-reason-labels.test.ts` (optional, recommended)

The label module is pure — a small dedicated test doubles as documentation of the fallback algorithm:

```ts
// Purpose: humaniseRawReason must handle edge cases (empty, single word,
// mixed separators) without throwing — forward-compat is pointless if a
// malformed SDK value crashes the client.
describe('formatTerminalReason fallback', () => {
  it('uppercases the first word and lowercases the rest', () => {
    expect(formatTerminalReason('FOO_BAR_BAZ')).toBe('Foo bar baz');
  });
  it('handles hyphen separators', () => {
    expect(formatTerminalReason('foo-bar')).toBe('Foo bar');
  });
  it('handles single-word values', () => {
    expect(formatTerminalReason('ended')).toBe('Ended');
  });
});
```

Optional because the component test already covers the happy path; include this for defensive coverage.

### 8.3 Regression surface

The following existing tests **must still pass without modification** after the change:

- `apps/client/src/layers/features/chat/__tests__/MessageList.test.tsx` — we add nothing to `MessageList`.
- `apps/client/src/layers/features/chat/__tests__/ChatStatusSection-configure.test.tsx` — we add nothing to `ChatStatusSection`.
- `apps/client/src/layers/features/chat/__tests__/ChatStatusStrip.test.tsx` — we don't touch the strip.
- `apps/client/src/layers/features/chat/__tests__/ChatPanel.test.tsx` — `ChatPanel` gains one new child, but the existing assertions are content-based, not structure-based. If any assertion counts DOM nodes inside `ChatPanel`, update the count; otherwise no change.

Verification: run `pnpm vitest run apps/client/src/layers/features/chat` before and after — expect identical pass counts plus the new tests.

### 8.4 No E2E test required

The existing e2e suite covers the golden path (successful completion) which is unchanged. An e2e for non-completed terminations would require synthesising an SDK failure mode (e.g. forcing `max_turns`), which is heavier than the value justifies for an informational chip. Deferred to the follow-up spec if we ever ship interactive behavior.

## 9) Performance Considerations

Negligible:

- One extra React element in the `ChatPanel` render tree.
- `AnimatePresence` subscription is cheap and already in use elsewhere in the same tree.
- No subscriptions, no timers, no memoisation required — `terminalReason` is a primitive on an already-reactive `sessionStatus` object.
- Bundle delta: estimated < 1KB min+gz (component + labels module).

## 10) Security Considerations

None. The component renders trusted, server-emitted string values that have been Zod-validated (`TerminalReasonSchema`) at the boundary. The humaniser function operates on strings via a small allowlist of regex-safe transforms (`replace(/[_-]+/g, ' ')`); no HTML injection vector. React's default escaping applies.

## 11) Documentation

- **Internal dev guide**: no new guide needed — the component is discoverable via the existing `status/` directory structure. A one-line mention in `contributing/chat.md` (if one exists; otherwise skip) pointing at the barrel would suffice.
- **Changelog entry**: yes. Suggested wording: _"UI: Surface SDK `terminal_reason` as an informational chip below the chat when a session ends for non-`completed` reasons (max turns, rate limit, stop hook, etc.)."_
- **Spec 245 follow-up**: update `specs/claude-agent-sdk-upgrade-0.2.112/04-implementation.md` "Deferred UI Work" section to cross-reference this spec once it ships.

## 12) Implementation Phases

This is a small, single-phase feature. No staging required.

**Phase 1 (MVP — the entire scope)**:

1. Create `apps/client/src/layers/features/chat/ui/status/terminal-reason-labels.ts` with `KNOWN_LABELS`, `isVisibleReason`, `formatTerminalReason`, `humaniseRawReason`.
2. Create `apps/client/src/layers/features/chat/ui/status/TerminalReasonChip.tsx` with the component.
3. Export both from `apps/client/src/layers/features/chat/ui/status/index.ts`.
4. Wire into `apps/client/src/layers/features/chat/ui/ChatPanel.tsx` between `ChatMessageArea` and `ChatStatusStrip`.
5. Add `apps/client/src/layers/features/chat/__tests__/TerminalReasonChip.test.tsx` with the 6 test cases above.
6. (Optional) Add `apps/client/src/layers/features/chat/__tests__/terminal-reason-labels.test.ts` for the fallback humaniser edge cases.
7. Run: `pnpm lint && pnpm typecheck && pnpm vitest run apps/client/src/layers/features/chat`.
8. Manually verify in dev playground: send a prompt that forces `max_turns` (e.g. `maxTurns: 1` override in dev settings, if exposed) and confirm the chip appears, reads correctly, and clears on the next submission.

No Phase 2 / Phase 3 — interactive treatments are out of scope and belong in a separate spec.

## 13) Open Questions

1. **Should the chip persist after session switch?**
   - Current design: yes, because `sessionStatus` is per-session and the chip reads it reactively. Switching sessions resets the chip naturally via `useChatSession`'s state reset. No explicit handling needed.
   - Risk: if `sessionStatusRef` is stale across switches (hypothetical bug), the chip could flash the wrong reason. Mitigation: the component's `key={terminalReason}` prop already handles this — a change in value re-mounts with fresh animation.

2. **Do we want a severity-based color variant now or later?**
   - Recommendation: **later**. Launch with `secondary` uniformly; gather user feedback; add `destructive` for `model_error`/`image_error` in a follow-up if the demand emerges. Shipping neutral is reversible; shipping opinionated color is not.

3. **Should the chip also appear on the `/session` route if loaded cold (no live stream)?**
   - By design, no — `sessionStatus.terminalReason` is ephemeral (only set on `session_status` events during the active SSE stream). Cold-loading a session from JSONL does not rehydrate `terminalReason` because the SDK's result messages don't round-trip it. This is consistent with the "Non-goals: no retroactive badges" constraint.
   - If the product later wants retroactive display, we'd need to either (a) parse `terminal_reason` from the last JSONL `result` line on session load, or (b) persist `terminalReason` alongside session metadata. Both are out of scope.

4. **Should the chip render during `'tool_deferred'` (a non-error, intentional pause state)?**
   - Per the copy table, yes — it reads "Tool deferred" and informs the user that the SDK is waiting. This matches how the SDK uses the value semantically (the loop genuinely terminated, just with deferred work outstanding).
   - Alternative: exclude `tool_deferred` from the visible set, since the system status strip already surfaces deferred-work context. Decision: **include it** for consistency; a future spec can promote deferred-tool UX into a richer affordance if needed.

## 14) Related ADRs

- **ADR-0089** (`decisions/0089-sdk-import-confinement-via-lint-rule.md`) — SDK types must not leak outside `services/runtimes/claude-code/`. This spec complies by consuming only the `TerminalReason` type re-exported from `@dorkos/shared/types`.
- **ADR-0085** (`decisions/0085-agent-runtime-interface-as-universal-abstraction.md`) — the chip reads from a runtime-neutral event (`session_status`), not from SDK-specific shapes. Future runtimes (Codex) can emit equivalent `terminalReason` values and reuse this UI unchanged.
- **ADR-0003** (`decisions/0003-sdk-jsonl-as-single-source-of-truth.md`) — informs the "no retroactive badges" non-goal: we intentionally do not reach into JSONL to rehydrate `terminalReason` on historical sessions.

## 15) References

- Spec 245: `specs/claude-agent-sdk-upgrade-0.2.112/02-specification.md` (Task 3.3 — original scope), `04-implementation.md` (deferral note line 77–78).
- Source locations already wired (do not modify):
  - `apps/server/src/services/runtimes/claude-code/sdk-event-mapper.ts:507-527`
  - `apps/server/src/services/runtimes/claude-code/__tests__/sdk-event-mapper.test.ts:627-666`
  - `packages/shared/src/schemas.ts:377-412`
  - `apps/client/src/layers/features/chat/model/stream/stream-event-handler.ts:213-229`
- SDK `TerminalReason` union: see `node_modules/.pnpm/@anthropic-ai+claude-agent-sdk@0.2.112.../sdk.d.ts` (as documented in spec 245 Task 4.1 research notes).
- Badge primitive: `apps/client/src/layers/shared/ui/badge.tsx`.
- Layer hierarchy rules: `.claude/rules/fsd-layers.md`.
- Testing conventions: `.claude/rules/testing.md`.

---

## Appendix A — Files Touched Summary

**New**:

- `apps/client/src/layers/features/chat/ui/status/TerminalReasonChip.tsx`
- `apps/client/src/layers/features/chat/ui/status/terminal-reason-labels.ts`
- `apps/client/src/layers/features/chat/__tests__/TerminalReasonChip.test.tsx`
- `apps/client/src/layers/features/chat/__tests__/terminal-reason-labels.test.ts` _(optional)_

**Modified**:

- `apps/client/src/layers/features/chat/ui/ChatPanel.tsx` — add 1 element + 1 import
- `apps/client/src/layers/features/chat/ui/status/index.ts` — add 1 re-export

**Unchanged** (verify):

- All files under `apps/server/**` — no server changes.
- All files under `packages/**` — no shared-package changes.
- `MessageList.tsx`, `MessageItem.tsx`, `AssistantMessageContent.tsx`, `ChatStatusSection.tsx`, `ChatStatusStrip.tsx` — zero edits.
