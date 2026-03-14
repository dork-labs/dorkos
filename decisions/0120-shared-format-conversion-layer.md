---
number: 120
title: Add Shared Format Conversion Layer to payload-utils
status: draft
created: 2026-03-13
spec: slack-adapter
superseded-by: null
---

# 120. Add Shared Format Conversion Layer to payload-utils

## Status

Draft (auto-extracted from spec: slack-adapter)

## Context

Different messaging platforms use different text formatting syntaxes. Slack uses "mrkdwn" (similar to Markdown but with differences like `*bold*` instead of `**bold**`). Telegram supports MarkdownV2 and HTML. Webhooks typically want plain text. Agent responses are standard Markdown. Each adapter currently handles format conversion independently (or not at all — Telegram sends plain text).

## Decision

Add a `formatForPlatform(content, platform)` function to `packages/relay/src/lib/payload-utils.ts`. This centralizes Markdown-to-platform conversion using `slackify-markdown` for Slack and can be extended for other platforms. The function is a thin wrapper with a platform switch — no separate module needed.

## Consequences

### Positive

- Single place to maintain format conversion logic across all adapters
- Future adapters (Discord, Matrix, etc.) get format conversion for free by adding a case
- `slackify-markdown` v5 is well-maintained (179K weekly downloads) and handles edge cases
- Consistent formatting quality across platforms

### Negative

- Adds `slackify-markdown` as a dependency to `packages/relay` (even if only the Slack adapter uses it initially)
- The `telegram` case is a pass-through for now — full Telegram Markdown conversion is deferred
- Platform-specific formatting edge cases may still need adapter-level handling
