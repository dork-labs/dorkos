# Inference Status Indicator — Task Breakdown

**Spec**: `specs/inference-status-indicator/02-specification.md`
**Mode**: Full
**Phases**: 5 (9 tasks total)

---

## Phase 1: Core Hooks & Data (No dependencies — all 4 tasks run in parallel)

### Task 1: [P1] Create inference verb phrases list

**File**: `apps/client/src/components/chat/inference-verbs.ts`

Create a new file with 50 custom verb phrases mixing 70s Black slang/jive talk and 90s hip-hop slang. These are NOT reused from Claude Code CLI.

```typescript
/**
 * 50 custom inference verb phrases — a mix of 70s Black slang / jive talk
 * and 90s hip-hop slang. Used by the inference status indicator.
 */
export const DEFAULT_INFERENCE_VERBS = [
  "Keepin' It Real",
  "Droppin' Science",
  "Gettin' Jiggy",
  'Can You Dig It?',
  'Word to Your Mother',
  "Kickin' It",
  "Straight Chillin'",
  "Bustin' Moves",
  "Feelin' Groovy",
  "Layin' It Down",
  "Breakin' It Down",
  "Gettin' Down",
  "Runnin' the Show",
  "Keepin' It Tight",
  "Blowin' Up",
  "Holdin' It Down",
  "Bringin' the Funk",
  "Cookin' Up",
  "Flippin' the Script",
  "Rockin' Steady",
  "Takin' It to the Bridge",
  "Doin' the Hustle",
  "Keepin' On",
  "Vibin' Out",
  "Gettin' Fly",
  "Rollin' Deep",
  'Represent!',
  "Bringin' the Noise",
  'Outta Sight',
  'Far Out',
  'Right On',
  'Solid Gold',
  'Stone Cold',
  "Stayin' Fresh",
  "Droppin' Beats",
  "Keepin' It Funky",
  "Smooth Operatin'",
  "Hittin' the Scene",
  "Raisin' the Roof",
  "Phat Trackin'",
  "Jivin'",
  "Groovin'",
  "Slammin'",
  'Dy-no-mite!',
  'Say Word',
  'Peep This',
  'Check It',
  'No Diggity',
  'All That and a Bag of Chips',
  "Takin' Care of Business",
] as const;
```

**Acceptance Criteria**:

- File exports `DEFAULT_INFERENCE_VERBS` as a `readonly` tuple of exactly 50 strings
- All phrases are unique
- No tests needed (static data)

---

### Task 2: [P1] Create inference theme interface and default theme

**File**: `apps/client/src/components/chat/inference-themes.ts`

Create the `IndicatorTheme` interface and `DEFAULT_THEME` constant. Include a commented-out holiday theme example for documentation.

```typescript
import { DEFAULT_INFERENCE_VERBS } from './inference-verbs';

export interface IndicatorTheme {
  name: string;
  icon: string; // e.g. "*", "✦", "❄"
  iconAnimation: string | null; // CSS @keyframes name, or null for static
  verbs: readonly string[];
  verbInterval: number; // ms between rotations (default: 3500)
  completionVerb?: string; // optional verb for complete state
}

export const DEFAULT_THEME: IndicatorTheme = {
  name: 'default',
  icon: '*',
  iconAnimation: 'shimmer-pulse',
  verbs: DEFAULT_INFERENCE_VERBS,
  verbInterval: 3500,
};

// Example holiday theme (not active — demonstrates pluggable theme system):
//
// export const WINTER_THEME: IndicatorTheme = {
//   name: 'winter',
//   icon: '❄',
//   iconAnimation: null,  // static snowflake
//   verbs: ['Chillin\'', 'Frostin\'', 'Snowin\'', 'Freezin\'', 'Icin\''],
//   verbInterval: 4000,
//   completionVerb: 'Wrapped Up',
// };
```

**Acceptance Criteria**:

- `IndicatorTheme` interface exported with all fields
- `DEFAULT_THEME` uses `'*'` icon, `'shimmer-pulse'` animation, `DEFAULT_INFERENCE_VERBS`, `3500` interval
- Commented-out winter theme example present
- No tests needed (type + static data)

**Depends on**: Task 1 (imports `DEFAULT_INFERENCE_VERBS`)

---

### Task 3: [P1] Create useElapsedTime hook with tests

**Files**:

- `apps/client/src/hooks/use-elapsed-time.ts`
- `apps/client/src/hooks/__tests__/use-elapsed-time.test.ts`

**Hook implementation**:

```typescript
import { useState, useEffect, useRef } from 'react';

interface ElapsedTimeResult {
  formatted: string;
  ms: number;
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 3600) {
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  }
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  return `${hours}h ${String(minutes).padStart(2, '0')}m`;
}

export function useElapsedTime(startTime: number | null): ElapsedTimeResult {
  const [now, setNow] = useState(() => Date.now());
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (startTime === null) {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      return;
    }

    // Update immediately, then every second
    setNow(Date.now());
    intervalRef.current = setInterval(() => setNow(Date.now()), 1000);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [startTime]);

  if (startTime === null) {
    return { formatted: '0m 00s', ms: 0 };
  }

  const ms = Math.max(0, now - startTime);
  return { formatted: formatElapsed(ms), ms };
}
```

**Test implementation**:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useElapsedTime } from '../use-elapsed-time';

describe('useElapsedTime', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns zero when startTime is null', () => {
    const { result } = renderHook(() => useElapsedTime(null));
    expect(result.current.formatted).toBe('0m 00s');
    expect(result.current.ms).toBe(0);
  });

  it('formats seconds correctly (< 1 minute)', () => {
    const now = Date.now();
    vi.setSystemTime(now);
    const { result } = renderHook(() => useElapsedTime(now - 5000));
    expect(result.current.formatted).toBe('0m 05s');
  });

  it('formats minutes and seconds (1m 05s)', () => {
    const now = Date.now();
    vi.setSystemTime(now);
    const { result } = renderHook(() => useElapsedTime(now - 65000));
    expect(result.current.formatted).toBe('1m 05s');
  });

  it('formats hours and minutes (1h 23m)', () => {
    const now = Date.now();
    vi.setSystemTime(now);
    const { result } = renderHook(() => useElapsedTime(now - 83 * 60 * 1000));
    expect(result.current.formatted).toBe('1h 23m');
  });

  it('updates every second via interval', () => {
    const now = Date.now();
    vi.setSystemTime(now);
    const { result } = renderHook(() => useElapsedTime(now));

    expect(result.current.formatted).toBe('0m 00s');

    act(() => {
      vi.advanceTimersByTime(5000);
    });

    expect(result.current.formatted).toBe('0m 05s');
  });

  it('cleans up interval on unmount', () => {
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
    const now = Date.now();
    vi.setSystemTime(now);
    const { unmount } = renderHook(() => useElapsedTime(now));

    unmount();
    expect(clearIntervalSpy).toHaveBeenCalled();
    clearIntervalSpy.mockRestore();
  });

  it('cleans up interval when startTime becomes null', () => {
    const now = Date.now();
    vi.setSystemTime(now);
    const { result, rerender } = renderHook(
      ({ startTime }: { startTime: number | null }) => useElapsedTime(startTime),
      { initialProps: { startTime: now } }
    );

    expect(result.current.ms).toBeGreaterThanOrEqual(0);

    rerender({ startTime: null });
    expect(result.current.formatted).toBe('0m 00s');
    expect(result.current.ms).toBe(0);
  });
});
```

**Acceptance Criteria**:

- Hook returns `{ formatted, ms }` with correct format for 0s, 65s, 83min cases
- Returns `{ formatted: '0m 00s', ms: 0 }` when `startTime` is null
- 1s interval, cleans up on unmount/null startTime
- All tests pass

---

### Task 4: [P1] Create useRotatingVerb hook with tests

**Files**:

- `apps/client/src/hooks/use-rotating-verb.ts`
- `apps/client/src/hooks/__tests__/use-rotating-verb.test.ts`

**Hook implementation**:

```typescript
import { useState, useEffect, useRef, useCallback } from 'react';

interface RotatingVerbResult {
  verb: string;
  key: string;
}

export function useRotatingVerb(verbs: readonly string[], intervalMs: number): RotatingVerbResult {
  const keyCounterRef = useRef(0);
  const lastVerbRef = useRef<string | null>(null);

  const pickRandom = useCallback((): string => {
    if (verbs.length === 0) return '';
    if (verbs.length === 1) return verbs[0];

    let next: string;
    do {
      next = verbs[Math.floor(Math.random() * verbs.length)];
    } while (next === lastVerbRef.current);

    lastVerbRef.current = next;
    return next;
  }, [verbs]);

  const [verb, setVerb] = useState<string>(() => {
    const initial = pickRandom();
    return initial;
  });

  useEffect(() => {
    const id = setInterval(() => {
      keyCounterRef.current += 1;
      setVerb(pickRandom());
    }, intervalMs);

    return () => clearInterval(id);
  }, [intervalMs, pickRandom]);

  return {
    verb,
    key: `verb-${keyCounterRef.current}`,
  };
}
```

**Test implementation**:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useRotatingVerb } from '../use-rotating-verb';

const TEST_VERBS = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon'] as const;

describe('useRotatingVerb', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns an initial verb from the list', () => {
    const { result } = renderHook(() => useRotatingVerb(TEST_VERBS, 3500));
    expect(TEST_VERBS).toContain(result.current.verb);
  });

  it('returns a key string', () => {
    const { result } = renderHook(() => useRotatingVerb(TEST_VERBS, 3500));
    expect(result.current.key).toMatch(/^verb-\d+$/);
  });

  it('rotates verb after interval', () => {
    const { result } = renderHook(() => useRotatingVerb(TEST_VERBS, 3500));
    const initialVerb = result.current.verb;

    // After many rotations at least one should differ (probabilistic but near-certain with 5 verbs)
    let changed = false;
    for (let i = 0; i < 10; i++) {
      act(() => {
        vi.advanceTimersByTime(3500);
      });
      if (result.current.verb !== initialVerb) {
        changed = true;
        break;
      }
    }
    expect(changed).toBe(true);
  });

  it('increments key on each rotation', () => {
    const { result } = renderHook(() => useRotatingVerb(TEST_VERBS, 3500));
    expect(result.current.key).toBe('verb-0');

    act(() => {
      vi.advanceTimersByTime(3500);
    });
    expect(result.current.key).toBe('verb-1');

    act(() => {
      vi.advanceTimersByTime(3500);
    });
    expect(result.current.key).toBe('verb-2');
  });

  it('does not repeat the same verb consecutively (with sufficient list)', () => {
    const { result } = renderHook(() => useRotatingVerb(TEST_VERBS, 1000));
    let prevVerb = result.current.verb;
    let consecutiveRepeat = false;

    for (let i = 0; i < 20; i++) {
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      if (result.current.verb === prevVerb) {
        consecutiveRepeat = true;
        break;
      }
      prevVerb = result.current.verb;
    }
    expect(consecutiveRepeat).toBe(false);
  });

  it('handles single-verb list gracefully', () => {
    const { result } = renderHook(() => useRotatingVerb(['Only'], 3500));
    expect(result.current.verb).toBe('Only');
  });

  it('handles empty verb list gracefully', () => {
    const { result } = renderHook(() => useRotatingVerb([], 3500));
    expect(result.current.verb).toBe('');
  });
});
```

**Acceptance Criteria**:

- Hook returns `{ verb, key }` with a random verb from the list
- Rotates every `intervalMs` milliseconds
- No consecutive repeats (for lists with 2+ items)
- Key increments on each rotation for AnimatePresence tracking
- Cleans up interval on unmount
- All tests pass

---

## Phase 2: Timing Integration (Depends on Phase 1)

### Task 5: [P2] Add streaming timing and token estimation to useChatSession

**Files**:

- `apps/client/src/hooks/use-chat-session.ts` (modify)
- `apps/client/src/hooks/__tests__/use-chat-session.test.tsx` (extend)

**Modifications to `use-chat-session.ts`**:

1. Add two new refs after `currentPartsRef`:

```typescript
const streamStartTimeRef = useRef<number | null>(null);
const estimatedTokensRef = useRef<number>(0);
```

2. Add state variables to expose ref values reactively:

```typescript
const [streamStartTime, setStreamStartTime] = useState<number | null>(null);
const [estimatedTokens, setEstimatedTokens] = useState<number>(0);
```

3. In `handleStreamEvent`, modify the `text_delta` case — after the existing text accumulation logic, add:

```typescript
case 'text_delta': {
  const { text } = data as TextDelta;
  const parts = currentPartsRef.current;
  const lastPart = parts[parts.length - 1];
  if (lastPart && lastPart.type === 'text') {
    lastPart.text += text;
  } else {
    parts.push({ type: 'text', text });
  }

  // Inference indicator: set start time on first delta, accumulate token estimate
  if (streamStartTimeRef.current === null) {
    const now = Date.now();
    streamStartTimeRef.current = now;
    setStreamStartTime(now);
  }
  estimatedTokensRef.current += text.length / 4;
  setEstimatedTokens(estimatedTokensRef.current);

  updateAssistantMessage(assistantId);
  break;
}
```

4. In the `done` case, after the existing logic, add reset:

```typescript
case 'done': {
  const doneData = data as { sessionId?: string };
  if (doneData.sessionId && doneData.sessionId !== sessionId) {
    options.onSessionIdChange?.(doneData.sessionId);
  }

  // Reset inference indicator state
  streamStartTimeRef.current = null;
  estimatedTokensRef.current = 0;
  setStreamStartTime(null);
  setEstimatedTokens(0);

  setStatus('idle');
  break;
}
```

5. Also reset refs at the start of `handleSubmit` (before streaming begins), after `currentPartsRef.current = [];`:

```typescript
currentPartsRef.current = [];
streamStartTimeRef.current = null;
estimatedTokensRef.current = 0;
setStreamStartTime(null);
setEstimatedTokens(0);
```

6. Add to return object:

```typescript
return {
  messages,
  input,
  setInput,
  handleSubmit,
  status,
  error,
  stop,
  isLoadingHistory,
  sessionStatus,
  streamStartTime,
  estimatedTokens,
};
```

**New tests to add to `use-chat-session.test.tsx`**:

```typescript
it('sets streamStartTime on first text_delta', async () => {
  const now = Date.now();
  vi.spyOn(Date, 'now').mockReturnValue(now);

  const sendMessage = createSendMessageMock([
    { type: 'text_delta', data: { text: 'Hello' } } as StreamEvent,
    { type: 'done', data: { sessionId: 's1' } } as StreamEvent,
  ]);
  const transport = createMockTransport({ sendMessage });
  const { result } = renderHook(() => useChatSession('s1'), { wrapper: createWrapper(transport) });

  await waitFor(() => expect(result.current.status).toBe('idle'));

  await act(async () => {
    result.current.setInput('test');
  });
  await act(async () => {
    await result.current.handleSubmit();
  });

  // After done, streamStartTime resets to null
  expect(result.current.streamStartTime).toBeNull();
  expect(result.current.estimatedTokens).toBe(0);

  vi.restoreAllMocks();
});

it('accumulates estimatedTokens from text_delta lengths', async () => {
  let onEventCapture: ((event: StreamEvent) => void) | null = null;
  const sendMessage = vi.fn(
    async (
      _sessionId: string,
      _content: string,
      onEvent: (event: StreamEvent) => void,
      _signal?: AbortSignal
    ) => {
      onEventCapture = onEvent;
      // Fire two text deltas (8 chars each = 2 tokens each = 4 total)
      onEvent({ type: 'text_delta', data: { text: '12345678' } } as StreamEvent);
      onEvent({ type: 'text_delta', data: { text: 'abcdefgh' } } as StreamEvent);
      onEvent({ type: 'done', data: { sessionId: 's1' } } as StreamEvent);
    }
  );
  const transport = createMockTransport({ sendMessage });
  const { result } = renderHook(() => useChatSession('s1'), { wrapper: createWrapper(transport) });

  await waitFor(() => expect(result.current.status).toBe('idle'));

  await act(async () => {
    result.current.setInput('test');
  });
  await act(async () => {
    await result.current.handleSubmit();
  });

  // After done, tokens reset
  expect(result.current.estimatedTokens).toBe(0);
});

it('resets streamStartTime and estimatedTokens on done', async () => {
  const sendMessage = createSendMessageMock([
    { type: 'text_delta', data: { text: 'Hello world!' } } as StreamEvent,
    { type: 'done', data: { sessionId: 's1' } } as StreamEvent,
  ]);
  const transport = createMockTransport({ sendMessage });
  const { result } = renderHook(() => useChatSession('s1'), { wrapper: createWrapper(transport) });

  await waitFor(() => expect(result.current.status).toBe('idle'));

  await act(async () => {
    result.current.setInput('test');
  });
  await act(async () => {
    await result.current.handleSubmit();
  });

  expect(result.current.streamStartTime).toBeNull();
  expect(result.current.estimatedTokens).toBe(0);
});
```

**Acceptance Criteria**:

- `streamStartTime` is set to `Date.now()` on the first `text_delta` of a stream
- `estimatedTokens` accumulates `text.length / 4` for each `text_delta`
- Both reset to `null`/`0` on `done` event
- Both reset at start of new message submission
- New values included in hook return object
- All new and existing tests pass

---

## Phase 3: UI Component (Depends on Phase 1)

### Task 6: [P3] Add shimmer-pulse CSS keyframe animation

**File**: `apps/client/src/index.css` (modify)

Add the `shimmer-pulse` keyframe after the existing `blink-cursor` keyframe (around line 164):

```css
@keyframes shimmer-pulse {
  0%,
  100% {
    opacity: 0.6;
    transform: scale(1);
  }
  50% {
    opacity: 1;
    transform: scale(1.15);
  }
}
```

This keyframe:

- 2s duration (set on the element, not in keyframe)
- Uses `ease-in-out` timing (set on the element)
- GPU-accelerated (only animates `opacity` and `transform`)
- Automatically respects existing `prefers-reduced-motion` CSS rule if one exists

**Acceptance Criteria**:

- `shimmer-pulse` keyframe defined in `index.css`
- Placed after `blink-cursor` keyframe
- Only uses `opacity` and `transform` properties (GPU-friendly)
- No test needed (visual CSS)

---

### Task 7: [P3] Create InferenceIndicator component with tests

**Files**:

- `apps/client/src/components/chat/InferenceIndicator.tsx`
- `apps/client/src/components/chat/__tests__/InferenceIndicator.test.tsx`

**Component implementation**:

```tsx
import { motion, AnimatePresence } from 'motion/react';
import { useElapsedTime } from '../../hooks/use-elapsed-time';
import { useRotatingVerb } from '../../hooks/use-rotating-verb';
import { DEFAULT_THEME, type IndicatorTheme } from './inference-themes';

interface InferenceIndicatorProps {
  status: 'idle' | 'streaming' | 'error';
  streamStartTime: number | null;
  estimatedTokens: number;
  theme?: IndicatorTheme;
}

function formatTokens(count: number): string {
  if (count >= 1000) {
    return `~${(count / 1000).toFixed(1)}k tokens`;
  }
  return `~${Math.round(count)} tokens`;
}

export function InferenceIndicator({
  status,
  streamStartTime,
  estimatedTokens,
  theme = DEFAULT_THEME,
}: InferenceIndicatorProps) {
  const { formatted: elapsed } = useElapsedTime(status === 'streaming' ? streamStartTime : null);
  const { verb, key } = useRotatingVerb(theme.verbs, theme.verbInterval);

  // Null render: idle with no accumulated tokens
  if (status === 'idle' && estimatedTokens === 0) {
    return null;
  }

  // Complete state: compact summary
  if (status === 'idle' && estimatedTokens > 0) {
    return (
      <motion.div
        initial={{ opacity: 1 }}
        animate={{ opacity: 0.6 }}
        transition={{ duration: 0.15 }}
        className="text-3xs text-muted-foreground/50 flex items-center gap-2 px-4 py-2"
        data-testid="inference-indicator-complete"
      >
        <span>{elapsed}</span>
        <span aria-hidden="true">&middot;</span>
        <span>{formatTokens(estimatedTokens)}</span>
      </motion.div>
    );
  }

  // Streaming state
  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2 }}
      className="text-2xs flex items-center gap-3 px-4 py-2"
      data-testid="inference-indicator-streaming"
    >
      {/* Shimmer icon */}
      <span
        aria-hidden="true"
        className="text-muted-foreground font-bold"
        style={
          theme.iconAnimation
            ? { animation: `${theme.iconAnimation} 2s ease-in-out infinite` }
            : undefined
        }
      >
        {theme.icon}
      </span>

      {/* Rotating verb with crossfade */}
      <span className="text-muted-foreground relative inline-flex min-w-[140px]">
        <AnimatePresence mode="wait">
          <motion.span
            key={key}
            initial={{ opacity: 0, y: 2 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -2 }}
            transition={{ duration: 0.3 }}
          >
            {verb}
          </motion.span>
        </AnimatePresence>
      </span>

      {/* Elapsed time */}
      <span className="text-muted-foreground/70 tabular-nums">{elapsed}</span>

      {/* Token estimate */}
      <span className="text-muted-foreground/60">{formatTokens(estimatedTokens)}</span>
    </motion.div>
  );
}
```

**Test implementation**:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom';
import { InferenceIndicator } from '../InferenceIndicator';

afterEach(() => {
  cleanup();
});

// Mock motion/react to render plain elements
vi.mock('motion/react', () => ({
  motion: {
    div: ({ children, initial, animate, exit, transition, ...props }: Record<string, unknown>) => {
      void initial;
      void animate;
      void exit;
      void transition;
      const { className, style, ...rest } = props as Record<string, unknown>;
      return (
        <div className={className as string} style={style as React.CSSProperties} {...rest}>
          {children as React.ReactNode}
        </div>
      );
    },
    span: ({ children, initial, animate, exit, transition, ...props }: Record<string, unknown>) => {
      void initial;
      void animate;
      void exit;
      void transition;
      const { className, style, ...rest } = props as Record<string, unknown>;
      return (
        <span className={className as string} style={style as React.CSSProperties} {...rest}>
          {children as React.ReactNode}
        </span>
      );
    },
  },
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// Mock the hooks to control their output
vi.mock('../../../hooks/use-elapsed-time', () => ({
  useElapsedTime: vi.fn(() => ({ formatted: '2m 14s', ms: 134000 })),
}));

vi.mock('../../../hooks/use-rotating-verb', () => ({
  useRotatingVerb: vi.fn(() => ({ verb: "Droppin' Science", key: 'verb-0' })),
}));

describe('InferenceIndicator', () => {
  it('returns null when idle with no tokens', () => {
    const { container } = render(
      <InferenceIndicator status="idle" streamStartTime={null} estimatedTokens={0} />
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders streaming state with all elements', () => {
    render(
      <InferenceIndicator status="streaming" streamStartTime={Date.now()} estimatedTokens={3200} />
    );

    expect(screen.getByTestId('inference-indicator-streaming')).toBeInTheDocument();
    expect(screen.getByText("Droppin' Science")).toBeInTheDocument();
    expect(screen.getByText('2m 14s')).toBeInTheDocument();
    expect(screen.getByText('~3.2k tokens')).toBeInTheDocument();
  });

  it('renders the theme icon with animation style', () => {
    render(
      <InferenceIndicator status="streaming" streamStartTime={Date.now()} estimatedTokens={100} />
    );

    const icon = screen.getByText('*');
    expect(icon).toHaveAttribute('aria-hidden', 'true');
    expect(icon.style.animation).toContain('shimmer-pulse');
  });

  it('renders complete state with summary', () => {
    render(<InferenceIndicator status="idle" streamStartTime={null} estimatedTokens={3200} />);

    expect(screen.getByTestId('inference-indicator-complete')).toBeInTheDocument();
    expect(screen.getByText('2m 14s')).toBeInTheDocument();
    expect(screen.getByText('~3.2k tokens')).toBeInTheDocument();
  });

  it('formats tokens below 1000 without k suffix', () => {
    render(
      <InferenceIndicator status="streaming" streamStartTime={Date.now()} estimatedTokens={450} />
    );

    expect(screen.getByText('~450 tokens')).toBeInTheDocument();
  });

  it('formats tokens at 1000+ with k suffix', () => {
    render(
      <InferenceIndicator status="streaming" streamStartTime={Date.now()} estimatedTokens={1250} />
    );

    expect(screen.getByText('~1.3k tokens')).toBeInTheDocument();
  });
});
```

**Acceptance Criteria**:

- Component renders three states: streaming, complete, null (idle+no tokens)
- Streaming state shows icon, verb, elapsed time, token count
- Complete state shows compact summary with `elapsed . tokens`
- Icon has `aria-hidden="true"`
- Token formatting: `~450 tokens` below 1000, `~3.2k tokens` at 1000+
- Uses `motion.div` for entrance animation and `AnimatePresence` for verb crossfade
- All tests pass

---

## Phase 4: Wiring (Depends on Phase 2 + Phase 3)

### Task 8: [P4] Wire InferenceIndicator through ChatPanel and MessageList

**Files**:

- `apps/client/src/components/chat/ChatPanel.tsx` (modify)
- `apps/client/src/components/chat/MessageList.tsx` (modify)

**ChatPanel.tsx changes**:

1. Update the destructuring from `useChatSession` to include the new values:

```typescript
const {
  messages,
  input,
  setInput,
  handleSubmit,
  status,
  error,
  stop,
  isLoadingHistory,
  sessionStatus,
  streamStartTime,
  estimatedTokens,
} = useChatSession(sessionId, {
  transformContent,
  onTaskEvent: taskState.handleTaskEvent,
  onSessionIdChange: setSessionId,
});
```

2. Pass the new props to `<MessageList>`:

```tsx
<MessageList
  ref={messageListRef}
  messages={messages}
  sessionId={sessionId}
  status={status}
  onScrollStateChange={handleScrollStateChange}
  streamStartTime={streamStartTime}
  estimatedTokens={estimatedTokens}
/>
```

**MessageList.tsx changes**:

1. Add import at top:

```typescript
import { InferenceIndicator } from './InferenceIndicator';
```

2. Extend the `MessageListProps` interface:

```typescript
interface MessageListProps {
  messages: ChatMessage[];
  sessionId: string;
  status?: 'idle' | 'streaming' | 'error';
  onScrollStateChange?: (state: ScrollState) => void;
  streamStartTime?: number | null;
  estimatedTokens?: number;
}
```

3. Update the function signature to destructure the new props:

```typescript
function MessageList({ messages, sessionId, status, onScrollStateChange, streamStartTime, estimatedTokens }, ref) {
```

4. After the virtualizer items div (inside the scroll container's relative div, after the `{virtualizer.getVirtualItems().map(...)}`), add the indicator:

```tsx
{
  /* Inference status indicator — positioned below last virtual item */
}
<div style={{ position: 'absolute', top: virtualizer.getTotalSize(), left: 0, width: '100%' }}>
  <InferenceIndicator
    status={status ?? 'idle'}
    streamStartTime={streamStartTime ?? null}
    estimatedTokens={estimatedTokens ?? 0}
  />
</div>;
```

This positions the indicator absolutely below all virtual items, inside the same relative container, so it scrolls naturally with the content. The existing auto-scroll behavior (scrolling to the last message) will keep it visible.

**Acceptance Criteria**:

- `ChatPanel` destructures and passes `streamStartTime` and `estimatedTokens` to `MessageList`
- `MessageList` renders `InferenceIndicator` below the virtual items
- Indicator is visible during streaming and collapses on completion
- No layout shift when transitioning from streaming to complete
- Existing auto-scroll continues to work
- Existing tests still pass (new props are optional)
- `turbo typecheck` passes

---

## Phase 5: Polish (Depends on Phase 4)

### Task 9: [P5] Final verification, polish, and build check

**No new files. Verification and adjustments only.**

**Steps**:

1. Run `turbo typecheck` and fix any type errors
2. Run `turbo test` and fix any failures
3. Run `turbo build` and verify clean build
4. Manual verification checklist:
   - [ ] Indicator appears during streaming, below last message
   - [ ] Asterisk shimmer animation plays
   - [ ] Verb rotates every ~3.5s with crossfade
   - [ ] Elapsed time updates every second
   - [ ] Token count increases as text streams
   - [ ] Completion: collapses to compact summary, no layout shift
   - [ ] Dark mode: text colors readable
   - [ ] `prefers-reduced-motion`: animations disabled, content still shows
   - [ ] Mobile viewport: text scales correctly
   - [ ] Auto-scroll keeps indicator visible
   - [ ] Fast response (<5s): appears and collapses quickly
   - [ ] Long response (>1min): time format adapts
5. Fix any visual issues found (spacing, colors, animation timing)
6. Ensure `text-2xs` and `text-3xs` utility classes exist or add them if missing

**Acceptance Criteria**:

- `turbo build` passes cleanly
- `turbo test` all green
- `turbo typecheck` no errors
- All manual checklist items verified
- No console errors during streaming

---

## Dependency Graph

```
Phase 1 (parallel):
  Task 1: inference-verbs.ts
  Task 2: inference-themes.ts  (depends on Task 1)
  Task 3: use-elapsed-time.ts + tests
  Task 4: use-rotating-verb.ts + tests

Phase 2 (depends on Phase 1):
  Task 5: use-chat-session.ts modifications + tests

Phase 3 (depends on Phase 1 — can run parallel with Phase 2):
  Task 6: index.css shimmer-pulse keyframe
  Task 7: InferenceIndicator.tsx + tests (depends on Tasks 2, 3, 4, 6)

Phase 4 (depends on Phase 2 + Phase 3):
  Task 8: ChatPanel + MessageList wiring

Phase 5 (depends on Phase 4):
  Task 9: Polish and verification
```

## Parallel Execution Opportunities

- **Tasks 1, 3, 4** can all run simultaneously (no interdependencies)
- **Task 2** depends only on Task 1 (trivial import)
- **Tasks 5 and 6** can run in parallel (different files, no shared code)
- **Task 7** must wait for Tasks 2, 3, 4, 6 (imports from all)
- **Task 8** must wait for Tasks 5 and 7
- **Task 9** must wait for Task 8
