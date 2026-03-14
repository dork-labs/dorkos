---
number: 119
title: Use Socket Mode Only for Slack Adapter
status: draft
created: 2026-03-13
spec: slack-adapter
superseded-by: null
---

# 119. Use Socket Mode Only for Slack Adapter

## Status

Draft (auto-extracted from spec: slack-adapter)

## Context

Slack offers two event delivery mechanisms: Socket Mode (WebSocket-based, no public URL required) and HTTP Events API (webhook-based, requires public HTTPS endpoint). The Telegram adapter supports both polling and webhook modes. DorkOS is a self-hosted tool often running behind firewalls or on developer laptops.

## Decision

Support Socket Mode only. Do not implement HTTP Events API for the Slack adapter. This mirrors the "polling-first" philosophy of the Telegram adapter while being even simpler (one mode, not two).

## Consequences

### Positive

- No public URL required — works behind firewalls, NATs, and on laptops without ngrok/tunnel setup
- Simpler adapter code — no webhook server, no signing secret verification for inbound events
- Fewer config fields for users (no webhookUrl, webhookPort, webhookSecret)
- Slack's explicit recommendation for single-tenant, self-hosted apps
- Socket Mode's 10-connection limit is irrelevant for single-tenant DorkOS

### Negative

- Socket Mode connections can drop, and Slack does not replay missed events during the reconnection window
- HTTP mode would be more reliable at scale (retries, load balancing) but DorkOS is single-tenant
- If a future use case requires HTTP mode, a new adapter mode would need to be added
