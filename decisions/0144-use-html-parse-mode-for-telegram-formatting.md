---
number: 144
title: Use HTML Parse Mode for Telegram Formatting
status: draft
created: 2026-03-18
spec: relay-adapter-code-quality
superseded-by: null
---

# 0144. Use HTML Parse Mode for Telegram Formatting

## Status

Draft (auto-extracted from spec: relay-adapter-code-quality)

## Context

The Relay adapter system converts standard Markdown from agent responses to platform-specific formats. Slack uses `slackify-markdown` (existing dependency). Telegram's `formatForPlatform('telegram')` was a passthrough with a TODO — users saw raw markdown markers instead of formatted text.

Telegram supports two parse modes: `MarkdownV2` and `HTML`. MarkdownV2 is closer to the source format but requires escaping 18 special characters (`.`, `!`, `-`, `(`, `)`, `+`, `=`, `{`, `}`, `>`, `#`, `|`, `~`, and more). HTML only requires escaping `&`, `<`, `>`.

## Decision

Use `parse_mode: 'HTML'` for Telegram message formatting. Implement a lightweight `markdownToTelegramHtml()` converter that transforms standard Markdown to Telegram's HTML subset (`<b>`, `<i>`, `<s>`, `<code>`, `<pre>`, `<a>`).

## Consequences

### Positive

- Simpler implementation — HTML entity escaping is 3 characters vs 18+ for MarkdownV2
- More robust — fewer edge cases with nested formatting and special characters
- Follows the pattern established by `slackify-markdown` (platform-specific converter in a single function)
- No new dependencies required — inline implementation

### Negative

- Lossy conversion — some Markdown features (tables, footnotes, task lists) have no HTML equivalent in Telegram's subset
- Headings are converted to bold text (Telegram has no heading tag)
- Two-step conversion (escape HTML entities, then insert tags) means the converter must be careful about ordering
