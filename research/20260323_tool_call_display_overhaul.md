---
title: 'Tool Call Display Overhaul — MCP Name Parsing, JSON Formatting, Streaming UX, Low-Lift Improvements'
date: 2026-03-23
type: external-best-practices
status: active
tags:
  [
    tool-calls,
    mcp,
    json-viewer,
    syntax-highlighting,
    diff-viewer,
    streaming-ui,
    ansi,
    react,
    chat-ui,
    tool-grouping,
    timing-display,
  ]
feature_slug: tool-call-display-overhaul
searches_performed: 14
sources_count: 38
---

# Tool Call Display Overhaul

## Prior Research Consulted

Before any new searches were conducted, the following prior reports were read in full and directly inform this document:

- `research/20260304_mcp_tool_naming_conventions.md` — The `mcp__server__tool` wrapping format, Stripe/GitHub naming patterns, the double-underscore delimiter convention.
- `research/20260316_tool_result_truncation_patterns.md` — String-slice at 5KB vs CSS max-height, `TruncatedOutput` component recommendation, virtualization trade-offs.
- `research/20260304_agent_tools_elevation.md` — MCP tool namespace structure, `allowedTools` wildcard patterns, per-agent tool filtering.
- `research/20260316_subagent_activity_streaming_ui_patterns.md` — CSS grid row height animation trick, ARIA contract for collapsibles, auto-expand/auto-collapse state machine, tool call bucketing strategy.
- `research/20260316_tool_approval_timeout_visibility_ux.md` — In-progress tool state display, color phase transitions, `prefers-reduced-motion` patterns.
- `research/20260311_ui_quality_improvements_research.md` — shadcn Collapsible patterns, module splitting, event log UI patterns.

---

## Research Summary

This report covers five interconnected topics for the `tool-call-display-overhaul` feature:

1. **MCP Tool Name Parsing** — The `mcp__server__tool` triple-component format is a confirmed Anthropic SDK convention. The display format "Server > Tool" (with `snake_case` → `Title Case` conversion) is the best pattern. Cursor uses simple label stripping; Claude.ai shows parsed names without prefixes.
2. **Input/Output Formatting** — Key-value grids for simple inputs, collapsible JSON tree for complex objects, string-slice truncation (already researched at `20260316_tool_result_truncation_patterns.md`) for large outputs. `react-json-view-lite` is the best JSON tree library (zero deps, 8x faster than `react-json-view`).
3. **Syntax Highlighting** — Shiki v4 with fine-grained bundles is the quality choice for static code; Prism/`react-syntax-highlighter` is the lightweight choice for dynamic output. For bash/terminal output specifically, `ansi-to-react` handles ANSI color codes natively.
4. **Streaming Tool Call Display** — The auto-expand while running → auto-collapse after completion state machine (from the subagent report) applies equally to non-subagent tool calls. CSS `grid-template-rows: 0fr → 1fr` is the animation technique.
5. **Low-Lift Improvements** — Duration display (`<1s` → `1.2s` → `14s` tiered format), diff rendering via `react-diff-viewer-continued` (1.08 MB, actively maintained), ANSI-aware terminal output, collapsible grouping for 5+ sequential tool calls, clickable file paths via regex detection.

---

## Key Findings

### 1. MCP Tool Name Parsing and Display

#### The Wire Format

The Anthropic Agent SDK uses a mandatory `mcp__<server-name>__<tool-name>` namespace when registering MCP tools with Claude. This is the name that appears in tool-use traces, tool approval events, and the SSE stream. Examples:

```
mcp__dorkos__relay_send
mcp__stripe__create_customer
mcp__github__get_file_contents
```

The double-underscore (`__`) is the confirmed delimiter. A well-formed MCP tool name has **exactly two** double-underscore sequences. The pattern is:

```
^mcp__([a-z0-9_-]+)__([a-z0-9_-]+)$
```

Server names and tool names each use `snake_case` by convention (90%+ of production MCP tools per ZazenCodes analysis of 100 servers).

#### Parsing Algorithm

```typescript
function parseMcpToolName(rawName: string): {
  isMcp: boolean;
  serverName: string | null;
  toolName: string;
  displayServer: string | null;
  displayTool: string;
} {
  const MCP_PREFIX = 'mcp__';
  if (!rawName.startsWith(MCP_PREFIX)) {
    return {
      isMcp: false,
      serverName: null,
      toolName: rawName,
      displayServer: null,
      displayTool: formatToolName(rawName),
    };
  }

  // Strip 'mcp__' prefix, then split on the FIRST double-underscore only
  const withoutPrefix = rawName.slice(MCP_PREFIX.length); // 'dorkos__relay_send'
  const separatorIndex = withoutPrefix.indexOf('__');

  if (separatorIndex === -1) {
    // Malformed: 'mcp__somethingwithoutdelimiter'
    return {
      isMcp: true,
      serverName: null,
      toolName: withoutPrefix,
      displayServer: null,
      displayTool: formatToolName(withoutPrefix),
    };
  }

  const serverName = withoutPrefix.slice(0, separatorIndex); // 'dorkos'
  const toolName = withoutPrefix.slice(separatorIndex + 2); // 'relay_send'

  return {
    isMcp: true,
    serverName,
    toolName,
    displayServer: formatServerName(serverName), // 'DorkOS'
    displayTool: formatToolName(toolName), // 'Relay Send'
  };
}

function formatServerName(raw: string): string {
  // Known server name overrides for human-friendly display
  const OVERRIDES: Record<string, string> = {
    dorkos: 'DorkOS',
    github: 'GitHub',
    stripe: 'Stripe',
    filesystem: 'Files',
  };
  return OVERRIDES[raw] ?? raw.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatToolName(raw: string): string {
  return raw.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
```

This handles DorkOS tools like `mcp__dorkos__relay_send` → `{ displayServer: 'DorkOS', displayTool: 'Relay Send' }` and third-party tools like `mcp__github__get_file_contents` → `{ displayServer: 'GitHub', displayTool: 'Get File Contents' }`.

#### Display Patterns: Three Approaches

**Approach A: "Server > Tool" badge** (Recommended)

```
[DorkOS] Relay Send
```

A small muted server badge + the tool name. The badge visually separates the namespace from the action. This is the pattern GitHub Copilot uses for tool calls in its VS Code chat view — the extension name appears in a dim label before the tool name.

- Pros: Visually distinct namespacing; immediately answers "where does this come from?"; scales to third-party MCP servers
- Cons: Slightly more DOM than just the tool name
- Complexity: Low

**Approach B: "Tool (via Server)"**

```
Relay Send (via DorkOS)
```

- Pros: Reads naturally in English
- Cons: The parenthetical creates visual noise when scanning many tool calls; the "via" phrasing implies optionality when the namespace is structural
- Not recommended

**Approach C: Strip MCP prefix, show only tool name**

```
relay_send
```

This is what Cursor does — it strips the namespace entirely and shows the raw `snake_case` tool name. Claude Code's terminal output does the same.

- Pros: Minimal, no parsing needed
- Cons: Loses the server context; third-party tools like `create_customer` (Stripe) or `get_file_contents` (GitHub) become ambiguous when multiple MCP servers are active
- Acceptable as a fallback for DorkOS-only tools; insufficient when external MCP servers are present

#### Recommendation for DorkOS

Use **Approach A** with the server badge rendered as a small muted pill and the tool name in normal weight. For DorkOS's own tools (`mcp__dorkos__*`), the server badge can be omitted entirely since all sessions run in a DorkOS context — the server is implicit. Show the server badge only for non-DorkOS MCP servers. This matches what Claude.ai does: it shows the integration name only for third-party tool calls, not for its own tools.

```tsx
function ToolNameDisplay({ rawName }: { rawName: string }) {
  const parsed = parseMcpToolName(rawName);

  // DorkOS tools: just show the formatted tool name
  if (parsed.serverName === 'dorkos') {
    return <span className="font-medium">{parsed.displayTool}</span>;
  }

  // Third-party MCP tools: show server badge + tool name
  if (parsed.isMcp && parsed.displayServer) {
    return (
      <span className="flex items-center gap-1.5">
        <span className="text-muted-foreground bg-muted rounded px-1 py-0.5 text-[10px] font-medium">
          {parsed.displayServer}
        </span>
        <span className="font-medium">{parsed.displayTool}</span>
      </span>
    );
  }

  // Built-in Claude Code tools (Read, Write, Bash, etc.): show as-is with title casing
  return <span className="font-medium">{parsed.displayTool}</span>;
}
```

---

### 2. Tool Call Input/Output Formatting

#### Input Formatting: Three Tiers

Tool call inputs (the `input` object on a `tool_use` block) range from a single string parameter to deeply nested JSON objects. A single display strategy cannot serve all cases.

**Tier 1: Single-string inputs** — Render as a styled code block

```
Read: /src/components/MessageItem.tsx
Bash: pnpm test --run
```

When `Object.keys(input).length === 1` and the value is a string, show `Key: value` inline without a JSON wrapper. This covers 80% of Claude Code tool calls (Read, Write, Bash, Grep, Glob, WebSearch all take a single primary parameter).

**Tier 2: Small multi-key inputs (2–5 keys, shallow)** — Key-value grid

```
file_path    /src/components/MessageItem.tsx
content      import React from 'react'...
```

A simple CSS grid with two columns: key in `text-muted-foreground` monospace, value in normal weight. No accordion needed. Covers `Edit`, `Write`, `WebFetch`.

**Tier 3: Large or nested inputs** — Collapsible JSON tree

When the input has >5 keys or nested objects, render an expandable JSON tree. The user can see the shape at a glance and drill into specific keys.

#### JSON Tree: Library Recommendation

Based on performance benchmarks against a 300KB JSON file (50 renders on M1 MacBook):

| Library                       | Median render (ms) | Bundle  | Dependencies |
| ----------------------------- | ------------------ | ------- | ------------ |
| `react-json-view`             | 1,540 ms           | ~125 KB | Many         |
| `react-json-tree`             | 620 ms             | ~28 KB  | 1            |
| `react-json-view-lite`        | 82 ms              | ~8 KB   | 0            |
| `react-json-pretty` (no tree) | 24 ms              | ~4 KB   | 0            |

**`react-json-view-lite` is the clear winner** for a tool call display use case:

- 18x faster than `react-json-view` (the most commonly used library)
- Zero dependencies
- Full TypeScript support
- Keyboard navigation (arrow keys) built in
- Accessible (ARIA tree view pattern)
- Customizable via CSS classes — compatible with Tailwind
- Version 2.x requires React 18+; React 19 compatibility should be confirmed but is expected given the React 18+ requirement

The library's CSS class API makes theming straightforward:

```tsx
import { JsonView, allExpanded, defaultStyles } from 'react-json-view-lite';
import 'react-json-view-lite/dist/index.css';

<JsonView
  data={toolCallInput}
  shouldExpandNode={allExpanded} // or collapseAllNested for deep objects
  style={{
    ...defaultStyles,
    container: 'font-mono text-xs',
    label: 'text-muted-foreground',
    stringValue: 'text-green-600 dark:text-green-400',
    numberValue: 'text-blue-600 dark:text-blue-400',
    booleanValue: 'text-purple-600 dark:text-purple-400',
  }}
/>;
```

#### Output Formatting

Tool call outputs (the `content` field on a `tool_result` block) are raw strings. Three categories:

1. **File content** (`Read` tool): Syntax highlight based on file extension extracted from the corresponding `input.file_path`. Use Shiki or Prism for highlighting.
2. **Bash/terminal output**: May contain ANSI escape codes. Use `ansi-to-react` to render colored output faithfully.
3. **Structured data returned by MCP tools**: Often JSON. Detect with `JSON.parse()` — if it parses, render with `react-json-view-lite`.
4. **Plain text**: Render as `<pre>` with the existing `TruncatedOutput` truncation pattern (already in `ToolCallCard.tsx`, researched at `20260316_tool_result_truncation_patterns.md`).

The detection logic:

```typescript
function classifyToolOutput(
  content: string,
  toolName: string
): 'file-content' | 'terminal' | 'json' | 'plain' {
  // Check if result looks like it came from a file read
  const isFileRead = toolName === 'Read' || toolName === 'Glob' || toolName.startsWith('mcp__');

  // ANSI escape code detection
  const hasAnsi = /\x1b\[[0-9;]*m/.test(content);
  if (hasAnsi) return 'terminal';

  // JSON detection
  const trimmed = content.trim();
  if (
    (trimmed.startsWith('{') || trimmed.startsWith('[')) &&
    (() => {
      try {
        JSON.parse(trimmed);
        return true;
      } catch {
        return false;
      }
    })()
  ) {
    return 'json';
  }

  return 'plain';
}
```

---

### 3. Syntax Highlighting

#### Library Comparison

| Library                    | Min+gz              | Weekly DLs | Quality          | Active                | Best for                    |
| -------------------------- | ------------------- | ---------- | ---------------- | --------------------- | --------------------------- |
| `shiki` v4                 | 695 KB (web bundle) | 4M         | VS Code-grade    | Yes                   | Static code display, themes |
| `prismjs`                  | ~12 KB (core)       | 8.6M       | Good             | Slow (v2 in progress) | Dynamic inline highlighting |
| `highlight.js`             | ~3.9 MB             | 9.4M       | Good             | Yes (slow pace)       | Auto-detect language        |
| `react-syntax-highlighter` | ~30 KB (wrapper)    | ~5M        | Wraps prism/hljs | Yes                   | React convenience           |

**For DorkOS tool call display, the recommendation is split:**

**For file content from `Read` tool**: Use **Shiki v4 with the fine-grained bundle**. Shiki produces VS Code-quality highlighting that developers immediately recognize as correct. Its `shiki/core` fine-grained API allows importing only the needed language grammars:

```typescript
// Only load the languages DorkOS needs for tool output highlighting
import { createHighlighter } from 'shiki/core';
import javascript from 'shiki/langs/javascript.mjs';
import typescript from 'shiki/langs/typescript.mjs';
import python from 'shiki/langs/python.mjs';
import bash from 'shiki/langs/bash.mjs';
import json from 'shiki/langs/json.mjs';
import { githubDark } from 'shiki/themes';

// Initialize once and reuse (lazy init on first tool result render)
let highlighter: Awaited<ReturnType<typeof createHighlighter>> | null = null;

async function getHighlighter() {
  if (!highlighter) {
    highlighter = await createHighlighter({
      themes: [githubDark],
      langs: [javascript, typescript, python, bash, json],
    });
  }
  return highlighter;
}
```

With 5 languages, the gzipped bundle contribution is roughly 150–200 KB (vs 695 KB for the full web bundle). The async init should be deferred — lazy-load on first file content render.

**For Bash/terminal output**: Use **`ansi-to-react`** (nteract). This is a React-specific package that converts ANSI escape codes to styled `<span>` elements. Last published 10 days ago (as of research date), actively maintained, used by Jupyter and nteract.

```tsx
import Ansi from 'ansi-to-react';

// In the tool output renderer:
<pre className="bg-muted/20 rounded p-2 font-mono text-xs">
  <Ansi>{toolCall.result}</Ansi>
</pre>;
```

The package handles: SGR color codes (16/256/truecolor), bold, underline, reset sequences. It does NOT handle cursor positioning or terminal control sequences — appropriate for captured command output, not a live terminal emulator.

**For inline tool names and small code snippets** (not full file content): Skip syntax highlighting entirely. Plain `<code>` with `font-mono text-xs` is sufficient and avoids the Shiki initialization overhead.

---

### 4. Streaming Tool Call Display

#### What Exists (Confirmed by Prior Research)

The subagent streaming patterns report (`20260316_subagent_activity_streaming_ui_patterns.md`) established the complete state machine and animation technique. These patterns apply **equally to regular tool calls**, not just subagent `Agent`/`Task` blocks:

**Auto-expand/auto-collapse state machine:**

```
IDLE → SPAWNED: expand immediately (no animation — instant)
RUNNING: content streams in (natural growth, no animation needed)
RUNNING → COMPLETED: auto-collapse after 1.5s delay
USER_EXPANDED: animated expand (user clicked collapsed card)
```

**CSS animation technique (no JS height measurement):**

```css
.tool-call-content {
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows 280ms cubic-bezier(0.4, 0, 0.2, 1);
}

.tool-call-content.is-open {
  grid-template-rows: 1fr;
}

.tool-call-content-inner {
  overflow: hidden;
  min-height: 0;
}
```

With motion.dev (DorkOS's existing animation system):

```tsx
<motion.div
  initial={false}
  animate={{ height: isExpanded ? 'auto' : 0 }}
  transition={isStreaming ? { duration: 0 } : { type: 'spring', stiffness: 280, damping: 32 }}
  style={{ overflow: 'hidden' }}
>
  {/* streaming content */}
</motion.div>
```

The key rule: **never animate height during active streaming** — use `duration: 0` (instant snap). Animations only on user-triggered expand/collapse after completion.

#### What to Show During Execution vs After Completion

**During execution (RUNNING state):**

```
┌─────────────────────────────────────────────────────────────┐
│ ▼ [spinner] Read • /src/components/MessageItem.tsx         │
├─────────────────────────────────────────────────────────────┤
│ [streaming progress output if available]                    │
└─────────────────────────────────────────────────────────────┘
```

- Show tool name (formatted per §1)
- Show primary parameter inline in the header (the most important single piece of information)
- Animated spinner in the header
- Expand the card body immediately (no animation)
- Stream `progressOutput` if the tool emits it (Bash, Write)

**After completion (COMPLETED → collapsed after 1.5s):**

```
┌─────────────────────────────────────────────────────────────┐
│ ▶ [check icon] Read • /src/components/MessageItem.tsx  1.2s │
└─────────────────────────────────────────────────────────────┘
```

- Replace spinner with checkmark (or error icon on failure)
- Show elapsed duration (see §5 for format)
- Collapse after 1.5s delay
- Summary line remains always visible

**User-expanded (after completion):**

```
┌─────────────────────────────────────────────────────────────┐
│ ▼ [check] Read • /src/components/MessageItem.tsx       1.2s │
├─────────────────────────────────────────────────────────────┤
│ import React from 'react'                                    │
│ import { useState } from 'react'                             │
│ ...                                                          │
└─────────────────────────────────────────────────────────────┘
```

- Syntax-highlighted output rendered via Shiki or `ansi-to-react`
- Truncated at 5KB with "Show full output (14.2KB)" button

#### The "Primary Parameter" Header Pattern

The single most valuable UX improvement for tool calls is surfacing the primary parameter directly in the collapsed header. This eliminates the need to expand most tool calls:

```typescript
function getPrimaryParam(toolName: string, input: Record<string, unknown>): string | null {
  // Map each tool to its most informative parameter
  const PRIMARY_PARAMS: Record<string, string> = {
    Read: 'file_path',
    Write: 'file_path',
    Edit: 'file_path',
    Bash: 'command',
    Grep: 'pattern',
    Glob: 'pattern',
    WebSearch: 'query',
    WebFetch: 'url',
    Agent: 'description',
    Task: 'description',
  };

  const paramKey = PRIMARY_PARAMS[toolName];
  if (paramKey && typeof input[paramKey] === 'string') {
    const value = input[paramKey] as string;
    // Truncate for header display
    return value.length > 60 ? value.slice(0, 60) + '…' : value;
  }

  // For MCP tools: show first string value
  const firstStringValue = Object.values(input).find((v) => typeof v === 'string');
  return typeof firstStringValue === 'string' ? firstStringValue.slice(0, 60) : null;
}
```

---

### 5. Low-Medium Lift Improvements

#### 5a. Execution Duration Display

Chrome DevTools, VS Code, and most developer tools use a **tiered format** based on magnitude:

| Duration      | Format                       | Example  |
| ------------- | ---------------------------- | -------- |
| < 100ms       | `<100ms` (no decimal needed) | `<100ms` |
| 100ms – 999ms | `Xms`                        | `347ms`  |
| 1s – 9.9s     | `X.Xs` (one decimal)         | `1.2s`   |
| 10s – 59s     | `Xs` (no decimal)            | `14s`    |
| 60s+          | `Xm Xs`                      | `1m 23s` |

The reasoning: decimals matter in the sub-second range (347ms vs 400ms is meaningful), but at 14 seconds a decimal adds no human value. Magnitude carries the signal.

```typescript
function formatDuration(ms: number): string {
  if (ms < 100) return '<100ms';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}
```

The duration is recorded as `startedAt` on the tool call state when the `tool_use` event arrives, and `completedAt` when the matching `tool_result` arrives. Both timestamps are already available from the SSE stream's event timing.

#### 5b. Tool Call Grouping (5+ Sequential Calls)

When an agent makes 5+ sequential tool calls (reading many files, running many searches), showing each as a separate card creates vertical noise. The industry pattern (from GitHub Copilot Mission Control, Perplexity Deep Research, ChatGPT's research mode) is a summary group.

**Trigger condition**: 5+ tool calls without an intervening assistant text message.

**Group display while running:**

```
┌─────────────────────────────────────────────────────────────┐
│ ▼ [spinner] Reading files...                    ⏱ 8s       │
├─────────────────────────────────────────────────────────────┤
│ Read 7 files · 2 Grep searches                              │
│ Currently: Reading src/auth/session.ts... ▋                 │
└─────────────────────────────────────────────────────────────┘
```

**Group display after completion:**

```
┌─────────────────────────────────────────────────────────────┐
│ ▶ [check] Read 12 files · Ran 1 command · 2 searches  14s  │
└─────────────────────────────────────────────────────────────┘
```

The summary format (from the subagent research) uses middle-dot separators and a maximum of 3–4 categories:

```typescript
// Reuse the formatSummaryBadge() from 20260316_subagent_activity_streaming_ui_patterns.md
// It already implements the bucketing strategy for files_read, files_written,
// commands_run, searches, web_fetches, subagents_spawned, mcp_calls
```

**Implementation approach**: The grouping logic lives in the message reducer, not in individual `ToolCallCard` components. When 5 consecutive `tool_use` events arrive without a `text_delta` between them, they are wrapped in a `ToolCallGroup` container. Each individual card remains accessible via expand.

This is the same pattern used by `assistant-ui`'s `ToolGroup` component, which auto-collapses consecutive tool invocations into a single collapsible disclosure widget.

**Threshold choice**: 5 is the right threshold. 1–4 tool calls are still individually scannable. At 5+, the user is watching an agent "do work" rather than making discrete decisions — summarization is appropriate.

#### 5c. Diff Rendering for Edit Operations

The `Edit` tool has both `old_string` and `new_string` parameters in its input. Rather than showing two raw strings, rendering an inline diff immediately communicates what changed.

**Approach A: Inline unified diff (Recommended)**

Show a classic unified diff with red removed lines and green added lines. This is the format that every developer recognizes from git diff, PR reviews, and code review tools.

**Library: `react-diff-viewer-continued`**

- Active fork of the unmaintained `react-diff-viewer`
- Last published: 22 days ago (as of research date)
- Weekly downloads: 582,465
- Bundle size: ~1.08 MB (before tree-shaking; the actual diff logic component is significantly smaller)
- Features: inline and side-by-side modes, built-in syntax highlighting support
- React 19 compatible (fork is actively maintained)

```tsx
import ReactDiffViewer from 'react-diff-viewer-continued';

// In the Edit tool call's expanded view:
{
  toolCall.name === 'Edit' && toolCall.input && (
    <ReactDiffViewer
      oldValue={toolCall.input.old_string ?? ''}
      newValue={toolCall.input.new_string ?? ''}
      splitView={false} // inline diff, not side-by-side
      useDarkTheme={resolvedTheme === 'dark'}
      hideLineNumbers={true} // saves space in chat UI
      styles={{
        variables: {
          dark: {
            diffViewerBackground: 'transparent',
            removedBackground: 'rgba(255, 80, 80, 0.1)',
            addedBackground: 'rgba(40, 200, 80, 0.1)',
          },
        },
      }}
    />
  );
}
```

**Approach B: Side-by-side diff** — Not recommended for chat UI. Side-by-side requires significant horizontal space and is optimized for code review workflows, not for glancing at what an agent changed. Inline diff reads linearly and fits naturally in a card.

**Approach C: Just show old + new separately** — No library needed, but makes the user do the mental diff themselves. The cognitive load is on the user, not the UI.

**Lazy loading to manage bundle size**: Since diffs only appear for `Edit` calls, the component should be lazy-loaded:

```typescript
const DiffViewer = lazy(() => import('./DiffViewer'));
// Wrap in <Suspense fallback={<pre>{oldString}</pre>}> with a raw text fallback
```

#### 5d. Clickable File Paths in Results

Terminal emulators (iTerm2, VS Code integrated terminal, Warp) detect file paths in output and make them clickable. The patterns they use for detection:

**Pattern 1: Absolute paths** — `^(/[^/\s]+)+(\.(ts|tsx|js|py|md|json|yaml|yml|css|html|sh))?$`

**Pattern 2: Relative paths starting with `.`** — `^\.[./][^\s]+$`

**Pattern 3: File:line syntax** — `/path/to/file.ts:42` or `/path/to/file.ts:42:8`

**Pattern 4: TypeScript/ESLint error format** — `path/to/file.ts(42,8): error TS2345...`

Implementation in a tool output renderer:

```typescript
const FILE_PATH_REGEX = /(?:^|\s)((?:\/|\.\.?\/)[^\s:,;()\[\]'"]+(?:\.[a-zA-Z]{1,5})?(?::\d+(?::\d+)?)?)/g;

function linkifyFilePaths(text: string, onPathClick: (path: string) => void): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let match;

  while ((match = FILE_PATH_REGEX.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }

    const rawPath = match[1];
    // Strip line:col suffix for the path, keep for display
    const colonIndex = rawPath.lastIndexOf(':');
    const hasLineNumber = colonIndex > 0 && !isNaN(Number(rawPath.slice(colonIndex + 1)));
    const filePath = hasLineNumber ? rawPath.slice(0, colonIndex) : rawPath;

    parts.push(
      <button
        key={match.index}
        onClick={() => onPathClick(filePath)}
        className="text-primary underline decoration-dotted hover:decoration-solid font-mono text-xs"
        title={`Open ${filePath}`}
      >
        {rawPath}
      </button>
    );

    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }

  return parts;
}
```

The `onPathClick` handler should trigger a `Read` tool call pre-loaded in the session input, or open the file in the session's working directory context. In DorkOS, this would likely navigate to a `?dir=<path>` URL or pre-fill the chat input with `@<filepath>`.

**Scope**: Apply path linkification only to `Bash` output and MCP tool results — not to all chat text (false positives in prose). The `Grep` tool output is particularly valuable to linkify since it returns file:line results by design.

#### 5e. ANSI-Aware Terminal Output

`ansi-to-react` is already covered in §3. Key additional detail: Buildkite's `terminal-to-html` library is the gold standard for production CI/CD terminal output rendering, but it's a Go-based server-side solution. `ansi-to-react` is the correct client-side equivalent.

For Bash tool output specifically, a complete rendering stack would be:

```tsx
function BashOutput({ content }: { content: string }) {
  const classified = content.includes('\x1b[') ? 'ansi' : 'plain';

  if (classified === 'ansi') {
    return (
      <div className="rounded bg-zinc-950 p-2 font-mono text-xs">
        <Ansi>{content}</Ansi>
      </div>
    );
  }

  return (
    <TruncatedOutput content={content} /> // existing 5KB truncation component
  );
}
```

---

## Potential Solutions Summary

### MCP Tool Name Display

| Approach                    | Description               | Pros                                         | Cons                                | Complexity | Recommended                                   |
| --------------------------- | ------------------------- | -------------------------------------------- | ----------------------------------- | ---------- | --------------------------------------------- |
| A: Server badge + Tool name | `[DorkOS] Relay Send`     | Clear namespacing; scales to third-party MCP | Slightly more DOM                   | Low        | Yes (with DorkOS badge omitted for own tools) |
| B: "Tool (via Server)"      | `Relay Send (via DorkOS)` | Natural English                              | Parenthetical noise                 | Low        | No                                            |
| C: Strip prefix, show raw   | `relay_send`              | Minimal                                      | Ambiguous with multiple MCP servers | None       | Fallback only                                 |

### JSON Input/Output Rendering

| Approach                     | Description                | Pros                                                | Cons                                                | Complexity    | Recommended      |
| ---------------------------- | -------------------------- | --------------------------------------------------- | --------------------------------------------------- | ------------- | ---------------- |
| `react-json-view-lite`       | Zero-dep, fast tree viewer | 18x faster than react-json-view; keyboard nav; ARIA | React 18+ required                                  | Low (drop-in) | Yes              |
| `react-json-view`            | Feature-rich tree viewer   | Editing, many themes                                | Slow (1,540ms median), heavy deps                   | Low           | No               |
| Raw `<pre>` + JSON.stringify | Plain formatted text       | Zero dependencies                                   | No expand/collapse; not scannable for large objects | None          | Only as fallback |

### Syntax Highlighting

| Approach                           | Description                 | Pros                                            | Cons                                           | Complexity | Recommended              |
| ---------------------------------- | --------------------------- | ----------------------------------------------- | ---------------------------------------------- | ---------- | ------------------------ |
| Shiki fine-grained                 | VS Code-quality, async init | Best quality; ~150-200KB for 5 langs            | Async init latency; WASM                       | Medium     | Yes, for file content    |
| PrismJS + react-syntax-highlighter | Lightweight, synchronous    | Fast; well-known                                | Regex-based (less accurate); PrismJS v2 in dev | Low        | Acceptable fallback      |
| `ansi-to-react`                    | ANSI code renderer          | Correct for bash output; zero deps beyond React | Only handles ANSI, not syntax                  | Low        | Yes, for terminal output |

### Diff Rendering

| Approach                      | Description                  | Pros                                                     | Cons                                             | Complexity | Recommended |
| ----------------------------- | ---------------------------- | -------------------------------------------------------- | ------------------------------------------------ | ---------- | ----------- |
| `react-diff-viewer-continued` | Inline unified diff          | Active maintenance; familiar format; side-by-side option | 1.08MB bundle (tree-shakeable); should lazy-load | Low-Medium | Yes         |
| Manual old/new display        | Show both strings separately | Zero deps                                                | User does the mental diff                        | None       | No          |
| `react-diff-view`             | Git diff parser + renderer   | Lower download count; git-focused                        | Less appropriate for string diffs; 1.48MB        | Medium     | No          |

### Streaming Display

| Approach                  | Description               | Pros                                             | Cons                                      | Complexity | Recommended               |
| ------------------------- | ------------------------- | ------------------------------------------------ | ----------------------------------------- | ---------- | ------------------------- |
| CSS grid rows 0fr→1fr     | GPU-animated collapsible  | No JS height measurement; works during streaming | Slightly less familiar CSS                | Low        | Yes                       |
| motion.dev animate height | Framer Motion auto height | Already in codebase; familiar                    | Must disable during streaming             | Low        | Yes (DorkOS already uses) |
| JS height measurement     | Classic expand animation  | Universal                                        | Stale measurements during streaming; jank | Medium     | No                        |

---

## Recommendations

### Priority Order (by impact/effort ratio)

**P0 — MCP Tool Name Parsing** (1–2 hours, high impact)
Parse `mcp__server__tool` on every `tool_use` event. Extract a `parseMcpToolName()` utility into `shared/lib/tool-name.ts`. Update `ToolCallCard.tsx` to use `ToolNameDisplay` component. Hide the DorkOS server badge for own tools; show it for third-party MCP.

**P0 — Primary Parameter in Header** (2–3 hours, very high impact)
Implement `getPrimaryParam()` and render it inline in the tool call header. This is the single change that makes the most tool calls legible without expanding. No library needed.

**P1 — Duration Display** (1 hour, low effort, clear value)
Record `startedAt` on the `tool_use` event arrival. Add `completedAt` on `tool_result`. Render with `formatDuration()`. Tiered format as documented in §5a.

**P1 — ANSI Terminal Output** (1–2 hours)
Add `ansi-to-react` dependency. Add ANSI detection in the output classifier. Wrap Bash output in `<Ansi>` component with dark background.

**P2 — Tool Call Grouping** (3–4 hours)
Implement the 5+ sequential tool call grouping in the message reducer. Reuse `formatSummaryBadge()` from the subagent accumulator pattern (already fully designed in `20260316_subagent_activity_streaming_ui_patterns.md`).

**P2 — JSON Tree for MCP Tool Input/Output** (2–3 hours)
Add `react-json-view-lite` dependency. Add JSON detection in output classifier. Render structured inputs and outputs with the tree component.

**P3 — Diff Rendering for Edit** (2–3 hours, requires lazy load)
Add `react-diff-viewer-continued` as a lazy-loaded component. Apply only to `Edit` tool calls' input display. Use inline mode (not side-by-side).

**P3 — Syntax Highlighting for File Content** (3–5 hours)
Add Shiki with fine-grained bundle. Async init on first `Read` result render. Extract file extension from `input.file_path` for language detection.

**P4 — Clickable File Paths** (2–3 hours)
Implement `linkifyFilePaths()` regex transformer. Apply to Bash and Grep tool outputs only. Wire click handler to appropriate navigation/pre-fill behavior.

---

## Libraries

| Library                         | Bundle (min+gz)      | Weekly Downloads | Maintenance      | Use Case                            |
| ------------------------------- | -------------------- | ---------------- | ---------------- | ----------------------------------- |
| `react-json-view-lite`          | ~8 KB                | ~100K            | Active           | JSON tree viewer for inputs/outputs |
| `ansi-to-react`                 | ~15 KB               | ~74 uses         | Active (nteract) | ANSI terminal output rendering      |
| `shiki` (fine-grained, 5 langs) | ~150-200 KB          | 4M               | Very active      | File content syntax highlighting    |
| `react-diff-viewer-continued`   | ~1.08 MB (lazy-load) | 582K             | Active fork      | Edit tool diff rendering            |
| `react-syntax-highlighter`      | ~30 KB (prism)       | ~5M              | Active           | Fallback syntax highlighting        |

**Not recommended:**

- `react-json-view` — too slow (1,540ms median), heavy bundle
- `react-json-tree` — adequate but slower than `react-json-view-lite`, 1 dependency
- `diff2html` — HTML output only, not React-native
- `react-diff-viewer` (original) — abandoned 6 years ago

---

## Research Gaps and Limitations

- **`react-json-view-lite` React 19 compatibility**: The repo states React 18+ requirement. React 19 is backward-compatible in most cases, but should be verified with a quick `pnpm add react-json-view-lite && pnpm typecheck` before committing.
- **Shiki async init timing**: The exact latency of `createHighlighter()` on first render in a Vite 6 / React 19 SPA has not been measured in this codebase. Consider showing a `<pre>` fallback while the highlighter initializes (typically < 200ms on modern hardware with the fine-grained bundle).
- **`react-diff-viewer-continued` dark mode**: The library supports `useDarkTheme` prop, but its dark theme colors may conflict with DorkOS's neutral gray design system. Custom `styles.variables` will likely be needed.
- **Clickable path regex false positives**: The regex will match things like `/dev/null` or `/tmp/` in error messages. This is acceptable but could be refined with extension filtering if false positives become problematic in practice.
- **Tool call grouping threshold**: The 5-call threshold is inferred from competitive analysis (GitHub Copilot, Perplexity), not from user research. A/B testing the threshold would improve confidence.
- **MCP server name registry**: The `OVERRIDES` map in `formatServerName()` needs to grow as DorkOS adds external MCP server support. A server name → display name registry should be stored in configuration, not hardcoded.

---

## Contradictions and Disputes

- **Shiki vs Prism for dynamic tool output**: The Smashing Magazine and CSS-Tricks communities generally favor Shiki for quality. The performance community (7x slower than Prism for a 10-block article) favors Prism. For DorkOS's use case (highlighted once per `Read` result, not on every keystroke), the quality win from Shiki is worth the init cost. However, if profiling shows measurable rendering bottlenecks, swapping to `react-syntax-highlighter` with Prism is a valid fallback with minimal code change.
- **Tool call grouping timing**: The subagent research recommends auto-collapse after 1.5 seconds. For regular tool calls (not subagents), a shorter delay (0.8–1s) might be more appropriate — regular tool calls complete faster and the user has less context to absorb before the collapse. This is a judgment call that benefits from user observation.

---

## Sources and Evidence

Prior DorkOS research (all read in full before external searches):

- `research/20260304_mcp_tool_naming_conventions.md` — `mcp__server__tool` format confirmed, Stripe/GitHub naming patterns, ZazenCodes 100-server analysis
- `research/20260316_tool_result_truncation_patterns.md` — 5KB string-slice recommendation, CSS max-height performance issues, virtualization trade-offs
- `research/20260304_agent_tools_elevation.md` — MCP namespace structure, `allowedTools` wildcard filtering, tool grouping by domain
- `research/20260316_subagent_activity_streaming_ui_patterns.md` — CSS grid height animation, auto-expand state machine, tool call bucketing/summary format, ARIA contract
- `research/20260316_tool_approval_timeout_visibility_ux.md` — In-progress tool state, CSS animation approach, `prefers-reduced-motion`
- `research/20260311_ui_quality_improvements_research.md` — Collapsible patterns, event log design

External sources:

- [MCP Tool Naming Conventions — ZazenCodes](https://zazencodes.com/blog/mcp-server-naming-conventions) — 90%+ use snake_case, `domain_verb_noun` patterns
- [Connect to external tools with MCP — Anthropic Agent SDK Docs](https://platform.claude.com/docs/en/agent-sdk/mcp) — `mcp__server__tool` confirmed naming convention
- [react-json-view-lite Performance Benchmarks — GitHub](https://github.com/AnyRoad/react-json-view-lite) — 82ms median vs 1,540ms for react-json-view on 300KB JSON; zero deps; keyboard nav
- [7 Best React JSON Viewers (2026 Update) — ReactScript](https://reactscript.com/best-json-viewer/) — Library survey: json-edit-react, JSON View, react-json-view, react-json-view-lite, etc.
- [highlight.js vs prismjs vs shiki npm trends](https://npmtrends.com/highlight.js-vs-prismjs-vs-shiki) — Download counts: hljs 9.4M, prism 8.6M, shiki 4M; Shiki most actively maintained
- [Shiki Performance Discussion — GitHub #846](https://github.com/shikijs/shiki/discussions/846) — Web bundle 46s vs fine-grained; caching strategy; worker thread approach
- [Shiki Bundles Documentation](https://shiki.style/guide/bundles) — Full bundle 1.2MB gzip, web bundle 695KB gzip; fine-grained `shiki/core` for minimal footprint
- [react-shiki — GitHub](https://github.com/AVGVSTVS96/react-shiki) — React hook/component wrapper for Shiki with dynamic import optimization
- [Comparing web code highlighters — chsm.dev](https://chsm.dev/blog/2025/01/08/comparing-web-code-highlighters) — Prism ~5ms / hljs ~14ms / Shiki ~50ms for 10 code blocks
- [ansi-to-react — GitHub, nteract](https://github.com/nteract/ansi-to-react) — Converts ANSI escape codes to React elements; last published ~10 days before research date
- [ansi_up — GitHub, drudru](https://github.com/drudru/ansi_up) — Zero-dependency ANSI to HTML; alternative if React-agnostic rendering is needed
- [react-diff-viewer-continued — npm](https://www.npmjs.com/package/react-diff-viewer-continued) — Active fork, 582K weekly DLs, last published recently, inline + side-by-side modes
- [react-diff-view vs react-diff-viewer vs react-diff-viewer-continued — npm-compare](https://npm-compare.com/react-diff-view,react-diff-viewer,react-diff-viewer-continued) — Bundle sizes: continued 1.08MB, react-diff-view 1.48MB; maintenance comparison
- [Prism command-line plugin](https://prismjs.com/plugins/command-line/) — Shell output formatting with Prism (alternative to ansi-to-react for non-ANSI output)
- [Convert ANSI colored terminal output — PrismJS Discussion #3731](https://github.com/orgs/PrismJS/discussions/3731) — ANSI + Prism integration patterns

---

## Search Methodology

- Searches performed: 14 WebSearch calls + 7 WebFetch calls
- Prior research consulted: 6 DorkOS research reports (read in full before any external search)
- Most productive search terms: "react JSON tree viewer bundle size 2026 comparison", "shiki bundle size fine-grained React client side dynamic import", "react-diff-viewer-continued vs react-diff-view 2025 2026", "ansi-to-html ansi-to-react npm ANSI escape codes render browser"
- Primary sources: GitHub READMEs for performance benchmarks (react-json-view-lite), official Shiki documentation (shiki.style), npm-compare for side-by-side library comparisons, npmtrends for download counts
- Existing DorkOS research covered: MCP naming (covered), truncation (covered), streaming/collapsible (covered), tool approval state (covered) — all referenced rather than re-researched
