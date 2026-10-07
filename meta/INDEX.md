# Meta Index

`meta/` holds the strategy and brand foundation for DorkOS: the current
positioning, the litepapers, the brand foundation, the value-architecture method,
customer voice, personas, agent etiquette and the website-copy working sessions.
This is the "why we build it and how we talk about it" layer, not a product-API
source of truth. For current product behavior, see the docs site (`docs/`) and
the internal developer guides (`contributing/`).

**Start here:** [`positioning-202610/00-overview.md`](positioning-202610/00-overview.md),
the canonical strategy statement since the 2026-10-06 vision reset. DorkOS is a
workspace for people and agents, built first for founders who run a business
with agents. The chat workspace is table stakes; what sets DorkOS apart is mini
apps (your agents build the tools your business needs), built for founders, and
ownership. Its [demo-claim gate](positioning-202610/00-overview.md#the-demo-claim-gate)
decides what any public surface may claim. Where an older file in this folder
disagrees with it, the overview wins; older files carry a banner saying so.

## Current strategy (`positioning-202610/`)

- [`positioning-202610/00-overview.md`](positioning-202610/00-overview.md): vision,
  mission, what sets us apart (mini apps, built for founders, ownership), the
  message stack (tagline, headline, supporting line) and the headline rules, audience, category, core ideas, trust by default, local first and
  cloud optional, launch scope, roadmap order, the demo-claim gate, open risks,
  and what it supersedes.

## Strategy and brand (root)

- [`dorkos-litepaper.md`](dorkos-litepaper.md): the full story (the office and
  the workers), with every capability labelled built, before launch or roadmap,
  plus the architecture that carries over. Rewritten 2026-10-06.
- [`brand-foundation.md`](brand-foundation.md): category, positioning, audience,
  origin story, voice, naming and taglines. Brought current 2026-10-07.
- [`agent-etiquette.md`](agent-etiquette.md): how an agent conducts itself in a
  room, DM or channel it shares with people and other agents. Present, useful
  and mostly quiet. Updated 2026-10-06 so its rules rest on judgment and the
  record, not on hard caps.
- [`user-care.md`](user-care.md): how we treat a person who reports a bug or asks
  for something.
- [`customer-voice.md`](customer-voice.md): real frustrations in people's own
  words. Everything collected so far is developer voice (Kai); founder voice is
  still to be gathered.
- [`linear-loop-litepaper.md`](linear-loop-litepaper.md): the design narrative
  for closing the product feedback loop with Linear plus Claude Code, the
  precursor thinking behind the `/flow` engine. Carries a staleness banner.

## Value architecture (method)

- [`value-architecture.md`](value-architecture.md): the method itself.
- [`value-architecture-applied.md`](value-architecture-applied.md): the method
  worked through for DorkOS. Its 2026-10 addendum (Message House v3) comes first.
- [`value-architecture-handbook.md`](value-architecture-handbook.md): the
  practitioner handbook.

## Personas (`personas/`)

Decision-making filters, referenced from `AGENTS.md`.

- [`personas/the-ai-native-founder.md`](personas/the-ai-native-founder.md):
  Ikechi, **the primary persona**. A semi-technical, T-shaped founder building a
  big business mostly with agents (partly grounded on a real user).
- [`personas/the-autonomous-builder.md`](personas/the-autonomous-builder.md): Kai
  Nakamura, **the secondary persona**. A developer running many agents across many
  projects.
- [`personas/the-prompt-dabbler.md`](personas/the-prompt-dabbler.md): the
  anti-persona. The boundary is operator mentality, not technical skill.
- [`personas/icp-agent-run-business.md`](personas/icp-agent-run-business.md): the
  ideal-customer profile, a founder-led business run mostly by agents.
- `personas/manifest.json` and `personas/config.json`: the persona registry and
  config. The manifest also lists the retired personas and their archive paths.

## Modules (`modules/`)

Per-module litepapers from February 2026, each with a 2026-10 roadmap note.

- [`modules/relay-litepaper.md`](modules/relay-litepaper.md): the Relay messaging
  module, planned to merge into one conversation system.
- [`modules/mesh-litepaper.md`](modules/mesh-litepaper.md): the Mesh agent
  discovery module.

## PM methodology (`linear-method/`)

A reference copy of the Linear method (principles and practices for building
products). It informed the design of the DorkOS `/flow` engine. It is reference
material, not the current spec: for how `/flow` behaves today see
[`contributing/flow-engine.md`](../contributing/flow-engine.md) and the
`/flow:*` commands. Entry point: [`linear-method/1-1--introduction.md`](linear-method/1-1--introduction.md).

## Website copy (`website-copy/`)

The working sessions behind the marketing-site copy.

- [`website-copy/decisions.md`](website-copy/decisions.md): the copy decisions of
  record. Decision 19 records the 2026-10 category, tagline and story; Decision 21
  records the message stack and headline rules; Decision 3 is retired;
  Decision 18 is updated.
- [`website-copy/process.md`](website-copy/process.md): how the copy was produced.
- `website-copy/brief/`: the February 2026 creative brief (superseded) and its
  supplement.
- `website-copy/rounds/`: per-round drafts (`01-big-idea`, `02-homepage`) and
  design reviews. Frozen history.

## Harness smoke (`harness-smoke/`)

Receipts from real harness smoke runs. See `harness-smoke/README.md`.

## History

- [`positioning-202607/`](positioning-202607/00-overview.md): the July 2026
  positioning review ("one place for every AI agent you run", developer
  beachhead, the two-act addendum, the July GTM plan and tracker). Superseded
  2026-10-06; every file is bannered.
- [`archive/dorkos-litepaper-v2.md`](archive/dorkos-litepaper-v2.md): the second
  litepaper (March 2026, "an operating system for AI coding agents").
- [`archive/dorkos-litepaper-v1.md`](archive/dorkos-litepaper-v1.md): the first
  litepaper (February 2026).
- [`archive/personas/`](archive/personas/): retired personas, each with a note on
  why: Priya Sharma, The Knowledge Architect
  ([`the-knowledge-architect.md`](archive/personas/the-knowledge-architect.md));
  Lil, The Private Professional
  ([`the-private-professional.md`](archive/personas/the-private-professional.md));
  and the earlier ICP, the AI-Native Dev Shop
  ([`icp-ai-native-dev-shop.md`](archive/personas/icp-ai-native-dev-shop.md)).
