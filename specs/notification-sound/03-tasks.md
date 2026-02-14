# Tasks: Notification Sound on AI Response Completion

**Feature Slug:** notification-sound
**Spec:** [02-specification.md](02-specification.md)
**Generated:** 2026-02-13

---

## Task 1: Store + Settings UI

**Subject:** [notification-sound] [P1] Adding enableNotificationSound and showStatusBarSound to Zustand store and Settings dialog

**Dependencies:** None

**Description:**

Add two new boolean settings to the Zustand app store and wire them into the Settings dialog.

### app-store.ts changes

Add to the `AppState` interface:

```typescript
enableNotificationSound: boolean;
setEnableNotificationSound: (v: boolean) => void;
showStatusBarSound: boolean;
setShowStatusBarSound: (v: boolean) => void;
```

Add state initialization and setters (after `showTaskCelebrations`):

```typescript
enableNotificationSound: (() => {
  try { return localStorage.getItem('gateway-enable-notification-sound') !== 'false'; }
  catch { return true; }
})(),
setEnableNotificationSound: (v) => {
  try { localStorage.setItem('gateway-enable-notification-sound', String(v)); } catch {}
  set({ enableNotificationSound: v });
},

showStatusBarSound: (() => {
  try { return localStorage.getItem('gateway-show-status-bar-sound') !== 'false'; }
  catch { return true; }
})(),
setShowStatusBarSound: (v) => {
  try { localStorage.setItem('gateway-show-status-bar-sound', String(v)); } catch {}
  set({ showStatusBarSound: v });
},
```

Add to `resetPreferences()`:
- In the localStorage removal block: `localStorage.removeItem('gateway-enable-notification-sound');` and `localStorage.removeItem('gateway-show-status-bar-sound');`
- In the `set()` call: `enableNotificationSound: true, showStatusBarSound: true,`

### SettingsDialog.tsx changes

Add to the `useAppStore` destructure:

```typescript
enableNotificationSound, setEnableNotificationSound,
showStatusBarSound, setShowStatusBarSound,
```

**Preferences tab** — add after the "Task celebrations" SettingRow:

```tsx
<SettingRow label="Notification sound" description="Play a sound when AI finishes responding (3s+ responses)">
  <Switch checked={enableNotificationSound} onCheckedChange={setEnableNotificationSound} />
</SettingRow>
```

**Status Bar tab** — add after the "Show context usage" SettingRow:

```tsx
<SettingRow label="Show sound toggle" description="Display notification sound toggle">
  <Switch checked={showStatusBarSound} onCheckedChange={setShowStatusBarSound} />
</SettingRow>
```

---

## Task 2: Sound file + playback utility

**Subject:** [notification-sound] [P1] Creating notification sound file and playNotificationSound utility

**Dependencies:** None

**Description:**

### Sound file

Create or place a notification sound file at `apps/client/public/notification.mp3`. This should be a short (~250ms) two-tone chime. Options:
1. Write a generation script at `apps/client/scripts/generate-notification-sound.ts` that synthesizes a WAV using OfflineAudioContext (880Hz A5 + 1047Hz C6, fast attack, exponential decay)
2. Or create a minimal placeholder audio file

The generated file should be committed to the repo (~5-10KB).

### Playback utility

Create `apps/client/src/lib/notification-sound.ts`:

```typescript
let audio: HTMLAudioElement | null = null;

export function playNotificationSound(): void {
  try {
    if (!audio) {
      audio = new Audio('/notification.mp3');
    }
    audio.currentTime = 0;
    audio.play().catch(() => {
      // Silently ignore autoplay rejection
    });
  } catch {
    // Silently ignore any errors
  }
}
```

Key design decisions:
- Singleton `Audio` instance — reused across plays, only one HTTP request ever
- `currentTime = 0` — allows rapid re-triggering if needed
- `.play().catch()` — handles autoplay policy rejection silently
- Not a React hook — plain function, callable from anywhere

---

## Task 3: Hook integration + ChatPanel wiring

**Subject:** [notification-sound] [P1] Integrating onStreamingDone callback into use-chat-session and ChatPanel

**Dependencies:** Task 1, Task 2

**Description:**

### use-chat-session.ts changes

Add `onStreamingDone` to the `ChatSessionOptions` interface:

```typescript
interface ChatSessionOptions {
  transformContent?: (content: string) => string | Promise<string>;
  onTaskEvent?: (event: TaskUpdateEvent) => void;
  onSessionIdChange?: (newSessionId: string) => void;
  onStreamingDone?: () => void;
}
```

In the `'done'` event handler (inside `handleStreamEvent`, the `case 'done':` block), add the callback invocation **before** the existing reset logic. The key change is to check `streamStartTimeRef.current` before it gets reset to null:

```typescript
case 'done': {
  const doneData = data as { sessionId?: string };
  if (doneData.sessionId && doneData.sessionId !== sessionId) {
    options.onSessionIdChange?.(doneData.sessionId);
  }
  // Play notification sound if response took 3+ seconds
  if (streamStartTimeRef.current) {
    const elapsed = Date.now() - streamStartTimeRef.current;
    if (elapsed >= 3000) {
      options.onStreamingDone?.();
    }
  }
  // Reset inference indicator state
  streamStartTimeRef.current = null;
  estimatedTokensRef.current = 0;
  setStreamStartTime(null);
  setEstimatedTokens(0);
  // Reset text streaming cursor state
  if (textStreamingTimerRef.current) clearTimeout(textStreamingTimerRef.current);
  isTextStreamingRef.current = false;
  setIsTextStreaming(false);
  setStatus('idle');
  break;
}
```

The important part: the `onStreamingDone` check must happen **before** `streamStartTimeRef.current = null` so `streamStartTimeRef.current` still has the start timestamp.

### ChatPanel.tsx changes

Add imports:

```typescript
import { playNotificationSound } from '../../lib/notification-sound';
```

Add store selector (near other `useAppStore` selectors):

```typescript
const enableNotificationSound = useAppStore((s) => s.enableNotificationSound);
```

Add `onStreamingDone` to the `useChatSession` options object:

```typescript
const { messages, input, setInput, handleSubmit, status, error, sessionBusy, stop, isLoadingHistory, sessionStatus, streamStartTime, estimatedTokens, isTextStreaming, isWaitingForUser, waitingType, activeInteraction } =
  useChatSession(sessionId, {
    transformContent,
    onTaskEvent: handleTaskEventWithCelebrations,
    onSessionIdChange: setSessionId,
    onStreamingDone: useCallback(() => {
      if (enableNotificationSound) {
        playNotificationSound();
      }
    }, [enableNotificationSound]),
  });
```

---

## Task 4: Status bar widget

**Subject:** [notification-sound] [P1] Creating NotificationSoundItem status bar component and integrating into StatusLine

**Dependencies:** Task 1

**Description:**

### Create NotificationSoundItem.tsx

Create `apps/client/src/components/status/NotificationSoundItem.tsx`:

```typescript
import { Volume2, VolumeOff } from 'lucide-react';

interface NotificationSoundItemProps {
  enabled: boolean;
  onToggle: () => void;
}

export function NotificationSoundItem({ enabled, onToggle }: NotificationSoundItemProps) {
  const Icon = enabled ? Volume2 : VolumeOff;
  return (
    <button
      onClick={onToggle}
      className="inline-flex items-center gap-1 hover:text-foreground transition-colors duration-150"
      aria-label={enabled ? 'Mute notification sound' : 'Unmute notification sound'}
      title={enabled ? 'Sound on — click to mute' : 'Sound off — click to unmute'}
    >
      <Icon className="size-(--size-icon-xs)" />
    </button>
  );
}
```

### StatusLine.tsx integration

Add import:

```typescript
import { NotificationSoundItem } from './NotificationSoundItem';
```

Add to the `useAppStore` destructure:

```typescript
showStatusBarSound,
enableNotificationSound,
setEnableNotificationSound,
```

After the context entry block (after the `if (showStatusBarContext ...)` block), add:

```typescript
if (showStatusBarSound) {
  entries.push({
    key: 'sound',
    node: (
      <NotificationSoundItem
        enabled={enableNotificationSound}
        onToggle={() => setEnableNotificationSound(!enableNotificationSound)}
      />
    ),
  });
}
```

---

## Task 5: Tests

**Subject:** [notification-sound] [P1] Writing tests for notification sound feature

**Dependencies:** Task 1, Task 2, Task 3, Task 4

**Description:**

### Unit test: notification-sound.ts

Create `apps/client/src/lib/__tests__/notification-sound.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Must reset modules between tests to clear the singleton
let playNotificationSound: () => void;

const mockPlay = vi.fn().mockResolvedValue(undefined);
const mockAudioInstance = {
  play: mockPlay,
  currentTime: 0,
};

vi.stubGlobal('Audio', vi.fn(() => mockAudioInstance));

beforeEach(async () => {
  vi.clearAllMocks();
  mockAudioInstance.currentTime = 0;
  // Re-import to reset singleton
  vi.resetModules();
  const mod = await import('../../lib/notification-sound');
  playNotificationSound = mod.playNotificationSound;
});

describe('playNotificationSound', () => {
  it('creates an Audio element and calls play()', () => {
    playNotificationSound();
    expect(Audio).toHaveBeenCalledWith('/notification.mp3');
    expect(mockPlay).toHaveBeenCalled();
  });

  it('catches play() rejection silently', () => {
    mockPlay.mockRejectedValueOnce(new Error('Autoplay blocked'));
    expect(() => playNotificationSound()).not.toThrow();
  });

  it('reuses the same Audio instance across multiple calls', () => {
    playNotificationSound();
    playNotificationSound();
    // Audio constructor called only once (singleton)
    expect(Audio).toHaveBeenCalledTimes(1);
  });

  it('sets currentTime = 0 before playing', () => {
    mockAudioInstance.currentTime = 5;
    playNotificationSound();
    expect(mockAudioInstance.currentTime).toBe(0);
  });
});
```

### Component test: NotificationSoundItem.tsx

Create `apps/client/src/components/status/__tests__/NotificationSoundItem.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import { NotificationSoundItem } from '../NotificationSoundItem';

describe('NotificationSoundItem', () => {
  it('renders Volume2 icon when enabled', () => {
    render(<NotificationSoundItem enabled={true} onToggle={vi.fn()} />);
    const button = screen.getByRole('button');
    expect(button).toHaveAttribute('aria-label', 'Mute notification sound');
  });

  it('renders VolumeOff icon when disabled', () => {
    render(<NotificationSoundItem enabled={false} onToggle={vi.fn()} />);
    const button = screen.getByRole('button');
    expect(button).toHaveAttribute('aria-label', 'Unmute notification sound');
  });

  it('calls onToggle when clicked', () => {
    const onToggle = vi.fn();
    render(<NotificationSoundItem enabled={true} onToggle={onToggle} />);
    fireEvent.click(screen.getByRole('button'));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('has correct aria-label for enabled state', () => {
    render(<NotificationSoundItem enabled={true} onToggle={vi.fn()} />);
    expect(screen.getByRole('button')).toHaveAttribute('aria-label', 'Mute notification sound');
  });

  it('has correct aria-label for disabled state', () => {
    render(<NotificationSoundItem enabled={false} onToggle={vi.fn()} />);
    expect(screen.getByRole('button')).toHaveAttribute('aria-label', 'Unmute notification sound');
  });
});
```

### SettingsDialog.test.tsx additions

Add these tests to the existing `apps/client/src/components/settings/__tests__/SettingsDialog.test.tsx` file:

```tsx
it('renders "Notification sound" toggle in Preferences tab', () => {
  render(<SettingsDialog open={true} onOpenChange={vi.fn()} />, { wrapper: Wrapper });
  expect(screen.getByText('Notification sound')).toBeInTheDocument();
  expect(screen.getByText('Play a sound when AI finishes responding (3s+ responses)')).toBeInTheDocument();
});

it('renders "Show sound toggle" in Status Bar tab', () => {
  render(<SettingsDialog open={true} onOpenChange={vi.fn()} />, { wrapper: Wrapper });
  expect(screen.getByText('Show sound toggle')).toBeInTheDocument();
  expect(screen.getByText('Display notification sound toggle')).toBeInTheDocument();
});
```

### use-chat-session.test.tsx additions

Add these tests to the existing `apps/client/src/hooks/__tests__/use-chat-session.test.tsx` file. The tests need to verify the `onStreamingDone` callback behavior:

```tsx
it('fires onStreamingDone when done event received after 3+ seconds', async () => {
  const onStreamingDone = vi.fn();
  let streamCallback: (event: StreamEvent) => void;

  const transport = createMockTransport({
    sendMessage: vi.fn((_sid, _msg, callback) => {
      streamCallback = callback;
      return new Promise(() => {}); // Never resolves (we control events manually)
    }),
  });

  const { result } = renderHook(
    () => useChatSession('test-session', { onStreamingDone }),
    { wrapper: createWrapper(transport) },
  );

  // Set input and submit
  act(() => { result.current.setInput('Hello'); });
  act(() => { result.current.handleSubmit(); });

  // Simulate 4 seconds passing by manipulating Date.now
  const originalNow = Date.now;
  const startTime = originalNow();
  Date.now = () => startTime + 4000;

  // Fire done event
  act(() => {
    streamCallback({ type: 'done', data: {} });
  });

  expect(onStreamingDone).toHaveBeenCalledTimes(1);

  // Restore Date.now
  Date.now = originalNow;
});

it('does NOT fire onStreamingDone for responses under 3 seconds', async () => {
  const onStreamingDone = vi.fn();
  let streamCallback: (event: StreamEvent) => void;

  const transport = createMockTransport({
    sendMessage: vi.fn((_sid, _msg, callback) => {
      streamCallback = callback;
      return new Promise(() => {});
    }),
  });

  const { result } = renderHook(
    () => useChatSession('test-session', { onStreamingDone }),
    { wrapper: createWrapper(transport) },
  );

  act(() => { result.current.setInput('Hello'); });
  act(() => { result.current.handleSubmit(); });

  // Simulate only 1 second passing
  const originalNow = Date.now;
  const startTime = originalNow();
  Date.now = () => startTime + 1000;

  act(() => {
    streamCallback({ type: 'done', data: {} });
  });

  expect(onStreamingDone).not.toHaveBeenCalled();

  Date.now = originalNow;
});
```

### Mocking strategy notes

- Mock `HTMLAudioElement` globally: `vi.stubGlobal('Audio', mockAudioConstructor)`
- Mock audio instance: `{ play: vi.fn().mockResolvedValue(undefined), currentTime: 0 }`
- For component tests involving ChatPanel: mock `@/lib/notification-sound` module with `vi.mock('../../lib/notification-sound', () => ({ playNotificationSound: vi.fn() }))`
