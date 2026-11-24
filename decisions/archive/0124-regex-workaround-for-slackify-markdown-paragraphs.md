---
number: 124
title: Regex Workaround for slackify-markdown Paragraph Breaks During Streaming
status: archived
created: 2026-03-14
spec: relay-adapter-streaming-fixes
superseded-by: null
---

# 124. Regex Workaround for slackify-markdown Paragraph Breaks During Streaming

## Status

Draft (auto-extracted from spec: relay-adapter-streaming-fixes)

## Context

The `slackify-markdown` library (v5.0.0) has a known issue (#40) where it inserts `\n\n` paragraph separators between block-level elements when converting Markdown to Slack's mrkdwn format. During streaming, intermediate `chat.update` calls render these double-newlines as visible line breaks, making each streaming chunk appear on a new line instead of flowing continuously. We considered two alternatives: switching to Slack's native `markdown` block type (requires blocks API migration) or replacing `slackify-markdown` entirely.

## Decision

Apply a targeted regex workaround — collapse `\n{2,}` to `\n` on intermediate `chat.update` calls only. The final `handleDone` update preserves the full paragraph formatting from `slackify-markdown`. This keeps the existing conversion pipeline intact and avoids a library migration.

## Consequences

### Positive

- Surgical fix (single `String.replace()` call) with negligible performance cost
- No dependency changes or library migration required
- Final messages retain proper paragraph structure
- Can be removed if/when slackify-markdown fixes Issue #40

### Negative

- Intermediate streaming previews lose paragraph structure (acceptable for progressive preview)
- Workaround may mask future formatting issues introduced by the library
