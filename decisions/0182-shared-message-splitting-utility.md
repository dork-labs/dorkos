---
number: 182
title: Shared Message Splitting Utility Across Relay Adapters
status: draft
created: 2026-03-22
spec: slack-adapter-world-class
superseded-by: null
---

# 0182. Shared Message Splitting Utility Across Relay Adapters

## Status

Draft (auto-extracted from spec: slack-adapter-world-class)

## Context

The Telegram adapter has a `splitMessage()` function for splitting long messages at natural boundaries. The Slack adapter truncates long messages at 4000 chars via `truncateText()`, silently losing content. Both adapters need message splitting with platform-specific length limits and code-block awareness. We considered three approaches: keep adapter-specific implementations, create a shared utility in `payload-utils.ts`, or build a more complex message formatting pipeline.

## Decision

Extract and enhance `splitMessage()` into `packages/relay/src/lib/payload-utils.ts` as a shared utility used by both Telegram and Slack adapters. The enhanced version adds configurable max length (4000 for Telegram, 3500 for Slack), multi-priority split points (paragraph > line > word > hard cut), and code-block fence awareness (closing/reopening triple-backtick fences at split boundaries). Telegram is refactored to import from the shared location with no behavioral change.

## Consequences

### Positive

- DRY: single implementation for all adapters that need message splitting
- Code-block awareness prevents broken formatting in split messages
- Configurable max length accommodates platform differences
- Future adapters (Discord, etc.) get message splitting for free

### Negative

- Telegram adapter must update its import path (minor migration)
- Shared utility has slightly more complexity than the original Telegram-specific version
