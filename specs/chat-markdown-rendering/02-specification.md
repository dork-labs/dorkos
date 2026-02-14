# Chat Markdown Rendering

**Status:** Draft
**Author:** Claude Code
**Date:** 2026-02-07
**Slug:** chat-markdown-rendering
**Ideation:** `specs/chat-markdown-rendering/01-ideation.md`

---

## Overview

Integrate Vercel's Streamdown library into the DorkOS chat UI so that assistant messages render rich markdown (headers, code blocks, lists, bold, italic, tables, links, blockquotes) with syntax-highlighted code blocks, instead of displaying raw markdown text.

## Background / Problem Statement

The `StreamingText` component currently returns the raw `content` string as plain text in a `whitespace-pre-wrap` div. When Claude responds with markdown formatting, users see raw syntax (`**bold**`, `` `code` ``, `# heading`) instead of rendered HTML. This makes long, structured responses hard to read.

The component already has a placeholder comment referencing Streamdown, and the library is already installed in `node_modules`.

## Goals

- Render assistant messages as formatted markdown with syntax-highlighted code blocks
- Handle incomplete/unterminated markdown gracefully during SSE streaming
- Support light/dark mode for code block themes
- Maintain readable message width (~65ch prose default)
- Keep user messages as plain text

## Non-Goals

- Markdown preview for user input
- LaTeX/math rendering (KaTeX)
- Mermaid diagram rendering
- Custom markdown extensions beyond GFM
- `@tailwindcss/typography` plugin (Streamdown provides its own styling)

## Technical Dependencies

| Dependency | Version | Status | Purpose |
|-----------|---------|--------|---------|
| `streamdown` | latest | Installed in node_modules | Streaming markdown renderer |
| `tailwindcss` | ^4.0.0 | Installed | CSS framework |
| `@tailwindcss/vite` | ^4.0.0 | Installed | Vite plugin for Tailwind |
| `react` | ^19.0.0 | Installed | UI framework |

No new dependencies need to be installed.

## Detailed Design

### Architecture

No architectural changes. The modification is isolated to the rendering layer:

```
SSE text_delta → useChatSession (unchanged) → setMessages (unchanged)
  → MessageList (unchanged) → MessageItem (minor class changes) → StreamingText (Streamdown)
```

### File Changes

#### 1. `src/client/components/chat/StreamingText.tsx` (Primary change)

Replace the plain-text renderer with Streamdown:

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

Key details:
- Remove the `useMemo` wrapper (Streamdown handles memoization internally via block-level caching)
- Remove the `whitespace-pre-wrap` wrapper div (Streamdown renders its own wrapper)
- `parseIncompleteMarkdown` defaults to `true` - handles unterminated syntax during streaming
- `shikiTheme` takes a `[light, dark]` tuple - automatically adapts to system/app dark mode
- `children` receives the accumulated markdown string

#### 2. `src/client/components/chat/MessageItem.tsx` (Minor changes)

Two changes needed:

**a) Conditionally apply markdown styling only for assistant messages:**

```tsx
<div className={isUser ? '' : 'max-w-prose'}>
  {isUser ? (
    <div className="whitespace-pre-wrap break-words">{message.content}</div>
  ) : (
    <StreamingText content={message.content} />
  )}
</div>
```

**b) Remove the `prose` classes from the wrapper:**

The current wrapper has `prose prose-sm dark:prose-invert max-w-none`. Since:
- `@tailwindcss/typography` is not installed, `prose` classes have no effect today
- Streamdown provides its own built-in Tailwind styling for markdown elements
- We want `max-w-prose` (not `max-w-none`) for readable width

Replace the prose wrapper with a simpler container that applies `max-w-prose` for assistant messages only.

#### 3. `src/client/index.css` (Add Streamdown source scanning)

Add a `@source` directive so Tailwind v4 scans Streamdown's distribution files for utility classes:

```css
@import "tailwindcss";
@source "../node_modules/streamdown/dist/*.js";
```

This is the Tailwind v4 equivalent of adding `content` paths in `tailwind.config.js`. Without it, Streamdown's built-in Tailwind classes won't be included in the CSS output.

### What Stays the Same

- `use-chat-session.ts` - No changes. Text delta accumulation and message state management are untouched.
- `ChatPanel.tsx` - No changes.
- `MessageList.tsx` - No changes. Virtualization works the same.
- `ToolCallCard.tsx` - No changes.
- Server code - No changes.
- `package.json` - No changes (streamdown already listed).

## User Experience

**Before:** Assistant messages show raw markdown text like `**bold** and \`code\`` in a monospace-looking plain text block.

**After:** Assistant messages render as formatted HTML with:
- Styled headings (h1-h6)
- Bold, italic, strikethrough text
- Inline code and fenced code blocks with syntax highlighting
- Ordered and unordered lists
- Tables with borders
- Blockquotes
- Links (clickable)
- Horizontal rules
- Copy button on code blocks (built into Streamdown)

User messages remain plain text (matching ChatGPT/Claude.ai patterns).

During streaming, incomplete markdown renders gracefully - e.g., an unclosed code block still appears as a code block while text streams in.

## Testing Strategy

### Unit Tests

#### Update `MessageList.test.tsx`

The existing tests use `screen.getByText('Hello world')` which should still work since the text content is preserved inside Streamdown's rendered HTML. However, Streamdown needs to be mocked in tests since it has complex rendering internals.

```tsx
// Mock Streamdown to avoid complex rendering in unit tests
vi.mock('streamdown', () => ({
  Streamdown: ({ children }: { children: string }) => <div data-testid="streamdown">{children}</div>,
}));
```

**Tests to verify:**
- `renders user message content` - Should still pass (user messages are plain text, not using Streamdown)
- `renders assistant message content` - May need update to query by `data-testid="streamdown"` then check text within
- `renders multiple messages` - Should still pass
- `shows user and assistant labels` - Should still pass
- `renders tool calls within messages` - Should still pass

#### New tests for `StreamingText`

```tsx
// Purpose: Verify StreamingText passes content to Streamdown correctly
it('passes content to Streamdown component', () => {
  render(<StreamingText content="# Hello" />);
  expect(screen.getByText('# Hello')).toBeDefined(); // with mock
});

// Purpose: Verify empty content doesn't crash
it('handles empty content', () => {
  const { container } = render(<StreamingText content="" />);
  expect(container).toBeDefined();
});
```

#### New tests for MessageItem conditional rendering

```tsx
// Purpose: Verify user messages render as plain text (not markdown)
it('renders user messages as plain text', () => {
  const msg = { id: '1', role: 'user' as const, content: '**not bold**', timestamp: '' };
  render(<MessageItem message={msg} />);
  expect(screen.getByText('**not bold**')).toBeDefined();
});

// Purpose: Verify assistant messages use Streamdown
it('renders assistant messages with Streamdown', () => {
  const msg = { id: '1', role: 'assistant' as const, content: '# Heading', timestamp: '' };
  render(<MessageItem message={msg} />);
  expect(screen.getByTestId('streamdown')).toBeDefined();
});
```

### Manual Testing Checklist

- [ ] Send a message and verify assistant response renders markdown
- [ ] Verify code blocks have syntax highlighting
- [ ] Verify code blocks have a copy button
- [ ] Toggle light/dark mode and verify code block theme adapts
- [ ] Verify streaming shows formatted text progressively (no flash of raw markdown)
- [ ] Verify long messages have readable width (~65ch)
- [ ] Verify user messages remain plain text
- [ ] Verify tool call cards still render correctly alongside markdown text
- [ ] Verify virtualised scrolling still works with variable-height markdown messages
- [ ] Test with a message containing: heading, bold, code block, list, table, link, blockquote

## Performance Considerations

- **Streamdown memoization**: Streamdown internally memoizes at the block level - only changed blocks re-render when new text_delta arrives. This is O(n) vs O(n^2) for naive re-parsing.
- **CDN loading**: Streamdown v2 loads syntax highlighting languages and themes on-demand via CDN. First code block in a new language may have a brief loading delay.
- **Virtualization**: `@tanstack/react-virtual` in MessageList means off-screen messages don't render at all, mitigating any per-message rendering cost.
- **No new bundle size concern**: Streamdown is already in the dependency tree. The `@source` directive adds its Tailwind classes to the CSS output (minimal impact).

## Security Considerations

- **XSS**: Streamdown renders markdown to React elements (not `dangerouslySetInnerHTML`), providing built-in XSS protection.
- **Links**: Rendered links are clickable. Since this is an internal tool (DorkOS), the risk is minimal. If needed later, a `components` override can add `target="_blank" rel="noopener noreferrer"` to links.
- **CDN**: Streamdown v2's CDN loading for Shiki languages/themes connects to external servers. Acceptable for an online chat application.

## Documentation

- Update `CLAUDE.md` (gateway) to note markdown rendering is powered by Streamdown
- No other documentation changes needed

## Implementation Phases

### Phase 1: Core Integration (MVP)

1. Add `@source` directive to `index.css`
2. Replace `StreamingText` with Streamdown component
3. Update `MessageItem` to conditionally render plain text for user / markdown for assistant
4. Remove unused `prose` classes from MessageItem
5. Mock Streamdown in tests, verify existing tests pass
6. Add new tests for conditional rendering

### Phase 2: Polish (if needed)

1. Fine-tune `max-w-prose` behavior (ensure code blocks can overflow wider)
2. Add `target="_blank"` to rendered links via `components` prop
3. Adjust Shiki theme pair if default `github-light`/`github-dark` doesn't match the zinc palette

## Open Questions

*None - all clarifications from ideation have been resolved.*

## References

- [Streamdown GitHub](https://github.com/vercel/streamdown) - Official repository
- [Streamdown Documentation](https://streamdown.ai/) - API reference and guides
- [Streamdown Configuration](https://streamdown.ai/docs/configuration) - Props reference
- [Streamdown Styling](https://streamdown.ai/docs/styling) - Tailwind integration
- [Tailwind CSS v4 Migration](https://tailwindcss.com/blog/tailwindcss-v4) - v4 configuration changes
- [Ideation Document](./01-ideation.md) - Full discovery and research
