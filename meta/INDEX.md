# Meta Index

`meta/` holds the strategy and brand foundation for DorkOS: the litepapers, brand
positioning, value-architecture method, customer voice, personas, and the
website-copy working sessions. This is the "why we build it and how we talk about
it" layer, not a product-API source of truth. It is a point-in-time strategy
snapshot (largely Q1 2026) that sits outside the maintenance harness, so some
files use terminology the product has since moved past (for example the scheduler
shipped as Tasks, not Pulse, and the old `/pm` workflow is now `/flow`). For
current product behavior, see the docs site (`docs/`) and the internal developer
guides (`contributing/`). Files whose terminology has drifted carry a short
status banner at the top.

## Strategy and brand (root)

- [`dorkos-litepaper.md`](dorkos-litepaper.md): the full product vision: what
  DorkOS is, the platform/modules/extensions model, and the autonomy thesis.
  Carries a staleness banner.
- [`brand-foundation.md`](brand-foundation.md): brand and product positioning,
  origin story, voice, and naming. Carries a staleness banner.
- [`linear-loop-litepaper.md`](linear-loop-litepaper.md): the design narrative for
  closing the product feedback loop with Linear plus Claude Code, the precursor
  thinking behind the `/flow` engine. Carries a staleness banner.
- [`customer-voice.md`](customer-voice.md): real developer frustrations DorkOS
  solves, in the customers' own words.

## Value architecture (method)

- [`value-architecture.md`](value-architecture.md): the value-architecture method
  itself (the framework).
- [`value-architecture-applied.md`](value-architecture-applied.md): that method
  worked through for DorkOS specifically.
- [`value-architecture-handbook.md`](value-architecture-handbook.md): the
  practitioner handbook for applying it.

## Personas (`personas/`)

Proto-personas and the ideal-customer profile, with a manifest. Referenced
throughout `AGENTS.md` as decision-making filters.

- [`personas/the-autonomous-builder.md`](personas/the-autonomous-builder.md): Kai
  Nakamura, the primary persona.
- [`personas/the-knowledge-architect.md`](personas/the-knowledge-architect.md):
  Priya Sharma, the secondary persona.
- [`personas/the-prompt-dabbler.md`](personas/the-prompt-dabbler.md): the
  anti-persona (out of scope by design).
- [`personas/icp-ai-native-dev-shop.md`](personas/icp-ai-native-dev-shop.md): the
  ideal-customer profile.
- `personas/manifest.json` and `personas/config.json`: persona registry and
  config (used by the persona-toolkit tooling).

## Modules (`modules/`)

Per-module litepapers that go deeper than the main litepaper.

- [`modules/relay-litepaper.md`](modules/relay-litepaper.md): the Relay messaging
  module.
- [`modules/mesh-litepaper.md`](modules/mesh-litepaper.md): the Mesh agent-discovery
  module.

## PM methodology (`linear-method/`)

A reference copy of the Linear method (principles and practices for building
products). This PM methodology informed the design of the DorkOS `/flow` engine.
It is reference material, not the current spec: for how `/flow` actually behaves
today see [`contributing/flow-engine.md`](../contributing/flow-engine.md) and the
`/flow:*` commands. Entry point: [`linear-method/1-1--introduction.md`](linear-method/1-1--introduction.md).

## Website copy (`website-copy/`)

The working sessions behind the marketing-site copy: a creative brief, a process
log, recorded decisions, and the per-round drafts and design reviews.

- [`website-copy/decisions.md`](website-copy/decisions.md): the copy decisions of
  record.
- [`website-copy/process.md`](website-copy/process.md): how the copy was produced.
- `website-copy/brief/`: the creative brief and its supplement.
- `website-copy/rounds/`: per-round drafts (`01-big-idea`, `02-homepage`) and
  design reviews.

## Archive (`archive/`)

- [`archive/dorkos-litepaper-v1.md`](archive/dorkos-litepaper-v1.md): the
  superseded first version of the litepaper, kept for provenance.
