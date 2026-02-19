---
slug: update-homepage-brand-foundation
number: 38
created: 2026-02-17
status: ideation
---

# Update Homepage Based on Brand Foundation

**Slug:** update-homepage-brand-foundation
**Author:** Claude Code
**Date:** 2026-02-17
**Related:** `meta/brand-foundation.md`, `research/20260217_dorkos_landing_page_marketing.md`

---

## 1) Intent & Assumptions

- **Task brief:** Rewrite the DorkOS homepage (`apps/web`) to align with the updated brand foundation document. Keep the same visual branding (colors, fonts, general style) but improve messaging, formatting, section ordering, and content. Channel Steve Jobs (positioning clarity), Seth Godin (tribe/movement thinking), and David Ogilvy (concrete copy craft).
- **Assumptions:**
  - Same visual system: cream palette, IBM Plex Sans/Mono, graph paper hero, retro tech aesthetic
  - Same technical stack: Next.js 16, Tailwind 4, FSD marketing feature module
  - Content changes only (copy, data, section ordering) — not a full visual redesign
  - No new third-party dependencies unless compelling
  - Product screenshot stays (it's real and effective)
- **Out of scope:**
  - New visual design language or color palette
  - Dynamic data (live GitHub stars, npm downloads) — can note as future enhancement
  - Blog/changelog system
  - Pricing page
  - A/B testing infrastructure

## 2) Pre-reading Log

- `meta/brand-foundation.md`: Updated brand doc — "Own Your AI" primary tagline, "We Believe" manifesto, voice examples table, concrete hero copy, installation belonging narrative, "What DorkOS Is Not" section
- `apps/web/src/app/(marketing)/page.tsx`: Homepage orchestrator — Hero, ProjectsGrid, AboutSection, OriginSection, ContactSection
- `apps/web/src/layers/features/marketing/ui/Hero.tsx`: Current hero — "Claude Code / in your browser." tagline, npm install CTA, product screenshot
- `apps/web/src/layers/features/marketing/lib/projects.ts`: 6 feature cards (Chat Interface, Tool Approval, Session Management, Slash Commands, Dark Mode, Mobile Responsive)
- `apps/web/src/layers/features/marketing/lib/philosophy.ts`: 4 philosophy items (Open Source, Developer First, Privacy Respecting, Extensible)
- `apps/web/src/layers/features/marketing/ui/AboutSection.tsx`: "About" section — lead text + philosophy grid
- `apps/web/src/layers/features/marketing/ui/OriginSection.tsx`: "The Origin" — 3 paragraphs about why DorkOS exists
- `apps/web/src/layers/features/marketing/ui/ContactSection.tsx`: Email reveal with PostHog tracking
- `apps/web/src/layers/features/marketing/ui/MarketingHeader.tsx`: Fixed header with scroll-shrink animation
- `apps/web/src/layers/features/marketing/ui/MarketingFooter.tsx`: Dark footer with retro brand stripes
- `apps/web/src/layers/features/marketing/ui/MarketingNav.tsx`: Floating bottom nav pill
- `apps/web/src/config/site.ts`: Site config — name, description, URLs, email
- `research/20260217_dorkos_landing_page_marketing.md`: Full research report — Evil Martians 100 dev tool study, Jobs/Godin/Ogilvy principles applied, section ordering recommendations, copy guidelines

## 3) Codebase Map

**Primary Components/Modules:**

- `apps/web/src/app/(marketing)/page.tsx` — Homepage orchestrator (all section composition)
- `apps/web/src/layers/features/marketing/` — FSD marketing feature module (all UI + data)
- `apps/web/src/config/site.ts` — Site-wide config (name, description, URLs)
- `apps/web/src/app/(marketing)/layout.tsx` — Marketing layout (metadata, JSON-LD)

**Data Files (content to update):**

- `apps/web/src/layers/features/marketing/lib/projects.ts` — Feature card data
- `apps/web/src/layers/features/marketing/lib/philosophy.ts` — Philosophy items data
- `apps/web/src/layers/features/marketing/lib/types.ts` — TypeScript interfaces

**Shared Dependencies:**

- Tailwind 4 custom properties in `globals.css`
- IBM Plex Sans/Mono fonts (root layout)
- PostHog analytics (ContactSection, ProjectCard)
- Motion.dev animations (MarketingNav)
- Next.js Image optimization

**Potential Blast Radius:**

- Direct: ~12 files (all marketing feature module files + page.tsx + site config)
- Indirect: Marketing layout metadata (if site description changes)
- Tests: None currently exist for marketing components
- SEO: JSON-LD schema, OG meta tags, site description

## 4) Research Summary

### Evil Martians (100 Dev Tool Landing Pages Study)

Best-performing section structure:
1. Nav (logo + docs + GitHub + CTA)
2. Hero (centered, headline + sub + CTA + product visual)
3. Credibility signal (immediately after hero)
4. Problem/Why (real user problems, not feature lists)
5. How it works / Features (specific, concrete, one idea per section)
6. Testimonials (curated, aligned with page claims)
7. Open source / CTA
8. Final CTA block

Key findings: No salesy BS. Clever and simple wins. Curated testimonials (not auto-pulled). For early-stage tools without logos: GitHub stars + npm downloads + tech stack credibility.

### Jobs Principles

- **Name a category and own it.** "Own Your AI" = category. Proof points follow.
- **Rule of Three.** Structure reveals in threes. Three steps, three features, three bullets.
- **The antagonist.** The villain is cloud dependency, not a competitor. "Every AI interface you've tried lives in someone else's cloud."
- **Simplicity as philosophy.** No feature matrices. If you need 12 bullets, you haven't found your one thing.

### Godin Principles

- **"People like us do things like this."** DorkOS is an identity statement, not just a tool choice.
- **The "not for you" move.** "What DorkOS Is Not" section explicitly excludes wrong audience. Builds conviction for the right one.
- **Tribal copy signals:** "Your AI. Your machine. Your rules." > "Powerful AI workflow tool."

### Ogilvy Principles

- **Specificity is believability.** "localhost:4242" > "local access." "~/.claude/projects/" > "stored locally." "One npm install" > "quick setup."
- **Ban vague adjectives:** powerful, seamless, robust, next-gen, cutting-edge, innovative, intuitive, comprehensive.
- **The headline is 80 cents of every dollar.** If the hero headline isn't doing the job alone, the page isn't working.

## 5) Current vs. Proposed Section Comparison

### Current Homepage (5 sections):
1. **Hero** — "Claude Code / in your browser." + npm install CTA
2. **Features** — 6 feature cards (3x2 grid)
3. **About** — "DorkOS is an open-source web UI..." + 4 philosophy items
4. **Origin** — "DorkOS started because Claude Code deserved..."
5. **Contact** — Email reveal

### Proposed Homepage (8 sections):

| # | Section | Component | Status |
|---|---|---|---|
| 1 | **Hero** | `Hero.tsx` (modified) | Rewrite copy |
| 2 | **Credibility Bar** | `CredibilityBar.tsx` (new) | New section |
| 3 | **The Problem** | `ProblemSection.tsx` (new) | New section |
| 4 | **How It Works** | `HowItWorksSection.tsx` (new) | New section |
| 5 | **Features** | `ProjectsGrid.tsx` (modified) | Reduce to 4 cards |
| 6 | **What DorkOS Is Not** | `NotSection.tsx` (new) | New section |
| 7 | **About / Origin** | `AboutSection.tsx` (modified) | Merge + rewrite |
| 8 | **Contact** | `ContactSection.tsx` (unchanged) | Keep |

### Detailed Copy for Each Section

---

#### Section 1: HERO (rewrite)

**Current:**
- Label: "Open Source"
- H1: "Claude Code / in your browser."
- Subhead: "A web UI for Claude Code. Chat interface, tool approval, and session management built on the Agent SDK."
- CTA: "npm install -g dorkos"

**Proposed:**
- Label: "Open Source" (keep)
- H1: **"Own Your AI."**
- Subhead: "Remote access to Claude Code from any browser. One npm install. Runs on your machine. No cloud. No middleman."
- CTA Primary: `npm install -g dorkos` (keep, it works)
- CTA Secondary: "Read the docs" (keep)
- Product screenshot (keep)

**Rationale:** Jobs' category-first principle. "Own Your AI" is the identity claim. The subhead delivers Ogilvy specificity — every clause is a concrete, falsifiable fact. No adjectives.

---

#### Section 2: CREDIBILITY BAR (new)

A slim, horizontal bar immediately after the hero. Three signals:

```
Built on the Claude Agent SDK  ·  Open Source  ·  MIT Licensed
```

Minimal design — monospace, small, warm-gray. Not a logo garden (we don't have enterprise logos). Not flashy. Just three facts that establish technical credibility.

**Rationale:** Evil Martians research: credibility signal immediately after hero is "one of the fastest ways to build credibility." For early-stage without logos, tech stack + license is the move.

---

#### Section 3: THE PROBLEM (new)

A short, punchy section that frames the antagonist without naming competitors (Jobs' villain principle + Godin's tribe exclusion).

**Label:** (none — no label, just text)

**Copy:**

> Every AI coding interface you've used lives in someone else's cloud.
> Their servers. Their logs. Their uptime. Their rules.
>
> DorkOS is different.
> It runs on your machine. You access it from any browser.
> Your sessions, your transcripts, your infrastructure.

**Design:** Centered text on cream-tertiary background. Same engineering-bracket aesthetic as current OriginSection. Typographic emphasis only — no icons, no illustrations.

**Rationale:** This is the Jobs antagonist + Godin tribe signal. Frames cloud AI interfaces as the problem pattern (not a specific product). Establishes DorkOS as the alternative.

---

#### Section 4: HOW IT WORKS (new)

Three steps. Rule of Three (Jobs). Ogilvy specificity (port numbers, file paths, real commands).

**Label:** "How It Works"

**Step 1: Install**
```
npm install -g dorkos
```
One command. No config files. No Docker. No cloud account.

**Step 2: Run**
```
dorkos --dir ~/projects
```
Server starts at localhost:4242. Add `--tunnel` for remote access from anywhere.

**Step 3: Work**
Full Claude Code in your browser. Tool approvals, session history, slash commands.
JSONL transcripts stored at `~/.claude/projects/`. Always local.

**Design:** Three-column grid (stacks on mobile). Each step has a monospace code block + brief description below. Clean, technical, no fluff.

**Rationale:** Ogilvy's specificity rule. "localhost:4242" and "~/.claude/projects/" are proof the product exists and has been built with care. The three steps show the entire workflow in 30 seconds.

---

#### Section 5: FEATURES (modified)

**Current:** 6 cards (Chat Interface, Tool Approval, Session Management, Slash Commands, Dark Mode, Mobile Responsive)

**Proposed:** Reduce to 4 cards — cut the ones that are table stakes (Dark Mode, Mobile Responsive). Focus on differentiating capabilities.

1. **Chat Interface** — "Rich markdown, streaming responses, and syntax highlighting. Claude Code in a real browser UI." (stable, Core)
2. **Tool Approval** — "Review and approve every tool call before it executes. Full control over what Claude does on your machine." (stable, Core)
3. **Session Management** — "Browse, resume, and sync sessions across devices. Works with CLI-started sessions. One source of truth." (stable, Core)
4. **Slash Commands** — "Discover and run commands from .claude/commands/ with a searchable palette. Your workflows, surfaced." (stable, Developer)

**Design:** Keep the current grid layout (now 2x2 on desktop). Remove status/type badges — everything shown is shipped and stable.

**Rationale:** Jobs' simplicity. Dark Mode and Mobile Responsive are expected, not differentiating. Four cards at 2x2 is visually balanced and each card now carries weight.

---

#### Section 6: WHAT DORKOS IS NOT (new)

Godin's "not for you" move. From the brand foundation.

**Copy:**

> DorkOS is not a hosted service.
> Not a model aggregator.
> Not a chat widget.
>
> It's infrastructure you run, own, and control.

**Design:** Centered, cream-white background. Large typography (similar to hero scale). The negations in warm-gray, the final affirmation in charcoal or brand-orange. Minimal — the whitespace is the design.

**Rationale:** This builds tribe by excluding the wrong audience. It answers "what category is this?" by defining the negative space. Every developer who reads this and nods is pre-qualified.

---

#### Section 7: ABOUT / ORIGIN (merged + rewritten)

Merge current AboutSection and OriginSection into a single tighter section.

**Label:** "About"

**Lead text:** "DorkOS is open source infrastructure for Claude Code." (Shorter than current. Godin: state the belief, not the feature.)

**Philosophy grid (rewritten from brand foundation's "We Believe"):**

| # | Title | Description |
|---|---|---|
| 01 | Your Machine | Your AI runs on your hardware. Your sessions stay local. No cloud dependency. |
| 02 | Open Source | MIT licensed. Read every line of code that touches your AI sessions. |
| 03 | Power Users | Built for developers who ship. Not a toy. Not a wrapper. A runtime. |
| 04 | Autonomy | Full control is the default. Unrestricted permissions by design. |

**Origin paragraph (one paragraph, not three):**
"DorkOS exists because Claude Code deserved a browser interface. Built on the Agent SDK, it reads the same JSONL session files as the CLI. No separate backend. No data duplication. One source of truth."

**Closing line:** Keep "The name is playful. The tool is serious." — it's earned and memorable.

**Rationale:** The current About and Origin sections overlap and dilute each other. Merging them creates one strong section. The philosophy grid now maps to the brand foundation's "We Believe" values instead of generic developer tool qualities.

---

#### Section 8: CONTACT (keep as-is)

The email reveal mechanism is distinctive and well-executed. No changes needed.

---

### Additional Changes

**Site Config (`config/site.ts`):**
- Update `description` from "A web UI for Claude Code" to "Remote access to Claude Code. On your machine."

**Footer:**
- Change "v1.0 · System Online" to actual version or remove — it's inaccurate and breaking trust (Ogilvy: specificity is believability).

**Nav:**
- Update links to match new section IDs: features, about, contact, docs

**Marketing Layout Metadata:**
- Update OG description to match new site description

## 6) Decisions (Resolved)

| # | Question | Decision |
|---|---|---|
| 1 | Credibility bar content | **Static text** — "Built on Claude Agent SDK · Open Source · MIT Licensed". No API calls. Add dynamic counts later when stars are meaningful. |
| 2 | Terminal demo in "How It Works" | **Animated terminal (termynal)** — Lightweight terminal animation for the 3-step install/run/work flow. Creates the Jobs "holy smokes" moment. |
| 3 | Social proof / testimonials | **Skip for now** — No testimonials section until we have real, curated developer quotes. None > fake. |
| 4 | Footer version | **Show real npm version** — Display actual version (e.g., "v0.2.0"). Ogilvy: specificity is believability. |
| 5 | Problem section tone | **Direct "you" address** — "Every AI coding interface you've used..." Makes the reader the protagonist. |
| 6 | Site structure | **Single page** — One scrolling page. DorkOS is one product with one install. Go multi-page when Pulse/Channels/Wing ship. |
