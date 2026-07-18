---
title: 'Shapes, Shape-Shifting, and BYOA — Positioning Evaluation and Product Direction'
date: 2026-07-17
type: research
status: active
tags:
  [
    positioning,
    branding,
    shapes,
    generative-ui,
    extensions,
    byoa,
    byom,
    marketplace,
    meta-harness,
    naming,
  ]
---

# Shapes, Shape-Shifting, and BYOA — Positioning Evaluation and Product Direction

**Scope**: founder-initiated evaluation (2026-07-17) of rebranding DorkOS around "shape-shifting" generative UI + extensions, which evolved into a broader strategic synthesis: the BYOA/copilot-flip thesis, the "Shape" product primitive, marketplace taxonomy, and a naming system. Sources: full read of `meta/positioning-202607/`, codebase capability inventory, and three web-research passes (landscape, BYOA/pricing, connector gateways). Web claims sourced by agents on 2026-07-17.

---

## 1. Verdicts (decisions and leanings from the founder conversation)

- **Keep the name "DorkOS" and the "You, Multiplied." roof.** Confirmed by founder; consistent with `meta/positioning-202607/02-positioning.md` §7 (rename considered and rejected).
- **"Shape-shifting" is viable as the capability brand**, not the company identity. Conditions: it modifies a concrete noun ("the shape-shifting \_\_\_"), the sidekick narrative keeps the customer as hero (StoryBrand-compliant), and the demo-claim gate applies — no marketing the claim until a reference Shape ships end-to-end. Collision scan: no product brands itself "shape-shifting"; existing usage is academic HCI + an icon tool (shapeshifter.design). ShapeShift (crypto) owns only the one-word noun.
- **"World's first shape-shifting X" is defensible as a term claim** (nobody claims it) — but NOT "world's first meta-harness" (Databricks **Omnigent** self-describes as "a meta-harness," June 2026, with mainstream press).
- **"Meta-harness": embrace as category descriptor, never as identity.** Use in SEO/docs/comparison surfaces ("What is a meta-harness?" concept page — the term is in its explainer phase, an SEO land-grab moment). Keep the differentiation line: "a meta-harness is a dashboard; DorkOS is the coordination layer under one." Note the confusable second academic meaning (meta-agent that rewrites another agent's harness).
- **"Malleable"**: rejected by founder for marketing (academic-flavored). Provenance for the record: Ink & Switch essay "Malleable Software" (Geoffrey Litt, Josh Horowitz, Peter van Hardenberg, June 2025); Malleable Systems Collective (malleable.systems, ~2019). May cite once in a manifesto essay for Priya-tier credibility.
- **No paid placement inside chats — ever.** Founder agreed. Sponsored content in agent responses would destroy the "honest by design" trust position. Marketplace featured placement with clear labeling is the ceiling.
- **"Cockpit"**: founder never loved the word. Note: it's also semantically imprecise — a cockpit flies _one_ plane; DorkOS coordinates a fleet. "Mission control" (already primary) and "control tower" are fleet-accurate alternatives; "sidekick" works as the _narrative role_ (the shape-shifting companion), not the place-noun. Caution: GitHub announced "Agent HQ" (Oct 2025) — "HQ" is contested.

## 2. The naming system

The strongest product vocabularies pair a **verb** (what it does), a **noun** (what you install), and a **meme line** (what spreads). Recommendation:

- **Verb/adjective: shape-shift / shape-shifting** — founder's term, unclaimed, fun, animatable.
- **Noun: Shapes** — coined in this session (not a prior DorkOS or industry term). The concrete unit that keeps "shape-shifting" from being vapor (cf. Notion blocks, Slack channels). ⚠️ Collision: **shapes.inc** — funded Discord AI-companion app (TechCrunch Apr 2026, ~$8M seed, 400K+ MAU, "user-created Shapes"). Different category (consumer companions vs. dev cockpit); acceptable as an in-product feature noun, contested as a headline brand. Fallback noun: **Loadouts** (cleanest collision scan of all candidates).
- **Meme line: "Never its final form."** (DBZ energy, dev-native, shareable.)
- **Explainer metaphor: the game console.** "Same console, different cartridge, different machine." Clearest 5-second explanation of Shapes.

Killed by collision scan: **Morph** (Morph Labs — AI-coding infra, same category, worst collision), **Shift** (shift.com multi-app workstation browser), **Chameleon** (chameleon.io + camouflage-not-transformation semantics), **Origami** (Meta Origami Studio), **Decks/Desks** (colonized). Other candidates evaluated: Gears ("switch gears" idiom, clean), Many Hats (names the ICP; Red Hat adjacency), Stations (mission-control-native, safe, not viral), Multiform (brand-family fit with "You, Multiplied"), Rigs (share-your-rig culture; needs check).

## 3. The strategic spine: BYOA / the copilot flip

Founder thesis: instead of every SaaS app embedding its own margin-stacked agent, apps expose data + tools (MCP) and users bring their own agent/model. The copilot paradigm flipped: apps come into one agent-centric system. **Shape-shifting and BYOA are one thesis** — the flip is the strategy, BYOM is the economics, Shapes are the unit (an app's presence in your cockpit: MCP data + tools + UI), the marketplace is distribution, shape-shifting is the experience.

Evidence (web research, 2026-07-17):

- **AI fee fatigue is documented**: Zylo 2026 SaaS Management Index — 78% of IT leaders hit with unexpected AI charges, 79% saw AI price increases at renewal, 61% cut projects; Uber burned its 2026 AI budget in four months, capped engineers at $1,500/mo; GitHub Copilot's June 2026 usage-billing move ("Tokenpocalypse") produced $29→~$750/mo bills and public exit threats; Salesforce Agentforce changed pricing 3× in 18 months. Sharpest hook: **unpredictable pass-through billing**, more than "they serve you the cheap model" (both exist).
- **Supply side arrived**: official/remote MCP servers from Linear, Notion, PostHog, Sentry, Stripe, Atlassian, HubSpot, Slack (~16→25+ remote servers Jan–Apr 2026). **MCP Apps (SEP-1865) goes final 2026-07-28** — interactive UI over MCP, the literal mechanism for official Shapes.
- **Prior art**: Val Town (Pete Millspaugh) published "Bring Your Own Agent (BYOA)" 2026-02-25 (blog.val.town/byoa) — near-identical thesis ("$500–1,000/mo black boxes"). "BYOA" also has two other circulating meanings: bring-your-coding-agent-into-an-orchestrator (Augment Code, JetBrains — what DorkOS already does) and Microsoft's bring-your-agent-into-Copilot. **The term must be defined on first use, or coin our own frame ("the copilot flip").**
- **Scope honestly**: Gartner projects 40% of enterprise apps embed agents by end-2026 — the center of gravity is still "embed." Ben Thompson (Feb 2026) frames the horizontal-vs-bound-agent tension but picks Microsoft (identity) as the horizontal winner. BYOA is a **wedge** aimed at people who feel the fee pain (developers, operator-founders) — i.e., Kai and Ikechi — not a claim the whole market flips.
- a16z, "Is Software Losing Its Head?" (May 2026): UI-based SaaS moats erode as agents hit APIs directly; Salesforce hedged by shipping "Headless 360" alongside Agentforce.

## 4. Capability ground truth (codebase inventory, 2026-07-17)

The shape-shifting story is **more shipped than the positioning docs credit** (extensions ranked #14/17 in `03-feature-ranking.md`; generative UI unranked):

- **Shipped**: 24-node declarative widget catalog (` ```dorkos-ui ` fences, interactivity round-trip via `/api/sessions/:id/ui-action`); PIP live-widget surface (verified interactive tic-tac-toe vs. agent); MCP Apps host (hand-rolled, not `@mcp-ui/client`); 12-variant multi-document canvas/workbench (files, terminal, browser, 3D, CSV, diff); `control_ui` tool (~20 actions); full extension platform (8 slots, esbuild pipeline, hot reload) with **agent-built extensions** (`create_extension` → `test_extension` → `reload_extensions`); marketplace plugins install extensions transactionally.
- **Scoping ground truth**: an agent **is** a directory (`.dork/agent.json`; `switch_agent` is literally `{cwd}`). Extension discovery is cwd-scoped (`~/.dork/extensions/` + `{cwd}/.dork/extensions/`, local wins) but enable/disable is one global list; a cwd change that alters the extension set triggers a **full page reload** (`use-cwd-extension-sync.ts`). `ExtensionAPI.getState().agentId` is a stub (always `null`). **Bug found**: `control_ui switch_agent` host callback never wired in production → silent no-op (captured as **DOR-354**). Precedents: per-agent right-panel layout map (DOR-227, localStorage); ADR 260717-001409 put sidebar org in _user config_, explicitly rejecting agent-manifest UI state ("a group is a personal cockpit preference, not a property of the agent"). **"Workspace" is a taken term** (git worktree/clone checkouts, `services/workspace/`).
- **Gaps for "the UI becomes an app"**: no full-page/route extension point (slots are shell sub-regions); extension storage is one JSON blob (no queries/schema); no sandboxing for client extensions; no cross-machine state sync; no packaged "install one thing → complete app experience" pattern demonstrated.

## 5. The Shape primitive (working design)

**A Shape = a named, installable bundle: extensions (UI) + panel/canvas layout + one or more agents + skills + MCP connections + schedules.**

- **Shape as place, not agent property.** Arguments against hard agent-binding (founder is undecided; these are the counterpoints): a shape is the _office_, agents are _staff_ — you summon agents into a context, not rebuild the office per worker; multi-agent shapes (content pipeline with several agents) make per-agent binding ambiguous; team futures share shapes while agents stay personal; ADR 260717-001409 already drew this line; under BYOA the shape is "the app" and agents/models are swappable operators. Affinity direction: **shape → suggested agents**, with at most a soft default-shape pointer on an agent.
- **Ontology**: extensions are _parts_; Shapes are _wholes_ (Shapes contain extensions). An MCP server with UI (MCP Apps) is an _ingredient_ a shape uses (auto-wrappable as a lightweight shape). Consumer rule: _if installing it changes what DorkOS is for you, it's a Shape; if it adds a capability, it's a plugin/extension._
- **When people switch shapes**: when they switch jobs-to-be-done. Kai: per-project + per-activity (coding / release-day / triage). Priya: per mode of thought (research vs. build). Ikechi: per company × function (3 businesses × CRM/content/finance) — the heaviest user; multi-company = shape sets. Team future: per role, shapes shared via team marketplace sources.
- **Smallest enabling changes** (from codebase report): wire real `agentId` into `ExtensionAPI.getState()`; fix DOR-354; replace the extension-set reload with live re-mount; extend `visibleWhen` context with `agentId`/`cwd` (and stop hardcoding it `undefined` for extension slots); optional `agentAffinity` manifest field; add `apply_layout`/shape-switch to `UiCommandSchema`; name the layout concept "Shape" (not "workspace" — taken).

## 6. Priorities, demos, monetization

- **Install > modify > build.** Installing official Shapes rides existing vendor MCP servers; **fork → tweak → share** is the community flywheel ("I made my own version" is what people post — cf. presets/mods/VS Code themes/Notion templates); building net-new live is the _proof_ demo that makes "modify anything" believable.
- **Demos** (order): (1) fork-a-shape → tweak → share; (2) install-a-shape (one install → sidebar tab + dashboard + scheduled agent); (3) live-build ("watch it grow a tool"); (4) PIP live widgets. PIP ideas: **AI spend meter** (turns BYOA economics into a visible widget — for budget-holders) and **fun/universal real-time widgets** for everyone else (live sports score you can talk to; deploy monitor; delivery tracker). Extensions poll at a 5s floor today — near-real-time OK, true streaming needs WS support.
- **Monetization lines**: free/forkable community shapes (don't tax the flywheel); official vendor shapes with affiliate/referral (e.g., QuickBooks signup), certification, clearly-labeled marketplace placement; managed data layer later (Obsidian Sync playbook: free local-first core, paid sync/multi-user data) — consistent with no-hosted-SaaS-at-launch. **No in-chat placement** (see §1).

## 7. Open strategic question: developer vs. business-user positioning

Founder direction (2026-07-17): "Right now we're positioned for developers. Instead, I'd like to position towards business users… especially with our Shapes." Tension: the entire `positioning-202607` corpus is built on the developer/operator beachhead, an imminent 14-week GTM plan, and the demo-claim gate (business use cases are the _least_-verified surfaces). The strategy already moved the line once — "operator mentality, not technical skill" — so the door is Ikechi, not a repositioning. **Recommended resolution: two acts.** Act 1 (now): launch on the dev/operator positioning as planned; build Shapes + one reference business shape + evals behind it. Act 2 (evidence-triggered: N business shapes working, real Ikechi-cohort users, install friction ≈ zero via desktop app): expand positioning to operators/business builders. This decision gates most of the program plan and should be made explicitly (candidate for an ADR when resolved).

## 8. Investigation results (marketplace taxonomy, evals, connectors, Cursor Canvas)

### 8.1 Marketplace business-use-case taxonomy — mostly plumbed, no UI

The Segment-catalog-style category browse is **far closer than expected**:

- `BasePackageManifestSchema` already has `category` (free-text, `z.string().max(64).optional()`) + `tags` (`packages/marketplace/src/manifest-schema.ts:63-114`); `MarketplaceJsonEntrySchema` carries the same `category` as a **Claude-Code-native** field (ADR-0236 — a plural `categories[]` would need the sidecar treatment, since CC's validator rejects unknown keys).
- Client: the `/marketplace` URL schema already reserves `?category=` ("no UI yet" per its own doc comment, `marketplace-search.ts`), `filterPackages` does exact-match category filtering with tests — **only the facet UI is missing** (`MarketplaceHeader.tsx` has type tabs + search only).
- Site: `/marketplace?category=` already filters via `rankPackages()`; `PackageCard` renders category as plain text (not a link). **No `/marketplace/category/[slug]` route** — but `apps/site/src/app/(marketing)/features/category/[category]/page.tsx` is a fully-built SEO category-page template (static params, per-category metadata/canonical, BreadcrumbList + CollectionPage JSON-LD) to clone.
- The site catalog is fetched live from GitHub (`dork-labs/marketplace` `marketplace.json` + `dorkos.json`, hourly ISR) — Neon Postgres holds only install telemetry, not the catalog. Backfilling categories = editing the external registry repo.
- Remaining work: controlled vocabulary (closed enum or CI-checked list; decide singular vs. `categories[]`), validator + scaffolder support, client facet chips, site category links + SEO route, category-awareness in the 8 marketplace MCP tools (`tool-search`/`tool-recommend`), registry backfill.

### 8.2 Eval system — doesn't exist; every primitive does

- **No eval tooling anywhere** (no promptfoo/braintrust/judge/benchmark hits; no eval scripts). `runtimeConformance` is protocol-shape conformance against fakes; `test-mode` runtime is 100% scripted (no model, no tools); `smoke:integration` mocks the `claude` binary and never sends a chat turn.
- **The pattern already works once**: `apps/e2e/tests/chat/send-message.spec.ts` drives the **real ClaudeCodeRuntime** through the real UI ("Respond with exactly: hello world"; a Read-tool prompt asserting a tool-call card). Not run in CI (no workflow references playwright/e2e).
- **Insertion point**: a headless eval package (`packages/evals` or `apps/e2e/tests/evals/`) — boot real server + credentialed runtime, POST prompts via `/api/sessions/:id/messages`, collect SSE with `collectDurableEvents`-style helpers (`packages/test-utils/src/sse-test-helpers.ts`), assert on **API/filesystem outcomes** (package installed, extension compiled+enabled, task cron created, ui_command emitted) rather than DOM. Docker `integration` target is the CI container shape (swap the mocked `claude` shim for a credentialed binary, secret-gated).

### 8.3 Connector gateway ground truth

- **The MCP spec genuinely does not solve multi-account/multi-tenant OAuth** (spec discussion #234 treats it as open) — gateways fill a real gap, not a marketing one.
- **Composio**: best-in-class multi-account (`connected_account_id`/aliases, `max_accounts_per_toolkit`), 1,000+ toolkits, Rube MCP gateway; but **cloud token vault by default**, closed-source backend, self-hosting enterprise-gated; $0/20K → $29/200K → $229/2M calls (pricing changes 2026-08-15); Series A ~$25-29M (Lightspeed, ~Q1 2025).
- **Self-host-native alternatives**: Nango (ELv2, 800+ APIs, multi-tenant by design), Klavis Strata (MIT), MetaMCP (MIT, aggregation not vaulting), Docker MCP Gateway (weak multi-account), Open Connector (AGPL-3.0, new 2026, "open-source Composio" — early/unproven; AGPL needs legal review).
- **In-repo seams**: a connector gateway is **net-new** but extends three existing patterns — `services/core/credential-provider.ts` (encrypted reference-based secrets), the relay `adapter-manager`/`adapter-factory` shape (per-service adapters + consent gates, currently messaging-only), and the marketplace `adapter` package type as distribution. Cloud-link "Accounts" (RFC 8628 device link to dorkos.ai) and `services/runtimes/connect/` (runtime vendor credentials, delegated CLI login) are adjacent, not overlapping.
- Direction consistent with house style: a `ConnectorProvider` abstraction (the `AgentRuntime`/`Transport` pattern) — Composio as the batteries-included managed option, a self-hostable provider (Nango-class) for the privacy-first cohort, raw MCP as baseline.

### 8.4 Cursor Canvas (competitive marker — founder was right)

Cursor 3.1 (2026-04-16) shipped **Canvas**: agents generate persistent, interactive React UIs (`.tsx` files importing an IDE-injected `cursor/canvas` module) in the Agents Window — tables/charts/diagrams + Cursor's diff/todo components; Design Mode adds point-and-annotate steering. Limits: canvases live outside the repo (`~/.cursor/projects/<project>/canvases/`), can't render outside the IDE (third-party projects exist to liberate them), React/Vue/vanilla only. Validates agent-generated persistent UI as a mainstream direction; DorkOS's differentiators remain open rendering (MCP Apps standard vs. IDE-injected module), marketplace distribution, and shapes-as-installable-wholes.

### 8.5 Other

- Sports-demo feasibility: keyless ESPN/MLB StatsAPI + TheSportsDB free key; existing sports MCP servers (ESPN MCP, cyanheads/sports-mcp-server, mcp-sports-hub) — the "talk to the game" PIP demo is low-friction.
- Val Town verified: Steve Krouse (CEO) + Tom MacWright (CTO), ~6-person team; Pete Millspaugh (writer-engineer) authored the BYOA post (2026-02-25). Safe and advisable to cite; potential allies.
- Bug captured: **DOR-354** (`control_ui switch_agent` no-op).
- **Program plan**: `plans/` doc covering positioning addendum, Shape spec, wiring fixes, taxonomy, reference shape, evals, site/docs/litepaper updates, GTM sequencing — to be drafted next.

## 9. Source pointers

- Prior session research: `research/20260708_generative_ui_standards_dorkos.md` (two-tier gen-UI decision base), `meta/positioning-202607/00-overview.md`–`09-gtm-plan.md`, `meta/brand-foundation.md`, `meta/personas/`.
- Key external: Databricks Omnigent (meta-harness claim, June 2026); Val Town BYOA post (blog.val.town/byoa, Feb 2026); Ink & Switch "Malleable Software" (June 2025); a16z "Is Software Losing Its Head?" (May 2026); Stratechery "Microsoft and Software Survival" (Feb 2026); Zylo 2026 SaaS Management Index; MCP Apps SEP-1865 (final 2026-07-28); shapes.inc (TechCrunch Apr 2026); Morph Labs (morphllm.com); shift.com; chameleon.io.
