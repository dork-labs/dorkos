# Chat Markdown Rendering - Tasks

**Spec:** `specs/chat-markdown-rendering/02-specification.md`
**Created:** 2026-02-07
**Status:** Ready

---

## Task Summary

| # | Phase | Task | Status | Depends On |
|---|-------|------|--------|------------|
| 1 | P1 | Add Streamdown `@source` directive to `index.css` | TODO | -- |
| 2 | P1 | Replace StreamingText with Streamdown component | TODO | -- |
| 3 | P1 | Update MessageItem for conditional rendering | TODO | T2 |
| 4 | P2 | Update existing tests and add new test coverage | TODO | T1, T2, T3 |
| 5 | P3 | Update gateway CLAUDE.md documentation | TODO | T1, T2, T3 |

**Parallel opportunities:** T1 and T2 can be done in parallel. T4 and T5 can be done in parallel once P1 tasks complete.

---

## Phase 1: CSS + Component Changes

### Task 1: Add Streamdown `@source` directive to `index.css`

**File:** `src/client/index.css`

Add a `@source` directive immediately after the existing `@import "tailwindcss"` line so that Tailwind v4 scans Streamdown's distribution files for utility classes. Without this, Streamdown's built-in Tailwind classes will not be included in the CSS output.

**Current state (line 1):**

```css
@import "tailwindcss";
```

**Target state:**

```css
@import "tailwindcss";
@source "../node_modules/streamdown/dist/*.js";
```

This is the Tailwind v4 equivalent of adding `content` paths in `tailwind.config.js`. The `@source` directive tells Tailwind to scan the specified glob for class names to include in its generated output.

**Acceptance criteria:**
- `@source "../node_modules/streamdown/dist/*.js";` appears on the line immediately after `@import "tailwindcss";`
- No other lines in `index.css` are changed
- Vite dev server starts without errors

---

### Task 2: Replace StreamingText with Streamdown component

**File:** `src/client/components/chat/StreamingText.tsx`

Replace the entire file contents. The current implementation is a plain-text renderer with a `useMemo` wrapper and `whitespace-pre-wrap` div. Replace it with the Streamdown component.

**Current file:**

```tsx
import { useMemo } from 'react';

interface StreamingTextProps {
  content: string;
}

export function StreamingText({ content }: StreamingTextProps) {
  const rendered = useMemo(() => {
    // Basic text rendering for initial implementation
    // Will be enhanced with Streamdown library integration for
    // O(n) incremental markdown parsing with memoized blocks
    return content;
  }, [content]);

  return (
    <div className="whitespace-pre-wrap break-words">
      {rendered}
    </div>
  );
}
```

**Target file:**

```tsx
import { Streamdown } from 'streamdown';

interface StreamingTextProps {
  content: string;
}

export function StreamingText({ content }: StreamingTextProps) {
  return (
    <Streamdown
      shikiTheme={['github-light', 'github-dark']}
    >
      {content}
    </Streamdown>
  );
}
```

**Key details:**
- Remove the `useMemo` import and wrapper -- Streamdown handles memoization internally via block-level caching
- Remove the `whitespace-pre-wrap break-words` wrapper div -- Streamdown renders its own wrapper
- `parseIncompleteMarkdown` defaults to `true` so unterminated syntax during streaming is handled automatically
- `shikiTheme` takes a `[light, dark]` tuple that automatically adapts to system/app dark mode
- `children` receives the accumulated markdown string

**Acceptance criteria:**
- File imports `Streamdown` from `'streamdown'`
- No `useMemo` import remains
- No wrapper `div` with `whitespace-pre-wrap` remains
- `shikiTheme` is set to `['github-light', 'github-dark']`
- Component still exports `StreamingText` with the same `{ content: string }` prop interface

---

### Task 3: Update MessageItem for conditional rendering

**File:** `src/client/components/chat/MessageItem.tsx`

Two changes:

**Change A -- Remove `prose` classes from the wrapper div:**

The current wrapper on line 30 is:

```tsx
<div className="prose prose-sm dark:prose-invert max-w-none">
```

Since `@tailwindcss/typography` is not installed, the `prose` classes have no effect. Streamdown provides its own built-in Tailwind styling. Replace with a conditional class that applies `max-w-prose` only for assistant messages.

**Change B -- Conditionally render plain text for user messages and Streamdown for assistant messages:**

The current rendering (line 31) always passes through `StreamingText`:

```tsx
<StreamingText content={message.content} />
```

User messages should remain plain text. Only assistant messages should use `StreamingText` (which now renders via Streamdown).

**Current lines 30-32:**

```tsx
        <div className="prose prose-sm dark:prose-invert max-w-none">
          <StreamingText content={message.content} />
        </div>
```

**Target lines 30-35:**

```tsx
        <div className={isUser ? '' : 'max-w-prose'}>
          {isUser ? (
            <div className="whitespace-pre-wrap break-words">{message.content}</div>
          ) : (
            <StreamingText content={message.content} />
          )}
        </div>
```

**Acceptance criteria:**
- No `prose`, `prose-sm`, or `dark:prose-invert` classes remain in the file
- `max-w-none` is replaced with conditional `max-w-prose` (assistant only)
- User messages render as plain text in a `whitespace-pre-wrap break-words` div
- Assistant messages render via `<StreamingText>`
- The `isUser` variable (already defined on line 11) is reused

---

## Phase 2: Test Updates

### Task 4: Update existing tests and add new test coverage

**Depends on:** T1, T2, T3

Three sub-tasks, all in the test layer.

#### 4a. Add Streamdown mock to `MessageList.test.tsx`

**File:** `src/client/components/chat/__tests__/MessageList.test.tsx`

Add a `vi.mock('streamdown')` call after the existing `vi.mock('@tanstack/react-virtual')` block (after line 25). This prevents Streamdown's complex rendering internals from running in tests.

**Mock to add:**

```tsx
// Mock Streamdown to avoid complex rendering in unit tests
vi.mock('streamdown', () => ({
  Streamdown: ({ children }: { children: string }) => <div data-testid="streamdown">{children}</div>,
}));
```

**Verify all 5 existing tests still pass:**
- `renders empty list without error` -- no messages, unaffected
- `renders user message content` -- user messages now render as plain text (not through StreamingText/Streamdown), so `screen.getByText('Hello world')` should still find the text
- `renders assistant message content` -- assistant messages now render through mocked Streamdown which outputs the text in a `div`, so `screen.getByText('Hi there, how can I help?')` should still find the text
- `renders multiple messages` -- combination of user and assistant, both text lookups should still work
- `shows user and assistant labels` -- labels are outside the content div, unaffected
- `renders tool calls within messages` -- tool calls are outside the content div, unaffected

Run with: `npx vitest run src/client/components/chat/__tests__/MessageList.test.tsx`

#### 4b. Create `StreamingText.test.tsx`

**File:** `src/client/components/chat/__tests__/StreamingText.test.tsx` (new file)

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { StreamingText } from '../StreamingText';

afterEach(() => {
  cleanup();
});

// Mock Streamdown to avoid complex rendering in unit tests
vi.mock('streamdown', () => ({
  Streamdown: ({ children }: { children: string }) => <div data-testid="streamdown">{children}</div>,
}));

describe('StreamingText', () => {
  it('passes content to Streamdown component', () => {
    render(<StreamingText content="# Hello" />);
    expect(screen.getByTestId('streamdown')).toBeDefined();
    expect(screen.getByText('# Hello')).toBeDefined();
  });

  it('handles empty content', () => {
    const { container } = render(<StreamingText content="" />);
    expect(container).toBeDefined();
    expect(screen.getByTestId('streamdown')).toBeDefined();
  });

  it('passes markdown content through unchanged', () => {
    render(<StreamingText content="**bold** and `code`" />);
    expect(screen.getByText('**bold** and `code`')).toBeDefined();
  });
});
```

Run with: `npx vitest run src/client/components/chat/__tests__/StreamingText.test.tsx`

#### 4c. Create `MessageItem.test.tsx`

**File:** `src/client/components/chat/__tests__/MessageItem.test.tsx` (new file)

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MessageItem } from '../MessageItem';

afterEach(() => {
  cleanup();
});

// Mock Streamdown to avoid complex rendering in unit tests
vi.mock('streamdown', () => ({
  Streamdown: ({ children }: { children: string }) => <div data-testid="streamdown">{children}</div>,
}));

describe('MessageItem', () => {
  it('renders user messages as plain text', () => {
    const msg = { id: '1', role: 'user' as const, content: '**not bold**', timestamp: new Date().toISOString() };
    render(<MessageItem message={msg} />);
    // User messages should show raw markdown syntax, not rendered
    expect(screen.getByText('**not bold**')).toBeDefined();
    // Should NOT use Streamdown for user messages
    expect(screen.queryByTestId('streamdown')).toBeNull();
  });

  it('renders assistant messages with Streamdown', () => {
    const msg = { id: '1', role: 'assistant' as const, content: '# Heading', timestamp: new Date().toISOString() };
    render(<MessageItem message={msg} />);
    // Assistant messages should use Streamdown
    expect(screen.getByTestId('streamdown')).toBeDefined();
    expect(screen.getByText('# Heading')).toBeDefined();
  });

  it('shows correct label for user messages', () => {
    const msg = { id: '1', role: 'user' as const, content: 'Test', timestamp: new Date().toISOString() };
    render(<MessageItem message={msg} />);
    expect(screen.getByText('You')).toBeDefined();
  });

  it('shows correct label for assistant messages', () => {
    const msg = { id: '1', role: 'assistant' as const, content: 'Reply', timestamp: new Date().toISOString() };
    render(<MessageItem message={msg} />);
    expect(screen.getByText('Claude')).toBeDefined();
  });

  it('renders tool calls for assistant messages', () => {
    const msg = {
      id: '1',
      role: 'assistant' as const,
      content: 'Let me check.',
      toolCalls: [
        { toolCallId: 'tc-1', toolName: 'Read', input: '{}', status: 'complete' as const },
      ],
      timestamp: new Date().toISOString(),
    };
    render(<MessageItem message={msg} />);
    expect(screen.getByText('Read')).toBeDefined();
  });
});
```

Run with: `npx vitest run src/client/components/chat/__tests__/MessageItem.test.tsx`

**Final verification:** Run all tests together:

```bash
npx vitest run src/client/components/chat/__tests__/
```

**Acceptance criteria:**
- All 5 existing `MessageList.test.tsx` tests pass with the Streamdown mock
- All 3 new `StreamingText.test.tsx` tests pass
- All 5 new `MessageItem.test.tsx` tests pass
- No test regressions in the full suite (`npm run test:run`)

---

## Phase 3: Documentation

### Task 5: Update gateway CLAUDE.md documentation

**Depends on:** T1, T2, T3

**File:** `CLAUDE.md` (repository root)

Add a note about markdown rendering in the Client architecture section. After the existing bullet about Components, add a bullet about markdown rendering.

Find this section:

```
- **Components**: `ChatPanel` > `MessageList` > `MessageItem` + `ToolCallCard`; `SessionSidebar`; `CommandPalette` (cmdk); `PermissionBanner` + `ToolApproval` for tool approval flow
```

Add after it:

```
- **Markdown Rendering**: Assistant messages are rendered as rich markdown via the `streamdown` library (Vercel). `StreamingText` wraps the `<Streamdown>` component with `github-light`/`github-dark` Shiki themes. User messages remain plain text. The `@source` directive in `index.css` ensures Streamdown's Tailwind classes are included in the CSS output.
```

**Acceptance criteria:**
- New bullet appears in the Client section of `CLAUDE.md`
- Mentions `streamdown`, Shiki themes, user vs assistant distinction, and the `@source` directive
- No other sections of `CLAUDE.md` are changed

---

## Execution Notes

### Recommended execution order:

1. **T1 + T2** in parallel (no dependencies between them)
2. **T3** after T2 (uses the updated `StreamingText` component)
3. **T4 + T5** in parallel after T1+T2+T3 are complete

### Total changes:

- **3 files modified:** `index.css`, `StreamingText.tsx`, `MessageItem.tsx`
- **2 files created:** `StreamingText.test.tsx`, `MessageItem.test.tsx`
- **1 file updated:** `CLAUDE.md` (one new bullet)
- **0 dependencies added** (streamdown already installed)

### Verification commands:

```bash
# Dev server starts cleanly
npm run dev

# All tests pass
npm run test:run

# Specific test files
npx vitest run src/client/components/chat/__tests__/MessageList.test.tsx
npx vitest run src/client/components/chat/__tests__/StreamingText.test.tsx
npx vitest run src/client/components/chat/__tests__/MessageItem.test.tsx
```
