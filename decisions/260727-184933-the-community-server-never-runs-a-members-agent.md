---
id: 260727-184933
title: The community server never runs a member's agent; hosted DorkOS is three products, not one
status: accepted
created: 2026-07-27
spec: community-server
superseded-by: null
---

# 260727-184933. The community server never runs a member's agent; hosted DorkOS is three products, not one

## Status

Accepted.

(2026-08-06 audit) Product 2 shipped as the CommunityAdapter port (packages/shared/src/community-adapter.ts) with local-SQLite and read-only Buzz backends, not the standalone apps/community described here; the never-runs-a-member's-agent policy holds for both.

## Context

DorkOS is building communities: shared rooms where several people and several agents talk (`specs/community-server/`, `260727-155419`). Two questions arrived together and turned out to be the same question.

**How does someone who does not run DorkOS join a community?** Requiring an install before you can read a chat invitation is the largest drop-off you can put in front of a person, and it makes communities developer-only — Ikechi and Lil never get in.

**Should there be a hosted DorkOS?** The stated goal was "similar to what Slack and Notion both do: access your account locally through an installed app, and on the web."

That comparison contains an inversion worth surfacing. **In Slack and Notion the server holds everything and the desktop app is a browser in a costume** — delete it and you lose nothing. DorkOS is the reverse: your machine holds the agents, the git checkouts, the model credentials, the filesystem. The install is not a client of the product; it **is** the product.

So "hosted DorkOS" is really asking _whose machine runs the agents_, and ADR-0320 already recorded why that question is not a deployment detail:

> anyone who can drive agents effectively holds the server process's filesystem access and spends the owner's Claude quota, so multi-user access is a trust-domain decision, not a UI toggle

On someone else's hardware, that sentence describes a liability rather than a preference.

## Decision

**Hosted DorkOS is three distinct products.** They are separable, they have different economics, and conflating them is what makes the question hard.

|                                                     | What it is                                                                                                                                                                        | Status                                                                        |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| **1. Remote access to your own install**            | Your phone or laptop reaching the DorkOS on your own machine, over a tunnel or a non-loopback bind. Your agents, your filesystem, your credentials — just reached from elsewhere. | **Already shipped.** Tunnel + ADR-0320's exposure guard. No new architecture. |
| **2. A hosted community server, with a web client** | `apps/community`: roster, channels, membership, message history. A browser client for people who just want to talk.                                                               | Being built.                                                                  |
| **3. Hosted agent execution**                       | A container per user, their repos in our storage, their model credentials in our custody, tenant isolation.                                                                       | A separate future product. Not scheduled.                                     |

**The load-bearing constraint, and the reason this is an ADR rather than a plan:**

> **The community server never executes a member's agent.**

Agents run on their members' own machines and connect in. A community holds the conversation; it does not hold compute. This is what keeps `apps/community` cheap enough to self-host, free of credential custody, free of the tenant-isolation problem, and — most importantly — it keeps the blast radius of any agent on the machine of the person who owns it.

**Presence follows the install.** If a member's computer is off, that member _and their agents_ are offline, the way a person who is asleep is offline. v1 does not queue for absent members and does not promise an agent will answer later. This is stated as an accepted property rather than a limitation to engineer around.

**When product 2's web client is built, it is deliberately incomplete.** You can join and talk; you cannot bring agents, because you have nowhere to run them. That is the honest shape: the limitation is real and visible, and the pull is other people's agents shipping work in the channel beside you.

## Consequences

### Positive

- `apps/community` stays a chat server. No container orchestration, no per-user compute, no cost curve that scales with agent usage.
- **No credential custody.** A member's Anthropic or OpenAI credentials never leave their machine, so a community-server breach cannot spend anyone's model quota or read anyone's source.
- The trust-domain boundary of ADR-0320 is preserved rather than relocated: whoever can drive an agent still holds only their own filesystem.
- Product 1 already exists, so a meaningful part of "use it on the web" needs nothing built.
- The upgrade path from web to install is a real capability difference, not a paywall.

### Negative

- **A community is only as available as its members' machines.** Ask a question at 3am and the agent whose owner is asleep does not answer. Accepted deliberately; if it becomes intolerable, product 3 is the answer, not offline queuing.
- The first community demo is developer-to-developer, since both participants need an install to bring agents. The browser client is the next milestone, not this one.
- Someone will eventually propose running "just a small agent" on the community server — a scheduled summary, a welcome bot, a moderation helper. **That is the boundary eroding**, and it should be refused or promoted to product 3 explicitly, never allowed in as an exception.

### Neutral

- Product 3 remains genuinely desirable and is not foreclosed. But it changes DorkOS from software people run into a service we operate — support, uptime, security, per-user cost — which is a company-shape decision, not an architectural one.
- The DorkOS account (`accounts-and-auth` P2: Better Auth on Neon Postgres, RFC 8628 device linking) is already the identity across all three products. That is what delivers the Slack-like feeling of one account and several surfaces, without inverting where the data lives.

## Related

- ADR-0320 — optional-by-default local login, required on exposure. Supplies the trust-domain argument and ships product 1.
- ADR 260726-170125 — a room is a membership-scoped durable stream.
- `specs/community-server/01-ideation.md` (`260727-155419`) — D2 (server-side `CommunityAdapter`) is what lets a member's agent reach a community without the community hosting it.
- `research/20260727_agent-identity-in-communities.md` — how Buzz admits an agent by owner attestation, and why revoking the human must revoke their agents.
