---
id: 260804-021140
title: '"Connections" is the single umbrella for the outside world, and this is the last rename'
status: accepted
created: 2026-08-04
spec: language-ia-simplification
supersedes: '260726-193526 (Integration half only)'
superseded-by: null
---

# 260804-021140. "Connections" is the single umbrella for the outside world, and this is the last rename

## Status

Accepted. **Supersedes the Integration half of ADR 260726-193526** ("Channel" means a conversation; Relay's integrations are called "Integrations"). The Channel half of that ADR — bare "channel" means a conversation — still stands and is not touched here. **Confirms** the Connections surface named in ADR 260729-234626 (Direct connections are the front door).

## Context

This is the **third** rename of the same surface in about four months. It is worth being honest about that up front, because the first two failed for a reason this one fixes, and the record needs to say why this is the last one rather than the next in a series.

- **ADR-0224** named Relay's external messaging surface **"Channels"** (Telegram, Slack, webhooks). It read well for a CPaaS-style product, but DorkOS then grew conversations of its own, and "channel" became the sidebar's word for a conversation. One word, two concepts, one glance apart.
- **ADR 260726-193526** renamed it **"Integration."** It fixed the Channel collision and matched what `docs/integrations/` had always called it. But it left a second problem standing, which it named explicitly: **"Connection" already meant network health** all over the cockpit — `ConnectionStatusBanner`, the status bar's "Connection lost", `SessionInspector`'s "Connection" row, the wizard's "Connection successful". The obvious umbrella for the outside world, "Connections", was blocked because a user reading "Connection lost" beside a "Connections" tab would think their Telegram link had dropped. So the surface got the blander, more distant word instead of the one users actually reach for.

Two things changed since then, and together they unblock the good word:

1. **The connector program shipped** (ADR 260729-234626): vendor OAuth + MCP accounts (Gmail, GitHub, Notion, Linear...) as first-class "services your agents can act on." The outside world is now clearly **two** things — inbound messaging (who reaches your agents) and outbound accounts (what your agents act on) — that want a **single** front door with two rooms, not two sibling nav items.
2. **DOR-855 retired the network-sense "Connection"** (Wave 1 of this program). A pinned vocab-gate script (`scripts/check-vocab-gate.ts`) now fails the build if the singular word "connection" reappears in user-facing copy for network health; that copy moved to a plain-language family ("reachable", "server link", "test passed"). The identifiers stayed (`ConnectionState`, `use-sse-connection`, React Flow's `Connection`) — the gate reads copy positions, not code.

**That is the finality argument.** Every prior rename of this surface failed because it collided with a word already in use. "Channels" collided with conversations; "Connections" was blocked by network health. DOR-855 removed the collision's other party. With the network sense gone, "Connections" is free, and it is the word a person actually searches for when they want to wire an agent to the outside world. There is no fourth word waiting to displace it, because the thing that displaced the first three — a live collision — no longer exists.

## Decision

**"Connections" is the single user-facing umbrella for everything outside DorkOS.** One nav item, one page (`/connections`), two named regions with distinct verbs and distinct consent stories:

- **Messaging** — "Where people and platforms reach your agents" (Telegram, Slack, webhooks). Runs on Relay.
- **Accounts** — "Services your agents can act on for you" (Gmail, GitHub, Notion...). Runs on the ConnectorProvider port.

From cockpit chrome we **retire** the words `integration`, `connector`, `adapter`, and `provider` as user-facing nouns. The Settings → Integrations tab is deleted; the per-agent accordion, the session inspector group, and the origin badge all say "Connection(s)". The carrier plumbing, when summoned, is named for what it is — the Accounts region's advanced section is titled **"Composio & Nango"**, never "Providers" or "Engines" (both failed a live comprehension test with the founder).

This decision is **display copy only**. It changes no wire format, API path, schema name, or architectural seam. The two-layer split below is the point of the ADR: the product vocabulary and the architecture vocabulary are allowed to differ, on purpose, and each is internally consistent.

### The product ↔ architecture mapping

Everything in the left column is what a user reads. Everything in the right column keeps its name and is deliberately unchanged.

| What the user sees (product copy)                                                   | What stays unchanged (wire / API / schema / seam)                                                                                               |
| ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| **Connections** (nav item, page)                                                    | `/connections` is a UI route only; no wire noun named "connections"                                                                             |
| **Messaging** region                                                                | Relay subsystem: `relay.*` subjects, `RelayAdapter`, `/api/relay/*`, `adapters.json`                                                            |
| **Accounts** region                                                                 | `ConnectorProvider` port (`packages/shared/src/connector-provider.ts`), `/api/connectors/*`, `ConnectedAccount`, `connector-attachments` schema |
| A **connection** (messaging kind)                                                   | a `RelayAdapter` plus its binding — `AdapterConfig`, `BindingStore`, `/api/relay/bindings`                                                      |
| A **connection** (account kind)                                                     | a `ConnectedAccount` obtained through a `ConnectorProvider`                                                                                     |
| **"Composio & Nango"** (advanced)                                                   | the `ConnectorProvider` implementations; `provider` identifiers, `/api/connectors/providers/*`                                                  |
| network status: "reachable", "server link", "test passed"                           | `ConnectionState`, `use-sse-connection.ts`, `sse-connection.ts`, React Flow `Connection`                                                        |
| a **channel** (a conversation)                                                      | `ChannelTypeSchema` (`'dm' \| 'group' \| 'channel' \| 'thread'`), `channelType`, `origin: 'channel'`                                            |
| **Marketplace** facets: Agents, Plugins, Skill Packs, Adapters + Connectors, Shapes | package-type manifest keys authors write — unchanged (see the registry below)                                                                   |

The rule: a rename that would force a schema migration, break a stored binding, or make a contributor translate the same word across a network boundary is not worth the display polish. So the wire kept its names, and the surface got the human ones.

### The scoped-word registry (P6 viewport test)

A word may live in more than one place if its senses never share a viewport. **A scoped word is legitimate only if its two domains never render in the same viewport; where a bridge between domains is unavoidable, it is stated in words.**

| Word                         | Where it is allowed                                                                                            | Where it is banned                                                                              | Test                                                                 |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| **Relay**, **Mesh**          | subsystem brands: marketing pages, docs concept pages, architecture docs                                       | cockpit chrome — say "Messaging is off", not "Relay is disabled"; "Agent discovery", not "Mesh" | a user never sees the settings toggle and the concept doc at once    |
| **adapter**, **connector**   | marketplace-author domain (package facets, manifest keys) + architecture (`RelayAdapter`, `ConnectorProvider`) | cockpit chrome outside the marketplace                                                          | the marketplace catalog and the Connections page are different pages |
| **provider**                 | OpenCode's model-provider picker; summoned plumbing (the "Composio & Nango" card's internals)                  | the Accounts region's own copy — it says "Composio & Nango", never "provider"                   | the model picker and the Connections page never co-render            |
| **channel** (platform sense) | only when platform-qualified: "Slack channel", "Telegram channel"                                              | bare "channel" — that is always a DorkOS conversation                                           | the qualifier is the disambiguator, in the same breath               |

The bridges that **do** cross a viewport are made explicit in copy rather than hidden. In the marketplace, an adapter card carries a region-matched bridge line into the Connections vocabulary (a messaging adapter reads "Adds a new way to reach your agents"; a connector-refinement adapter reads "Adds a new service your agents can act on"), and the install toast deep-links to the matching Connections region. That is the seam between the marketplace-author word "adapter" and the user word "connection", said out loud.

## Consequences

### Positive

- One word, one meaning, for the outside world: **Connection**. The three previously-colliding surfaces are each disjoint now — Channel (a conversation), Connection (the outside world), and network health (which no longer borrows a noun at all).
- The umbrella finally matches the search intent. A user wiring an agent to Telegram or Gmail looks under Connections, and both live there.
- No schema, API, config, or database change. A stored binding, a connected account, and a relay subject all keep working across the rename.
- The two-layer split is now recorded, so the next contributor who notices the UI says "Connection" while the code says `RelayAdapter` reads this table instead of filing a bug or "fixing" the drift.

### Negative

- **It is genuinely the third rename**, and it partially supersedes an ADR accepted eight days earlier. Users who learned "Integrations" have to learn "Connections". The release note owns this directly ("Integrations is now part of Connections") and says why it is the last one.
- Old changelog entries and research artifacts still say "Channels" and "Integrations" for the superseded meanings. Changelog history is deliberately not rewritten, so a reader of old release notes meets the retired words without a signpost.
- The two-layer split is a standing maintenance obligation: the vocab-gate protects the network-sense retirement, but nothing mechanically enforces that new cockpit copy avoids "integration/connector/adapter/provider". A follow-up wave of the gate (banned-terms `wave-2`) is scoped for those words but not yet landed, so until it is, the discipline is human.
- One user-facing residue is left standing on purpose: the marketing site's feature taxonomy still labels this feature with the `integration` category, which renders on dorkos.ai. It predates this capstone and belongs to the not-yet-landed Wave-2 vocab work, not a docs pass, so it is recorded here rather than quietly renamed under a docs change.
- "Connection" is a slightly heavier word than "Channel". It is more accurate and unambiguous now, which is the trade this whole program is making on purpose.
