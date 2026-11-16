---
slug: unified-status-strip
number: 153
created: 2026-03-20
status: specified
---

# Unified Status Strip Specification

**Status:** Specified
**Authors:** Claude Code
**Date:** 2026-03-20
**Ideation:** `specs/unified-status-strip/01-ideation.md`
**Research:** `research/20260320_unified_status_strip.md`

---

## Overview

Consolidate `InferenceIndicator` and `SystemStatusZone` into a single `ChatStatusStrip` component using a state machine architecture. One morphing container, positioned between `MessageList` and the chat input, displays exactly one status type at a time using a prioritized state selector. Visual styles converge on the muted `SystemStatusZone` aesthetic while preserving the data richness of `InferenceIndicator` (rotating verbs, elapsed time, token count).

## Background / Problem Statement

The chat UI currently has two separate status display components with divergent placement, visual style, and behavior:

1. **`InferenceIndicator`** (209 lines, `layers/features/chat/ui/InferenceIndicator.tsx`): Positioned _inside_ the `MessageList` virtualizer as an absolutely-positioned element below all virtual items. This means it scrolls with content and becomes invisible when the user scrolls up. It displays 4 states (streaming, complete, waiting-for-user, rate-limited) with rotating verbs, elapsed time, and token count. Seven inference-related props are threaded through `MessageList` solely to reach this component.

2. **`SystemStatusZone`** (30 lines, `layers/features/chat/ui/SystemStatusZone.tsx`): Positioned _between_ `MessageList` and the chat input in `ChatPanel` (line 353). Always visible regardless of scroll position. Displays ephemeral SDK status messages (e.g., "Compacting context...") with an `AnimatePresence` height collapse + opacity fade. Auto-clears via a 4-second timer in `useChatSession`.

These components serve the same conceptual purpose — telling the user what the agent is doing — but diverge in every dimension: placement, visual weight, data richness, and lifecycle. The consolidation creates a single mental model for users: "that zone below the messages tells me what's happening."

## Goals

- Replace both `InferenceIndicator` and `SystemStatusZone` with a single `ChatStatusStrip` component
- Position the strip outside the scroll container (always visible regardless of scroll position)
- Display exactly one status type at a time, selected by an explicit priority stack
- Converge visual styles on the muted `SystemStatusZone` palette (`text-muted-foreground/60`, `text-xs`)
- Preserve data richness: rotating verbs, elapsed time, token count during streaming
- Simplify `MessageList` by removing 7 inference-related props
- Eliminate the prop-threading pattern from `ChatPanel` through `MessageList` to `InferenceIndicator`
- Make the priority logic testable as a pure function without React mocks

## Non-Goals

- Changes to the `useChatSession` hook internals or state shape
- New status types not already modeled (e.g., context window usage percentage)
- `StatusLine` (bottom bar) consolidation — separate component, different concerns
- Changes to how system status messages are generated server-side
- Changes to the system status auto-clear timer (remains 4s in `useChatSession`)

## Technical Dependencies

| Dependency             | Version   | Purpose                                                         |
| ---------------------- | --------- | --------------------------------------------------------------- |
| `motion/react`         | ^12.x     | `AnimatePresence`, `motion.div` for height collapse + crossfade |
| `lucide-react`         | ^0.x      | Icons: `Info`, `Shield`, `MessageSquare`, `RefreshCw`           |
| `@dorkos/shared/types` | workspace | `PermissionMode` type                                           |

All dependencies are already in the project. No new packages required.

## Detailed Design

### Architecture: State Machine with Prioritized Content Slots

A `deriveStripState()` pure function maps raw props to a `StripState` discriminated union. The component renders content based on the active state variant via `AnimatePresence mode="wait"` keyed by `state.type`. This follows the Apple Dynamic Island principle: one element, different content, smooth morphing.

### StripState Discriminated Union

```typescript
import type { LucideIcon } from 'lucide-react';

type StripState =
  | { type: 'rate-limited'; countdown: number | null; elapsed: string }
  | { type: 'waiting'; waitingType: 'approval' | 'question'; elapsed: string }
  | { type: 'system-message'; message: string; icon: LucideIcon }
  | {
      type: 'streaming';
      verb: string;
      verbKey: string;
      elapsed: string;
      tokens: string;
      icon: string;
      iconAnimation: string | null;
      isBypassVerb: boolean;
    }
  | { type: 'complete'; elapsed: string; tokens: string }
  | { type: 'idle' };
```

### Priority Stack

Encoded in `deriveStripState` — the first matching condition wins:

```
1. rate-limited       → user needs to know they're waiting (amber)
2. waiting-for-user   → user action required to continue (amber)
3. system-message     → SDK operational event, informational (muted)
4. streaming          → normal inference in progress, ambient (muted)
5. complete           → post-stream summary, auto-dismisses (60% opacity)
6. idle               → nothing to show (strip collapses to height 0)
```

### `deriveStripState()` Pure Function

```typescript
interface StripStateInput {
  status: 'idle' | 'streaming' | 'error';
  isRateLimited: boolean;
  countdown: number | null;
  isWaitingForUser: boolean;
  waitingType: 'approval' | 'question';
  systemStatus: string | null;
  elapsed: string;
  verb: string;
  verbKey: string;
  tokens: string;
  theme: IndicatorTheme;
  isBypassVerb: boolean;
  showComplete: boolean;
  lastElapsed: string;
  lastTokens: string;
}

function deriveStripState(input: StripStateInput): StripState {
  // Priority 1: Rate-limited
  if (input.status === 'streaming' && input.isRateLimited) {
    return { type: 'rate-limited', countdown: input.countdown, elapsed: input.elapsed };
  }

  // Priority 2: Waiting for user
  if (input.status === 'streaming' && input.isWaitingForUser) {
    return { type: 'waiting', waitingType: input.waitingType, elapsed: input.elapsed };
  }

  // Priority 3: System message
  if (input.systemStatus) {
    return {
      type: 'system-message',
      message: input.systemStatus,
      icon: deriveSystemIcon(input.systemStatus),
    };
  }

  // Priority 4: Streaming
  if (input.status === 'streaming') {
    return {
      type: 'streaming',
      verb: input.verb,
      verbKey: input.verbKey,
      elapsed: input.elapsed,
      tokens: input.tokens,
      icon: input.isBypassVerb ? '\u2620' : input.theme.icon,
      iconAnimation: input.isBypassVerb ? null : input.theme.iconAnimation,
      isBypassVerb: input.isBypassVerb,
    };
  }

  // Priority 5: Complete (auto-dismisses after 8s)
  if (input.showComplete) {
    return { type: 'complete', elapsed: input.lastElapsed, tokens: input.lastTokens };
  }

  // Priority 6: Idle
  return { type: 'idle' };
}
```

### `deriveSystemIcon()` Helper

Pattern-matches system message content to a contextual icon:

```typescript
import { Info, RefreshCw, Shield } from 'lucide-react';

function deriveSystemIcon(message: string): LucideIcon {
  const lower = message.toLowerCase();
  if (lower.includes('compact')) return RefreshCw;
  if (lower.includes('permission')) return Shield;
  return Info;
}
```

### Three-Layer Animation Stack

| Layer                 | Element                                             | Duration | Easing   | Purpose                                                                               |
| --------------------- | --------------------------------------------------- | -------- | -------- | ------------------------------------------------------------------------------------- |
| 1. Outer height       | `motion.div` wrapping entire strip                  | 200ms    | ease-out | Strip collapses to `height: 0` when idle, expands to `height: 'auto'` when active     |
| 2. Inner crossfade    | `AnimatePresence mode="wait"` keyed by `state.type` | 150ms    | ease     | Content morphs between state types (streaming ↔ system ↔ complete)                    |
| 3. Verb sub-animation | `AnimatePresence mode="wait"` keyed by `verbKey`    | 300ms    | ease     | Verb rotation within the streaming state (existing pattern from `InferenceIndicator`) |

**Outer height animation** (matches `contributing/animations.md` Height Collapse pattern):

```typescript
<motion.div
  initial={false}
  animate={{ height: state.type === 'idle' ? 0 : 'auto' }}
  transition={{ duration: 0.2, ease: 'easeOut' }}
  className="overflow-hidden"
>
  {/* Inner crossfade */}
</motion.div>
```

**Inner crossfade:**

```typescript
<AnimatePresence mode="wait">
  <motion.div
    key={state.type}
    initial={{ opacity: 0 }}
    animate={{ opacity: 1 }}
    exit={{ opacity: 0 }}
    transition={{ duration: 0.15 }}
  >
    {renderContent(state)}
  </motion.div>
</AnimatePresence>
```

### Visual Specification

All states share a common container: `text-xs py-2 flex items-center justify-center gap-1.5 px-4`.

```
STREAMING:    [icon] [verb]                      [elapsed]  [tokens]   (muted)
WAITING:      [icon] Waiting for [approval/answer] [elapsed]           (amber)
RATE-LIMITED: [icon] Rate limited - retrying in Xs [elapsed]           (amber)
SYSTEM:       [icon] [message text]                                    (muted)
COMPLETE:     [elapsed] . [tokens]                                     (60% opacity)
```

| State          | Text color                           | Icon color                                          | Font size | Special                              |
| -------------- | ------------------------------------ | --------------------------------------------------- | --------- | ------------------------------------ |
| streaming      | `text-muted-foreground`              | theme icon (shimmer)                                | `text-xs` | Bypass verbs use `text-amber-500/60` |
| waiting        | `text-amber-600 dark:text-amber-400` | `text-amber-500` (Shield/MessageSquare)             | `text-xs` | —                                    |
| rate-limited   | `text-amber-600 dark:text-amber-400` | `text-amber-500` (hourglass emoji)                  | `text-xs` | Countdown ticks                      |
| system-message | `text-muted-foreground/60`           | `text-muted-foreground/60` (contextual Lucide icon) | `text-xs` | —                                    |
| complete       | `text-muted-foreground/50`           | —                                                   | `text-xs` | `opacity: 0.6`, auto-dismiss 8s      |
| idle           | —                                    | —                                                   | —         | Height collapses to 0                |

### File Structure

#### Files to Create

**1. `layers/features/chat/ui/ChatStatusStrip.tsx`**

Unified component containing:

- `StripState` type (discriminated union)
- `StripStateInput` interface
- `deriveStripState()` pure function (exported for testing)
- `deriveSystemIcon()` helper (exported for testing)
- `formatTokens()` helper (moved from `InferenceIndicator`)
- `ChatStatusStrip` component (outer height + inner crossfade + per-state renderers)

Props interface:

```typescript
interface ChatStatusStripProps {
  status: 'idle' | 'streaming' | 'error';
  streamStartTime: number | null;
  estimatedTokens: number;
  permissionMode?: PermissionMode;
  isWaitingForUser?: boolean;
  waitingType?: 'approval' | 'question';
  isRateLimited?: boolean;
  rateLimitRetryAfter?: number | null;
  systemStatus: string | null;
  theme?: IndicatorTheme;
}
```

**2. `layers/features/chat/model/use-strip-state.ts`**

Hook managing derived state lifecycle:

- Calls `useElapsedTime(status === 'streaming' ? streamStartTime : null)` internally
- Calls `useRotatingVerb(verbs, theme.verbInterval)` internally
- Computes `isBypassVerb` from verb + `BYPASS_INFERENCE_VERBS`
- Manages snapshot refs (`lastElapsedRef`, `lastTokensRef`) for post-stream completion display
- Manages `showComplete` state + 8-second auto-dismiss timer via `useEffect`
- Manages rate-limit `countdown` state with 1-second tick interval
- Calls `deriveStripState()` with all inputs
- Returns `StripState`

```typescript
interface UseStripStateInput {
  status: 'idle' | 'streaming' | 'error';
  streamStartTime: number | null;
  estimatedTokens: number;
  permissionMode: PermissionMode;
  isWaitingForUser: boolean;
  waitingType: 'approval' | 'question';
  isRateLimited: boolean;
  rateLimitRetryAfter: number | null;
  systemStatus: string | null;
  theme: IndicatorTheme;
}

function useStripState(input: UseStripStateInput): StripState;
```

**3. `layers/features/chat/__tests__/ChatStatusStrip.test.tsx`**

Tests organized in three groups:

- **`deriveStripState()` pure function tests**: All 6 states, priority ordering (e.g., rate-limited beats waiting, waiting beats system-message), edge cases
- **`deriveSystemIcon()` tests**: Contextual icon mapping
- **Component rendering tests**: Each state renders expected content, `data-testid` attributes present
- **Lifecycle tests**: Complete auto-dismiss timer (use `vi.useFakeTimers`), rate-limit countdown

#### Files to Modify

**4. `layers/features/chat/ui/ChatPanel.tsx`**

Changes:

- Remove `SystemStatusZone` import
- Add `ChatStatusStrip` import
- Replace `<SystemStatusZone message={systemStatus} />` (line 353) with:
  ```tsx
  <ChatStatusStrip
    status={status}
    streamStartTime={streamStartTime}
    estimatedTokens={estimatedTokens}
    permissionMode={permissionMode}
    isWaitingForUser={isWaitingForUser ?? false}
    waitingType={waitingType ?? 'approval'}
    isRateLimited={isRateLimited ?? false}
    rateLimitRetryAfter={rateLimitRetryAfter ?? null}
    systemStatus={systemStatus}
  />
  ```
- Remove 7 inference props from `<MessageList>` (lines 303-309): `streamStartTime`, `estimatedTokens`, `permissionMode`, `isWaitingForUser`, `waitingType`, `isRateLimited`, `rateLimitRetryAfter`

**5. `layers/features/chat/ui/MessageList.tsx`**

Changes:

- Remove `import { InferenceIndicator } from './InferenceIndicator'` (line 15)
- Remove `import type { PermissionMode } from '@dorkos/shared/types'` (line 11, if no other usages)
- Remove 7 props from `MessageListProps` interface (lines 54-60): `streamStartTime`, `estimatedTokens`, `permissionMode`, `isWaitingForUser`, `waitingType`, `isRateLimited`, `rateLimitRetryAfter`
- Remove corresponding destructured parameters from the component function (lines 79-85)
- Remove the InferenceIndicator render block (lines 211-225): the `<div>` with absolute positioning and `<InferenceIndicator>`
- Total reduction: ~30 lines, 7 fewer props in the interface

**6. `dev/showcases/StatusShowcases.tsx`**

Changes:

- Replace `InferenceIndicator` and `SystemStatusZone` showcases with `ChatStatusStrip` showcases
- Showcase all 6 states: streaming, waiting, rate-limited, system-message, complete, idle
- Update imports
- Update `chat-sections.ts` registry entries (rename component keys)

**7. `layers/features/chat/index.ts`** (barrel export)

Changes:

- Remove `InferenceIndicator` export
- Remove `SystemStatusZone` export
- Add `ChatStatusStrip` export
- Add `deriveStripState` and `StripState` type exports (for testing and dev tools)

#### Files to Delete

| File                                                          | Reason                                 |
| ------------------------------------------------------------- | -------------------------------------- |
| `layers/features/chat/ui/InferenceIndicator.tsx`              | Replaced by `ChatStatusStrip`          |
| `layers/features/chat/ui/SystemStatusZone.tsx`                | Replaced by `ChatStatusStrip`          |
| `layers/features/chat/__tests__/InferenceIndicator.test.tsx`  | Replaced by `ChatStatusStrip.test.tsx` |
| `layers/features/chat/ui/__tests__/SystemStatusZone.test.tsx` | Replaced by `ChatStatusStrip.test.tsx` |

#### Files to Keep (Unchanged)

| File                                              | Purpose                                        |
| ------------------------------------------------- | ---------------------------------------------- |
| `layers/features/chat/ui/inference-themes.ts`     | `IndicatorTheme` interface + `DEFAULT_THEME`   |
| `layers/features/chat/ui/inference-verbs.ts`      | 50 default verbs + 55 bypass verbs             |
| `layers/features/chat/model/use-rotating-verb.ts` | Verb rotation hook (called by `useStripState`) |
| `layers/shared/model/use-elapsed-time.ts`         | Elapsed time hook (called by `useStripState`)  |

### Data Flow

```
BEFORE:
  useChatSession → ChatPanel
    ├── → MessageList (7 props threaded) → InferenceIndicator
    └── → SystemStatusZone (1 prop: systemStatus)

AFTER:
  useChatSession → ChatPanel
    ├── → MessageList (7 fewer props, no indicator)
    └── → ChatStatusStrip (all status props direct)
              └── useStripState
                    ├── useElapsedTime (shared hook)
                    ├── useRotatingVerb (feature hook)
                    └── deriveStripState (pure function)
```

### Placement in ChatPanel Layout

The `ChatStatusStrip` occupies the same position as the current `SystemStatusZone` — between the `MessageList` container `<div>` and `PromptSuggestionChips`:

```
<div className="..."> {/* Main content area */}
  {/* Empty state OR MessageList */}
  {/* Scroll overlays */}
</div>

<ChatStatusStrip ... />          {/* <-- HERE (replaces SystemStatusZone) */}

<AnimatePresence>
  {showSuggestions && <PromptSuggestionChips ... />}
</AnimatePresence>
```

## User Experience

### Before (Current)

- **Inference status** scrolls with messages — invisible when scrolled up
- **System status** is always visible below messages — muted, ephemeral
- Two different visual languages for "what the agent is doing"
- Seven props threaded through `MessageList` solely for status display

### After (Target)

- **Single status zone** between messages and input — always visible
- One visual language: muted, data-dense, visually quiet
- Status morphs smoothly between types (Dynamic Island effect)
- Priority system ensures the most important status is shown
- Post-stream summary auto-dismisses after 8 seconds
- `MessageList` is simpler (7 fewer props)

### State Transitions Users Will See

1. **Idle → Streaming**: Strip expands from height 0, verb + elapsed + tokens appear
2. **Streaming → System Message**: Cross-fade; system message takes over with contextual icon
3. **System Message → Streaming**: Cross-fade back when system message clears (4s timer in `useChatSession`)
4. **Streaming → Waiting**: Cross-fade to amber waiting state with Shield/MessageSquare icon
5. **Streaming → Rate-Limited**: Cross-fade to amber rate-limit with countdown
6. **Streaming → Complete**: Strip fades to 60% opacity, shows duration + token summary
7. **Complete → Idle**: After 8 seconds, strip collapses to height 0

## Testing Strategy

### Unit Tests: `deriveStripState()` Pure Function

These tests exercise the priority logic with no React rendering:

```typescript
describe('deriveStripState', () => {
  const baseInput: StripStateInput = {
    status: 'idle',
    isRateLimited: false,
    countdown: null,
    isWaitingForUser: false,
    waitingType: 'approval',
    systemStatus: null,
    elapsed: '0:00',
    verb: 'Thinking',
    verbKey: 'verb-0',
    tokens: '~0 tokens',
    theme: DEFAULT_THEME,
    isBypassVerb: false,
    showComplete: false,
    lastElapsed: '0:32',
    lastTokens: '~12.3k tokens',
  };

  // Purpose: Verify idle state when no conditions are active
  it('returns idle when no active status', () => {
    expect(deriveStripState(baseInput).type).toBe('idle');
  });

  // Purpose: Verify streaming state activates on status change
  it('returns streaming when status is streaming', () => {
    const state = deriveStripState({ ...baseInput, status: 'streaming' });
    expect(state.type).toBe('streaming');
  });

  // Purpose: Verify rate-limited beats waiting (priority 1 > 2)
  it('rate-limited takes priority over waiting', () => {
    const state = deriveStripState({
      ...baseInput,
      status: 'streaming',
      isRateLimited: true,
      isWaitingForUser: true,
    });
    expect(state.type).toBe('rate-limited');
  });

  // Purpose: Verify waiting beats system-message (priority 2 > 3)
  it('waiting takes priority over system message', () => {
    const state = deriveStripState({
      ...baseInput,
      status: 'streaming',
      isWaitingForUser: true,
      systemStatus: 'Compacting context...',
    });
    expect(state.type).toBe('waiting');
  });

  // Purpose: Verify system-message beats streaming (priority 3 > 4)
  it('system message takes priority over streaming', () => {
    const state = deriveStripState({
      ...baseInput,
      status: 'streaming',
      systemStatus: 'Compacting context...',
    });
    expect(state.type).toBe('system-message');
  });

  // Purpose: Verify complete shows when streaming ends with tokens
  it('returns complete when showComplete is true', () => {
    const state = deriveStripState({ ...baseInput, showComplete: true });
    expect(state.type).toBe('complete');
    if (state.type === 'complete') {
      expect(state.elapsed).toBe('0:32');
      expect(state.tokens).toBe('~12.3k tokens');
    }
  });
});
```

### Unit Tests: `deriveSystemIcon()`

```typescript
describe('deriveSystemIcon', () => {
  // Purpose: Verify contextual icon mapping for known message patterns
  it('returns RefreshCw for compact messages', () => {
    expect(deriveSystemIcon('Compacting context...')).toBe(RefreshCw);
  });

  it('returns Shield for permission messages', () => {
    expect(deriveSystemIcon('Permission mode changed')).toBe(Shield);
  });

  it('returns Info for unknown messages', () => {
    expect(deriveSystemIcon('Some other status')).toBe(Info);
  });
});
```

### Component Tests: Rendering

Mock `useElapsedTime` and `useRotatingVerb` (matching existing patterns from `InferenceIndicator.test.tsx`):

```typescript
vi.mock('@/layers/shared/model', () => ({
  useElapsedTime: vi.fn(() => ({ formatted: '2m 14s', ms: 134000 })),
}));
vi.mock('../model/use-rotating-verb', () => ({
  useRotatingVerb: vi.fn(() => ({ verb: "Droppin' Science", key: 'verb-0' })),
}));
```

Tests:

- Renders nothing visible (height 0) when all conditions are idle
- Renders streaming content with verb, elapsed time, and tokens
- Renders waiting state with correct icon (Shield for approval, MessageSquare for question)
- Renders rate-limited state with countdown
- Renders system message with contextual icon
- Renders complete state with snapshot values
- Uses `data-testid` attributes: `chat-status-strip-streaming`, `chat-status-strip-waiting`, etc.

### Lifecycle Tests

```typescript
// Purpose: Verify complete state auto-dismisses after 8 seconds
it('auto-dismisses complete state after 8 seconds', () => {
  vi.useFakeTimers();
  const { rerender } = render(<ChatStatusStrip status="streaming" ... />);
  // Transition to idle (triggers complete)
  rerender(<ChatStatusStrip status="idle" ... />);
  expect(screen.getByTestId('chat-status-strip-complete')).toBeInTheDocument();
  // Advance 8 seconds
  vi.advanceTimersByTime(8000);
  expect(screen.queryByTestId('chat-status-strip-complete')).not.toBeInTheDocument();
  vi.useRealTimers();
});
```

### Mocking Strategy

- Mock `useElapsedTime` and `useRotatingVerb` to control time and verb values
- No `Transport` mock needed (component is pure UI, no data fetching)
- Use `vi.useFakeTimers()` for auto-dismiss and countdown tests

## Performance Considerations

- **Hook internalization**: `useElapsedTime` and `useRotatingVerb` now run inside `useStripState` rather than being threaded as props. Both hooks use `setInterval` with cleanup — no performance change, but cleaner ownership.
- **Conditional hook execution**: `useElapsedTime` receives `null` startTime when not streaming, which disables its interval. `useRotatingVerb` always runs (cheap — one `setInterval` with `setState`).
- **AnimatePresence overhead**: Minimal. `mode="wait"` prevents simultaneous mount/unmount. Only the active state's subtree is rendered.
- **Net reduction**: Removing `InferenceIndicator` from inside the virtualizer removes one absolutely-positioned element from the virtual list measurement. `MessageList` re-renders with 7 fewer prop comparisons.

## Security Considerations

No security implications. This is a pure UI refactoring — no user input handling, no data fetching, no authentication changes.

## Documentation

| Document                        | Update                                                                            |
| ------------------------------- | --------------------------------------------------------------------------------- |
| `contributing/animations.md`    | No changes needed — patterns already documented                                   |
| `contributing/design-system.md` | No changes needed — uses existing tokens                                          |
| Inline TSDoc                    | Add TSDoc to `ChatStatusStrip`, `useStripState`, `deriveStripState`, `StripState` |

## Implementation Phases

### Phase 1: Core — State Machine + Component

1. Create `use-strip-state.ts` hook with all lifecycle management
2. Create `ChatStatusStrip.tsx` with `deriveStripState`, `StripState` type, and component
3. Create `ChatStatusStrip.test.tsx` with pure function tests and component rendering tests
4. Verify tests pass in isolation

### Phase 2: Integration — Wire + Remove

5. Modify `ChatPanel.tsx` — replace `SystemStatusZone` with `ChatStatusStrip`, remove 7 inference props from `MessageList`
6. Modify `MessageList.tsx` — remove `InferenceIndicator` import, remove 7 props from interface, remove render block
7. Update barrel exports in `layers/features/chat/index.ts`
8. Delete `InferenceIndicator.tsx`, `SystemStatusZone.tsx`, and their test files
9. Verify no broken imports across the codebase

### Phase 3: Polish — Playground + Cleanup

10. Update `StatusShowcases.tsx` to showcase all 6 `ChatStatusStrip` states
11. Update `chat-sections.ts` registry entries
12. Run full lint, typecheck, and test suite
13. Visual review in dev playground

## Open Questions

_No open questions. All decisions were resolved during the ideation phase (see `specs/unified-status-strip/01-ideation.md`, Section 6)._

## Related ADRs

- **ADR-0150** (`decisions/0150-streamdown-animated-prop-for-text-streaming.md`): Related animation pattern decision
- **ADR-0151** (`decisions/0151-use-stick-to-bottom-for-spring-scroll.md`): Scroll behavior that interacts with strip placement

## References

- Ideation document: `specs/unified-status-strip/01-ideation.md`
- Research report: `research/20260320_unified_status_strip.md`
- Original InferenceIndicator spec: `specs/inference-status-indicator/02-specification.md`
- SystemStatusZone spec: `specs/system-status-compact-boundary/02-specification.md`
- Prior research on compact boundary patterns: `research/20260316_system_status_compact_boundary_ui_patterns.md`
- Compound component patterns research: `research/20260310_statusline_compound_component_patterns.md`
- Animation patterns guide: `contributing/animations.md`
- Design system guide: `contributing/design-system.md`
