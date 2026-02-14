# Tasks: Browser Tab Identity

## Phase 1: Core — Static Favicon + Title

### Task 1: [tab-identity] [P1] Create favicon-utils.ts with pure utility functions and unit tests

**Status:** pending

**Description:**
Create `apps/client/src/lib/favicon-utils.ts` with all pure utility functions for hashing, color generation, emoji mapping, canvas favicon creation, and DOM favicon setting. Also create `apps/client/src/lib/__tests__/favicon-utils.test.ts` with comprehensive unit tests.

**Files to create:**
- `apps/client/src/lib/favicon-utils.ts`
- `apps/client/src/lib/__tests__/favicon-utils.test.ts`

**Implementation — `favicon-utils.ts`:**

```typescript
const EMOJI_SET = [
  '\u{1F600}', '\u{1F60E}', '\u{1F916}', '\u{1F98A}', '\u{1F431}', '\u{1F436}', '\u{1F981}', '\u{1F438}', '\u{1F435}', '\u{1F984}',
  '\u{1F432}', '\u{1F989}', '\u{1F427}', '\u{1F43C}', '\u{1F98B}', '\u{1F338}', '\u{1F52E}', '\u{1F3AF}', '\u{1F680}', '\u{26A1}',
  '\u{1F30A}', '\u{1F340}', '\u{1F3A8}', '\u{1F3B5}', '\u{1F48E}', '\u{1F525}', '\u{1F308}', '\u{2B50}', '\u{1F9E0}', '\u{1F47E}',
];

export function fnv1aHash(str: string): number {
  let hash = 0x811c9dc5; // FNV offset basis
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0; // FNV prime, keep as uint32
  }
  return hash;
}

export function hashToHslColor(cwd: string): string {
  const hash = fnv1aHash(cwd);
  const hue = hash % 360;
  return `hsl(${hue}, 70%, 55%)`;
}

export function hashToEmoji(cwd: string): string {
  const hash = fnv1aHash(cwd);
  return EMOJI_SET[hash % EMOJI_SET.length];
}

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

**Tests — `favicon-utils.test.ts`:**

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { fnv1aHash, hashToHslColor, hashToEmoji, setFavicon } from '../favicon-utils';

describe('fnv1aHash', () => {
  it('returns consistent hash for same input', () => {
    expect(fnv1aHash('/Users/test/project')).toBe(fnv1aHash('/Users/test/project'));
  });

  it('returns different hashes for different inputs', () => {
    expect(fnv1aHash('/project-a')).not.toBe(fnv1aHash('/project-b'));
  });

  it('returns a uint32', () => {
    const hash = fnv1aHash('/any/path');
    expect(hash).toBeGreaterThanOrEqual(0);
    expect(hash).toBeLessThanOrEqual(0xFFFFFFFF);
  });
});

describe('hashToHslColor', () => {
  it('returns valid HSL color string', () => {
    expect(hashToHslColor('/test')).toMatch(/^hsl\(\d+, 70%, 55%\)$/);
  });

  it('returns same color for same cwd', () => {
    expect(hashToHslColor('/a')).toBe(hashToHslColor('/a'));
  });

  it('produces different hues for different paths', () => {
    expect(hashToHslColor('/project-1')).not.toBe(hashToHslColor('/project-2'));
  });
});

describe('hashToEmoji', () => {
  it('returns a single emoji character from EMOJI_SET', () => {
    const emoji = hashToEmoji('/test');
    expect(emoji.length).toBeGreaterThanOrEqual(1);
    expect(emoji.length).toBeLessThanOrEqual(2); // emoji can be 1-2 UTF-16 code units
  });

  it('returns same emoji for same cwd', () => {
    expect(hashToEmoji('/a')).toBe(hashToEmoji('/a'));
  });
});

describe('setFavicon', () => {
  beforeEach(() => {
    // Clean up any link elements from previous tests
    document.querySelectorAll("link[rel*='icon']").forEach(el => el.remove());
  });

  it('creates a link element if none exists', () => {
    setFavicon('data:image/png;base64,test');
    const link = document.querySelector<HTMLLinkElement>("link[rel*='icon']");
    expect(link).not.toBeNull();
    expect(link!.href).toBe('data:image/png;base64,test');
  });

  it('reuses existing link element', () => {
    const existing = document.createElement('link');
    existing.rel = 'icon';
    document.head.appendChild(existing);

    setFavicon('data:image/png;base64,updated');
    const links = document.querySelectorAll("link[rel*='icon']");
    expect(links.length).toBe(1);
    expect((links[0] as HTMLLinkElement).href).toBe('data:image/png;base64,updated');
  });
});
```

Note: `generateCircleFavicon` requires Canvas API which is not available in jsdom. It will be tested indirectly via hook tests that mock `favicon-utils`. The pure functions (`fnv1aHash`, `hashToHslColor`, `hashToEmoji`) and DOM manipulation (`setFavicon`) can be tested directly.

**Acceptance criteria:**
- `fnv1aHash` returns consistent uint32 hashes; different inputs produce different outputs
- `hashToHslColor` returns valid `hsl(H, 70%, 55%)` format strings
- `hashToEmoji` returns an emoji from the curated 30-item EMOJI_SET
- `generateCircleFavicon` generates a 32x32 canvas circle and returns a PNG data URI
- `setFavicon` creates or reuses the `<link rel="icon">` element
- All unit tests pass

---

### Task 2: [tab-identity] [P1] Create use-document-title hook and tests

**Status:** pending
**Depends on:** Task 1

**Description:**
Create `apps/client/src/hooks/use-document-title.ts` hook that sets `document.title` based on the working directory and optional active task form. Also create `apps/client/src/hooks/__tests__/use-document-title.test.ts`.

**Files to create:**
- `apps/client/src/hooks/use-document-title.ts`
- `apps/client/src/hooks/__tests__/use-document-title.test.ts`

**Implementation — `use-document-title.ts`:**

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
          ? activeForm.slice(0, 40) + '\u2026'
          : activeForm;
      title += ` \u2014 ${truncated}`;
    }

    title += ' \u2014 DorkOS';
    document.title = title;
  }, [cwd, activeForm]);
}
```

**Title format examples:**
- No cwd: `DorkOS`
- With cwd `/Users/test/webui`: `{emoji} webui — DorkOS`
- With task: `{emoji} webui — Running tests — DorkOS`
- Long task (50+ chars): truncated to 40 chars with ellipsis

**Tests — `use-document-title.test.ts`:**

```typescript
/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useDocumentTitle } from '../use-document-title';

describe('useDocumentTitle', () => {
  beforeEach(() => {
    document.title = '';
  });

  it('sets title with emoji and directory name', () => {
    renderHook(() => useDocumentTitle({ cwd: '/Users/test/myproject', activeForm: null }));
    expect(document.title).toMatch(/^. myproject \u2014 DorkOS$/);
  });

  it('includes activeForm in title when present', () => {
    renderHook(() => useDocumentTitle({ cwd: '/test/proj', activeForm: 'Running tests' }));
    expect(document.title).toContain('Running tests');
    expect(document.title).toContain('\u2014 DorkOS');
  });

  it('truncates long activeForm at 40 chars', () => {
    const longForm = 'A'.repeat(50);
    renderHook(() => useDocumentTitle({ cwd: '/test', activeForm: longForm }));
    expect(document.title).toContain('\u2026');
    expect(document.title.length).toBeLessThan(100);
  });

  it('falls back to default title when cwd is null', () => {
    renderHook(() => useDocumentTitle({ cwd: null, activeForm: null }));
    expect(document.title).toBe('DorkOS');
  });

  it('uses last path segment as directory name', () => {
    renderHook(() => useDocumentTitle({ cwd: '/a/b/c/deep-project', activeForm: null }));
    expect(document.title).toContain('deep-project');
    expect(document.title).not.toContain('/a/b/c');
  });
});
```

**Acceptance criteria:**
- Title shows emoji + directory basename + " — DorkOS" when cwd is set
- Title falls back to "DorkOS" when cwd is null
- Active form text is appended with em-dash separator
- Long active form text (>40 chars) is truncated with ellipsis
- All tests pass

---

### Task 3: [tab-identity] [P1] Create use-favicon hook (static only) and tests

**Status:** pending
**Depends on:** Task 1

**Description:**
Create `apps/client/src/hooks/use-favicon.ts` hook that generates and sets a colored circle favicon based on the cwd. This task implements the static favicon only (no pulsing animation — that comes in Phase 2). Also create `apps/client/src/hooks/__tests__/use-favicon.test.ts`.

**Files to create:**
- `apps/client/src/hooks/use-favicon.ts`
- `apps/client/src/hooks/__tests__/use-favicon.test.ts`

**Implementation — `use-favicon.ts` (Phase 1 — static only):**

```typescript
import { useEffect, useRef } from 'react';
import {
  hashToHslColor,
  generateCircleFavicon,
  setFavicon,
} from '@/lib/favicon-utils';

interface UseFaviconOptions {
  cwd: string | null;
  isStreaming: boolean;
}

export function useFavicon({ cwd, isStreaming }: UseFaviconOptions) {
  const solidRef = useRef<string>('');

  // Generate favicon when cwd changes
  useEffect(() => {
    if (!cwd) return;

    const color = hashToHslColor(cwd);
    const solid = generateCircleFavicon(color);
    solidRef.current = solid;
    setFavicon(solid);
  }, [cwd]);
}
```

Note: The `isStreaming` parameter is accepted but not used yet — pulsing logic is added in Task 5.

**Tests — `use-favicon.test.ts`:**

```typescript
/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useFavicon } from '../use-favicon';

vi.mock('@/lib/favicon-utils', () => ({
  hashToHslColor: vi.fn(() => 'hsl(180, 70%, 55%)'),
  generateCircleFavicon: vi.fn(() => 'data:image/png;base64,solid'),
  setFavicon: vi.fn(),
}));

import { generateCircleFavicon, setFavicon } from '@/lib/favicon-utils';

describe('useFavicon', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('generates and sets favicon when cwd is provided', () => {
    renderHook(() => useFavicon({ cwd: '/test', isStreaming: false }));
    expect(generateCircleFavicon).toHaveBeenCalledWith('hsl(180, 70%, 55%)');
    expect(setFavicon).toHaveBeenCalledWith('data:image/png;base64,solid');
  });

  it('does nothing when cwd is null', () => {
    renderHook(() => useFavicon({ cwd: null, isStreaming: false }));
    expect(generateCircleFavicon).not.toHaveBeenCalled();
  });

  it('regenerates favicon when cwd changes', () => {
    const { rerender } = renderHook(
      ({ cwd }) => useFavicon({ cwd, isStreaming: false }),
      { initialProps: { cwd: '/project-a' as string | null } },
    );
    expect(setFavicon).toHaveBeenCalledTimes(1);

    rerender({ cwd: '/project-b' });
    expect(setFavicon).toHaveBeenCalledTimes(2);
  });
});
```

**Acceptance criteria:**
- Favicon is generated and set when cwd is provided
- Favicon is not generated when cwd is null
- Favicon regenerates when cwd changes
- Hook accepts `isStreaming` param (unused in this phase)
- All tests pass

---

### Task 4: [tab-identity] [P1] Mount hooks in App.tsx, add fallback favicon to index.html, create public/favicon.png

**Status:** pending
**Depends on:** Task 2, Task 3

**Description:**
Wire `useFavicon` and `useDocumentTitle` into `App.tsx` at the root level. Add a static `<link rel="icon">` fallback to `apps/client/index.html`. Create a simple 32x32 neutral favicon PNG at `apps/client/public/favicon.png`.

**Files to modify:**
- `apps/client/src/App.tsx`
- `apps/client/index.html`

**Files to create:**
- `apps/client/public/favicon.png` (simple 32x32 PNG — can be a neutral gray circle or DorkOS-branded icon)

**Changes to `App.tsx`:**

Import the hooks and the `useDirectoryState` hook (already used in `ChatPanel`):

```typescript
import { useFavicon } from './hooks/use-favicon';
import { useDocumentTitle } from './hooks/use-document-title';
import { useDirectoryState } from './hooks/use-directory-state';
```

Inside the `App` component body, before the existing `useEffect` for escape key, add:

```typescript
const [selectedCwd] = useDirectoryState();

useFavicon({ cwd: selectedCwd, isStreaming: false });
useDocumentTitle({ cwd: selectedCwd, activeForm: null });
```

Note: In Phase 1, `isStreaming` is hardcoded to `false` and `activeForm` is hardcoded to `null`. These will be wired to real state in Phase 2 (Task 5) and Phase 3 (Task 6) respectively.

**Changes to `index.html`:**

Add inside the `<head>` section, after the viewport meta tag:

```html
<link rel="icon" type="image/png" href="/favicon.png">
```

**Creating `favicon.png`:**

Generate a simple 32x32 PNG file. This can be a neutral gray circle (matching the design system's muted color) or a simple branded icon. It serves as:
1. The default favicon before React hydrates
2. The permanent favicon for Safari (which blocks JS favicon updates)

**Acceptance criteria:**
- `useFavicon` and `useDocumentTitle` are called in `App.tsx`
- Both hooks receive `selectedCwd` from `useDirectoryState()`
- `index.html` has a `<link rel="icon">` fallback
- `public/favicon.png` exists as a 32x32 PNG
- The app loads without errors
- Tab title shows emoji + directory name when a cwd is selected
- Tab favicon shows a colored circle when a cwd is selected

---

## Phase 2: Pulsing Animation

### Task 5: [tab-identity] [P2] Add favicon pulsing animation with isStreaming store integration

**Status:** pending
**Depends on:** Task 4

**Description:**
Add `generateDimmedFavicon` to `favicon-utils.ts`, add `isStreaming` boolean to `app-store.ts`, wire `ChatPanel` to write streaming status to the store, and add pulsing logic to `use-favicon.ts`. Write tests for interval lifecycle.

**Files to modify:**
- `apps/client/src/lib/favicon-utils.ts`
- `apps/client/src/stores/app-store.ts`
- `apps/client/src/components/chat/ChatPanel.tsx`
- `apps/client/src/hooks/use-favicon.ts`
- `apps/client/src/App.tsx`

**Files to modify (tests):**
- `apps/client/src/hooks/__tests__/use-favicon.test.ts`

**1. Add `generateDimmedFavicon` to `favicon-utils.ts`:**

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

**2. Add `isStreaming` to `app-store.ts`:**

Add to the `AppState` interface:

```typescript
isStreaming: boolean;
setIsStreaming: (v: boolean) => void;
```

Add to the store initializer:

```typescript
isStreaming: false,
setIsStreaming: (v) => set({ isStreaming: v }),
```

**3. Wire `ChatPanel` to write streaming status:**

In `ChatPanel.tsx`, add a `useEffect` that syncs the chat session status to the store:

```typescript
const setIsStreaming = useAppStore((s) => s.setIsStreaming);

useEffect(() => {
  setIsStreaming(status === 'streaming');
  return () => setIsStreaming(false); // Clean up on unmount
}, [status, setIsStreaming]);
```

**4. Update `use-favicon.ts` with pulsing logic:**

Replace the Phase 1 implementation with the full version:

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

**5. Update `App.tsx` to read `isStreaming` from store:**

Change the `useFavicon` call:

```typescript
const isStreaming = useAppStore((s) => s.isStreaming);
useFavicon({ cwd: selectedCwd, isStreaming });
```

**6. Additional tests for `use-favicon.test.ts`:**

Add `generateDimmedFavicon` to the mock and add pulsing tests:

```typescript
vi.mock('@/lib/favicon-utils', () => ({
  hashToHslColor: vi.fn(() => 'hsl(180, 70%, 55%)'),
  generateCircleFavicon: vi.fn(() => 'data:image/png;base64,solid'),
  generateDimmedFavicon: vi.fn(() => Promise.resolve('data:image/png;base64,dimmed')),
  setFavicon: vi.fn(),
}));

it('cleans up interval on unmount', () => {
  const clearSpy = vi.spyOn(globalThis, 'clearInterval');
  const { unmount } = renderHook(() => useFavicon({ cwd: '/test', isStreaming: true }));
  unmount();
  expect(clearSpy).toHaveBeenCalled();
  clearSpy.mockRestore();
});

it('starts pulsing interval when streaming', async () => {
  vi.useFakeTimers();
  renderHook(() => useFavicon({ cwd: '/test', isStreaming: true }));
  await vi.advanceTimersByTimeAsync(1200);
  // setFavicon called: once for initial, then twice for pulsing (600ms intervals)
  expect(setFavicon).toHaveBeenCalledTimes(3);
  vi.useRealTimers();
});
```

**Acceptance criteria:**
- `generateDimmedFavicon` creates a dimmed version of a favicon data URI
- `app-store.ts` has `isStreaming` and `setIsStreaming`
- `ChatPanel` writes streaming status to the store via `useEffect`
- Favicon pulses (alternates solid/dimmed every 600ms) when `isStreaming` is true
- Pulsing stops and restores solid favicon when streaming ends
- Interval is cleaned up on unmount
- All new and existing tests pass

---

## Phase 3: Task Summary in Title

### Task 6: [tab-identity] [P3] Wire activeForm into document title with truncation

**Status:** pending
**Depends on:** Task 5

**Description:**
Wire `useTaskState().activeForm` into `useDocumentTitle` so the tab title shows the current task description. Since `useTaskState` requires a `sessionId` and lives in `ChatPanel`, use a Zustand atom approach: add `activeForm` to `app-store.ts`, have `ChatPanel` write it, and have `App.tsx` read it for `useDocumentTitle`.

**Files to modify:**
- `apps/client/src/stores/app-store.ts`
- `apps/client/src/components/chat/ChatPanel.tsx`
- `apps/client/src/App.tsx`

**Files to modify (tests):**
- `apps/client/src/hooks/__tests__/use-document-title.test.ts` (if additional tests needed)

**1. Add `activeForm` to `app-store.ts`:**

Add to the `AppState` interface:

```typescript
activeForm: string | null;
setActiveForm: (v: string | null) => void;
```

Add to the store initializer:

```typescript
activeForm: null,
setActiveForm: (v) => set({ activeForm: v }),
```

**2. Wire `ChatPanel` to write `activeForm` to store:**

In `ChatPanel.tsx`, add a `useEffect` that syncs the task state's `activeForm`:

```typescript
const setActiveForm = useAppStore((s) => s.setActiveForm);

useEffect(() => {
  setActiveForm(taskState.activeForm);
  return () => setActiveForm(null); // Clean up on unmount
}, [taskState.activeForm, setActiveForm]);
```

**3. Update `App.tsx` to pass `activeForm` to `useDocumentTitle`:**

```typescript
const activeForm = useAppStore((s) => s.activeForm);
useDocumentTitle({ cwd: selectedCwd, activeForm });
```

**Title format examples after this task:**
- No cwd: `DorkOS`
- With cwd: `{emoji} webui — DorkOS`
- With task: `{emoji} webui — Running tests — DorkOS`
- Long task: `{emoji} webui — AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA... — DorkOS` (truncated at 40 chars with ellipsis)

**Acceptance criteria:**
- `app-store.ts` has `activeForm` and `setActiveForm`
- `ChatPanel` writes `taskState.activeForm` to the store
- `App.tsx` passes `activeForm` from the store to `useDocumentTitle`
- Tab title shows task description when a task is in progress
- Tab title truncates task descriptions longer than 40 characters with ellipsis
- Task description is cleared from title when no task is active
- All tests pass
