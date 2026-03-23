# Tool Call Display Overhaul

**Status:** Draft
**Authors:** Claude Code, 2026-03-23
**Spec Number:** 169
**Ideation:** `specs/tool-call-display-overhaul/01-ideation.md`

---

## Overview

Overhaul the tool call display in the DorkOS chat UI to fix three bugs and add two enhancements. The changes make tool calls a first-class observability surface — genuinely informative during streaming and beautifully formatted after completion.

**Bug fixes:**

1. MCP tool calls show raw names like `mcp__slack__send_message` instead of humanized labels
2. Expanded tool cards show an empty body during SSE streaming (no content until tool completes)
3. Partial JSON input displays as garbled text during streaming

**Enhancements:** 4. Content-type classified output rendering (JSON tree, ANSI terminal colors, Edit diffs) 5. Execution duration display on completed tool cards

## Background / Problem Statement

Tool call cards are the primary observability surface for agent activity in DorkOS. When a user watches an agent work, they see a sequence of tool calls — reading files, running commands, editing code. The current implementation has three bugs that undermine trust and utility:

**MCP name rendering is broken.** The Anthropic SDK convention uses `mcp__<server>__<tool>` format for MCP tool names. Our `getToolLabel()` function has explicit handling for 15 SDK tools (Bash, Read, Write, etc.) but the `default` case returns the raw tool name unchanged. As MCP adoption grows (external tools, DorkOS's own MCP server), users increasingly see cryptic names.

**Tool card bodies are empty during streaming.** When `expandToolCalls` is enabled or the user manually expands a card during streaming, they see nothing. Three factors combine: `handleToolCallStart` initializes input as `''` (falsy), `ToolCallCard` guards with `{toolCall.input && ...}` (truthiness check), and neither `progressOutput` nor `result` exist yet. The entire card body renders nothing.

**Partial JSON shows garbled text.** During streaming, `ToolArgumentsDisplay` receives partial JSON like `'{"command":"ls'`, attempts `JSON.parse`, fails, and falls back to a raw `<pre>` tag showing truncated JSON fragments. This is confusing — users see broken syntax that looks like an error.

Additionally, tool outputs currently render as plain monospace text regardless of content type. JSON responses from MCP tools, ANSI-colored terminal output from Bash, and diff results from Edit all get the same treatment.

## Goals

- Fix MCP tool name display with badge + humanized name format
- Fix empty tool card body during SSE streaming with streaming-aware rendering
- Fix partial JSON garbled display by deferring formatted rendering until input is complete
- Add content-type classified output rendering (JSON tree, ANSI styled, unified diff)
- Add execution duration display on completed tool cards
- Maintain backward compatibility with auto-hide, truncation, hook display, and interactive tool calls

## Non-Goals

- Server-side changes to the SDK event mapper or SSE protocol
- Tool call grouping (5+ sequential calls collapsed into a summary)
- Syntax highlighting for file content via Shiki
- Clickable file paths in tool results
- Virtual scrolling for large outputs
- Persisting hooks or progress data in server-side transcripts (JSONL)
- Changes to the CollapsibleCard accordion primitive

## Technical Dependencies

### New Libraries

| Library                       | Version | Size                                            | React 19         | Purpose                                               |
| ----------------------------- | ------- | ----------------------------------------------- | ---------------- | ----------------------------------------------------- |
| `react-json-view-lite`        | ^2.0.0  | ~8KB gzip, zero deps                            | React 18+        | JSON tree viewer for tool inputs/outputs              |
| `ansi-to-react`               | ^6.0.10 | ~15KB, deps: anser, escape-carriage, linkify-it | `^19.0.0` peer   | ANSI escape code rendering for Bash output            |
| `react-diff-viewer-continued` | ^4.2.0  | ~1.08MB, deps: @emotion/css, diff               | `^19.0.0` peer   | Unified diff rendering for Edit results (lazy-loaded) |
| `ansi-regex`                  | ^6.0.0  | ~1KB                                            | N/A (pure regex) | ANSI escape code detection for content classifier     |

All libraries support React 19 and have TypeScript types bundled.

### Existing Dependencies (no version changes)

- `motion/react` ^12.33.0 — AnimatePresence, motion.div (CollapsibleCard animations)
- `lucide-react` — Check, X, Loader2, ChevronDown, Clock icons
- `tailwindcss` ^4.0.0 — Styling

## Detailed Design

### 1. MCP Tool Name Parsing (`tool-labels.ts`)

Add MCP name detection before the `default` case in `getToolLabel()`.

**Parsing logic:**

```typescript
/** Known MCP server display name overrides. */
const MCP_SERVER_LABELS: Record<string, string> = {
  dorkos: 'DorkOS',
  slack: 'Slack',
  telegram: 'Telegram',
  github: 'GitHub',
  filesystem: 'Files',
  playwright: 'Browser',
  context7: 'Context7',
};

/** Parse an MCP tool name into server + tool components. */
export function parseMcpToolName(toolName: string): {
  server: string;
  serverLabel: string;
  tool: string;
  toolLabel: string;
} | null {
  if (!toolName.startsWith('mcp__')) return null;
  const parts = toolName.split('__');
  if (parts.length < 3) return null;
  const server = parts[1];
  const tool = parts.slice(2).join('__'); // Handle tools with __ in name
  const serverLabel = MCP_SERVER_LABELS[server] ?? humanizeSnakeCase(server);
  const toolLabel = humanizeSnakeCase(tool);
  return { server, serverLabel, tool, toolLabel };
}

/** Convert snake_case to Title Case. */
function humanizeSnakeCase(s: string): string {
  return s
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}
```

**Integration into `getToolLabel()`:**

```typescript
export function getToolLabel(toolName: string, input: string): string {
  // ... existing JSON parse ...

  switch (toolName) {
    // ... 15 existing cases ...
    default: {
      const mcp = parseMcpToolName(toolName);
      if (mcp) return mcp.toolLabel;
      return toolName;
    }
  }
}
```

**New export — `getMcpServerBadge()`:**

```typescript
/** Return the MCP server badge label, or null for non-MCP / DorkOS tools. */
export function getMcpServerBadge(toolName: string): string | null {
  const mcp = parseMcpToolName(toolName);
  if (!mcp) return null;
  // Hide badge for DorkOS's own tools — implicit context
  if (mcp.server === 'dorkos') return null;
  return mcp.serverLabel;
}
```

**Rendering in ToolCallCard header:**

```tsx
const badge = getMcpServerBadge(toolCall.toolName);
// In the header:
<>
  {getToolStatusIcon(toolCall.status)}
  {badge && (
    <span className="bg-muted text-muted-foreground text-3xs rounded px-1 py-0.5 font-medium">
      {badge}
    </span>
  )}
  <span className="text-3xs font-mono">{getToolLabel(toolCall.toolName, toolCall.input)}</span>
</>;
```

### 2. Streaming Display Fix (`ToolCallCard.tsx` + `tool-arguments-formatter.tsx`)

#### 2a. Fix the falsy input check

**Before (buggy):**

```tsx
{
  toolCall.input && <ToolArgumentsDisplay toolName={toolCall.toolName} input={toolCall.input} />;
}
```

**After (fixed):**

```tsx
{
  toolCall.status === 'running' && !toolCall.input ? (
    <div className="text-muted-foreground flex items-center gap-1.5 py-1 text-xs">
      <Loader2 className="size-3 animate-spin" />
      <span>Preparing...</span>
    </div>
  ) : toolCall.input !== undefined && toolCall.input !== '' ? (
    <ToolArgumentsDisplay
      toolName={toolCall.toolName}
      input={toolCall.input}
      isStreaming={toolCall.status === 'running'}
    />
  ) : null;
}
```

This ensures:

- Between `tool_call_start` and first `tool_call_delta`: shows "Preparing..." with spinner
- During streaming with partial input: passes `isStreaming=true` to ToolArgumentsDisplay
- After completion: renders formatted display

#### 2b. Streaming-aware ToolArgumentsDisplay

Add `isStreaming` prop to `ToolArgumentsDisplay`:

```typescript
interface ToolArgumentsDisplayProps {
  toolName: string;
  input: string;
  isStreaming?: boolean;
}
```

**Rendering logic:**

```tsx
export function ToolArgumentsDisplay({
  toolName: _toolName,
  input,
  isStreaming = false,
}: ToolArgumentsDisplayProps) {
  if (!input) return null;

  // During streaming, show raw accumulating text — don't try to parse
  if (isStreaming) {
    const displayInput = input.length > 5120 ? input.slice(0, 5120) + '\u2026' : input;
    return (
      <pre className="text-muted-foreground overflow-x-auto text-xs whitespace-pre-wrap">
        {displayInput}
        <span className="ml-0.5 inline-block size-1.5 animate-pulse rounded-full bg-current" />
      </pre>
    );
  }

  // After completion, attempt structured rendering
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(input);
  } catch {
    const displayInput = input.length > 5120 ? input.slice(0, 5120) + '\u2026' : input;
    return <pre className="overflow-x-auto text-xs whitespace-pre-wrap">{displayInput}</pre>;
  }

  // ... existing key-value grid rendering (unchanged) ...
}
```

### 3. Execution Duration Tracking

#### 3a. Type changes (`chat-types.ts`)

Add two optional fields to `ToolCallState`:

```typescript
export interface ToolCallState {
  // ... existing fields ...
  /** Timestamp (ms since epoch) when tool_call_start was received. */
  startedAt?: number;
  /** Timestamp (ms since epoch) when tool_result was received. */
  completedAt?: number;
}
```

#### 3b. Stream handler changes (`stream-tool-handlers.ts`)

In `handleToolCallStart`:

```typescript
helpers.currentPartsRef.current.push({
  type: 'tool_call',
  toolCallId: tc.toolCallId,
  toolName: tc.toolName,
  input: '',
  status: 'running',
  startedAt: Date.now(),
  ...(buffered && buffered.length > 0 ? { hooks: buffered } : {}),
});
```

In `handleToolResult`:

```typescript
if (existing) {
  existing.result = tc.result;
  existing.status = 'complete';
  existing.completedAt = Date.now();
  existing.progressOutput = undefined;
  // ... rest unchanged ...
}
```

#### 3c. Duration formatter (`shared/lib`)

New utility in `apps/client/src/layers/shared/lib/format-duration.ts`:

```typescript
/** Format a duration in ms using tiered display: 347ms / 1.2s / 14s / 1m 23s */
export function formatDuration(ms: number): string {
  if (ms < 100) return '<100ms';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}
```

#### 3d. Duration badge in ToolCallCard header

```tsx
const duration =
  toolCall.startedAt && toolCall.completedAt
    ? toolCall.completedAt - toolCall.startedAt
    : undefined;

// In header, after status icon and label:
{
  duration !== undefined && (
    <span className="text-muted-foreground text-3xs ml-auto tabular-nums">
      {formatDuration(duration)}
    </span>
  );
}
```

### 4. Content-Type Classified Output Rendering

#### 4a. Content classifier utility

New utility in `apps/client/src/layers/shared/lib/classify-content.ts`:

```typescript
import ansiRegex from 'ansi-regex';

export type ContentType = 'json' | 'ansi' | 'plain';

const ANSI_PATTERN = ansiRegex();

/** Classify a string as JSON, ANSI-colored, or plain text. */
export function classifyContent(content: string): ContentType {
  // Check for ANSI escape codes first (most specific signal)
  if (ANSI_PATTERN.test(content)) return 'ansi';

  // Try JSON parse — only valid complete JSON objects/arrays
  const trimmed = content.trimStart();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      JSON.parse(content);
      return 'json';
    } catch {
      // Partial or invalid JSON — treat as plain
    }
  }

  return 'plain';
}
```

#### 4b. Output renderer component

New component in `apps/client/src/layers/features/chat/ui/OutputRenderer.tsx`:

```tsx
import { lazy, Suspense, useState } from 'react';
import { classifyContent, type ContentType } from '@/layers/shared/lib';
import { JsonView, darkStyles, collapseAllNested } from 'react-json-view-lite';
import 'react-json-view-lite/dist/index.css';
import Ansi from 'ansi-to-react';

const DiffViewer = lazy(() => import('react-diff-viewer-continued'));

/** Maximum characters to render before truncation (5KB). */
const TRUNCATE_THRESHOLD = 5120;

interface OutputRendererProps {
  content: string;
  toolName: string;
  /** Tool input JSON — used by Edit tool to extract old_string for diff. */
  input?: string;
}

/** Render tool output with content-type-appropriate formatting. */
export function OutputRenderer({ content, toolName, input }: OutputRendererProps) {
  const [showFull, setShowFull] = useState(false);
  const [showRaw, setShowRaw] = useState(false);
  const isTruncated = content.length > TRUNCATE_THRESHOLD;
  const displayContent = isTruncated && !showFull ? content.slice(0, TRUNCATE_THRESHOLD) : content;

  // Edit tool: show diff if we have old_string and new_string in the input
  if (toolName === 'Edit' && input) {
    return <EditDiffOutput content={displayContent} input={input} />;
  }

  const contentType = classifyContent(displayContent);

  // Allow toggle between formatted and raw
  if (showRaw || contentType === 'plain') {
    return (
      <OutputWrapper
        isTruncated={isTruncated}
        showFull={showFull}
        onShowFull={() => setShowFull(true)}
        totalLength={content.length}
        showRaw={showRaw}
        onToggleRaw={contentType !== 'plain' ? () => setShowRaw(false) : undefined}
      >
        <pre className="max-h-48 overflow-y-auto text-xs whitespace-pre-wrap">{displayContent}</pre>
      </OutputWrapper>
    );
  }

  if (contentType === 'json') {
    try {
      const parsed = JSON.parse(displayContent);
      return (
        <OutputWrapper
          isTruncated={isTruncated}
          showFull={showFull}
          onShowFull={() => setShowFull(true)}
          totalLength={content.length}
          onToggleRaw={() => setShowRaw(true)}
        >
          <div className="max-h-48 overflow-y-auto text-xs">
            <JsonView data={parsed} shouldExpandNode={collapseAllNested} style={darkStyles} />
          </div>
        </OutputWrapper>
      );
    } catch {
      // Fallback to plain
    }
  }

  if (contentType === 'ansi') {
    return (
      <OutputWrapper
        isTruncated={isTruncated}
        showFull={showFull}
        onShowFull={() => setShowFull(true)}
        totalLength={content.length}
        onToggleRaw={() => setShowRaw(true)}
      >
        <div className="max-h-48 overflow-y-auto font-mono text-xs">
          <Ansi>{displayContent}</Ansi>
        </div>
      </OutputWrapper>
    );
  }

  // Fallback: plain text
  return (
    <OutputWrapper
      isTruncated={isTruncated}
      showFull={showFull}
      onShowFull={() => setShowFull(true)}
      totalLength={content.length}
    >
      <pre className="max-h-48 overflow-y-auto text-xs whitespace-pre-wrap">{displayContent}</pre>
    </OutputWrapper>
  );
}
```

**OutputWrapper** handles truncation and raw toggle consistently:

```tsx
function OutputWrapper({
  children,
  isTruncated,
  showFull,
  onShowFull,
  totalLength,
  showRaw,
  onToggleRaw,
}: {
  children: React.ReactNode;
  isTruncated: boolean;
  showFull: boolean;
  onShowFull: () => void;
  totalLength: number;
  showRaw?: boolean;
  onToggleRaw?: () => void;
}) {
  return (
    <div className="mt-2 border-t pt-2">
      {children}
      <div className="mt-1 flex items-center gap-2">
        {isTruncated && !showFull && (
          <button
            onClick={onShowFull}
            className="text-muted-foreground hover:text-foreground text-xs underline"
          >
            Show full output ({(totalLength / 1024).toFixed(1)}KB)
          </button>
        )}
        {onToggleRaw && (
          <button
            onClick={onToggleRaw}
            className="text-muted-foreground hover:text-foreground text-xs underline"
          >
            {showRaw ? 'Formatted' : 'Raw'}
          </button>
        )}
      </div>
    </div>
  );
}
```

**EditDiffOutput** — lazy-loaded diff viewer for Edit tool results:

```tsx
function EditDiffOutput({ content, input }: { content: string; input: string }) {
  let oldString = '';
  let newString = '';
  try {
    const parsed = JSON.parse(input);
    oldString = typeof parsed.old_string === 'string' ? parsed.old_string : '';
    newString = typeof parsed.new_string === 'string' ? parsed.new_string : '';
  } catch {
    // Can't extract diff — fall back to plain text
    return (
      <div className="mt-2 border-t pt-2">
        <pre className="max-h-48 overflow-y-auto text-xs whitespace-pre-wrap">{content}</pre>
      </div>
    );
  }

  if (!oldString && !newString) {
    return (
      <div className="mt-2 border-t pt-2">
        <pre className="max-h-48 overflow-y-auto text-xs whitespace-pre-wrap">{content}</pre>
      </div>
    );
  }

  return (
    <div className="mt-2 border-t pt-2">
      <Suspense
        fallback={
          <pre className="max-h-48 overflow-y-auto text-xs whitespace-pre-wrap">{content}</pre>
        }
      >
        <div className="max-h-48 overflow-y-auto text-xs">
          <DiffViewer
            oldValue={oldString}
            newValue={newString}
            splitView={false}
            useDarkTheme
            hideLineNumbers
            showDiffOnly
            extraLinesSurroundingDiff={2}
          />
        </div>
      </Suspense>
    </div>
  );
}
```

#### 4c. Integration into ToolCallCard

Replace the existing result rendering in `ToolCallCard.tsx`:

**Before:**

```tsx
{
  toolCall.progressOutput && !toolCall.result && (
    <TruncatedOutput content={toolCall.progressOutput} />
  );
}
{
  toolCall.result && <TruncatedOutput content={toolCall.result} />;
}
```

**After:**

```tsx
{
  toolCall.progressOutput && !toolCall.result && (
    <TruncatedOutput content={toolCall.progressOutput} />
  );
}
{
  toolCall.result && (
    <OutputRenderer content={toolCall.result} toolName={toolCall.toolName} input={toolCall.input} />
  );
}
```

`TruncatedOutput` remains for `progressOutput` (which is always plain text from `tool_progress` events). `OutputRenderer` replaces `TruncatedOutput` for final `result` only.

### 5. File Organization

All changes stay within the existing FSD layer structure:

```
apps/client/src/layers/
├── shared/lib/
│   ├── tool-labels.ts              ← MODIFIED (MCP parsing)
│   ├── tool-arguments-formatter.tsx ← MODIFIED (streaming-aware)
│   ├── format-duration.ts          ← NEW
│   ├── classify-content.ts         ← NEW
│   └── index.ts                    ← MODIFIED (new exports)
├── features/chat/
│   ├── model/
│   │   ├── chat-types.ts           ← MODIFIED (startedAt/completedAt)
│   │   └── stream-tool-handlers.ts ← MODIFIED (timestamps)
│   └── ui/
│       ├── ToolCallCard.tsx         ← MODIFIED (header badge, duration, body fix)
│       └── OutputRenderer.tsx       ← NEW
```

**FSD compliance:** `OutputRenderer` lives in `features/chat/ui/` because it imports from `shared/lib` (classify-content, format-duration) — unidirectional ✓. The new shared utilities (`format-duration.ts`, `classify-content.ts`) have no layer imports — base layer ✓.

### 6. Data Model Changes

Only `ToolCallState` interface gains two optional fields (`startedAt`, `completedAt`). No server-side type changes. No database changes. No API changes.

The `MessagePart` type from `@dorkos/shared/types` is not modified — the timestamps are client-only state tracked during streaming. Historical tool calls loaded from transcripts will have `undefined` timestamps (no duration shown), which is correct behavior since we don't have the timing data.

## User Experience

### Before (current state)

1. User starts a chat, agent begins using tools
2. MCP tool calls show raw names: `mcp__slack__send_message`
3. User expands a running tool card → sees empty white space
4. Partial JSON flashes in garbled form during streaming
5. Tool results are always plain monospace text regardless of content
6. No indication of how long a tool call took

### After (this spec)

1. User starts a chat, agent begins using tools
2. MCP tool calls show `[Slack] Send message` with server badge
3. User expands a running tool card → sees "Preparing..." with spinner, then raw accumulating input with a subtle pulse dot
4. Once tool completes, input switches to clean key-value grid
5. Tool results render context-appropriately:
   - JSON responses show as collapsible tree (expand/collapse nodes)
   - Bash output preserves ANSI colors (green for success, red for errors)
   - Edit results show unified diff (old → new, inline)
   - All outputs have a "Raw" toggle button
6. Completed cards show duration: "1.2s" in the header

### Edge Cases

- **Empty input tools** (e.g., `TaskList`): No body content, no "Preparing..." — these complete near-instantly
- **Very large JSON outputs** (>5KB): Truncated first, then JSON tree renders on the truncated portion; "Show full output" expands before tree rendering
- **Non-JSON, non-ANSI outputs**: Fall through to plain text (existing `TruncatedOutput` behavior)
- **History tool calls** (from transcript): No duration display (timestamps are client-only streaming state). All inputs/outputs are complete, so no streaming state issues.
- **Interactive tool calls** (approval/question): Not affected — they have their own rendering path via `interactiveType`

## Testing Strategy

### Unit Tests

**`tool-labels.test.ts`** — Add MCP parsing test cases:

```typescript
describe('MCP tool name parsing', () => {
  it('humanizes mcp__slack__send_message → "Send message"', () => {
    expect(getToolLabel('mcp__slack__send_message', '{}')).toBe('Send message');
  });

  it('humanizes mcp__dorkos__relay_send → "Relay send"', () => {
    expect(getToolLabel('mcp__dorkos__relay_send', '{}')).toBe('Relay send');
  });

  it('returns raw name for non-MCP unknown tools', () => {
    expect(getToolLabel('UnknownTool', '{}')).toBe('UnknownTool');
  });
});

describe('getMcpServerBadge', () => {
  it('returns "Slack" for mcp__slack__send_message', () => {
    expect(getMcpServerBadge('mcp__slack__send_message')).toBe('Slack');
  });

  it('returns null for mcp__dorkos__ tools (implicit context)', () => {
    expect(getMcpServerBadge('mcp__dorkos__relay_send')).toBeNull();
  });

  it('returns null for non-MCP tools', () => {
    expect(getMcpServerBadge('Bash')).toBeNull();
  });

  it('humanizes unknown server names', () => {
    expect(getMcpServerBadge('mcp__custom_server__do_thing')).toBe('Custom Server');
  });
});

describe('parseMcpToolName', () => {
  it('handles tools with double underscores in tool name', () => {
    const result = parseMcpToolName('mcp__server__tool__with__underscores');
    expect(result?.tool).toBe('tool__with__underscores');
  });

  it('returns null for non-mcp names', () => {
    expect(parseMcpToolName('Bash')).toBeNull();
  });

  it('returns null for malformed mcp names', () => {
    expect(parseMcpToolName('mcp__')).toBeNull();
    expect(parseMcpToolName('mcp__server')).toBeNull();
  });
});
```

**`format-duration.test.ts`** — New test file:

```typescript
describe('formatDuration', () => {
  it('shows <100ms for very fast calls', () => {
    expect(formatDuration(50)).toBe('<100ms');
  });

  it('shows milliseconds for sub-second calls', () => {
    expect(formatDuration(347)).toBe('347ms');
  });

  it('shows one decimal for 1-10 second calls', () => {
    expect(formatDuration(1234)).toBe('1.2s');
  });

  it('shows whole seconds for 10-60 second calls', () => {
    expect(formatDuration(14_200)).toBe('14s');
  });

  it('shows minutes and seconds for 60+ second calls', () => {
    expect(formatDuration(83_000)).toBe('1m 23s');
  });
});
```

**`classify-content.test.ts`** — New test file:

```typescript
describe('classifyContent', () => {
  it('detects valid JSON objects', () => {
    expect(classifyContent('{"key":"value"}')).toBe('json');
  });

  it('detects valid JSON arrays', () => {
    expect(classifyContent('[1, 2, 3]')).toBe('json');
  });

  it('detects ANSI escape codes', () => {
    expect(classifyContent('\x1b[32mSuccess\x1b[0m')).toBe('ansi');
  });

  it('returns plain for regular text', () => {
    expect(classifyContent('Hello world')).toBe('plain');
  });

  it('returns plain for partial/invalid JSON', () => {
    expect(classifyContent('{"command":"ls')).toBe('plain');
  });

  it('prioritizes ANSI over JSON when both present', () => {
    expect(classifyContent('\x1b[32m{"key":"value"}\x1b[0m')).toBe('ansi');
  });
});
```

**`tool-arguments-formatter.test.tsx`** — New test file:

```typescript
describe('ToolArgumentsDisplay', () => {
  it('shows raw text with pulse indicator during streaming', () => {
    render(<ToolArgumentsDisplay toolName="Bash" input='{"comm' isStreaming />);
    expect(screen.getByText(/\{"comm/)).toBeInTheDocument();
  });

  it('shows formatted key-value grid after completion', () => {
    render(
      <ToolArgumentsDisplay
        toolName="Bash"
        input='{"command":"ls -la"}'
        isStreaming={false}
      />
    );
    expect(screen.getByText('Command')).toBeInTheDocument();
    expect(screen.getByText('ls -la')).toBeInTheDocument();
  });

  it('returns null for empty input when not streaming', () => {
    const { container } = render(
      <ToolArgumentsDisplay toolName="Bash" input="" isStreaming={false} />
    );
    expect(container.firstChild).toBeNull();
  });
});
```

**`ToolCallCard.test.tsx`** — Add streaming and duration tests:

```typescript
describe('streaming display', () => {
  it('shows "Preparing..." when running with empty input', () => {
    render(
      <ToolCallCard
        toolCall={{ ...baseToolCall, status: 'running', input: '' }}
        defaultExpanded
      />
    );
    expect(screen.getByText('Preparing...')).toBeInTheDocument();
  });

  it('shows streaming input when running with partial input', () => {
    render(
      <ToolCallCard
        toolCall={{ ...baseToolCall, status: 'running', input: '{"command":"ls' }}
        defaultExpanded
      />
    );
    expect(screen.getByText(/\{"command/)).toBeInTheDocument();
  });
});

describe('duration display', () => {
  it('shows duration on completed cards', () => {
    render(
      <ToolCallCard
        toolCall={{
          ...baseToolCall,
          status: 'complete',
          startedAt: 1000,
          completedAt: 2234,
        }}
      />
    );
    expect(screen.getByText('1.2s')).toBeInTheDocument();
  });

  it('does not show duration on running cards', () => {
    render(
      <ToolCallCard
        toolCall={{
          ...baseToolCall,
          status: 'running',
          startedAt: 1000,
        }}
      />
    );
    expect(screen.queryByText(/ms|s$/)).not.toBeInTheDocument();
  });
});

describe('MCP server badge', () => {
  it('shows server badge for third-party MCP tools', () => {
    render(
      <ToolCallCard
        toolCall={{
          ...baseToolCall,
          toolName: 'mcp__slack__send_message',
          input: '{"channel":"#general","text":"hello"}',
        }}
      />
    );
    expect(screen.getByText('Slack')).toBeInTheDocument();
  });

  it('does not show badge for DorkOS MCP tools', () => {
    render(
      <ToolCallCard
        toolCall={{
          ...baseToolCall,
          toolName: 'mcp__dorkos__relay_send',
          input: '{}',
        }}
      />
    );
    expect(screen.queryByText('DorkOS')).not.toBeInTheDocument();
  });
});
```

### Mocking Strategies

- **react-json-view-lite**: Mock with a simple `<pre>` component in tests to avoid CSS import issues
- **ansi-to-react**: Mock with a component that strips ANSI and renders plain text
- **react-diff-viewer-continued**: Mock the lazy import — return a simple `<pre>` with both values
- **ansi-regex**: No mock needed — it's a pure regex function

### Integration Tests

No new integration tests needed — changes are entirely client-side rendering. Existing E2E tests that interact with tool calls will automatically exercise the new rendering.

## Performance Considerations

| Concern                                             | Mitigation                                                                                                        |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `react-json-view-lite` on large JSON (>100KB)       | Use `collapseAllNested` (only root expanded). 5KB truncation already limits visible data.                         |
| `react-diff-viewer-continued` bundle size (~1.08MB) | Lazy-loaded via `React.lazy()`. Only loaded when an Edit tool result is first rendered.                           |
| `ansi-regex` on every tool result                   | The regex is compiled once (module-level), test is O(n) on string length. 5KB truncation limits input.            |
| Content classifier called on every result render    | Pure function, no side effects. Memoizable if profiling shows issues.                                             |
| `JSON.parse` called twice (classifier + renderer)   | Acceptable overhead — JSON.parse on 5KB is <1ms. Can optimize later with a combined parse-and-classify if needed. |
| Streaming re-renders (every `tool_call_delta`)      | Raw `<pre>` rendering during streaming is lightweight. No JSON.parse or library rendering until complete.         |

## Security Considerations

- **XSS via tool results**: `react-json-view-lite` renders values as text nodes (no `dangerouslySetInnerHTML`). `ansi-to-react` converts ANSI codes to styled `<span>` elements. Both are safe by default.
- **ANSI injection**: Tool results may contain ANSI codes from Bash output. `ansi-to-react` only converts recognized escape sequences to CSS styles — no script execution.
- **JSON.parse on untrusted input**: Standard browser JSON.parse is safe (no code execution). Used only for rendering, not for data processing.
- **Diff viewer with @emotion/css**: Uses CSS-in-JS for styling. The `nonce` prop is available for CSP compliance if needed.

## Documentation

### Files to Update

- `contributing/design-system.md` — Add tool call card rendering section if it doesn't exist
- No external docs changes — this is internal UI behavior

### No Breaking API Changes

No server API changes, no transport changes, no shared type exports that downstream consumers depend on. The `ToolCallState` interface change (adding optional fields) is backward-compatible.

## Implementation Phases

### Phase 1: Bug Fixes (Foundation)

1. **MCP tool name parsing** — `tool-labels.ts` changes + tests
2. **Streaming display fix** — `ToolCallCard.tsx` falsy check fix + `tool-arguments-formatter.tsx` streaming mode + tests
3. **Duration tracking** — `chat-types.ts` + `stream-tool-handlers.ts` + `format-duration.ts` + `ToolCallCard.tsx` header + tests

### Phase 2: Enhanced Output Rendering

4. **Install libraries** — `pnpm add react-json-view-lite ansi-to-react react-diff-viewer-continued ansi-regex` in `apps/client/`
5. **Content classifier** — `classify-content.ts` + tests
6. **OutputRenderer component** — JSON tree, ANSI rendering, Edit diff, raw toggle
7. **Integration** — Replace `TruncatedOutput` for `result` in `ToolCallCard.tsx`

### Phase 3: Polish

8. **react-json-view-lite theming** — Create DorkOS-branded dark style matching the neutral gray palette
9. **react-diff-viewer-continued theming** — Dark theme color overrides for DorkOS palette
10. **Barrel exports** — Update `shared/lib/index.ts` with new exports

## Open Questions

1. ~~**react-json-view-lite CSS import**~~ (RESOLVED)
   **Answer:** Use CSS import directly — `import 'react-json-view-lite/dist/index.css'` works natively with Vite 6. Unlayered third-party CSS sits outside Tailwind v4's cascade layers with higher priority, so no conflicts. Alternatively, the `style={darkStyles}` prop can bypass CSS imports entirely for a custom theme.

2. ~~**react-diff-viewer-continued @emotion/css**~~ (RESOLVED)
   **Answer:** No conflicts. Emotion's scoped classnames prevent collisions with Tailwind v4, and unlayered injection order works favorably. Lazy-loading is for code-splitting performance only, not CSS isolation.

## Related ADRs

- **ADR-0138**: Dedicated `tool_progress` StreamEvent Type — confirms `progressOutput` is separate from `input` accumulation, which this spec depends on.

## Changelog

| Date       | Change        |
| ---------- | ------------- |
| 2026-03-23 | Initial draft |

## References

- Ideation: `specs/tool-call-display-overhaul/01-ideation.md`
- Research: `research/20260323_tool_call_display_overhaul.md`
- MCP naming research: `research/20260304_mcp_tool_naming_conventions.md`
- Auto-hide spec: `specs/auto-hide-tool-calls/02-specification.md`
- Truncation spec: `specs/tool-result-truncation/02-specification.md`
- [react-json-view-lite](https://github.com/AnyRoad/react-json-view-lite) — v2.x, React 18+, zero deps
- [ansi-to-react](https://github.com/nteract/ansi-to-react) — v6.0.10, React 19 peer dep
- [react-diff-viewer-continued](https://github.com/Aeolun/react-diff-viewer-continued) — v4.2.0, React 19 peer dep
- [ansi-regex](https://github.com/chalk/ansi-regex) — v6.x, ANSI detection regex
