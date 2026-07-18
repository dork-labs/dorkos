---
id: 260718-042209
title: 'Shapes monetization guardrails: free community shapes, vendor affiliate/placement, no paid placement in chats ever'
status: accepted
created: 2026-07-17
spec: null
superseded-by: null
---

# 260718-042209. Shapes monetization guardrails: free community shapes, vendor affiliate/placement, no paid placement in chats ever

## Status

Accepted

## Context

Shapes are becoming the installable-app unit for DorkOS — community-built and official-vendor-built alike (`plans/shapes-program.md` D2) — and a monetization boundary needs to exist before any vendor conversation starts (e.g., a Composio affiliate deal, a QuickBooks-style referral shape) or the marketplace's category/placement UI (`plans/shapes-program.md` W3) ships. Without a stated line, marketplace placement and vendor deals drift toward the single most lucrative and most trust-destroying pattern in the category: sponsored results woven into agent responses. The brand's honest-by-design pillar (`AGENTS.md` Quality Standard; `meta/brand-foundation.md`) and the "would Kai find it valuable" filter make in-chat ads a categorical non-starter, not a pricing tradeoff to weigh case by case.

## Decision

We will enforce three monetization rules for Shapes, confirmed by the founder 2026-07-17:

1. **Community shapes are free and forkable, never taxed** — no marketplace fee, no revenue share, protecting the fork → tweak → share flywheel (`research/20260717_shapes-byoa-positioning.md` §6).
2. **Official vendor shapes may monetize only through affiliate/referral links, certification programs, and clearly-labeled marketplace placement** — a labeled "featured" slot in browse/search surfaces, never disguised as an organic result.
3. **No paid placement inside chats, ever.** An agent's response can never be influenced, ranked, or populated by a vendor's payment. This is the load-bearing rule: it holds regardless of revenue pressure, applies to every current and future monetization surface (marketplace, Shapes, connectors), and any future monetization proposal that touches in-chat content is rejected on sight without re-litigating the tradeoff.

## Consequences

### Positive

- Removes the single highest-risk monetization path before any vendor partnership conversation starts, so business development never has to negotiate a sponsor's request for in-chat placement.
- Keeps the community flywheel (fork/tweak/share) untaxed, which the research treats as the core distribution mechanism for Shapes.
- Gives the marketplace placement UI (`plans/shapes-program.md` W3) an unambiguous scope: placement money can only ever touch browse/search surfaces, never the chat transcript.

### Negative

- Forecloses a monetization line (in-chat sponsored suggestions) that could be lucrative and that some agent products already use — this is a deliberate trust trade, not a revenue optimization, and it will recur as a temptation as monetization pressure grows.
- "Clearly-labeled marketplace placement" still needs its own UX and disclosure-copy definition before it ships — this ADR sets the boundary, not the label design.
- Vendor affiliate/certification programs require terms and possibly legal review before the first vendor shape monetizes — this ADR authorizes the category but does not build it.

## Alternatives Considered

- **Allow limited, clearly-labeled sponsored suggestions inside chat** (the pattern several consumer AI products use) — rejected: even labeled, it changes what an agent's response can be bought to say, which is the exact trust violation the brand's honest-by-design pillar exists to prevent.
- **Tax community shapes with a small marketplace fee to fund the platform** — rejected: it taxes the flywheel the whole Shapes strategy depends on for distribution (`research/20260717_shapes-byoa-positioning.md` §6), and the managed-data-layer/Cloud tiers are the intended revenue line instead (`11-revenue-model.md`).
- **Defer the guardrail decision until a vendor deal is actually on the table** — rejected: waiting means negotiating boundaries under commercial pressure instead of recording them while the incentive is only theoretical.
