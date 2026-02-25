---
number: 19
title: Use grammY for Telegram Bot Integration
status: proposed
created: 2026-02-24
spec: relay-external-adapters
superseded-by: null
---

# 19. Use grammY for Telegram Bot Integration

## Status

Proposed (auto-extracted from spec: relay-external-adapters)

## Context

The Relay External Adapters spec requires a Telegram adapter that maps Telegram chats to Relay subjects. Three viable Node.js Telegram bot libraries were evaluated: grammY, Telegraf, and node-telegram-bot-api. The adapter needs TypeScript-first types, automatic retry for rate limits (429) and network errors, middleware error boundaries for handler isolation, and support for both long polling and webhook modes.

## Decision

Use grammY (`grammy` + `@grammyjs/auto-retry`) as the Telegram bot framework. Long polling is the default mode; webhook mode is opt-in via adapter config.

## Consequences

### Positive

- TypeScript-first with inline Bot API type hints — no separate @types package needed
- Built-in `@grammyjs/auto-retry` plugin handles 429 flood limits, 500 server errors, and network failures automatically
- Middleware error boundaries isolate handler failures without crashing the bot
- Active maintenance tracking latest Telegram Bot API versions
- 1.2M weekly npm downloads (vs 160K for Telegraf, 156K for node-telegram-bot-api)
- `bot.stop()` drains updates before shutdown — no message loss on restart

### Negative

- Adds a new dependency to `packages/relay/` (previously had no external API dependencies)
- Simple polling handles ~5K messages/hour — needs `@grammyjs/runner` upgrade for higher load (separate spec)
- Telegram bot privacy mode means bots only receive commands/replies in groups by default — requires user configuration via @BotFather
