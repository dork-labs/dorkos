---
slug: marketing-faq-section
number: 83
created: 2026-03-02
status: ideation
---

# Marketing FAQ Section

**Slug:** marketing-faq-section
**Author:** Claude Code
**Date:** 2026-03-02

---

## 1) Intent & Assumptions

- **Task brief:** Add an FAQ section to the DorkOS marketing homepage. Draft the copy (7 questions with accordion) and implement the component following existing marketing section patterns.
- **Assumptions:**
  - FAQ sits between IdentityClose and InstallMoment in the page flow
  - Uses the existing shadcn Accordion component (already installed, base-ui based)
  - Follows the data/UI separation pattern (faq-items.ts + FAQSection.tsx)
  - 7 questions covering: agent definition, data privacy, setup requirements, licensing, Claude Code dependency, deployment flexibility, cost
  - Claude Code is named in FAQ answers (vendor-agnostic narrative elsewhere, specific in FAQ)
  - "Agent" is defined as Q1 since the site never explains the term
- **Out of scope:**
  - Separate /faq page
  - Search/filter functionality
  - FAQ schema markup (can be added later for SEO)
  - Animated micro-interactions beyond standard REVEAL/STAGGER

## 2) Pre-reading Log

- `apps/site/src/app/(marketing)/page.tsx`: Page assembly — sections composed sequentially, FAQ goes between IdentityClose and InstallMoment
- `apps/site/src/layers/features/marketing/index.ts`: Barrel export — new component and data file must be added here
- `apps/site/src/layers/features/marketing/ui/HonestySection.tsx`: Narrow text section with corner brackets, charcoal bg, REVEAL/STAGGER pattern
- `apps/site/src/layers/features/marketing/ui/SubsystemsSection.tsx`: Data-driven section with companion lib file, cream-primary bg
- `apps/site/src/layers/features/marketing/ui/VillainSection.tsx`: Card-based section with spotlight effect, data from villain-cards.ts
- `apps/site/src/layers/features/marketing/lib/motion-variants.ts`: SPRING, VIEWPORT, REVEAL, STAGGER, SCALE_IN, DRAW_PATH
- `apps/site/src/layers/features/marketing/lib/subsystems.ts`: Data file pattern — interface + const array, no JSX
- `apps/site/src/components/ui/accordion.tsx`: base-ui Accordion (not Radix), uses `data-[panel-open]` for chevron rotation
- `contributing/design-system.md`: 8pt grid, IBM Plex fonts, color tokens
- `research/20260302_faq_section_best_practices_developer_tools.md`: FAQ best practices research

## 3) Codebase Map

- **Primary components/modules:**
  - `apps/site/src/layers/features/marketing/ui/FAQSection.tsx` (to create)
  - `apps/site/src/layers/features/marketing/lib/faq-items.ts` (to create)
  - `apps/site/src/app/(marketing)/page.tsx` (add import + render)
  - `apps/site/src/layers/features/marketing/index.ts` (add exports)

- **Shared dependencies:**
  - `apps/site/src/layers/features/marketing/lib/motion-variants.ts` — REVEAL, STAGGER, VIEWPORT
  - `apps/site/src/components/ui/accordion.tsx` — Accordion, AccordionItem, AccordionTrigger, AccordionContent
  - `motion/react` — motion component wrappers

- **Data flow:** faq-items.ts (static data) → FAQSection.tsx (renders accordion) → page.tsx (composes into page)

- **Potential blast radius:** Minimal — 4 files touched (2 new, 2 modified). No existing components affected.

## 5) Research

- **Best practice:** 7-10 questions in accordion, answers 2-4 sentences, answer in first sentence, link to docs for depth
- **Placement:** After value/identity sections, before final CTA — handles residual objections
- **Anti-patterns to avoid:** Questions nobody asked, vague security answers, FAQ-as-features-section, corporate passive voice
- **Copy register:** Match the site's declarative, honest tone. No exclamation marks. First/second person.
- **Recommendation:** Single-column accordion with `bg-cream-secondary` background (alternates from cream-white IdentityClose and cream-primary InstallMoment)

Full research: `research/20260302_faq_section_best_practices_developer_tools.md`

## 6) Decisions

| # | Decision | Choice | Rationale |
|---|----------|--------|-----------|
| 1 | Placement in page flow | After IdentityClose, before InstallMoment | Standard conversion funnel — neutralize objections right before the install CTA |
| 2 | Question count & format | 7 questions with accordion | Covers five concern buckets without bloat. Research says 7-10 is the sweet spot. |
| 3 | Define "agent" | Yes, as Q1 | The site never explains the term. Setting the foundation for every other answer. |
| 4 | Name Claude Code | Yes, in FAQ answers only | FAQ is the place for specifics. Marketing narrative stays vendor-agnostic. |

## 7) FAQ Copy Draft

### Eyebrow: Questions

### Q1: What do you mean by "agent"?

An agent is an AI coding tool — like Claude Code, Cursor, or Codex — that can read, write, and run code on your machine. DorkOS doesn't replace your agents. It gives them the infrastructure to work when you're not watching: scheduling, communication, memory, and coordination.

### Q2: How is this different from just using Claude Code?

Claude Code is the agent — the thing that thinks and writes code. DorkOS is the system around it. Without DorkOS, your agent stops when you close the terminal. With it, your agents run on schedules, message you when something breaks, coordinate with each other, and pick up where they left off.

### Q3: Does DorkOS send any data to external servers?

No. DorkOS runs entirely on your hardware. Session data stays in Claude Code's local transcript files. There are no accounts, no cloud dependency, and no telemetry phoning home.

### Q4: What do I need to get started?

Node.js 18+ and Claude Code. One command installs DorkOS. No accounts to create, no cloud services to configure. If you can run `npm install`, you're ready.

### Q5: What license is DorkOS under?

MIT. Use it commercially, fork it, modify it, ship it. No restrictions.

### Q6: Can I run DorkOS on a remote server?

Yes. DorkOS runs wherever you put it — your laptop, a VPS, a Raspberry Pi, a cloud VM. Built-in tunnel support lets you access it from anywhere.

### Q7: Is DorkOS free?

DorkOS is free and open source. The agents themselves use API credits from their providers — running Claude Code overnight might cost a few dollars depending on the work. DorkOS doesn't add any cost on top of that.

---

## 8) Implementation Plan

### Files to create:
1. `apps/site/src/layers/features/marketing/lib/faq-items.ts` — FaqItem interface + faqItems array
2. `apps/site/src/layers/features/marketing/ui/FAQSection.tsx` — Accordion section component

### Files to modify:
3. `apps/site/src/layers/features/marketing/index.ts` — Add exports for FAQSection and faqItems
4. `apps/site/src/app/(marketing)/page.tsx` — Import FAQSection, add between IdentityClose and InstallMoment

### Component structure:
- `bg-cream-secondary` background (alternates from surrounding sections)
- `max-w-2xl` content width
- Orange monospace eyebrow: "Questions"
- Accordion with custom warm-palette styling (override default shadcn border tokens)
- Each item: question as trigger, answer as content with optional doc link
- Standard REVEAL/STAGGER motion pattern
