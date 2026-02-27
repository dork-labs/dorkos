# The Value Architecture

A systematic framework for translating product features into human value. Produces structured output that serves as the single source of truth for all marketing communications.

**Created**: 2026-02-27
**Status**: Draft v1
**Consumers**: Marketing team, copywriters, AI agents, product marketers, founders
**Inputs**: Product features, personas, competitive landscape
**Outputs**: Value Ladders, Message House, Headline Bank, Funnel Messaging

---

## Why This Framework Exists

The marketing landscape has 10+ proven frameworks. Each does one thing well:

| Framework | What It Does Best | What It Misses |
|---|---|---|
| FAB | Writes copy (feature → advantage → benefit) | Shallow — stops at functional benefit |
| JTBD | Discovers purchase motivation | Doesn't produce positioning or copy |
| Dunford | Establishes competitive positioning | Doesn't address emotion or identity |
| Means-End Chain | Reveals deep psychological drivers | Requires 20-60 interviews; slow |
| Brand Ladder | Reaches emotion and identity | No competitive context |
| StoryBrand | Structures narrative messaging | Produces similar output for every company |
| Message House | Aligns messaging across channels | Organizing, not generative |
| Value Prop Canvas | Maps jobs, pains, gains | Teams fill it with assumptions |
| Apple Methodology | Translates specs to human outcomes | Requires genuine product conviction |
| Nike Architecture | Layers brand → category → product | Took 30 years to build; not a startup tool |

**None of them do everything.** The Value Architecture synthesizes the best mechanism from each into a single end-to-end system.

### Framework Lineage

Every component is traceable to a proven source:

```
JTBD (Christensen/Ulwick/Moesta) ──────┐
                                        ├──▶ Phase 1: Ground Truth
Dunford's Obviously Awesome ───────────┘

Means-End Chain (Gutman 1982) ─────────┐
Brand Ladder (Aaker/Y&R/Ogilvy) ──────┤
FAB (Sales training tradition) ────────┤──▶ Phase 2: Value Ladders
Apple Methodology (Jobs era) ──────────┘

Message House (PR/Corp Comms) ─────────┐
Dev Positioning Stack (emerging) ──────┤──▶ Phase 3: Message Architecture
Nike Brand Architecture ───────────────┘

Moesta's Four Forces of Progress ──────┐
Developer Marketing Principles ────────┤──▶ Phase 4: Activation
Vercel/Linear/Supabase patterns ───────┘
```

---

## The Core Model: Five Benefit Layers

Every product feature connects to human value through five ascending layers. Higher layers create deeper loyalty but require lower layers as proof.

```
┌─────────────────────────────────────────────────────────┐
│  LAYER 5: IDENTITY                                      │
│  "What choosing this says about me"                     │
│  ← Brand Ladder self-expressive benefit                 │
│  Example: "You build infrastructure, not just software" │
├─────────────────────────────────────────────────────────┤
│  LAYER 4: EMOTIONAL                                     │
│  "How this makes me feel"                               │
│  ← Means-End Chain psychosocial consequence             │
│  Example: "Wake up to progress, not an empty terminal"  │
├─────────────────────────────────────────────────────────┤
│  LAYER 3: FUNCTIONAL                                    │
│  "The measurable outcome for me"                        │
│  ← JTBD desired outcome statement                       │
│  Example: "Ship code while you sleep"                   │
├─────────────────────────────────────────────────────────┤
│  LAYER 2: MECHANISM                                     │
│  "What makes this different from alternatives"          │
│  ← Dunford's unique attributes vs. alternatives         │
│  Example: "Cron scheduling with overrun protection"     │
├─────────────────────────────────────────────────────────┤
│  LAYER 1: FEATURE                                       │
│  "What the product has or does"                         │
│  ← Product reality (code, specs, architecture)          │
│  Example: "Autonomous agent scheduling via Pulse"       │
└─────────────────────────────────────────────────────────┘
```

### Layer Rules

**Layer 1 (Feature)** must be objectively verifiable. If an engineer can't point to the code that implements it, it doesn't belong here.

**Layer 2 (Mechanism)** must answer "compared to what?" Features only differentiate relative to alternatives (Dunford's key insight). State what the user would do without your product, and why your approach is different.

**Layer 3 (Functional)** must be a measurable outcome, not a restatement of the feature. Test: can the user observe this result? "Schedules agent sessions" is a FEATURE restated. "Ships code while you sleep" is an OUTCOME observed.

**Layer 4 (Emotional)** must name a specific emotion, not a generic one. Test: would a human actually say this? "Feel good" fails. "Wake up to progress instead of anxiety" passes. Use the Means-End Chain "Why is that important to you?" probe to reach this layer.

**Layer 5 (Identity)** must describe who the user becomes, not what the product is. Test: does it complete the sentence "I am someone who..."? "Uses advanced automation" fails. "Builds systems that work autonomously" passes. This is the Brand Ladder's self-expressive benefit — what choosing this product signals about you.

### The Proof Anchor

Every ladder includes a proof element that makes the chain credible. Three proof types:

| Proof Type | What It Is | When to Use |
|---|---|---|
| **Human Metric** | Technical spec translated to human-scale number | When the feature has a quantifiable advantage |
| **Contrast Proof** | Before/after or with/without comparison | When the alternative is a known pain |
| **Social Proof** | Specific, numeric customer evidence or identity-anchor quote | When credibility needs external validation |

Apple's "1000 songs in your pocket" is a Human Metric (5GB → 1000 songs). Vercel's "build times from 7m to 40s" is Contrast Proof. Cursor's "more fun to be a programmer — Greg Brockman" is Social Proof from an identity anchor.

---

## Phase 1: Ground Truth

Run this phase once. Update quarterly or when competitive landscape shifts. This establishes the strategic foundation that all Value Ladders build on.

### 1A. Competitive Alternative Map

For each major product capability, answer Dunford's three questions:

```yaml
capability: "[Name]"
alternative: "What would the customer do if we didn't exist?"
unique_attribute: "What do we have that the alternative doesn't?"
so_what: "Why does that difference matter to the customer?"
```

**Process**:
1. List every capability/module in the product
2. For each, identify the real alternative (often "do nothing" or "cobble together scripts")
3. Name the specific attribute that differentiates
4. State why that attribute creates value

**Anti-pattern**: Don't list competing products unless customers actually compare you to them. For new categories, the real alternative is usually manual processes, status quo, or "hire someone."

### 1B. Jobs-to-Be-Done Map

For each persona, define their primary job and map product features to job steps.

```yaml
persona: "[Name — Archetype]"
core_job: "When [situation], I want [capability], so I can [outcome]"
emotional_job: "I want to feel [specific emotion] while doing this"
social_job: "I want to be perceived as [identity] by [audience]"
job_steps:
  - step: "[Action in the job workflow]"
    features_that_serve: ["Feature A", "Feature B"]
```

**Process** (adapted from Ulwick's Universal Job Map):
1. Start with the persona's trigger event (from persona file)
2. Walk through their workflow: Define → Locate → Prepare → Execute → Monitor → Conclude
3. At each step, identify which product features serve that step
4. Write the core job statement: "When [trigger], I want [product capability], so I can [the outcome they actually care about]"

### 1C. Identity Territory

Define the identity space your product occupies. This is the apex of every Brand Ladder — the self-expressive benefit that all features ultimately serve.

```yaml
identity_territory:
  worldview: "What belief system does the product represent?"
  tribe: "Who do you join by using this product?"
  signal: "What does choosing this product say about you to others?"
  anti_identity: "Who would never use this product, and why?"
```

### 1D. Anti-Positioning

From StoryBrand's villain construct and Dunford's "what we are NOT": define the enemy. Not a competitor — a force, a paradigm, a status quo.

```yaml
anti_positioning:
  villain: "The force/paradigm we oppose"
  external_problem: "The surface-level problem the villain creates"
  internal_problem: "How the villain makes the user feel"
  philosophical_problem: "Why this state of affairs is fundamentally wrong"
```

---

## Phase 2: Value Ladders

For each product feature or capability, build a complete Value Ladder.

### Value Ladder Template

```yaml
id: "[kebab-case-identifier]"
feature_name: "[Human-readable name]"
module: "[Which product module this belongs to]"

# Layer 1: Feature
feature: "[Objective, verifiable capability. What an engineer would say.]"

# Layer 2: Mechanism
mechanism:
  alternative: "[What users do without this feature]"
  differentiator: "[What makes our approach different]"

# Layer 3: Functional Benefit
functional: "[Measurable outcome the user observes. Must pass the 'can I see this result?' test.]"

# Layer 4: Emotional Benefit
emotional: "[Specific emotion or psychological state. Must pass the 'would a human say this?' test.]"

# Layer 5: Identity Benefit
identity: "[Who the user becomes. Must complete 'I am someone who...' ]"

# Proof Anchor
proof:
  type: "human_metric | contrast | social"
  spec: "[The raw technical fact]"
  translation: "[The human-scale translation — the '1000 songs' version]"
  social: "[Customer quote or third-party validation, if available]"

# Persona Resonance
resonance:
  - persona: "[Name]"
    primary_layer: "[Which layer resonates most with this persona]"
    why: "[Why this layer matters most to them]"
```

### Quality Checklist

Before finalizing any Value Ladder, verify:

- [ ] **Layer 1** is something an engineer can point to in the codebase
- [ ] **Layer 2** names a specific alternative (not "other products")
- [ ] **Layer 3** describes an outcome, not a restated feature
- [ ] **Layer 4** names a specific emotion a real person would articulate
- [ ] **Layer 5** completes "I am someone who..." naturally
- [ ] **Proof** translates a spec into a human-scale metric or comparison
- [ ] Each layer builds on the one below it (the chain is causal, not decorative)

### Persona-Benefit Matrix

After building all Value Ladders, create a matrix showing which benefit layer is most resonant for each persona:

```
                          Kai (Primary)    Priya (Secondary)
Feature A                 Layer 4          Layer 3
Feature B                 Layer 5          Layer 4
Feature C                 Layer 3          Layer 5
...
```

This matrix tells copywriters which altitude to write at for each audience-feature pair.

---

## Phase 3: Message Architecture

Synthesize all Value Ladders into a coherent message structure.

### 3A. Message House

```
┌──────────────────────────────────────────────────────┐
│                    PRIMARY MESSAGE                     │
│  One sentence. The roof of the house.                 │
│  Must be: differentiated, defensible, memorable.      │
│  Test: Can a journalist use this as their headline?   │
├──────────────┬──────────────┬────────────────────────┤
│  PILLAR 1    │  PILLAR 2    │  PILLAR 3              │
│  [Theme]     │  [Theme]     │  [Theme]               │
│              │              │                        │
│  Headline    │  Headline    │  Headline              │
│  (L3-L4)     │  (L3-L4)     │  (L3-L4)               │
│              │              │                        │
│  Proof 1     │  Proof 1     │  Proof 1               │
│  Proof 2     │  Proof 2     │  Proof 2               │
│  Proof 3     │  Proof 3     │  Proof 3               │
├──────────────┴──────────────┴────────────────────────┤
│                    FOUNDATION                         │
│  Brand values and beliefs (from brand-foundation.md)  │
│  Identity territory (from Phase 1C)                   │
│  Anti-positioning (from Phase 1D)                     │
└──────────────────────────────────────────────────────┘
```

**Construction rules:**
1. The Primary Message comes from the intersection of your strongest Value Ladders' Layer 5 benefits
2. Each Pillar groups related Value Ladders by theme
3. Pillar headlines should hit Layer 3 or 4 (emotional or functional)
4. Proof points come from each Value Ladder's proof anchor
5. Maximum 3-4 pillars — if you have more, you haven't prioritized

### 3B. Headline Bank

For each Pillar, generate headlines at multiple benefit levels using the Apple Translation Formula:

```yaml
pillar: "[Pillar name]"
headlines:
  # Level 4-5: Identity/Emotional (for hero sections, brand campaigns)
  identity: "[2-5 word tagline hitting Layer 5]"
  emotional: "[Short sentence hitting Layer 4]"

  # Level 2-3: Functional (for feature sections, product pages)
  functional: "[One sentence stating the measurable outcome]"

  # Level 1: Proof (for specs, comparison tables, deep-scroll)
  proof: "[The human-metric translation of the technical spec]"
```

**The Apple Formula**: Lead with emotion/identity (Layers 4-5), prove with function (Layer 3), anchor with specs (Layers 1-2). Never reverse this order.

**The Anti-Positioning Lead** (Linear/Nike pattern): When the audience has a known frustration with alternatives, lead by validating that frustration BEFORE asserting your benefit. "You know the problem" → "Here's why it's wrong" → "Here's what's possible."

### 3C. Funnel-Stage Messaging

Different stages of the customer journey require different benefit layers:

| Stage | Primary Layer | What the User Needs | Copy Pattern |
|---|---|---|---|
| **Discovery** | L3 Functional + L5 Identity | "What is this and why should I care?" | Positioning statement + category anchor |
| **Evaluation** | L2 Mechanism + L3 Functional | "How does it work and is it credible?" | Feature explanations + proof points |
| **Trial** | L1 Feature + L3 Functional | "Can I actually use this?" | Docs, quickstart, friction removal |
| **Adoption** | L4 Emotional | "This is working and I feel it" | Outcome stories, milestone celebrations |
| **Advocacy** | L5 Identity | "This is part of who I am now" | Community, philosophy, worldview content |

**Developer-specific note** (from research): Developers verify claims empirically. Their funnel is Discovery → Try → Love → Advocate. This means Layer 1-2 content (docs, code examples, honest specs) is MORE important for developers during evaluation than Layer 4-5 content. But Layer 4-5 is what creates advocacy and word-of-mouth.

---

## Phase 4: Activation Templates

Ready-made templates for downstream consumers (copywriters, landing page builders, campaign creators).

### 4A. Homepage Hero

```
[IDENTITY TAGLINE] — 2-5 words, Layer 5
[FUNCTIONAL PROOF] — 1 sentence, Layer 3 with embedded Layer 6 proof
[INSTALLATION CTA] — frictionless entry point
```

### 4B. Feature Section

```
[EMOTIONAL HEADLINE] — Layer 4, short
[FUNCTIONAL DESCRIPTION] — Layer 3, 1-2 sentences
[MECHANISM DETAIL] — Layer 2, how it works differently
[PROOF ANCHOR] — Human metric or contrast proof
```

### 4C. Comparison Section (Anti-Positioning)

```
[VALIDATE THE FRUSTRATION] — Name the status quo pain
[NAME THE VILLAIN] — The paradigm, not the competitor
[ASSERT THE ALTERNATIVE] — Your Layer 3 benefit as the answer
[PROVE IT] — Specific, numeric, functional proof
```

### 4D. Social Proof Architecture

Three tiers, in order of credibility for developer audiences:

1. **Numeric proof**: "Build times from 7m to 40s" (most credible)
2. **Identity-anchor quote**: "[Outcome statement] — [Respected person], [Known company]"
3. **Community signal**: GitHub stars, contributor count, npm downloads (credibility, not enthusiasm)

**Anti-pattern**: Generic testimonials ("Great product!") are worse than no social proof for developer audiences.

---

## Working With This Framework

### For Humans

1. Start with Phase 1 to establish Ground Truth (do this in a workshop or strategy session)
2. Build Value Ladders (Phase 2) for each major feature — use the template, check against the quality checklist
3. Synthesize into Message Architecture (Phase 3) — this becomes the source of truth document
4. Hand Activation Templates (Phase 4) to copywriters and designers

### For AI Agents

The YAML templates in Phase 1-2 are designed to be machine-parseable. An LLM can:
- Generate draft Value Ladders given a feature description and persona context
- Validate ladders against the quality checklist rules
- Generate headline variations at each benefit layer
- Produce funnel-stage-appropriate copy from the Message House

**Prompt pattern for LLM activation**:
```
Given the Value Ladder for [feature] and the persona [name],
write [copy type] at benefit Layer [N] for the [funnel stage] stage.
Use the [Apple/Anti-Positioning/Functional] headline pattern.
```

### For Ongoing Maintenance

- **New feature added**: Build a Value Ladder (Phase 2), update the Persona-Benefit Matrix, check if it fits an existing Pillar or needs a new one
- **New persona identified**: Re-score all Value Ladders for persona resonance, update Funnel-Stage Messaging
- **Competitive shift**: Re-run Phase 1A (Competitive Alternative Map), cascade changes down through Layer 2 of all affected Value Ladders
- **Quarterly review**: Re-validate all Layer 2 claims (are alternatives still the same?), update proof anchors with latest metrics

---

## Appendix A: Framework Comparison

Why this framework over any single alternative:

| Dimension | FAB | JTBD | Dunford | Brand Ladder | Value Architecture |
|---|---|---|---|---|---|
| Reaches identity level | No | Partial | No | Yes | Yes |
| Competitive context | No | No | Yes | No | Yes |
| Structured for LLMs | Yes | No | Partial | No | Yes |
| Produces copy directly | Yes | No | No | No | Yes (via templates) |
| Per-persona mapping | No | Yes | Yes | No | Yes |
| Proof architecture | No | No | No | No | Yes |
| Funnel-stage guidance | No | Partial | No | No | Yes |

## Appendix B: Source Frameworks

Detailed analysis of all 10+ source frameworks, with origins, structures, strengths, weaknesses, and examples:
- `research/20260227_feature_benefit_marketing_frameworks.md`

Practical examples from Apple, Nike, Vercel, Linear, Supabase, Cursor, Raycast, and Stripe:
- `research/20260227_feature_to_benefit_messaging_patterns.md`

## Appendix C: Connected Documents

- **Personas**: `meta/personas/` — personas define who receives the value
- **Brand Foundation**: `meta/brand-foundation.md` — voice, tone, anti-positioning
- **Litepaper**: `meta/dorkos-litepaper.md` — product vision and architecture
