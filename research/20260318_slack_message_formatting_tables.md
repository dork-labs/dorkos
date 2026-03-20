---
title: 'Slack Message Formatting — mrkdwn, Block Kit, and Tabular Data Alternatives'
date: 2026-03-18
type: external-best-practices
status: active
tags: [slack, mrkdwn, block-kit, formatting, tables, relay-adapter]
feature_slug: relay-external-adapters
searches_performed: 0
sources_count: 4
---

# Slack Message Formatting — mrkdwn, Block Kit, and Tabular Data Alternatives

**Date:** 2026-03-18
**Research Depth:** Focused Investigation
**Source:** Synthesized from three prior DorkOS research reports — no new web searches needed.

Prior research files consulted:

- `research/20260313_slack_bot_adapter_best_practices.md`
- `research/20260317_slack_tool_approval_block_kit.md`
- `research/20260227_slack_vs_telegram_relay_adapter.md`

---

## Research Summary

Slack does not support Markdown tables — not in `mrkdwn` and not in `text` fields. The `mrkdwn` dialect supports the basics (bold, italic, inline code, code blocks, links, mentions) but deliberately omits tables. Block Kit partially fills the gap via `section.fields` (two-column key-value pairs), but has no native table block. The best alternatives for tabular data are: code-block monospace formatting, `section.fields` two-column layout, multiple section blocks, or file attachments. The `slackify-markdown` library handles the conversion from standard Markdown automatically.

---

## Key Findings

### 1. mrkdwn Formatting Support

Slack's `mrkdwn` is a non-standard Markdown dialect. It supports:

| Format          | Standard Markdown    | Slack mrkdwn                   |
| --------------- | -------------------- | ------------------------------ | --- | --- | ----------------- |
| Bold            | `**text**`           | `*text*`                       |
| Italic          | `_text_` or `*text*` | `_text_`                       |
| Strikethrough   | `~~text~~`           | `~text~`                       |
| Inline code     | `` `code` ``         | `` `code` ``                   |
| Code block      | ` ```code``` `       | ` ```code``` `                 |
| Hyperlink       | `[text](url)`        | `<url\|text>`                  |
| User mention    | N/A                  | `<@U123456>`                   |
| Channel mention | N/A                  | `<#C123456>`                   |
| Ordered list    | `1. item`            | Not supported in `text` fields |
| Unordered list  | `- item`             | Not supported in `text` fields |
| Tables          | `                    | col                            | col | `   | **Not supported** |
| Blockquote      | `> text`             | Not supported in `text` fields |

Lists and blockquotes are supported only in **Block Kit `rich_text` blocks** — not in plain `mrkdwn` text fields.

mrkdwn is enabled by setting `"type": "mrkdwn"` on a text object, or by passing `mrkdwn: true` to `chat.postMessage`. It is applied per-field, not globally.

### 2. Slack Does Not Support Markdown Tables

Tables are explicitly absent from `mrkdwn`. Attempting to use standard Markdown table syntax (`| col | col | \n |---|---|`) will render as literal pipe characters and hyphens — it does not produce a visual table.

This is by design. Slack's text fields have a fixed-width monospace rendering option but no native table component.

**`slackify-markdown` conversion behavior:** `slackify-markdown` (v5.0.0, 179K weekly downloads) converts standard Markdown tables into a monospace code block representation. This is the library's own fallback strategy for an unsupported feature.

### 3. Block Kit — What It Offers for Structured Content

Block Kit is a JSON-based layout system that powers rich messages. It does not have a table block, but provides several building blocks useful for structured data:

#### `section.fields` — Two-Column Key-Value Layout

The closest native equivalent to a table row. Each `section` block can contain up to **10 fields**, rendered as a two-column grid:

```typescript
{
  type: 'section',
  fields: [
    { type: 'mrkdwn', text: '*Name:*\nAlice' },
    { type: 'mrkdwn', text: '*Status:*\nActive' },
    { type: 'mrkdwn', text: '*Agent:*\nCodeWriter' },
    { type: 'mrkdwn', text: '*Last run:*\n2h ago' },
  ]
}
```

This renders as a compact two-column card — good for key-value summaries, not for multi-row data tables.

**Constraints:**

- Max 10 fields per section
- Always two columns (no control over column count)
- Field text max: 2,000 characters per field
- No column headers row — must be implied by bold labels in each field

#### `rich_text` Block — Full Formatting Including Lists

`rich_text` blocks support the most formatting:

- Ordered and unordered lists
- Inline code, code blocks
- Bold, italic, strikethrough, underline
- Blockquotes
- **No tables**

```typescript
{
  type: 'rich_text',
  elements: [
    {
      type: 'rich_text_list',
      style: 'ordered',  // or 'bullet'
      elements: [
        {
          type: 'rich_text_section',
          elements: [{ type: 'text', text: 'Item one' }]
        }
      ]
    }
  ]
}
```

#### `header` Block

Plain text header (no mrkdwn):

```typescript
{ type: 'header', text: { type: 'plain_text', text: 'Agent Status Report' } }
```

#### `context` Block

Small subdued text — good for metadata, timestamps, footnotes:

```typescript
{
  type: 'context',
  elements: [{ type: 'mrkdwn', text: '_Last updated 2m ago_' }]
}
```

#### Block Kit Limits

- Max 50 blocks per message
- Max 10 fields per section
- Message text limit: 4,000 characters
- Block Kit does not support tables at any level

### 4. Best Practices for Tabular Data in Slack

Since Slack has no native table support, choose the best alternative based on context:

#### Option A: Monospace Code Block (simplest, most reliable)

Format tabular data as a fixed-width text table inside a code block. This is what `slackify-markdown` does automatically for Markdown tables.

```

```

Name Status Last Run
───────── ──────── ────────
Alice Active 2h ago
Bob Idle 1d ago
CodeAgent Running now

```

```

**Pros:** Renders consistently across all Slack clients. No Block Kit complexity. Handles any number of rows and columns.
**Cons:** Monospace font, no color/emphasis, can be hard to read for large tables.
**Character limit:** Stays within the 4,000-character text field limit for small tables.

#### Option B: `section.fields` Two-Column Layout (Block Kit)

Best for small key-value datasets (< 10 pairs). Renders visually as a card with two columns.

```typescript
{
  type: 'section',
  fields: [
    { type: 'mrkdwn', text: '*Agent*\nCodeWriter' },
    { type: 'mrkdwn', text: '*Status*\n:green_circle: Running' },
    { type: 'mrkdwn', text: '*Session*\n`abc-123`' },
    { type: 'mrkdwn', text: '*Started*\n10 minutes ago' },
  ]
}
```

**Pros:** Visually distinct from plain text, supports emoji and mrkdwn per-cell.
**Cons:** Fixed two-column layout only. Not suitable for data with more than 2 columns. No header row.

#### Option C: Multiple Section Blocks (one per row)

For "tables" with 3+ columns where each row should be clearly separated:

```typescript
// Header row
{ type: 'section', text: { type: 'mrkdwn', text: '*Name* | *Status* | *Runtime*' } },
{ type: 'divider' },
// Data rows
{ type: 'section', text: { type: 'mrkdwn', text: 'CodeWriter | Active | 2h 14m' } },
{ type: 'section', text: { type: 'mrkdwn', text: 'DataFetcher | Idle | —' } },
```

**Pros:** Flexible column count. Supports inline mrkdwn per row.
**Cons:** Visual alignment depends on font rendering (not guaranteed). Pipe separators are semantic, not visual.

#### Option D: File/Snippet Upload (for large datasets)

For tables with many rows or columns that exceed message limits, upload as a file:

```typescript
await client.files.uploadV2({
  channel_id: channelId,
  content: csvOrTextContent,
  filename: 'report.csv',
  title: 'Agent Report',
});
```

**Pros:** No size limits. Users can download the file. CSV opens in spreadsheet apps.
**Cons:** Requires `files:write` scope. User must click to open. Not inline.

#### Option E: `slackify-markdown` Auto-Conversion (for AI agent output)

When relaying AI agent Markdown responses that contain tables, `slackify-markdown` automatically converts them to code block format (Option A). No additional handling needed:

```typescript
import slackifyMarkdown from 'slackify-markdown';

// Agent returns Markdown with a table:
const agentMarkdown = `
| Name | Status |
|------|--------|
| Alice | Active |
`;

// slackify-markdown converts the table to a monospace code block
const slackText = slackifyMarkdown(agentMarkdown);
await client.chat.postMessage({ channel, text: slackText });
```

This is the recommended approach for relay adapters — let `slackify-markdown` handle the conversion automatically rather than building custom table logic.

---

## Summary Decision Matrix

| Use case                              | Best approach                                     |
| ------------------------------------- | ------------------------------------------------- |
| AI agent response with tables         | `slackify-markdown` (auto-converts to code block) |
| Key-value status card (≤ 10 pairs)    | `section.fields` two-column layout                |
| Small data table (< 20 rows)          | Code block monospace table                        |
| Large dataset or CSV                  | File upload via `files.uploadV2`                  |
| Multi-column report with row emphasis | Multiple section blocks with dividers             |

---

## Sources

- `research/20260313_slack_bot_adapter_best_practices.md` — mrkdwn format table, `slackify-markdown`, Block Kit `rich_text`
- `research/20260317_slack_tool_approval_block_kit.md` — Block Kit block types: `section.fields`, `context`, `header`, `actions`; 50 block limit; `text` fallback requirement
- `research/20260227_slack_vs_telegram_relay_adapter.md` — mrkdwn dialect, Block Kit JSON structure, Slack text field limits
- [slackify-markdown on npm](https://www.npmjs.com/package/slackify-markdown) (179K weekly downloads, v5.0.0)
- [The Only Guide to Slack mrkdwn Formatting — DEV Community](https://dev.to/suprsend/the-only-guide-to-slack-mrkdwn-not-markdown-formatting-w-codes-4329)
- [Block Kit | Slack Developer Docs](https://docs.slack.dev/block-kit/)
