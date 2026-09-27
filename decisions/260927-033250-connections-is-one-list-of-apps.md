---
id: 260927-033250
title: The Connections page is one list of apps, not two regions
status: accepted
created: 2026-09-27
spec: connections-one-list
superseded-by: null
amends: 260804-021140
---

# 260927-033250. The Connections page is one list of apps, not two regions

## Status

Accepted. **Amends** [260804-021140](260804-021140-connections-is-the-outside-world-umbrella-and-the-last-rename.md)
("Connections" is the single umbrella for the outside world, and this is the last rename). It
retires one clause of that decision: "One nav item, one page (`/connections`), **two named regions**
with distinct verbs and distinct consent stories: Messaging … Accounts". The page no longer has
regions. Everything else in 260804-021140 still governs: "Connections" is the umbrella, the words
integration, connector, adapter and provider stay out of user-facing copy, and the wire, API and
schema names stay as they are.

## Context

The page grew into six stacked sections (Communities, live chat bots, "Add a way to reach them",
message-delivery settings, Accounts, agent requests, then Composio and Nango keys at the bottom).
A person had to learn Messaging versus Accounts, managed versus own key, and Composio versus Nango
before connecting anything, and the account search answered "No matching services" whenever no
connection service was set up. The two regions asked two consent questions, but both reduce to one
question a person actually has: which agents get this app. The design session for
`specs/connections-one-list` (§1) compared one list against two tabs and chose one list.

## Decision

We will show every connection as one row in one list: **Yours** (each connected account, a second
account being a second row, and each chat app set up, marked with a small "Chat" tag) above **All
apps** (the catalog, with shelf chips and a small "For developers" group). Each row shows its state
and the one thing to do next. A connected row opens a side panel whose address is `?app=<id>`,
holding who can use it, recent activity and "Try it" prompts, with everything else folded under
More. Pending agent requests and program reviews sit in a "Needs you" strip that renders only when
something waits. Two decided reviews stay in it while they still need the person, by policy: an
approved connect for as long as its sign-in can be finished (the shared sign-in lifetime, 15
minutes by default), and an approved change DorkOS could not confirm for seven days. The plumbing moves off the page: how DorkOS reaches apps and how chat apps behave
live in Settings › Connections, communities live in the sidebar switcher, and the built-in agent
relay is never listed. `?region=` is retired; old links land on the list.

## Consequences

### Positive

- One question per row ("which agents get this?"), with nothing new to learn before the first
  connect; the list is the empty state on a first visit.
- Any surface can link to one app (`useOpenConnections({ app })`), so a chat card, the Control
  Center or a deep link opens exactly the panel it means.
- Chat apps and accounts share one row grammar, so a Marketplace chat app appears as an ordinary
  row with no new section.

### Negative

- The distinct consent stories the two regions made visible (who may reach your agents, versus what
  your agents may do as you) are now carried by each panel instead of by page structure; the chat
  app panel asks "Who answers", the account panel "Who can use it".
- A second account or a second bot is added from the app's panel, one step deeper than a catalog
  button, because an app with nothing left to set up leaves "All apps".
- Resolved program reviews no longer have a history list on the page; a decided review is still
  reachable by its `?review=` link.
