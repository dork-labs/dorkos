# Specification: Notification Sound on AI Response Completion

**Status:** Draft
**Author:** Claude Code
**Date:** 2026-02-13
**Ideation:** [specs/notification-sound/01-ideation.md](01-ideation.md)

---

## Overview

Add an audio notification sound that plays when the AI finishes responding, but only for responses that took 3+ seconds. This helps users who tab away during longer generations know when the response is ready. The feature includes:

1. A `enableNotificationSound` setting in Settings > Preferences (on by default)
2. A status bar widget (speaker icon) for one-click mute/unmute
3. A `showStatusBarSound` visibility toggle in Settings > Status Bar tab
4. A generated notification sound file (`notification.mp3`) in `public/`

## Background / Problem Statement

When using the chat UI, users often tab away while waiting for longer AI responses. There's no audio cue to indicate the response has completed, forcing users to periodically check back. A subtle notification sound solves this without requiring browser Notification API permissions or OS-level notifications.

## Goals

- Play a subtle audio notification when AI responses complete (3+ seconds only)
- Provide easy on/off toggle via status bar widget (single click)
- Persist preference in localStorage
- Work across all major browsers (Chrome, Firefox, Safari)
- Zero new npm dependencies

## Non-Goals

- Custom sound uploads or sound selection
- Volume control
- Different sounds per event type
- Native OS notifications (Notification API)
- Sound for other events (new session, incoming sync, etc.)
- Gating on `prefers-reduced-motion` (that's for visual motion, not audio)

## Technical Dependencies

- `HTMLAudioElement` — native browser API, no dependencies
- `lucide-react` — already installed, provides `Volume2` / `VolumeOff` icons
- `motion/react` — already installed, for status bar widget animations

## Detailed Design

### 1. Sound File Generation

Generate a notification sound using an offline Node.js script that synthesizes a two-tone chime via Web Audio API (OfflineAudioContext) and exports it as WAV. The script lives in `apps/client/scripts/generate-notification-sound.ts` and outputs to `apps/client/public/notification.mp3`.

**Sound characteristics:**
- Duration: ~250ms
- Two sine tones: 880Hz (A5) + 1047Hz (C6), slight stagger
- Fast attack, exponential decay
- Gentle, non-jarring character
- File size: ~5-10KB

The generated file is committed to the repo so the script only needs to run once (or to regenerate).

### 2. Zustand Store Additions (`app-store.ts`)

Add two new boolean settings following the existing pattern:

```typescript
// In AppState interface:
enableNotificationSound: boolean;
setEnableNotificationSound: (v: boolean) => void;
showStatusBarSound: boolean;
setShowStatusBarSound: (v: boolean) => void;
```

**Implementation:**
- `enableNotificationSound`: default `true`, localStorage key `gateway-enable-notification-sound`, uses `!== 'false'` pattern (default on)
- `showStatusBarSound`: default `true`, localStorage key `gateway-show-status-bar-sound`, uses `!== 'false'` pattern (default on)
- Both included in `resetPreferences()` — reset to `true`, clear localStorage keys

### 3. Notification Sound Utility (`lib/notification-sound.ts`)

A simple utility module (not a hook) that manages audio playback:

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

**Key design decisions:**
- Singleton `Audio` instance — reused across plays, only one HTTP request ever
- `currentTime = 0` — allows rapid re-triggering if needed
- `.play().catch()` — handles autoplay policy rejection silently
- No Web Audio API complexity — `HTMLAudioElement` is sufficient for a simple notification
- Not a React hook — plain function, callable from anywhere

### 4. Integration in `use-chat-session.ts`

In the `'done'` event handler (line ~452), add sound playback with the 3-second threshold:

```typescript
case 'done': {
  // Play notification sound if response took 3+ seconds
  if (streamStartTimeRef.current) {
    const elapsed = Date.now() - streamStartTimeRef.current;
    if (elapsed >= 3000) {
      options.onStreamingDone?.();
    }
  }
  // ... existing reset logic
}
```

**Why a callback (`onStreamingDone`) instead of direct playback:**
- `use-chat-session` is a pure data hook — it shouldn't know about sounds or settings
- The callback lets `ChatPanel` (the orchestrator) decide whether to play based on the Zustand setting
- Same pattern used for `onTaskEvent` and `onSessionIdChange`

Add to `UseChatSessionOptions`:
```typescript
onStreamingDone?: () => void;
```

### 5. ChatPanel Integration

In `ChatPanel.tsx`, wire the callback:

```typescript
const enableNotificationSound = useAppStore((s) => s.enableNotificationSound);

// In useChatSession options:
onStreamingDone: useCallback(() => {
  if (enableNotificationSound) {
    playNotificationSound();
  }
}, [enableNotificationSound]),
```

Import `playNotificationSound` from `@/lib/notification-sound`.

### 6. Status Bar Widget (`NotificationSoundItem.tsx`)

A new status bar item component at `apps/client/src/components/status/NotificationSoundItem.tsx`:

```typescript
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

**Behavior:**
- Shows `Volume2` icon when enabled, `VolumeOff` when disabled
- Single click toggles `enableNotificationSound` in the store
- No dropdown menu — just a simple toggle button
- Accessible: `aria-label` describes current state + action

### 7. StatusLine Integration

In `StatusLine.tsx`, add the sound widget after the context usage entry:

```typescript
import { NotificationSoundItem } from './NotificationSoundItem';

// In useAppStore destructure:
showStatusBarSound,
enableNotificationSound,
setEnableNotificationSound,

// After the context entry block:
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

### 8. Settings Dialog Changes

**Preferences tab** — add after "Task celebrations" toggle:

```tsx
<SettingRow label="Notification sound" description="Play a sound when AI finishes responding (3s+ responses)">
  <Switch checked={enableNotificationSound} onCheckedChange={setEnableNotificationSound} />
</SettingRow>
```

**Status Bar tab** — add after "Show context usage" toggle:

```tsx
<SettingRow label="Show sound toggle" description="Display notification sound toggle">
  <Switch checked={showStatusBarSound} onCheckedChange={setShowStatusBarSound} />
</SettingRow>
```

## User Experience

1. **First use:** User sends a message, AI takes 5+ seconds to respond. When done, a subtle chime plays. User sees speaker icon in status bar.
2. **Quick mute:** User clicks speaker icon in status bar → icon changes to `VolumeOff`, no more sounds.
3. **Re-enable:** User clicks muted icon → back to `Volume2`, sounds resume.
4. **Settings:** User opens Settings > Preferences → "Notification sound" toggle controls the same setting.
5. **Hide widget:** User opens Settings > Status Bar → "Show sound toggle" can hide the status bar icon entirely.
6. **Short responses:** AI responds in < 3 seconds → no sound plays (avoids fatigue).

## Testing Strategy

### Unit Tests

**`lib/__tests__/notification-sound.test.ts`:**
- `playNotificationSound()` creates an Audio element and calls `.play()`
- `.play()` rejection is caught silently (no thrown errors)
- Reuses the same Audio instance across multiple calls
- Sets `currentTime = 0` before playing

**`components/status/__tests__/NotificationSoundItem.test.tsx`:**
- Renders `Volume2` icon when enabled
- Renders `VolumeOff` icon when disabled
- Calls `onToggle` when clicked
- Has correct `aria-label` for each state

**`components/settings/__tests__/SettingsDialog.test.tsx` (additions):**
- "Notification sound" toggle appears in Preferences tab
- "Show sound toggle" appears in Status Bar tab
- Both toggles reflect store state

### Integration Tests

**`hooks/__tests__/use-chat-session.test.tsx` (additions):**
- `onStreamingDone` callback fires when `'done'` event received and streaming lasted 3+ seconds
- `onStreamingDone` does NOT fire for responses < 3 seconds
- `onStreamingDone` does NOT fire if `streamStartTimeRef` is null

### Mocking Strategy

- Mock `HTMLAudioElement` globally in test setup: `vi.stubGlobal('Audio', mockAudioConstructor)`
- Mock audio instance: `{ play: vi.fn().mockResolvedValue(undefined), currentTime: 0 }`
- For component tests: mock `@/lib/notification-sound` module

## Performance Considerations

- **Bundle impact:** Zero — no new dependencies. The utility module is ~10 lines.
- **Network:** One HTTP request for `notification.mp3` (~5-10KB), cached indefinitely by browser.
- **Memory:** Single `Audio` instance reused. No Web Audio API context overhead.
- **Rendering:** Status bar widget is a simple button, no expensive renders.

## Security Considerations

- No user data involved.
- Sound file is a static asset served from same origin.
- No external network requests.
- `Audio.play()` rejection handled gracefully (no error propagation).

## Documentation

- No external documentation needed.
- Settings are self-describing via label + description in the Settings dialog.

## Implementation Phases

### Phase 1: Core (All in one pass)

1. **Sound file:** Generate `notification.mp3` and place in `public/`
2. **Store:** Add `enableNotificationSound` + `showStatusBarSound` to `app-store.ts`
3. **Utility:** Create `lib/notification-sound.ts`
4. **Hook integration:** Add `onStreamingDone` callback to `use-chat-session.ts`
5. **ChatPanel:** Wire `onStreamingDone` to play sound when enabled
6. **Status bar widget:** Create `NotificationSoundItem.tsx`
7. **StatusLine:** Add sound widget entry
8. **Settings:** Add both toggles to SettingsDialog
9. **Tests:** All unit + integration tests

No phasing needed — this is a small, self-contained feature that can be implemented in a single pass.

## Open Questions

None — all clarifications resolved in ideation.

## References

- [MDN: HTMLMediaElement.play()](https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/play)
- [Chrome: Autoplay Policy](https://developer.chrome.com/blog/autoplay/)
- [Ideation Document](01-ideation.md)
