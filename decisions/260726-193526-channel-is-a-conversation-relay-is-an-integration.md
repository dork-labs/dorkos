---
id: 260726-193526
title: '"Channel" means a conversation; Relay''s integrations are called "Integrations"'
status: accepted
created: 2026-07-26
spec: rooms
superseded-by: null
---

# 260726-193526. "Channel" means a conversation; Relay's integrations are called "Integrations"

## Status

Accepted. **Supersedes ADR-0224** (User-Facing "Channels" Vocabulary Over "Relay Adapters").

**Superseded in part by ADR 260804-021140** (Connections is the umbrella for the outside world). The Integration half of this decision — calling Relay's external adapters "Integration" — is retired in favor of "Connections", now that DOR-855 removed the network-sense "Connection" that had blocked that word. The Channel half — bare "channel" means a conversation — still stands unchanged.

## Context

ADR-0224 chose "Channels" as the user-facing name for Relay's external messaging integrations — Telegram, Slack, webhooks. Its reasoning was sound at the time and is worth restating rather than dismissing: "Channels" is what Twilio, Intercom and most chatbot platforms call this, and a user trying to connect an agent to Telegram does not search for "Relay Adapters."

What changed is that DorkOS is now building conversations of its own (ADR 260726-170125). In a product with a Slack-style sidebar, "channel" means a conversation — that is the dominant meaning of the word for anyone who has used Slack, Discord, Matrix or Zulip. So the word is now claimed by two concepts, and one of them renders **inside the other's surface**: `entities/session/config/origin-descriptors.ts:28` puts a badge reading "Channel" on rows in `RecentSessionRow`, which is the same sidebar a "Channels" nav section occupies. Two different meanings, one glance apart.

The first attempt at fixing this was to rename Relay's concept to "Connection". That was wrong, and ADR-0224 had already said why — it lists as a benefit that it "eliminates the 'Connections' naming collision." Checking what that collision was:

**"Connection" already means network connectivity, all over the health surfaces.** `ConnectionStatusBanner`, `ConnectionItem` ("Connection lost"), `use-sse-connection.ts`, `sse-connection.ts`, `SessionInspector`'s "Connection" row, `status-bar-registry.ts:374`, and `TestStep.tsx`'s "Connection successful / failed" — which genuinely is testing a socket. The status bar is always visible, so a user reading "Connection lost" beside a "Connections" settings tab would reasonably conclude their Telegram integration had dropped.

## Decision

We will use **"Channel"** for an in-cockpit conversation and **"Integration"** for Relay's external adapters. "Connection" is left alone and keeps meaning network connectivity.

The evidence for "Integration" was already in the repository: **`docs/integrations/building-relay-adapters.mdx`**. The documentation has been filing relay adapters under "Integrations" the whole time, so this aligns the UI to a name the project already picked rather than inventing one.

It also holds up on its own:

- **No collision.** "Integration" appears in about ten client files, all prose or dev mocks, with no competing user-facing concept.
- **It is the industry convention for this concept.** Slack, Linear, Notion and GitHub all have an Integrations section meaning exactly "connect this product to another product."
- **It satisfies ADR-0224's own argument better than "Channels" did.** A user wanting to connect an agent to Telegram looks under Integrations. "Channels" only reads that way on CPaaS products like Twilio and Intercom, which have no conversation concept of their own to compete with it. DorkOS now does.

Scope is user-facing copy and the component names carrying it. **Wire data does not change**: `ChannelTypeSchema` (`'dm' | 'group' | 'channel' | 'thread'`) keeps its values because it names the remote surface kind inside Slack or Discord — their word for their thing — and so do the `channelType` field and the `origin: 'channel'` value. Renaming those would invent a euphemism for something the external service itself calls a channel.

## Consequences

### Positive

- One word, one meaning, for all three previously colliding concepts: Channel (a conversation), Integration (an external adapter), Connection (network connectivity).
- The UI now agrees with `docs/integrations/`, closing a gap that predates this decision.
- ADR-0224's discovery goal is better served, not sacrificed.
- No schema, API, config or database change — display labels and component names only.

### Negative

- **This is the second rename of the same surface**, and users who learned "Channels" from ADR-0224 have to learn it again. That cost is real and is the price of not having anticipated an in-cockpit conversation concept in April.
- The vocabulary gap ADR-0224 named gets wider: internal code still says `RelayAdapter`, `AdapterConfig`, `BindingStore`, and now the UI says "Integration", so contributors map a third term rather than a second.
- `docs/`, research artifacts and shipped changelog entries still say "Channels" for the old meaning. Changelog history is deliberately not rewritten, so a reader of old release notes will meet the superseded word with no signpost.
- "Integration" is a longer, blander word than "Channel". It is more accurate and less evocative, and some UI copy gets slightly heavier for it.
