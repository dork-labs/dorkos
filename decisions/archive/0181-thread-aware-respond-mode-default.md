---
number: 181
title: Default Slack Adapter to Thread-Aware Respond Mode
status: proposed
created: 2026-03-22
spec: slack-adapter-world-class
superseded-by: null
---

# 0181. Default Slack Adapter to Thread-Aware Respond Mode

## Status

Proposed

## Context

The Slack adapter currently responds to every message in every channel it has access to. In team workspaces, this floods channels with bot responses. OpenClaw's GitHub Issues (330K stars) document this as the #1 user complaint — users want the bot to only respond when @mentioned in channels, but continue conversations naturally in threads it has already joined. Three respond modes were considered: `always` (current behavior), `mention-only` (strict gating), and `thread-aware` (smart gating).

## Decision

Default the Slack adapter's `respondMode` to `thread-aware`. In this mode: DMs always process, @mentions in channels always process, and the bot continues responding in threads it has already participated in — without requiring repeated @mentions. This is implemented via an instance-scoped `ThreadParticipationTracker` (LRU Map, 1000 entries, 24h TTL) that records thread participation on outbound messages. The `always` and `mention-only` modes remain available as config overrides.

## Consequences

### Positive

- Eliminates the #1 complaint from AI Slack bot users (channel flooding)
- Natural conversation flow in threads without repeated @mentions
- DMs remain unrestricted (correct for developer tool use case)
- Backward-compatible: users can set `respondMode: 'always'` to restore current behavior

### Negative

- Slightly more complex inbound logic (gating checks before processing)
- Small memory overhead for thread tracking (~100 KB for 1000 entries)
- New users may initially be confused when bot doesn't respond to non-mentioned messages in channels
