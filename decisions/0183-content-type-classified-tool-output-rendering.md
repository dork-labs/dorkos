---
number: 183
title: Content-Type Classified Tool Output Rendering
status: draft
created: 2026-03-23
spec: tool-call-display-overhaul
superseded-by: null
---

# 183. Content-Type Classified Tool Output Rendering

## Status

Draft (auto-extracted from spec: tool-call-display-overhaul)

## Context

Tool call results in the DorkOS chat UI are rendered as plain monospace text regardless of content type. JSON responses from MCP tools, ANSI-colored terminal output from Bash, and diff results from Edit all receive the same `<pre>` treatment. This wastes the rich structure present in tool outputs and forces users to mentally parse raw text.

The existing `TruncatedOutput` component handles size truncation (5KB limit with expand) but has no content awareness. As MCP tool adoption grows, the variety of output formats will increase.

## Decision

Classify tool output content before rendering and use format-appropriate renderers:

- **JSON** → `react-json-view-lite` collapsible tree (collapse-all-nested by default)
- **ANSI escape codes** → `ansi-to-react` styled terminal output
- **Edit tool results** → `react-diff-viewer-continued` unified diff (lazy-loaded)
- **Plain text** → existing monospace `<pre>` rendering

Classification uses a pure function (`classifyContent`) that checks for ANSI escape codes first (most specific signal), then attempts JSON parse, then falls back to plain text. A "Raw" toggle button allows users to switch between formatted and raw views for any output.

## Consequences

### Positive

- JSON tool outputs become navigable — users can expand/collapse nodes instead of scrolling raw text
- Bash output preserves terminal colors (green for success, red for errors) that are currently stripped
- Edit tool results show visual diffs instead of raw "success" text
- Raw toggle preserves power-user access to unformatted output

### Negative

- Three new dependencies added to the client bundle (react-json-view-lite ~8KB, ansi-to-react ~15KB, react-diff-viewer-continued ~1.08MB lazy-loaded)
- Content classification adds a small overhead per tool result render (ANSI regex test + optional JSON.parse)
- CSS from third-party libraries may need theme adjustments to match DorkOS's neutral gray palette
