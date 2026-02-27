# The Value Architecture — Handbook

A complete guide to the framework, its philosophy, its process, and how to apply it.

**Created**: 2026-02-27
**Companion to**: `meta/value-architecture.md` (operational reference with templates)
**Research basis**: `research/20260227_feature_benefit_marketing_frameworks.md` and `research/20260227_feature_to_benefit_messaging_patterns.md`

---

## Table of Contents

1. [What Is The Value Architecture](#1-what-is-the-value-architecture)
2. [Why It Exists](#2-why-it-exists)
3. [The Core Insight](#3-the-core-insight)
4. [Benefits of the Framework](#4-benefits-of-the-framework)
5. [The Process — End to End](#5-the-process--end-to-end)
6. [All Outputs — Intermediate and Final](#6-all-outputs--intermediate-and-final)
7. [AI Agent Application Guide](#7-ai-agent-application-guide)
8. [Human Input Requirements](#8-human-input-requirements)
9. [Quality Standards](#9-quality-standards)
10. [Maintenance and Evolution](#10-maintenance-and-evolution)
11. [Naming and Terminology](#11-naming-and-terminology)

---

## 1. What Is The Value Architecture

The Value Architecture is a systematic process for translating product features into human value. It takes what the product IS (code, capabilities, technical attributes) and maps it — through five ascending layers — to what it MEANS to the person using it (outcomes, emotions, identity).

It is not a single framework. It is a synthesis of 10+ proven marketing and positioning frameworks, each contributing its strongest mechanism:

| Source Framework | What It Contributes | Where It Appears |
|---|---|---|
| JTBD (Christensen, Ulwick, Moesta) | "Hire" motivation, job mapping, four forces of progress | Phase 1B, Layer 3 |
| Obviously Awesome (April Dunford) | Competitive alternatives as the foundation for differentiation | Phase 1A, Layer 2 |
| Means-End Chain (Gutman 1982) | Laddering from attributes through consequences to terminal values | Layer 4, the "Why?" probe |
| Brand Ladder (Aaker, Y&R, Ogilvy) | Self-expressive benefit, identity signal | Layer 5 |
| FAB (Sales training tradition) | Feature → Advantage → Benefit translation | Layer 1 → Layer 3 path |
| Apple Methodology (Jobs era) | Benefit-first headlines, human metric translation | Proof Anchor, Phase 4 templates |
| StoryBrand (Donald Miller) | Villain construct, three-layer problem | Phase 1D anti-positioning |
| Message House (PR/Corp Comms) | Hierarchical message organization: roof, pillars, proof | Phase 3A |
| Nike Brand Architecture | Identity platform → category → product layering | Phase 3, funnel-stage messaging |
| Value Proposition Canvas (Osterwalder) | Jobs/Pains/Gains taxonomy | Phase 1B enrichment |
| Developer Positioning Stack (emerging) | The four essential positioning questions for dev tools | Phase 1A validation |

The output of the process is a set of structured documents that serve as the **single source of truth for all marketing communications** — from homepage headlines to sales decks to social media to investor pitches.

### What It Produces

A **Value Architecture** for a product consists of:

1. **Ground Truth** — the strategic foundation (competitive landscape, jobs to be done, identity territory)
2. **Value Ladders** — per-feature maps from technical attribute to human identity
3. **A Message House** — the hierarchical messaging structure (primary message, pillars, proof points)
4. **A Headline Bank** — ready-to-use headlines at every benefit layer
5. **Funnel-Stage Messaging** — what to say at each stage of the customer journey
6. **Activation Templates** — copy patterns for homepage, feature pages, comparisons, and social proof

### Who It's For

| Consumer | How They Use It |
|---|---|
| **Founders / Product Leaders** | Define positioning, make messaging decisions, align the team |
| **Copywriters / Content Marketers** | Pull from the Headline Bank and Activation Templates to write |
| **AI Agents** | Parse YAML templates to generate, validate, and iterate on messaging |
| **Designers** | Understand what benefit layer each visual should communicate |
| **Sales / DevRel** | Use the Message House as a talk track; know which layer to lead with for each audience |

---

## 2. Why It Exists

### The Problem with Existing Frameworks

Every established marketing framework solves one part of the feature-to-value problem. None solve all of it. Teams that use a single framework get one of these failure modes:

**FAB-only teams** write competent copy that stops at functional benefits. Their messaging sounds like every other product in the category. They never reach the emotional or identity levels that create loyalty and word-of-mouth.

**JTBD-only teams** understand their customers deeply but can't translate that understanding into positioning or copy. They have great research and mediocre marketing.

**Dunford-only teams** have sharp competitive positioning but flat emotional resonance. They know what they're better at, but their messaging doesn't make anyone *feel* anything.

**Brand Ladder-only teams** produce beautiful emotional creative that floats above the product. The ads are stunning but nobody knows what the product actually does.

**StoryBrand-only teams** have a clean narrative structure, but every company that uses StoryBrand sounds structurally identical. The framework imposes a template that homogenizes voice.

The fundamental problem: these frameworks operate at different altitudes, and each altitude requires a different tool.

```
ALTITUDE         FRAMEWORK NEEDED          WHAT IT ANSWERS
─────────────────────────────────────────────────────────
Identity         Brand Ladder / Nike       "Who do I become?"
Emotion          Means-End Chain           "How does it feel?"
Outcome          JTBD / FAB               "What does it do for me?"
Differentiation  Dunford                  "Why this, not that?"
Feature          Product reality           "What is it?"
```

### The Solution

The Value Architecture integrates all five altitudes into a single, repeatable process. You don't pick a framework — you execute a process that automatically produces output at every altitude.

The process is designed so that:
- Each altitude builds on the one below it (the chain is causal)
- Every claim is grounded in product reality (no aspirational vapor)
- Every layer is validated by a specific quality test
- The entire output is structured in YAML for machine consumption
- Humans make the strategic decisions; machines do the generation and organization

---

## 3. The Core Insight

The single most important insight from the research, and the principle the entire framework is built on:

> **Higher benefit layers create deeper loyalty, but they require lower layers as proof. You cannot credibly claim an identity benefit without anchoring it in something functional.**

Apple says "Think outside the outlet" (identity: freedom from power cables) — but only AFTER proving "24 hours battery life" (functional). Nike says "Just Do It" (identity: you are an athlete) — but only AFTER decades of athletic performance products (functional). Linear says "Software should be crafted" (identity: you value craft) — but only AFTER delivering sub-100ms response times (functional).

The inverse is also true: stopping at functional benefits is leaving loyalty on the table. A functional benefit can be matched or exceeded by a competitor. An identity benefit creates tribal affiliation that no feature comparison can dislodge.

This is why the framework has five layers — not three (like FAB), not two (like most copy formulas). You need:
1. The feature (what it is)
2. The mechanism (why it's different)
3. The functional benefit (what you observe)
4. The emotional benefit (how you feel)
5. The identity benefit (who you become)

And you need them connected — each layer must causally follow from the one below.

### The Second Key Insight: "Compared to What?"

From April Dunford: features are only differentiated relative to alternatives. "Persistent memory" is meaningless in isolation. "Persistent memory — unlike every agent session that starts from scratch" is differentiated.

This is why Layer 2 (Mechanism) exists in the Value Architecture but doesn't exist in the traditional Brand Ladder or FAB model. It forces you to name the alternative before claiming differentiation. Without this layer, you get benefits that sound impressive but don't land because the audience has no frame of reference.

### The Third Key Insight: Proof Must Be Human-Scale

From Apple's methodology: technical specs must be translated to human metrics before they can serve as proof.

"5GB storage" → "1,000 songs in your pocket"
"24-hour battery" → "Think outside the outlet"
"Sub-100ms response" → "No loading spinners during your standup"

This translation is not decoration. It is the mechanism by which functional proof reaches emotional territory. "5GB" activates nothing in the human brain. "1,000 songs" activates desire. Same fact, different framing, radically different response.

---

## 4. Benefits of the Framework

### For the Business

1. **Single source of truth** — Every marketing artifact (website, pitch deck, social post, ad campaign) draws from the same Value Architecture. No more contradictory messaging across channels.

2. **Persona-aware messaging** — The Persona-Benefit Matrix tells you exactly which benefit layer to lead with for each audience. No more one-size-fits-all copy.

3. **Funnel-stage appropriate** — Discovery messaging hits different layers than adoption messaging. The framework maps this explicitly.

4. **Competitive resilience** — Because Layer 2 forces competitive context, your messaging automatically repositions against alternatives. When competitors change, you update Layer 2 and the differentiation cascades.

5. **Speed to copy** — With a complete Value Architecture in place, a copywriter (human or AI) can produce on-brand, on-strategy copy in minutes instead of hours. The strategic thinking is already done.

### For Marketing Teams

1. **No more blank page problem** — The templates and Headline Bank provide starting points for every content need.

2. **Quality is testable** — Each layer has a specific quality test (see Quality Standards below). You can audit any piece of marketing against the framework.

3. **Consistency across contributors** — Whether a junior copywriter, a senior CMO, or an AI agent writes the copy, the Value Architecture ensures it hits the right altitude and uses the right proof.

4. **Feature launches are faster** — When a new feature ships, building a Value Ladder takes 30 minutes. The rest of the messaging infrastructure (Message House, Headline Bank, Funnel Messaging) absorbs it.

### For AI Agents

1. **Structured input = better output** — YAML templates give AI agents explicit structure, reducing hallucination and increasing relevance.

2. **Layer-specific generation** — Instead of "write marketing copy for this feature," an agent can be directed to "write Layer 4 emotional copy for this feature targeting this persona." Precision improves quality.

3. **Validation is automated** — The quality checklist rules are mechanical enough for an AI agent to self-check its own output.

4. **The framework is the prompt** — The Value Ladder template IS the prompt. Fill in the fields, and you have marketing-ready language at every altitude.

---

## 5. The Process — End to End

### Overview

```
PHASE 1: GROUND TRUTH (once, update quarterly)
  ├── 1A: Competitive Alternative Map
  ├── 1B: Jobs-to-Be-Done Map
  ├── 1C: Identity Territory
  └── 1D: Anti-Positioning
            │
            ▼
PHASE 2: VALUE LADDERS (per feature)
  ├── Build 5-layer ladder for each feature
  ├── Attach proof anchor to each ladder
  ├── Score persona resonance
  └── Assemble Persona-Benefit Matrix
            │
            ▼
PHASE 3: MESSAGE ARCHITECTURE (synthesis)
  ├── 3A: Message House (roof + pillars + proof)
  ├── 3B: Headline Bank (per pillar, per layer)
  └── 3C: Funnel-Stage Messaging
            │
            ▼
PHASE 4: ACTIVATION (downstream)
  ├── 4A: Homepage Hero template
  ├── 4B: Feature Section template
  ├── 4C: Comparison Section template
  └── 4D: Social Proof architecture
```

### Phase 1: Ground Truth (Strategic Foundation)

**Purpose**: Establish the strategic context that every Value Ladder builds on. This is the equivalent of Dunford's competitive positioning + JTBD research + Brand Ladder apex, done once and updated quarterly.

**Duration**: 2-4 hours for a small team, 1-2 workshops for a larger org.

#### Step 1A: Competitive Alternative Map

For each major product capability/module, document:

| Field | What to Write | Where the Answer Comes From |
|---|---|---|
| `capability` | The module/feature name | Product architecture |
| `alternative` | What the user does today without this | Customer interviews, founder intuition, or competitive research |
| `unique_attribute` | What you have that the alternative doesn't | Product differentiation analysis |
| `so_what` | Why the user should care about that difference | JTBD outcome mapping |

**The critical discipline**: The "alternative" is NOT always a competitor. For novel categories, it's usually:
- Manual process ("I do this by hand")
- Status quo ("I don't do this at all")
- Cobbled-together stack ("I use 3 different tools")
- Hiring someone ("I pay a contractor")

**Output**: A YAML file with one entry per capability. This becomes the source of truth for all Layer 2 (Mechanism) entries in Value Ladders.

#### Step 1B: Jobs-to-Be-Done Map

For each persona, document:

| Field | What to Write | Where the Answer Comes From |
|---|---|---|
| `persona` | Persona name and archetype | `meta/personas/` |
| `core_job` | "When [trigger], I want [capability], so I can [outcome]" | Persona trigger event + JTBD formula |
| `emotional_job` | "I want to feel [emotion] while doing this" | Means-End Chain laddering |
| `social_job` | "I want to be perceived as [identity] by [audience]" | Brand Ladder self-expressive |
| `job_steps` | The workflow steps and which features serve each | Ulwick's Universal Job Map |

**The critical discipline**: The core job statement must describe the OUTCOME the user wants, not the product they use. "I want to schedule agent sessions" is product language. "I want my projects to make progress while I sleep" is outcome language.

**Output**: A YAML file with one entry per persona. This feeds Layer 3-5 generation for all Value Ladders.

#### Step 1C: Identity Territory

Define the single identity space your product occupies. This is the Brand Ladder's apex — the self-expressive benefit territory that all features ultimately converge on.

| Field | What to Write | Where the Answer Comes From |
|---|---|---|
| `worldview` | The belief system the product represents | Brand foundation, litepaper vision |
| `tribe` | Who you join by choosing this product | User community characteristics |
| `signal` | What using this product signals about you to peers | Customer interviews, community observation |
| `anti_identity` | Who would NEVER use this product, and why | Anti-persona |

**Output**: A single YAML block. This anchors the top of every Value Ladder and prevents Layer 5 entries from drifting into generic territory.

#### Step 1D: Anti-Positioning

Define what you oppose — the villain, the paradigm, the status quo. From StoryBrand's narrative structure.

| Field | What to Write | Where the Answer Comes From |
|---|---|---|
| `villain` | The force or paradigm you're against | Brand foundation "What we're NOT" |
| `external_problem` | The surface-level problem it creates | User frustration research |
| `internal_problem` | How it makes the user FEEL | Emotional job analysis |
| `philosophical_problem` | Why this state of affairs is fundamentally WRONG | Brand values, vision |

**Output**: A single YAML block. This feeds the Anti-Positioning Lead pattern and the Comparison Section activation template.

---

### Phase 2: Value Ladders (Per-Feature Mapping)

**Purpose**: For each product feature or capability, build a complete 5-layer Value Ladder with proof anchor and persona resonance scoring.

**Duration**: 15-30 minutes per feature for a human; 2-5 minutes for an AI agent with context.

**Input**: A product feature/capability + Phase 1 Ground Truth.

**Process**:

1. **Layer 1 — Feature**: State the capability as an engineer would describe it. Point to the code. No marketing language.

2. **Layer 2 — Mechanism**: Pull from the Competitive Alternative Map (Phase 1A). Name the specific alternative and state how your approach differs. The sentence structure is: "Unlike [alternative], this [differentiator]."

3. **Layer 3 — Functional Benefit**: Ask "So what?" of Layer 2. What measurable outcome does the user observe? Apply the JTBD outcome test: "Minimize/maximize the [metric] when [doing the job step]." Or simply: "Can the user see and measure this result?"

4. **Layer 4 — Emotional Benefit**: Ask "Why does that matter to you personally?" of Layer 3. This is the Means-End Chain laddering probe. Keep asking "Why is that important?" until you hit a specific emotion. Not "feel good" — specific. Confident. Relieved. Empowered. Free. Calm. In control.

5. **Layer 5 — Identity Benefit**: Ask "What does that say about the kind of person you are?" of Layer 4. This completes the Brand Ladder. Apply the "I am someone who..." test. If the completion sounds natural and aspirational, it's a valid Layer 5.

6. **Proof Anchor**: Select the strongest technical fact from Layer 1 and translate it to a human-scale metric (Apple's "1000 songs" technique). Choose proof type:
   - **Human Metric**: Spec → human number ("stores your entire music library" → "1000 songs in your pocket")
   - **Contrast Proof**: Before/after ("manual invocation" → "fires automatically while you sleep")
   - **Social Proof**: Customer quote or metric ("build times from 7m to 40s")

7. **Persona Resonance**: For each persona, identify which layer resonates most and why. This becomes the Persona-Benefit Matrix.

**Output per feature**: One complete Value Ladder (YAML). See template in `value-architecture.md`.

**Output after all features**: The Persona-Benefit Matrix — a grid showing which layer to lead with for each persona-feature pair.

---

### Phase 3: Message Architecture (Synthesis)

**Purpose**: Organize all Value Ladders into a coherent, hierarchical messaging structure that any communicator can use.

**Duration**: 1-2 hours for a human synthesizing 10-20 Value Ladders.

#### Step 3A: Message House Construction

1. **Group Value Ladders by theme.** Look at the Layer 3 (Functional) and Layer 5 (Identity) entries across all ladders. Natural clusters will emerge — features that serve the same job or identity territory.

2. **Name each cluster as a Pillar.** Maximum 3-4. If you have more, you haven't prioritized. Each Pillar should be a distinct value dimension.

3. **Write the Pillar headline.** Should hit Layer 3 or 4 (functional or emotional). Not Layer 1 (too technical) or Layer 5 (too abstract without supporting pillars).

4. **Attach proof points.** Pull from each Value Ladder's proof anchor within that Pillar. 2-3 proof points per Pillar.

5. **Write the Primary Message (the roof).** This is the intersection of your strongest Pillars' Layer 5 benefits. One sentence. Must be: differentiated, defensible, memorable. Test: can a journalist use this as their headline?

6. **State the Foundation.** Brand values, identity territory, anti-positioning — pulled directly from Phase 1C and 1D.

**Output**: The Message House diagram (text-based structure).

#### Step 3B: Headline Bank

For each Pillar, generate headlines at four altitudes:

| Altitude | Layer | Use Case | Length |
|---|---|---|---|
| Identity | Layer 5 | Hero sections, brand campaigns, taglines | 2-5 words |
| Emotional | Layer 4 | Section headers, email subject lines, social | 1 short sentence |
| Functional | Layer 3 | Feature pages, product tours, comparison | 1 sentence |
| Proof | Layer 1-2 with translation | Specs, deep-scroll, data sheets | 1 sentence with metric |

**Output**: 3-5 headline options per Pillar per altitude. This is the working copy bank that downstream creators pull from.

#### Step 3C: Funnel-Stage Messaging

Map which layers to lead with at each stage of the customer journey:

| Stage | Lead Layer | Support Layer | What the User Needs |
|---|---|---|---|
| Discovery | L3 + L5 | L2 | "What is this? Why should I care?" |
| Evaluation | L2 + L3 | L1 | "How does it work? Is it credible?" |
| Trial | L1 + L3 | L6 (proof) | "Can I actually use this?" |
| Adoption | L4 | L3 | "This is working. I feel it." |
| Advocacy | L5 | L4 | "This is part of who I am." |

For each stage, write 2-3 example messages pulling from the appropriate layers.

**Output**: A messaging matrix with example copy per stage.

---

### Phase 4: Activation Templates (Downstream Copy)

**Purpose**: Provide ready-made copy patterns that any creator (human or AI) can fill in using the Value Architecture outputs.

These templates are NOT finished copy. They are structural patterns with layer-specific slots. The creator fills each slot by pulling from the relevant Value Ladder layer.

#### 4A: Homepage Hero

```
[LAYER 5 — IDENTITY TAGLINE]
[LAYER 3 — FUNCTIONAL PROOF with embedded PROOF ANCHOR metric]
[CTA — frictionless entry point]
```

#### 4B: Feature Section

```
[LAYER 4 — EMOTIONAL HEADLINE, short]
[LAYER 3 — FUNCTIONAL DESCRIPTION, 1-2 sentences]
[LAYER 2 — MECHANISM DETAIL, how it works differently]
[PROOF ANCHOR — human metric or contrast proof]
```

#### 4C: Comparison / Anti-Positioning Section

```
[VALIDATE THE FRUSTRATION — name the status quo pain from Phase 1D]
[NAME THE VILLAIN — the paradigm, not a competitor]
[ASSERT THE ALTERNATIVE — Layer 3 benefit as the answer]
[PROVE IT — specific, numeric proof]
```

#### 4D: Social Proof Architecture

Three tiers, ordered by credibility for developer audiences:
1. Numeric proof ("build times from 7m to 40s")
2. Identity-anchor quote ("[outcome] — [respected person], [known company]")
3. Community signal (GitHub stars, npm downloads, contributor count)

**Output**: Filled-in copy templates ready for design integration.

---

## 6. All Outputs — Intermediate and Final

### Intermediate Outputs (produced during the process)

| Output | Produced In | Format | Purpose |
|---|---|---|---|
| Competitive Alternative Map | Phase 1A | YAML | Feeds Layer 2 of all Value Ladders |
| JTBD Map (per persona) | Phase 1B | YAML | Feeds Layer 3-5 generation |
| Identity Territory | Phase 1C | YAML | Anchors Layer 5 of all Value Ladders |
| Anti-Positioning | Phase 1D | YAML | Feeds Comparison Section and villain construct |
| Individual Value Ladders | Phase 2 | YAML | Per-feature complete maps |
| Persona-Benefit Matrix | Phase 2 (synthesis) | Table | Maps persona × feature → resonant layer |

### Final Outputs (the deliverables)

| Output | Produced In | Format | Primary Consumer |
|---|---|---|---|
| **Message House** | Phase 3A | Text diagram + YAML | Leadership, marketing leads, all communicators |
| **Headline Bank** | Phase 3B | YAML (per pillar, per layer) | Copywriters, designers, AI agents |
| **Funnel-Stage Messaging** | Phase 3C | Table + example copy | Content marketers, growth team, sales |
| **Activation Templates** | Phase 4 | Structured copy with layer slots | Copywriters, landing page builders, campaign creators |
| **The Value Architecture** | All phases combined | Single Markdown + YAML document | Everyone — the single source of truth |

### File Structure in a Repository

```
meta/
├── value-architecture.md              # Operational reference (templates, rules)
├── value-architecture-handbook.md      # This document (philosophy, process, guide)
├── value-architecture-applied.md       # The actual applied output for this product
├── brand-foundation.md                 # Brand voice, tone, aesthetic
├── dorkos-litepaper.md                 # Product vision
└── personas/
    ├── manifest.json
    ├── the-autonomous-builder.md       # Primary persona
    ├── the-knowledge-architect.md      # Secondary persona
    ├── the-prompt-dabbler.md           # Anti-persona
    └── icp-ai-native-dev-shop.md       # ICP
research/
├── 20260227_feature_benefit_marketing_frameworks.md   # Framework analysis
└── 20260227_feature_to_benefit_messaging_patterns.md  # Brand examples
```

---

## 7. AI Agent Application Guide

### How an AI Agent Applies the Value Architecture Within a Repository

This section describes exactly how an AI coding/marketing agent would execute the Value Architecture process by reading repository contents — what it can derive autonomously, what it must ask a human for, and the sequence of operations.

### What the Agent Can Derive from the Repository

#### Layer 1 (Feature) — Fully Derivable

The agent reads the codebase to extract every feature with technical precision.

| Repository Source | What It Reveals |
|---|---|
| `CLAUDE.md` | Complete product architecture, all modules, all services, route handlers, data flow |
| `specs/manifest.json` | Every specified feature, its status (implemented/specified/ideation), chronological ordering |
| `apps/server/src/routes/*.ts` | API surface — every endpoint is a capability |
| `apps/server/src/services/*.ts` | Internal services — reveals mechanisms not visible from API alone |
| `apps/client/src/layers/features/*/` | UI features — what the user actually interacts with |
| `packages/*/src/` | Shared libraries — core logic that powers multiple features |
| `contributing/*.md` | Architecture docs, design system, patterns — deep implementation detail |
| `decisions/*.md` | ADRs — architectural choices and their rationale |

**Agent process**: Read `CLAUDE.md` first (it's the rosetta stone). Then scan `specs/manifest.json` for the feature inventory. Then read source code for implementation details.

#### Layer 2 (Mechanism) — Partially Derivable

The agent can describe HOW a feature works differently from general approaches by reading the code and architecture docs. But it CANNOT know what actual users do as an alternative without human input.

| What the Agent CAN Do | What It CANNOT Do |
|---|---|
| Describe the technical approach (e.g., "uses JSONL transcript files as single source of truth") | Know whether users currently use spreadsheets, scripts, or nothing |
| Identify unique architectural decisions from ADRs | Validate that those decisions matter to real customers |
| Compare to general industry patterns (e.g., "most agent tools use ephemeral sessions") | Know which specific tools users actually compare against |

**Agent process**: Read ADRs for architectural decisions. Read the litepaper's "What DorkOS Is NOT" for explicit differentiation. Draft Layer 2 entries with a `[NEEDS VALIDATION]` flag on the alternative.

#### Layer 3 (Functional Benefit) — Mostly Derivable

The agent can reason about outcomes by connecting features to persona job steps.

| What the Agent CAN Do | What It CANNOT Do |
|---|---|
| Map features to JTBD job steps using persona trigger events | Confirm that users actually experience these outcomes |
| Translate technical capabilities to outcome language | Know which outcomes users value MOST |
| Draft functional benefit statements | Validate that the language matches how users describe their own experience |

**Agent process**: Read persona files for job statements and triggers. For each feature, ask "What outcome does this enable for this persona?" Draft Layer 3, flag with `[DRAFT]`.

#### Layer 4 (Emotional Benefit) — Partially Derivable, Needs Human Validation

The agent can hypothesize emotions by applying the Means-End Chain "Why is that important?" probe to Layer 3. But emotional resonance is fundamentally a human judgment.

| What the Agent CAN Do | What It CANNOT Do |
|---|---|
| Apply the "Why does that matter?" probe iteratively | Know whether the hypothesized emotion is what users actually feel |
| Draw from persona frustrations and goals | Distinguish between emotions the FOUNDER wants users to feel and emotions users ACTUALLY feel |
| Reference brand foundation for emotional territory | Validate that the emotion is specific enough (not generic "feel good") |

**Agent process**: Take Layer 3. Ask "Why is that important to the persona?" 2-3 times. Draft Layer 4 with `[HYPOTHESIS — VALIDATE WITH USERS]` flag.

#### Layer 5 (Identity Benefit) — Partially Derivable, Needs Human Sign-Off

The agent can draft identity benefits using the Identity Territory from Phase 1C and the brand foundation. But identity positioning is a strategic choice — the highest-stakes marketing decision — and requires founder/leadership approval.

| What the Agent CAN Do | What It CANNOT Do |
|---|---|
| Read `brand-foundation.md` for stated identity territory | Decide whether this identity territory is correct for the market |
| Apply the "I am someone who..." test to generated candidates | Make the strategic choice of which identity to claim |
| Generate multiple options for human selection | Validate that the identity resonates with the target audience |

**Agent process**: Read brand foundation and Identity Territory. Generate 2-3 Layer 5 options per feature. Present to human for selection. Flag all as `[REQUIRES FOUNDER APPROVAL]`.

#### Proof Anchor — Mixed

| What the Agent CAN Do | What It CANNOT Do |
|---|---|
| Extract technical metrics from code (service counts, architectural stats) | Provide customer usage metrics (no access to production data) |
| Generate human-metric translations of specs | Provide customer quotes or testimonials |
| Create contrast proof by comparing with/without scenarios | Provide numeric social proof (downloads, stars, customer outcomes) |

**Agent process**: Draft Human Metric and Contrast Proof types. Leave Social Proof as `[PLACEHOLDER — NEEDS CUSTOMER DATA]`.

### The Agent Execution Sequence

```
STEP 1: READ CONTEXT
  ├── Read CLAUDE.md (product architecture)
  ├── Read meta/brand-foundation.md (voice, positioning)
  ├── Read meta/dorkos-litepaper.md (vision)
  ├── Read meta/personas/*.md (all personas)
  ├── Read specs/manifest.json (feature inventory)
  └── Read meta/value-architecture.md (framework templates)

STEP 2: BUILD PHASE 1 (GROUND TRUTH) — DRAFT
  ├── 1A: Draft Competitive Alternative Map
  │     Source: litepaper "What DorkOS Is NOT" + architecture
  │     Flag: alternatives need human validation
  ├── 1B: Draft JTBD Map per persona
  │     Source: persona files (triggers, goals, frustrations)
  │     Flag: job statements need human validation
  ├── 1C: Draft Identity Territory
  │     Source: brand-foundation.md
  │     Flag: needs founder approval
  └── 1D: Draft Anti-Positioning
        Source: brand-foundation.md "What DorkOS Is Not"
        Flag: villain construct needs human validation

STEP 3: PRESENT PHASE 1 FOR HUMAN REVIEW
  └── Show all Ground Truth drafts to human
      Ask: "Are these alternatives correct?"
      Ask: "Do these job statements match your understanding?"
      Ask: "Is this identity territory what you want to own?"

STEP 4: BUILD PHASE 2 (VALUE LADDERS) — DRAFT
  ├── For each feature in the feature inventory:
  │     Build 5-layer ladder
  │     Attach proof anchor (Human Metric or Contrast type)
  │     Score persona resonance
  └── Assemble Persona-Benefit Matrix

STEP 5: PRESENT VALUE LADDERS FOR HUMAN REVIEW
  └── Show each ladder individually
      Ask: "Does Layer 3 describe a real outcome you've seen?"
      Ask: "Does Layer 4 name the right emotion?"
      Ask: "Does Layer 5 sound like who your users become?"

STEP 6: BUILD PHASE 3 (MESSAGE ARCHITECTURE) — DRAFT
  ├── Group approved ladders into Pillars
  ├── Draft Message House
  ├── Generate Headline Bank (3-5 per pillar per layer)
  └── Draft Funnel-Stage Messaging

STEP 7: PRESENT MESSAGE ARCHITECTURE FOR HUMAN REVIEW
  └── Show Message House, get approval on:
      - Primary Message (roof)
      - Pillar selection and naming
      - Headline preferences

STEP 8: BUILD PHASE 4 (ACTIVATION) — DRAFT
  └── Fill in all activation templates using approved architecture

STEP 9: WRITE FINAL OUTPUT
  └── Compile everything into meta/value-architecture-applied.md
```

### Agent Prompt Patterns

For each generation step, the agent can use these prompt patterns internally:

**Generating Layer 3 from Layer 1-2:**
```
Given this feature: [Layer 1]
And this differentiator: [Layer 2]
For the persona: [Name] whose core job is: [JTBD statement]
What measurable outcome does the user observe?
Test: Can the user see and measure this result?
```

**Generating Layer 4 from Layer 3:**
```
Given this functional benefit: [Layer 3]
Ask "Why is that important to [persona name] personally?" three times.
Name the specific emotion. Not "feel good" — specific.
Test: Would a real person say "When this works, I feel [emotion]"?
```

**Generating Layer 5 from Layer 4:**
```
Given this emotional benefit: [Layer 4]
And this identity territory: [Phase 1C worldview and tribe]
Complete: "I am someone who [Layer 5]"
Test: Does this sound like something you'd say about yourself with pride?
```

**Generating Proof Anchor from Layer 1:**
```
Given this feature: [Layer 1]
Translate the most impressive technical spec into a human-scale metric.
Pattern: "[technical number]" → "[human-scale equivalent]"
Reference: "5GB" → "1,000 songs in your pocket"
```

---

## 8. Human Input Requirements

### Decisions Only Humans Can Make

| Decision | Why AI Can't Make It | When It's Needed |
|---|---|---|
| **Competitive alternative validation** | Requires knowledge of actual user behavior, not hypothetical | Phase 1A |
| **JTBD validation** | Real job statements come from customer interviews, not code analysis | Phase 1B |
| **Identity territory selection** | This is the highest-stakes positioning decision a company makes | Phase 1C |
| **Anti-positioning scope** | Choosing your enemy is a strategic act with market consequences | Phase 1D |
| **Emotional benefit validation** | Whether an emotion resonates is empirical, not logical | Phase 2, Layer 4 |
| **Layer 5 approval** | Identity claims shape how the market perceives you permanently | Phase 2, Layer 5 |
| **Pillar selection** | Which 3-4 themes to elevate is a prioritization decision | Phase 3A |
| **Primary Message approval** | The one sentence that defines you to the world | Phase 3A |
| **Social proof collection** | Customer quotes and metrics come from real customers | Phase 2, Proof Anchor |
| **Headline selection** | Choosing between generated options is a taste decision | Phase 3B |

### Human Input Format

To minimize human effort, the framework is designed so that humans make **choices, not creations**:

- Phase 1: Human VALIDATES agent-generated drafts (yes/no/modify)
- Phase 2: Human APPROVES or REJECTS each Value Ladder layer
- Phase 3: Human SELECTS from generated headline options
- Phase 4: Human REVIEWS final activation copy

The agent does the generative work. The human does the judgment work. This is by design.

### Minimum Human Time Investment

| Phase | Human Effort | What You're Doing |
|---|---|---|
| Phase 1 | 30-60 min | Reviewing and correcting Ground Truth drafts |
| Phase 2 | 10-20 min total | Approving/rejecting Value Ladders (2 min each) |
| Phase 3 | 20-30 min | Selecting pillars, approving primary message, choosing headlines |
| Phase 4 | 15-20 min | Reviewing final activation copy |
| **Total** | **~2 hours** | For a complete Value Architecture from scratch |

---

## 9. Quality Standards

### Layer Quality Tests

Every layer has a binary pass/fail test:

| Layer | Test | Pass Example | Fail Example |
|---|---|---|---|
| L1 Feature | Can an engineer point to the code? | "Cron-based scheduling with SQLite state" | "Smart scheduling" |
| L2 Mechanism | Does it name a specific alternative? | "Unlike manual `claude` invocations..." | "Better than other tools" |
| L3 Functional | Can the user observe and measure this? | "Ship code while you sleep" | "Improves agent capability" |
| L4 Emotional | Would a real person say "I feel [this]"? | "Wake up to progress, not dread" | "Feel empowered" |
| L5 Identity | Does "I am someone who [this]" sound natural? | "...builds systems that run autonomously" | "...uses good software" |
| Proof | Is the spec translated to human scale? | "Your agents never sleep" | "24/7 cron execution" |

### The Chain Test

The entire ladder must be causally connected. Read it bottom to top: "Because [L1], which means [L2], which lets you [L3], which makes you feel [L4], because you are someone who [L5]."

If any link in the chain feels like a leap, the ladder fails. Rewrite the disconnected layer.

### The "Would Apple Ship This?" Test

For final Headline Bank and Activation Template output, apply this filter:

1. **Is the headline benefit-first?** (Not feature-first)
2. **Is the metric human-scale?** (Not engineer-scale)
3. **Is the emotional claim earned by the functional proof below it?**
4. **Is it 5-7 words or fewer?** (For identity/emotional headlines)
5. **Could a journalist use it as their headline?** (For the Primary Message)

---

## 10. Maintenance and Evolution

### Trigger Events for Updates

| Event | What to Update | Scope |
|---|---|---|
| New feature shipped | Add a Value Ladder, update Persona-Benefit Matrix | Phase 2 only |
| New persona identified | Re-score all ladders for persona resonance | Phase 2 resonance + Phase 3C |
| Competitive landscape shifts | Re-run Phase 1A, cascade to all Layer 2 entries | Phase 1A → Phase 2 Layer 2 |
| New customer data (quotes, metrics) | Update Proof Anchors with Social Proof | Phase 2 Proof Anchors |
| Brand repositioning | Re-run Phase 1C-1D, cascade through all Layer 5 entries | Phase 1C-D → Phase 2 Layer 5 → Phase 3 |
| Quarterly review | Validate Layer 2 alternatives still accurate, refresh Headline Bank | All phases, light touch |

### Version History Pattern

Track changes to the Value Architecture the same way you track code:

```yaml
version: "1.0"
last_updated: "2026-02-27"
changelog:
  - date: "2026-02-27"
    change: "Initial Value Architecture created"
    scope: "All phases"
```

---

## 11. Naming and Terminology

### The Name: "The Value Architecture"

The framework is called **The Value Architecture** because:

1. **"Value"** — The output. Every piece of the framework translates product reality into human value. Value is the through-line from Layer 1 (feature) to Layer 5 (identity).

2. **"Architecture"** — The method. This is not a template you fill in once. It's a structural system — deliberate, layered, load-bearing. Each component supports the ones above it. Remove a layer and the structure fails. This is architecture, not decoration.

The name also resonates with the product it was designed for (DorkOS is infrastructure), with the developer audience (developers build architectures), and with the discipline required (architecture demands rigor).

### Key Terms

| Term | Definition |
|---|---|
| **Value Ladder** | The complete 5-layer map for a single feature, from Feature to Identity |
| **Layer** | One altitude in the Value Ladder (Feature, Mechanism, Functional, Emotional, Identity) |
| **Proof Anchor** | The evidence element attached to each Value Ladder (human metric, contrast, or social proof) |
| **Ground Truth** | The strategic foundation established in Phase 1 (competitive context, JTBD, identity territory, anti-positioning) |
| **Message House** | The hierarchical messaging structure: primary message (roof), pillars, proof points, foundation |
| **Headline Bank** | The collection of ready-to-use headlines organized by pillar and benefit layer |
| **Persona-Benefit Matrix** | The grid mapping each persona × feature to their most resonant benefit layer |
| **Activation Template** | Structural copy patterns with layer-specific slots for downstream creators |
| **Identity Territory** | The self-expressive benefit space the brand occupies (the apex of the Brand Ladder) |
| **Anti-Positioning** | The explicit definition of what the product opposes — the villain, the paradigm, the status quo |
| **Human Metric** | A technical spec translated to a number that activates human desire ("1000 songs in your pocket") |
| **Contrast Proof** | A before/after or with/without comparison that makes the benefit tangible |
| **Altitude** | Shorthand for benefit layer level — "write at Layer 4 altitude" means "write emotional benefit copy" |

### Abbreviations Used in Templates

| Abbreviation | Meaning |
|---|---|
| L1 | Layer 1 — Feature |
| L2 | Layer 2 — Mechanism |
| L3 | Layer 3 — Functional Benefit |
| L4 | Layer 4 — Emotional Benefit |
| L5 | Layer 5 — Identity Benefit |
| VA | Value Architecture |
| VL | Value Ladder |
| PBM | Persona-Benefit Matrix |
| MH | Message House |
| HB | Headline Bank |

---

## Appendix: Framework Selection Rationale

### Why These 10+ Frameworks and Not Others

The frameworks synthesized into The Value Architecture were selected based on five criteria:

1. **Proven at scale** — each has been used by companies generating $100M+ in revenue
2. **Distinct contribution** — each adds a mechanism no other framework provides
3. **Complementary, not redundant** — they operate at different altitudes
4. **Applicable to developer tools** — relevant to technical audiences, not just consumer goods
5. **Producible by AI agents** — the mechanism can be expressed as structured templates

Frameworks considered but not included:

| Framework | Why Excluded |
|---|---|
| Porter's Value Chain | Addresses business operations, not customer-facing messaging |
| Blue Ocean Strategy | Strategy-level framework; too broad for feature-to-benefit mapping |
| Crossing the Chasm (Moore) | Adoption lifecycle strategy, not a messaging framework |
| SPIN Selling | Sales methodology; FAB covers the same territory for marketing |
| The Challenger Sale | Sales methodology; relevant to enterprise, not developer PLG |
| Design Thinking | Product development methodology; not a messaging framework |
| Lean Canvas | Business model tool; Value Prop Canvas better serves the messaging need |

### The Insight That Drove the Synthesis

From studying how Apple, Nike, Vercel, Linear, Supabase, Cursor, Raycast, and Stripe actually market:

> **The best brands hit Layer 3-4 (emotional/functional) in their headlines, use Layer 1-2 as proof, and let Layer 5 (identity) emerge from consistent execution over time.**

No single framework captures this full vertical. The Value Architecture does.
