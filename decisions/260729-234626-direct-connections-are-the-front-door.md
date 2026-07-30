---
id: 260729-234626
title: 'Direct connections are the front door: vendor MCP + OAuth first, the aggregator is the long-tail engine, no DorkOS-held platform key'
status: accepted
created: 2026-07-29
spec: direct-connect
superseded-by: null
---

# 260729-234626. Direct connections are the front door: vendor MCP + OAuth first, the aggregator is the long-tail engine, no DorkOS-held platform key

## Status

Accepted

## Context

ADR 260718-045630 built the `ConnectorProvider` port with Composio (managed), Nango (self-host), and raw MCP (baseline). The connector-completion program shipped it end to end, and the first real-user test plus an adversarial design review (2026-07-29, `connections-ux-critique` artifact, DOR-745 thread) re-measured the landscape:

- Major vendors now run **official remote MCP servers with OAuth 2.1**: Linear, Notion, Vercel, Stripe, Sentry, Atlassian — and **Google Workspace** (`gmailmcp.googleapis.com` et al., bring-your-own OAuth client). Live probes issued client registrations to a localhost desktop client for Linear, Vercel, Notion, and Stripe.
- The MCP revision finalized 2026-07-28 blesses localhost redirects for native clients and replaces Dynamic Client Registration with **Client ID Metadata Documents** as the preferred no-prior-relationship mechanism (DCR stays as a compatibility rung).
- Slack **prohibits** unlisted apps from using its MCP server; the purpose-built Relay adapter already owns Slack and `recommendConnector` routes it there.
- MCP still has no multi-account primitive, but the gap is protocol-level, not physical: the DorkOS gateway can mint one `ConnectedAccount` per OAuth grant against the same vendor server, each with its own token in the encrypted store — the same trick the aggregator performs in its vault, done locally.

The zero-config story users actually want ("I never heard of Composio") is therefore achievable directly, with the strongest custody line DorkOS can honestly say.

## Decision

1. **Direct connection is the default lane.** The direct (raw-MCP) provider grows real OAuth 2.1 (PRM discovery → pre-registered → CIMD → DCR → prompt; `application_type: "native"`, PKCE S256, RFC 8707/9207) and **multi-account** (one account per grant, per-account token identity, per-account tool servers). Custody class: **`direct` — "The key stays on your machine."**
2. **Google Workspace connects directly through a DorkOS-registered OAuth client** (our name on the consent screen, token on the user's disk), with a bring-your-own-client-id escape hatch (the rclone pattern) for self-hosters.
3. **Composio remains, honestly scoped**: the engine for the long tail and a shortcut past OAuth-client registration — named plainly in its setup flow, one beat before a vendor consent screen names it anyway.
4. **No DorkOS-held platform key.** A DorkOS-owned aggregator key with `user_id` scoping is rejected: off-thesis for a local-first product, unbounded per-user cost, shared quota, unresolved terms — and unnecessary now that Gmail is reachable directly.
5. **Slack never enters the direct catalog** (prohibited in writing); the Relay adapter stays its answer.
6. **Shipping vendor names/marks/endpoints as preconfigured defaults is flag-gated on counsel review** (DOR-750). User-adds-server mode ships regardless.

## Consequences

- The Connections surface inverts around a service catalog whose strongest tiles carry the `direct` custody chip; the Providers section demotes to an advanced disclosure (`specs/connections-redesign`).
- The direct provider's fabricated `pollConnect` success must be fixed before any catalog work (verified authenticated initialize before `connected`).
- DorkOS hosts a stable Client ID Metadata Document on dorkos.ai; its URL becomes our `client_id` across vendors that support CIMD.
- Founder ops start early on the Google consent verification + CASA path (DOR-746) — the program's long pole.
- Per-vendor authorize-time behavior is unproven until the Linear spike (DOR-743) runs a real grant end to end; catalog sizing waits for it.
