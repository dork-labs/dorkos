---
number: 118
title: Use Slack Native Streaming API for Agent Responses
status: draft
created: 2026-03-13
spec: slack-adapter
superseded-by: null
---

# 118. Use Slack Native Streaming API for Agent Responses

## Status

Draft (auto-extracted from spec: slack-adapter)

## Context

The Slack adapter needs to deliver streaming agent responses to Slack channels. Two approaches exist: the traditional edit-in-place pattern (post a placeholder message, then repeatedly call `chat.update` as tokens arrive) or Slack's native streaming API (`chat.startStream`/`appendStream`/`stopStream`) released in October 2025 specifically for AI agent use cases.

## Decision

Use Slack's native streaming API via the `chatStream()` helper in `@slack/web-api`. On each `text_delta` StreamEvent, call `streamer.append()`. On `done`, call `streamer.stop()`. This replaces the buffer-and-send pattern used by the Telegram adapter.

## Consequences

### Positive

- First-class streaming UX in Slack — tokens appear in real-time, similar to ChatGPT
- Avoids `chat.update` Tier 3 rate limits (~50 req/min), which would bottleneck concurrent agent sessions
- Supports Slack's built-in AI feedback buttons (thumbs up/down) via `stopStream` blocks
- Aligns with Slack's official recommendation for AI-powered apps

### Negative

- The streaming API was released October 2025 and may have undiscovered edge cases
- Requires verifying `chatStream()` TypeScript types from the installed package (docs.slack.dev was inaccessible during research)
- Not available for older Slack workspaces that haven't enabled the streaming feature (fallback not implemented in v1)
