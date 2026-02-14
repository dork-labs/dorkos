---
slug: tab-identity
---

# Specification: Browser Tab Identity

## Status

Draft

## Authors

Claude Code — 2026-02-13

## Overview

When users have multiple DorkOS tabs open, every tab looks identical — same blank favicon, same "DorkOS" title. This makes it impossible to tell which tab corresponds to which project. This feature adds deterministic, zero-config visual differentiation using the working directory (cwd) as a seed: color-coded dynamic favicons, a pulsing favicon during AI streaming, and smart document titles with emoji prefixes and task summaries.

## Background / Problem Statement

DorkOS is a multi-session coding agent UI. Power users frequently open multiple tabs — one per project directory. Currently:

- **Favicon**: None exists. All tabs show the browser's default blank icon.
- **Title**: Hardcoded to "DorkOS" for every tab.
- **Streaming feedback**: No tab-level indicator that Claude is working.

Users must click into each tab to figure out which project it belongs to and whether the agent is active. This is a friction point that compounds with each additional tab.

## Goals

- Assign each working directory a unique, deterministic color and emoji visible in the browser tab
- Provide at-a-glance streaming status via favicon pulsing
- Show the project directory name and current task in the page title
- Zero configuration — works automatically based on the selected cwd
- No new runtime dependencies

## Non-Goals

- Server-side changes
- User-configurable colors or emoji preferences
- Obsidian plugin tab identity (runs inside Obsidian, not browser tabs)
- PWA / service worker support
- Animated GIF favicons or multi-frame smooth animations
- Favicon with text/letter overlay
- Persisting favicon state across sessions

## Technical Dependencies

- **Canvas API** — Built-in browser API for generating 32x32 PNG favicons. Universal support (Chrome 6+, Firefox 2+, Safari, Edge).
- **React 19** — Hooks (`useEffect`, `useRef`, `useMemo`) for lifecycle management.
- **Zustand 5** — Reading `selectedCwd` from `app-store.ts`.
- **No new npm dependencies.**

## Detailed Design

### Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│ App.tsx (root)                                          │
│                                                         │
│  useFavicon({ cwd, isStreaming })                       │
│    → reads selectedCwd from useDirectoryState()         │
│    → reads status from useChatSession()                 │
│    → generates favicon via favicon-utils.ts             │
│    → manages pulsing interval                           │
│                                                         │
│  useDocumentTitle({ cwd, activeForm })                  │
│    → reads selectedCwd from useDirectoryState()         │
│    → reads activeForm from useTaskState()               │
│    → sets document.title                                │
└─────────────────────────────────────────────────────────┘
         │                    │
         ▼                    ▼
┌─────────────────┐  ┌──────────────────┐
│ favicon-utils.ts │  │ DOM side effects │
│ (pure functions) │  │ • <link rel=icon>│
│ • fnv1aHash()    │  │ • document.title │
│ • hashToHslColor │  └──────────────────┘
│ • hashToEmoji()  │
│ • generateCircle │
│ • setFavicon()   │
└─────────────────┘
```

### File Organization

#### New files

| File | Purpose |
|------|---------|
| `apps/client/src/lib/favicon-utils.ts` | Pure utility functions for hashing, color generation, canvas favicon creation |
| `apps/client/src/hooks/use-favicon.ts` | React hook: favicon generation + pulsing animation lifecycle |
| `apps/client/src/hooks/use-document-title.ts` | React hook: document.title management |

#### Modified files

| File | Change |
|------|--------|
| `apps/client/src/App.tsx` | Mount `useFavicon()` and `useDocumentTitle()` at root |
| `apps/client/index.html` | Add `<link rel="icon">` fallback tag |

### `favicon-utils.ts` — Pure Utility Functions

#### `fnv1aHash(str: string): number`

FNV-1a hash producing a 32-bit unsigned integer. Chosen for excellent distribution on short strings like file paths.

```typescript
export function fnv1aHash(str: string): number {
  let hash = 0x811c9dc5; // FNV offset basis
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0; // FNV prime, keep as uint32
  }
  return hash;
}
```

#### `hashToHslColor(cwd: string): string`

Maps cwd to a vibrant HSL color string.

```typescript
export function hashToHslColor(cwd: string): string {
  const hash = fnv1aHash(cwd);
  const hue = hash % 360;
  return `hsl(${hue}, 70%, 55%)`;
}
```

Fixed saturation (70%) and lightness (55%) ensure all generated colors are vibrant and readable against both light and dark browser chrome.

#### `hashToEmoji(cwd: string): string`

Maps cwd to a deterministic face emoji from a curated set of 30.

```typescript
const EMOJI_SET = [
  '😀', '😎', '🤖', '🦊', '🐱', '🐶', '🦁', '🐸', '🐵', '🦄',
  '🐲', '🦉', '🐧', '🐼', '🦋', '🌸', '🔮', '🎯', '🚀', '⚡',
  '🌊', '🍀', '🎨', '🎵', '💎', '🔥', '🌈', '⭐', '🧠', '👾',
];

export function hashToEmoji(cwd: string): string {
  const hash = fnv1aHash(cwd);
  return EMOJI_SET[hash % EMOJI_SET.length];
}
```

Uses a secondary modulo (after hue) so the emoji and color are independently distributed — two directories could share a similar color but have different emojis, maximizing distinguishability.

#### `generateCircleFavicon(hslColor: string): string`

Renders a filled circle on a 32x32 canvas and returns a PNG data URI.

```typescript
export function generateCircleFavicon(hslColor: string): string {
  const canvas = document.createElement('canvas');
  canvas.width = 32;
  canvas.height = 32;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';

  ctx.fillStyle = hslColor;
  ctx.beginPath();
  ctx.arc(16, 16, 15, 0, Math.PI * 2);
  ctx.fill();

  return canvas.toDataURL('image/png');
}
```

#### `generateDimmedFavicon(solidDataUrl: string, opacity?: number): Promise<string>`

Creates a dimmed version of an existing favicon data URI for the pulsing animation.

```typescript
export function generateDimmedFavicon(
  solidDataUrl: string,
  opacity = 0.4,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const canvas = document.createElement('canvas');
    canvas.width = 32;
    canvas.height = 32;
    const ctx = canvas.getContext('2d');
    if (!ctx) return reject(new Error('Canvas context unavailable'));

    const img = new Image();
    img.onload = () => {
      ctx.globalAlpha = opacity;
      ctx.drawImage(img, 0, 0);
      resolve(canvas.toDataURL('image/png'));
    };
    img.onerror = reject;
    img.src = solidDataUrl;
  });
}
```

#### `setFavicon(dataUrl: string): void`

Updates the `<link rel="icon">` element in the document head.

```typescript
export function setFavicon(dataUrl: string): void {
  let link = document.querySelector<HTMLLinkElement>("link[rel*='icon']");
  if (!link) {
    link = document.createElement('link');
    link.rel = 'icon';
    document.head.appendChild(link);
  }
  link.href = dataUrl;
}
```

### `use-favicon.ts` — Favicon Hook

```typescript
import { useEffect, useRef } from 'react';
import {
  hashToHslColor,
  generateCircleFavicon,
  generateDimmedFavicon,
  setFavicon,
} from '@/lib/favicon-utils';

interface UseFaviconOptions {
  cwd: string | null;
  isStreaming: boolean;
}

export function useFavicon({ cwd, isStreaming }: UseFaviconOptions) {
  const solidRef = useRef<string>('');
  const dimmedRef = useRef<string>('');
  const intervalRef = useRef<number | null>(null);

  // Generate favicon when cwd changes
  useEffect(() => {
    if (!cwd) return;

    const color = hashToHslColor(cwd);
    const solid = generateCircleFavicon(color);
    solidRef.current = solid;
    setFavicon(solid);

    // Pre-generate dimmed version for animation
    generateDimmedFavicon(solid).then((dimmed) => {
      dimmedRef.current = dimmed;
    });
  }, [cwd]);

  // Manage pulsing animation
  useEffect(() => {
    if (isStreaming && solidRef.current && dimmedRef.current) {
      let showSolid = true;
      intervalRef.current = window.setInterval(() => {
        setFavicon(showSolid ? dimmedRef.current : solidRef.current);
        showSolid = !showSolid;
      }, 600);
    } else {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      if (solidRef.current) {
        setFavicon(solidRef.current);
      }
    }

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [isStreaming]);
}
```

### `use-document-title.ts` — Title Hook

```typescript
import { useEffect } from 'react';
import { hashToEmoji } from '@/lib/favicon-utils';

interface UseDocumentTitleOptions {
  cwd: string | null;
  activeForm: string | null;
}

export function useDocumentTitle({ cwd, activeForm }: UseDocumentTitleOptions) {
  useEffect(() => {
    if (!cwd) {
      document.title = 'DorkOS';
      return;
    }

    const emoji = hashToEmoji(cwd);
    const dirName = cwd.split('/').filter(Boolean).pop() ?? cwd;

    let title = `${emoji} ${dirName}`;

    if (activeForm) {
      const truncated =
        activeForm.length > 40
          ? activeForm.slice(0, 40) + '…'
          : activeForm;
      title += ` — ${truncated}`;
    }

    title += ' — DorkOS';
    document.title = title;
  }, [cwd, activeForm]);
}
```

**Title format examples:**
- No cwd: `DorkOS`
- With cwd: `🤖 webui — DorkOS`
- With task: `🤖 webui — Running tests — DorkOS`

### Integration in `App.tsx`

The hooks are mounted inside the existing `AppContent` or equivalent component that has access to the directory state and chat session. Both hooks are purely side-effect-based (no render output).

```typescript
// Inside App component body, after existing hooks:
const [selectedCwd] = useDirectoryState();
const { status } = useChatSession(activeSessionId, { /* existing options */ });

useFavicon({ cwd: selectedCwd, isStreaming: status === 'streaming' });
useDocumentTitle({ cwd: selectedCwd, activeForm: taskState.activeForm });
```

Note: The exact integration depends on where `useChatSession` and `useTaskState` are already called. If they're in `ChatPanel`, we may need to either lift state or create a lightweight wrapper. The key constraint is that `useFavicon` and `useDocumentTitle` must run at the `App` level so they're active even before a session is selected.

**Practical approach:** Since `useChatSession` requires a `sessionId` and is currently called in `ChatPanel`, we have two options:

1. **Option A (simpler):** Mount `useDocumentTitle` in `App.tsx` with just `cwd` (always works). Mount `useFavicon` in `App.tsx` with `cwd` for static color. Pass `isStreaming` up via a Zustand atom or mount the pulsing logic in `ChatPanel` where `useChatSession` already lives.

2. **Option B (cleaner):** Add a thin `isStreaming` boolean to `app-store.ts` that `ChatPanel` writes to when status changes. Then `useFavicon` in `App.tsx` reads from the store.

**Recommended: Option B** — adding `isStreaming: boolean` + `setIsStreaming(v: boolean)` to `app-store.ts` keeps the hooks at root level without prop drilling. `ChatPanel` already knows the streaming status and simply calls `setIsStreaming(status === 'streaming')` in a `useEffect`.

### `index.html` Changes

Add a static fallback favicon link:

```html
<link rel="icon" type="image/png" href="/favicon.png">
```

A simple 32x32 PNG with a neutral DorkOS-branded icon will be placed at `apps/client/public/favicon.png`. This serves Safari users (who can't receive dynamic updates) and provides a default before React hydrates.

## User Experience

### What users see

1. **On page load**: Tab immediately shows the directory name with an emoji prefix in the title. After React hydrates (~200ms), the favicon updates to a colored circle matching the cwd.

2. **When switching directories**: Both the favicon color and title emoji change instantly to reflect the new project.

3. **During AI streaming**: The favicon gently pulses (alternating solid/dimmed every 600ms), providing at-a-glance feedback that Claude is working — even when the tab is in the background.

4. **When a task is in progress**: The title appends the task description (e.g., "Running tests"), so users can see what each tab is doing from the tab bar.

5. **Multiple tabs**: Each tab has a visually distinct color and emoji based on its cwd. Users can quickly scan the tab bar to find the right project.

### Safari users

Safari blocks JavaScript-based favicon updates. These users will see the static fallback favicon.png but still benefit from the emoji + directory name in the title (emoji in titles works universally).

## Testing Strategy

### Unit Tests — `favicon-utils.test.ts`

```typescript
describe('fnv1aHash', () => {
  // Validates determinism: same input always produces same output
  it('returns consistent hash for same input', () => {
    expect(fnv1aHash('/Users/test/project')).toBe(fnv1aHash('/Users/test/project'));
  });

  // Validates distribution: different inputs produce different outputs
  it('returns different hashes for different inputs', () => {
    expect(fnv1aHash('/project-a')).not.toBe(fnv1aHash('/project-b'));
  });

  // Validates type: always returns a positive 32-bit integer
  it('returns a uint32', () => {
    const hash = fnv1aHash('/any/path');
    expect(hash).toBeGreaterThanOrEqual(0);
    expect(hash).toBeLessThanOrEqual(0xFFFFFFFF);
  });
});

describe('hashToHslColor', () => {
  // Validates output format matches CSS HSL syntax
  it('returns valid HSL color string', () => {
    expect(hashToHslColor('/test')).toMatch(/^hsl\(\d+, 70%, 55%\)$/);
  });

  // Validates determinism
  it('returns same color for same cwd', () => {
    expect(hashToHslColor('/a')).toBe(hashToHslColor('/a'));
  });

  // Validates different cwds produce different hues (not guaranteed but highly likely)
  it('produces different hues for different paths', () => {
    expect(hashToHslColor('/project-1')).not.toBe(hashToHslColor('/project-2'));
  });
});

describe('hashToEmoji', () => {
  // Validates emoji is from the curated set
  it('returns a single emoji character from EMOJI_SET', () => {
    const emoji = hashToEmoji('/test');
    expect(emoji.length).toBeGreaterThanOrEqual(1);
    expect(emoji.length).toBeLessThanOrEqual(2); // emoji can be 1-2 UTF-16 code units
  });

  // Validates determinism
  it('returns same emoji for same cwd', () => {
    expect(hashToEmoji('/a')).toBe(hashToEmoji('/a'));
  });
});
```

### Unit Tests — `use-document-title.test.ts`

```typescript
describe('useDocumentTitle', () => {
  // Validates title updates when cwd changes
  it('sets title with emoji and directory name', () => {
    renderHook(() => useDocumentTitle({ cwd: '/Users/test/myproject', activeForm: null }));
    expect(document.title).toMatch(/^. myproject — DorkOS$/);
  });

  // Validates task summary appears when provided
  it('includes activeForm in title when present', () => {
    renderHook(() => useDocumentTitle({ cwd: '/test/proj', activeForm: 'Running tests' }));
    expect(document.title).toContain('Running tests');
  });

  // Validates truncation of long task summaries
  it('truncates long activeForm at 40 chars', () => {
    const longForm = 'A'.repeat(50);
    renderHook(() => useDocumentTitle({ cwd: '/test', activeForm: longForm }));
    expect(document.title).toContain('…');
    expect(document.title.length).toBeLessThan(100);
  });

  // Validates fallback when no cwd
  it('falls back to default title when cwd is null', () => {
    renderHook(() => useDocumentTitle({ cwd: null, activeForm: null }));
    expect(document.title).toBe('DorkOS');
  });
});
```

### Unit Tests — `use-favicon.test.ts`

Canvas API is not available in jsdom, so tests mock `favicon-utils` functions.

```typescript
vi.mock('@/lib/favicon-utils', () => ({
  hashToHslColor: vi.fn(() => 'hsl(180, 70%, 55%)'),
  generateCircleFavicon: vi.fn(() => 'data:image/png;base64,solid'),
  generateDimmedFavicon: vi.fn(() => Promise.resolve('data:image/png;base64,dimmed')),
  setFavicon: vi.fn(),
}));

describe('useFavicon', () => {
  // Validates favicon is generated and set when cwd changes
  it('generates and sets favicon when cwd is provided', () => {
    renderHook(() => useFavicon({ cwd: '/test', isStreaming: false }));
    expect(generateCircleFavicon).toHaveBeenCalledWith('hsl(180, 70%, 55%)');
    expect(setFavicon).toHaveBeenCalledWith('data:image/png;base64,solid');
  });

  // Validates no action when cwd is null
  it('does nothing when cwd is null', () => {
    renderHook(() => useFavicon({ cwd: null, isStreaming: false }));
    expect(generateCircleFavicon).not.toHaveBeenCalled();
  });

  // Validates interval cleanup on unmount
  it('cleans up interval on unmount', () => {
    const clearSpy = vi.spyOn(globalThis, 'clearInterval');
    const { unmount } = renderHook(() => useFavicon({ cwd: '/test', isStreaming: true }));
    unmount();
    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  });

  // Validates pulsing starts during streaming
  it('starts pulsing interval when streaming', async () => {
    vi.useFakeTimers();
    renderHook(() => useFavicon({ cwd: '/test', isStreaming: true }));
    await vi.advanceTimersByTimeAsync(1200);
    // setFavicon called: once for initial, then twice for pulsing (600ms intervals)
    expect(setFavicon).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });
});
```

### Mocking Strategy

- **Canvas API**: Mock `document.createElement('canvas')` and its `getContext('2d')` return in jsdom tests. Alternatively, mock the entire `favicon-utils` module in hook tests since the utils have their own unit tests.
- **DOM manipulation**: `document.title` works natively in jsdom. `document.querySelector` for favicon link also works.
- **Timers**: Use `vi.useFakeTimers()` for pulsing interval tests.

## Performance Considerations

- **Canvas rendering**: ~2-3ms per favicon generation. Generated once per cwd change, cached in refs. Negligible.
- **Data URI size**: 32x32 PNG circle is ~1-3KB as base64. Two cached versions (solid + dimmed) = ~4-6KB total. Negligible.
- **Pulsing interval**: 600ms `setInterval` = 1.67 updates/sec. Browsers throttle background tabs to ~1 FPS, so no CPU waste for inactive tabs.
- **Title updates**: Direct `document.title` assignment — no React re-renders triggered. Updates only when `cwd` or `activeForm` changes.
- **Memory**: Two data URIs cached in refs. No accumulation or leaks.

## Security Considerations

- **No sensitive data exposure**: The cwd path is only used locally for hashing. The hash is one-way and the resulting color/emoji reveal nothing about the directory path.
- **No network requests**: Everything is client-side Canvas API. No data leaves the browser.
- **No localStorage writes**: This feature uses only in-memory refs and DOM mutations.

## Documentation

- Update `guides/design-system.md` if desired (optional — the favicon color palette could be documented there).
- No API documentation changes needed (client-only feature).
- No CLAUDE.md changes needed (no new commands or architecture patterns).

## Implementation Phases

### Phase 1: Core — Static Favicon + Title

1. Create `favicon-utils.ts` with `fnv1aHash`, `hashToHslColor`, `hashToEmoji`, `generateCircleFavicon`, `setFavicon`
2. Create `use-document-title.ts` hook
3. Create `use-favicon.ts` hook (static favicon only, no pulsing)
4. Mount both hooks in `App.tsx`
5. Add `<link rel="icon">` to `index.html`
6. Create static `public/favicon.png` fallback
7. Write unit tests for all pure functions

### Phase 2: Pulsing Animation

1. Add `generateDimmedFavicon` to `favicon-utils.ts`
2. Add `isStreaming` boolean to `app-store.ts`
3. Wire `ChatPanel` to write streaming status to store
4. Add pulsing logic to `use-favicon.ts`
5. Write tests for interval lifecycle

### Phase 3: Task Summary in Title

1. Wire `useTaskState().activeForm` into `useDocumentTitle`
2. Add truncation logic
3. Write tests for title with task summary

## Open Questions

None — all decisions have been made during ideation.

## References

- [Canvas API — MDN](https://developer.mozilla.org/en-US/docs/Web/API/Canvas_API)
- [FNV-1a Hash — Wikipedia](https://en.wikipedia.org/wiki/Fowler%E2%80%93Noll%E2%80%93Vo_hash_function)
- [Dynamic favicons — Remy Sharp](https://remysharp.com/2010/08/24/dynamic-favicons)
- [Favicon Badge libraries — GitHub](https://github.com/jelmervdl/favicon-badge)
- Existing codebase patterns: `CwdItem.tsx` (basename extraction), `InferenceIndicator.tsx` (streaming state), `app-store.ts` (Zustand preferences)
