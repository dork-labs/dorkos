---
number: 125
title: Use Emoji Reaction as Slack Typing Indicator
status: archived
created: 2026-03-14
spec: relay-adapter-streaming-fixes
superseded-by: null
---

# 125. Use Emoji Reaction as Slack Typing Indicator

## Status

Draft (auto-extracted from spec: relay-adapter-streaming-fixes)

## Context

Slack has no native typing indicator API for bots (confirmed by Slack team in bolt-js Issue #885). Users want visual feedback while agents process messages. We considered three alternatives: (1) emoji reaction on the user's message, (2) temporary "thinking..." message that gets deleted, (3) Slack status update. The temporary message approach adds noise and requires additional API calls for deletion. Status updates affect the bot globally, not per-conversation.

## Decision

Use `:hourglass_flowing_sand:` emoji reaction on the user's original message. Add the reaction on stream start (fire-and-forget), remove it on stream completion or error. This requires adding the `reactions:write` bot scope, meaning users must re-install the Slack app. The feature is opt-in via `typingIndicator: 'reaction'` config (default: `'none'`).

## Consequences

### Positive

- Visible, low-noise indicator tied to the specific message being processed
- Only 2 API calls per stream (add + remove), well within Slack rate limits
- Fire-and-forget pattern doesn't block the streaming pipeline
- Opt-in design avoids forcing scope changes on existing installations

### Negative

- Requires `reactions:write` scope — users must re-install the Slack app to enable
- Not a native typing indicator (no animated dots) — may not match user expectations from other chat apps
