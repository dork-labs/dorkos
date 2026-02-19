---
slug: update-homepage-brand-foundation
number: 38
created: 2026-02-17
status: specified
---

# Specification: Update Homepage Based on Brand Foundation

## Overview

Rewrite the DorkOS marketing homepage to align with the updated brand foundation document (`meta/brand-foundation.md`). The homepage moves from a generic "web UI for Claude Code" description to the "Own Your AI" positioning — leading with identity, specificity, and tribe-building copy inspired by Jobs (positioning clarity), Godin (movement thinking), and Ogilvy (concrete copy craft).

**Scope:** Content, copy, and section structure changes only. Same visual system (cream palette, IBM Plex fonts, retro tech aesthetic), same technical stack (Next.js 16, Tailwind 4, FSD marketing feature module).

**Key outcome:** A developer landing on the page immediately understands: (1) what DorkOS is, (2) that it runs on their machine, (3) how to install it in one command.

## Technical Design

### Architecture

All changes are within the FSD marketing feature module at `apps/web/src/layers/features/marketing/`. The pattern is: page.tsx orchestrates sections, each section is a standalone component, content data lives in `lib/` files.

### New Components (4)

| Component | File | Purpose |
|---|---|---|
| `CredibilityBar` | `ui/CredibilityBar.tsx` | Static credibility signals after hero |
| `ProblemSection` | `ui/ProblemSection.tsx` | Antagonist framing (cloud vs. local) |
| `HowItWorksSection` | `ui/HowItWorksSection.tsx` | 3-step install/run/work with animated terminal |
| `NotSection` | `ui/NotSection.tsx` | "What DorkOS Is Not" tribe-building section |

### Modified Components (5)

| Component | File | Changes |
|---|---|---|
| `Hero` | `ui/Hero.tsx` | New headline "Own Your AI.", new subhead, remove taglineLine1/Line2 split |
| `ProjectsGrid` | `ui/ProjectsGrid.tsx` | Layout change from 3-col to 2-col (4 cards) |
| `ProjectCard` | `ui/ProjectCard.tsx` | Remove status/type badges |
| `AboutSection` | `ui/AboutSection.tsx` | Merge with OriginSection content, new philosophy items |
| `MarketingFooter` | `ui/MarketingFooter.tsx` | Real version number instead of "v1.0 · System Online" |

### Removed Components (1)

| Component | File | Reason |
|---|---|---|
| `OriginSection` | `ui/OriginSection.tsx` | Content merged into AboutSection |

### Modified Data Files (3)

| File | Changes |
|---|---|
| `lib/projects.ts` | Reduce from 6 to 4 projects, update descriptions |
| `lib/philosophy.ts` | Rewrite 4 items to match brand foundation "We Believe" values |
| `lib/types.ts` | Remove `ProjectStatus` and `ProjectType` from `Project` interface (badges removed) |

### Modified Config Files (2)

| File | Changes |
|---|---|
| `config/site.ts` | Update `description` to "Remote access to Claude Code. On your machine." |
| `app/(marketing)/layout.tsx` | Update OG metadata to match new description |

### Modified Page File (1)

| File | Changes |
|---|---|
| `app/(marketing)/page.tsx` | New section ordering, add new components, remove OriginSection |

### New Dependency (1)

| Package | Purpose | Size |
|---|---|---|
| `termynal` or equivalent | Animated terminal demo in How It Works | Lightweight (~5KB) |

**Note:** If termynal has compatibility issues with React/Next.js SSR, implement a custom terminal animation component using CSS keyframes (no external dependency). The animation is simple: type out 3 commands with a blinking cursor. A ~50-line React component with CSS can achieve this.

## Section-by-Section Specification

### Section 1: Hero

**Component:** `Hero.tsx` (modified)

**Props change:**
```typescript
// Before
interface HeroProps {
  label?: string
  taglineLine1: string
  taglineLine2: string
  subhead: string
  bylineText: string
  bylineHref: string
}

// After
interface HeroProps {
  label?: string
  headline: string
  subhead: string
  ctaText: string
  ctaHref: string
}
```

**Content:**
- Label: "Open Source" (unchanged)
- Headline (h1): "Own Your AI."
- Subhead: "Remote access to Claude Code from any browser. One npm install. Runs on your machine. No cloud. No middleman."
- CTA Primary: `npm install -g dorkos` (linked to npm, with blinking cursor)
- CTA Secondary: "Read the docs →" (linked to `/docs/getting-started/quickstart`)
- Product screenshot: Keep unchanged (`/images/dorkos-screenshot.png`)

**Design notes:**
- Headline is a single line (no line break like current taglineLine1/Line2 split)
- The "." in "Own Your AI." is intentional — it's a declarative statement, not a question
- Keep all existing visual effects (graph paper bg, radial glow, scan lines, responsive clamp sizing)

**Acceptance criteria:**
- [ ] Headline reads "Own Your AI." in brand-orange
- [ ] Subhead is one paragraph, no line breaks, max-w-[500px]
- [ ] `npm install -g dorkos` CTA with blinking cursor
- [ ] Product screenshot below CTAs
- [ ] "Read the docs →" secondary link below CTA

---

### Section 2: Credibility Bar

**Component:** `CredibilityBar.tsx` (new)

**Content:**
```
Built on the Claude Agent SDK  ·  Open Source  ·  MIT Licensed
```

**Design:**
- Horizontal centered bar
- Background: `bg-cream-secondary` (subtle contrast from hero)
- Typography: `font-mono text-2xs tracking-[0.1em] text-warm-gray-light`
- Padding: `py-6` (compact)
- Three items separated by `·` (middle dot)
- No links, no icons — pure text credibility

**Acceptance criteria:**
- [ ] Renders three static text items separated by middle dots
- [ ] Visually distinct from hero (different background)
- [ ] Monospace, small, understated

---

### Section 3: The Problem

**Component:** `ProblemSection.tsx` (new)

**Content:**
```
Every AI coding interface you've used lives in someone else's cloud.
Their servers. Their logs. Their uptime. Their rules.

DorkOS is different.
It runs on your machine. You access it from any browser.
Your sessions, your transcripts, your infrastructure.
```

**Design:**
- Background: `bg-cream-tertiary`
- Centered text, max-w-[600px]
- Engineering bracket corners (same as current OriginSection aesthetic)
- First paragraph: `text-warm-gray text-lg`
- "DorkOS is different." line: `text-charcoal font-semibold`
- Second paragraph: `text-warm-gray text-lg`
- Padding: `py-32 px-8`
- No section label — the content speaks for itself

**Acceptance criteria:**
- [ ] Two paragraphs with "DorkOS is different." as visual separator
- [ ] Corner bracket decorations (reuse from OriginSection)
- [ ] Direct "you" address in opening line
- [ ] No section label

---

### Section 4: How It Works

**Component:** `HowItWorksSection.tsx` (new)

**Content:**

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
```
Full Claude Code in your browser.
```
Tool approvals, session history, slash commands. JSONL transcripts stored at `~/.claude/projects/`. Always local.

**Design:**
- Background: `bg-cream-primary`
- Section label: "How It Works" (mono, 2xs, brand-orange, uppercase — same style as current "Features" label)
- Three-column grid on desktop (`lg:grid-cols-3`), stacks on mobile
- Each step: step number (brand-green, mono), code block (monospace, bg-cream-secondary, rounded), description below
- **Animated terminal:** Steps 1 and 2 use an animated terminal that types out the command. Step 3 shows the result. Animation triggers on scroll into view (Intersection Observer).
- Code blocks use existing `font-mono` styling with a dark-on-cream aesthetic (not full dark terminal)

**Terminal animation spec:**
- Typing speed: ~50ms per character
- Cursor: blinking block cursor (reuse `cursor-blink` animation from globals.css)
- Trigger: Starts when section enters viewport (IntersectionObserver, threshold 0.3)
- Only animates once (no replay on re-scroll)
- SSR-safe: renders full text on server, animation is client-side enhancement only
- Fallback: if JS disabled, shows complete text (progressive enhancement)

**Acceptance criteria:**
- [ ] Three steps in a grid (3-col desktop, 1-col mobile)
- [ ] Each step has a number, code block, and description
- [ ] Terminal animation types out commands on scroll
- [ ] Animation is SSR-safe (full text rendered server-side)
- [ ] Section label "How It Works" in brand-orange

---

### Section 5: Features

**Component:** `ProjectsGrid.tsx` (modified) + `ProjectCard.tsx` (modified)

**Data changes in `projects.ts`:**

```typescript
export const projects: Project[] = [
  {
    id: 'chat-interface',
    title: 'Chat Interface',
    description: 'Rich markdown, streaming responses, and syntax highlighting. Claude Code in a real browser UI.',
  },
  {
    id: 'tool-approval',
    title: 'Tool Approval',
    description: 'Review and approve every tool call before it executes. Full control over what Claude does on your machine.',
  },
  {
    id: 'session-management',
    title: 'Session Management',
    description: 'Browse, resume, and sync sessions across devices. Works with CLI-started sessions. One source of truth.',
  },
  {
    id: 'slash-commands',
    title: 'Slash Commands',
    description: 'Discover and run commands from .claude/commands/ with a searchable palette. Your workflows, surfaced.',
  },
]
```

**Type changes in `types.ts`:**

```typescript
// Remove ProjectStatus and ProjectType
export interface Project {
  id: string
  title: string
  description: string
  href?: string
}
```

**ProjectCard changes:**
- Remove status badge and type badge
- Simpler card: title + description only
- Keep hover effect and optional href link

**ProjectsGrid changes:**
- Change desktop grid from `lg:grid-cols-3` to `lg:grid-cols-2` (4 cards = 2x2)
- Keep section label "Features"

**Acceptance criteria:**
- [ ] 4 feature cards (Chat Interface, Tool Approval, Session Management, Slash Commands)
- [ ] No status or type badges on cards
- [ ] 2-column grid on desktop, 1-column on mobile
- [ ] "Features" label in brand-orange

---

### Section 6: What DorkOS Is Not

**Component:** `NotSection.tsx` (new)

**Content:**
```
DorkOS is not a hosted service.
Not a model aggregator.
Not a chat widget.

It's infrastructure you run, own, and control.
```

**Design:**
- Background: `bg-cream-white`
- Centered, generous vertical padding (`py-32`)
- Negation lines: large text (`text-2xl md:text-3xl`), `text-warm-gray`, `font-light`
- Final affirmation: same size, `text-charcoal font-semibold` or `text-brand-orange font-semibold`
- Line spacing: generous (`leading-[2]` or similar) — each line breathes
- No section label, no decorations — the whitespace is the design

**Acceptance criteria:**
- [ ] Three negation lines in warm-gray
- [ ] Final affirmation line in charcoal or brand-orange (visually distinct)
- [ ] Large typography, generous spacing
- [ ] No section label or decorations

---

### Section 7: About (merged)

**Component:** `AboutSection.tsx` (modified)

**Content restructure:**
- Lead text: "DorkOS is open source infrastructure for Claude Code by Dork Labs."
- Description: "DorkOS exists because Claude Code deserved a browser interface. Built on the Agent SDK, it reads the same JSONL session files as the CLI. No separate backend. No data duplication. One source of truth."
- Philosophy grid: 4 items (rewritten — see below)
- Closing: "The name is playful. The tool is serious." (italic, warm-gray-light)

**Philosophy items in `philosophy.ts`:**

```typescript
export const philosophyItems: PhilosophyItem[] = [
  {
    number: '01',
    title: 'Your Machine',
    description: 'Your AI runs on your hardware. Your sessions stay local. No cloud dependency.',
  },
  {
    number: '02',
    title: 'Open Source',
    description: 'MIT licensed. Read every line of code that touches your AI sessions.',
  },
  {
    number: '03',
    title: 'Power Users',
    description: 'Built for developers who ship. Not a toy. Not a wrapper. A runtime.',
  },
  {
    number: '04',
    title: 'Autonomy',
    description: 'Full control is the default. Unrestricted permissions by design.',
  },
]
```

**OriginSection removal:**
- Delete `OriginSection.tsx` file
- Remove export from `index.ts` barrel
- Origin content ("DorkOS exists because...") absorbed into AboutSection description

**Acceptance criteria:**
- [ ] Single "About" section replaces old About + Origin
- [ ] Lead text is shorter and sharper
- [ ] Philosophy grid reflects brand foundation "We Believe" values
- [ ] "The name is playful. The tool is serious." closing line preserved
- [ ] OriginSection.tsx deleted, barrel export removed

---

### Section 8: Contact (unchanged)

Keep `ContactSection.tsx` exactly as-is. The email reveal mechanism is distinctive and well-executed.

---

### Additional Changes

#### Site Config (`config/site.ts`)

```typescript
export const siteConfig = {
  name: 'DorkOS',
  description: 'Remote access to Claude Code. On your machine.',
  // ... rest unchanged
}
```

#### Marketing Layout (`app/(marketing)/layout.tsx`)

- OG title and description auto-update from `siteConfig`
- JSON-LD `description` field auto-updates from `siteConfig`
- No manual changes needed (already reads from config)

#### Footer (`MarketingFooter.tsx`)

- Replace `v1.0 · System Online` with actual version
- Read version from `package.json` or hardcode current version (e.g., `v0.2.0`)
- Format: `v{version} · System Online`

#### Nav (`page.tsx`)

- Update nav links to match new section IDs:
  ```typescript
  const navLinks = [
    { label: 'features', href: '#features' },
    { label: 'about', href: '#about' },
    { label: 'contact', href: '#contact' },
    { label: 'docs', href: '/docs' },
  ]
  ```
  (These are already correct — no change needed since we're keeping the same section IDs.)

#### Page Orchestration (`page.tsx`)

New section order:
```tsx
<Hero ... />
<CredibilityBar />
<ProblemSection />
<HowItWorksSection />
<ProjectsGrid projects={projects} />
<NotSection />
<AboutSection ... />
<ContactSection ... />
```

#### Barrel Export (`index.ts`)

Add new exports, remove OriginSection:
```typescript
export { CredibilityBar } from './ui/CredibilityBar'
export { ProblemSection } from './ui/ProblemSection'
export { HowItWorksSection } from './ui/HowItWorksSection'
export { NotSection } from './ui/NotSection'
// Remove: export { OriginSection } from './ui/OriginSection'
```

## Implementation Phases

### Phase 1: Content & Data Updates (low risk)
1. Update `config/site.ts` description
2. Update `projects.ts` — reduce to 4 items, update descriptions
3. Update `philosophy.ts` — rewrite 4 items
4. Update `types.ts` — simplify `Project` interface

### Phase 2: Modify Existing Components (medium risk)
5. Rewrite `Hero.tsx` — new headline, subhead, simplified props
6. Modify `ProjectCard.tsx` — remove badges
7. Modify `ProjectsGrid.tsx` — change to 2-column grid
8. Merge content into `AboutSection.tsx` — add origin paragraph, closing line
9. Delete `OriginSection.tsx`
10. Update `MarketingFooter.tsx` — real version number

### Phase 3: New Sections (medium risk)
11. Create `CredibilityBar.tsx`
12. Create `ProblemSection.tsx`
13. Create `NotSection.tsx`
14. Create `HowItWorksSection.tsx` (with terminal animation)

### Phase 4: Assembly & Polish (low risk)
15. Update `page.tsx` — new section ordering
16. Update `index.ts` — barrel exports
17. Update `layout.tsx` — verify OG metadata
18. Visual QA — check all sections render correctly, responsive behavior, animations

## Copy Reference

All copy in this spec is final and implementation-ready. Sources:

| Section | Copy source |
|---|---|
| Hero headline | Brand foundation Section 9 (Taglines) |
| Hero subhead | Brand foundation Section 10 (Website Hero) |
| Problem section | Research report (Jobs antagonist principle) |
| How It Works | Brand foundation Section 4 (Product Architecture) + Ogilvy specificity |
| Features descriptions | Rewritten from current — tightened with voice examples table |
| Not section | Brand foundation Section 6 (What DorkOS Is Not) |
| Philosophy items | Brand foundation Section 5 (We Believe) |
| About lead text | Brand foundation Section 1 (Executive Summary) |
| About origin paragraph | Current OriginSection, condensed to one paragraph |

## Banned Words

Per Ogilvy principles and brand voice guidelines, the following words must NOT appear on the homepage:

powerful, seamless, robust, next-generation, cutting-edge, innovative, intuitive, comprehensive, enterprise-grade, revolutionary, easy-to-use, simple, AI assistant

## Testing

No automated tests currently exist for marketing components. This spec does not add tests (marketing pages are visually verified). Manual verification:

- [ ] All 8 sections render in correct order
- [ ] Hero headline is "Own Your AI."
- [ ] Terminal animation plays on scroll
- [ ] Terminal animation degrades gracefully (SSR, no-JS)
- [ ] 4 feature cards in 2x2 grid (desktop)
- [ ] No status/type badges on feature cards
- [ ] Footer shows real version number
- [ ] Mobile responsive (all sections stack correctly)
- [ ] OG meta description matches new site description
- [ ] No banned words on page
- [ ] All links work (npm, docs, GitHub)
- [ ] PostHog tracking still works on contact email reveal

## Non-Goals

- Dynamic GitHub star count / npm downloads (future enhancement)
- Testimonials section (skip until real quotes available)
- Multi-page site structure (revisit when Pulse/Channels/Wing ship)
- Blog or changelog system
- A/B testing
- New color palette or visual design language
- Terminal library dependency if SSR-incompatible (use custom CSS animation instead)
