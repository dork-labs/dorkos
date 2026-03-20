---
title: Design Spec — /story Page
---

# Design Spec: `/story` Page

**Date:** 2026-03-12
**Status:** Approved
**URL:** `dorkos.ai/story`
**Dual purpose:** Live presentation at No Edges event (March 12, 2026) + permanent DorkOS origin story page

---

## Overview

A scroll-driven narrative page that tells the origin story of DorkOS through Dorian's personal arc -- from wanting a to-do list to running coordinated autonomous agents across four companies in two months of evenings. The page serves a live presentation today and lives permanently on dorkos.ai as the "why behind the what."

The vibe throughout: less obligation, more life. The technology is in service of presence -- time back with family, focus on what matters, the machine handling what it doesn't need a human for.

---

## Decisions Summary

| Decision                | Choice                                                                                                            |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------- |
| URL                     | `/story`                                                                                                          |
| Scroll mode             | Dual: continuous scroll normally, `?present=true` for presentation snap                                           |
| Section 1 visualization | Dashboard cards that populate (8-card grid)                                                                       |
| Section 3 visualization | Equation reveal (X = Y, one at a time)                                                                            |
| Architecture            | Extend `layers/features/marketing/` with new story sections                                                       |
| Opening line            | "What if the most powerful thing you could do with AI was get Thursday afternoon back?"                           |
| Section 3 headline      | "Platforms will just be prompts."                                                                                 |
| Section 3 closer        | "Code isn't the scarce thing anymore. Knowing what to ask -- and what to remember -- is."                         |
| Section 4 top line      | "Anyone has access to the same AI. Not everyone has thought hard about what they actually want."                  |
| Section 4 close         | "I built this so the machine could handle the obligations. So I could focus on the parts that are irreplaceable." |

---

## File Structure

```
apps/site/src/
├── app/(marketing)/story/
│   ├── layout.tsx                        # metadata, OG tags
│   └── page.tsx                          # server component, composes sections
└── layers/features/marketing/
    ├── ui/
    │   ├── story/
    │   │   ├── StoryHero.tsx             # Slide 0: opening title card
    │   │   ├── MondayMorningSection.tsx  # Slide 1: boot dashboard
    │   │   ├── HowItBuiltSection.tsx     # Slide 2: 4-step timeline
    │   │   ├── JustPromptsSection.tsx    # Slide 3: equation reveal
    │   │   ├── CloseSection.tsx          # Slide 4: minimal close
    │   │   └── FutureVisionSection.tsx   # Slide 5: page-only, hidden in present mode
    │   └── PresentationShell.tsx         # Wraps the page; handles ?present=true
    └── lib/
        ├── use-presentation-mode.ts      # Hook: reads useSearchParams for ?present=true
        └── story-data.ts                 # Boot cards, timeline steps, equation items
```

New exports added to `layers/features/marketing/index.ts` barrel.

---

## Page Component

`app/(marketing)/story/page.tsx` is a **server component** (no `'use client'`). Metadata lives in `layout.tsx`. Client interactivity is encapsulated in section components and `PresentationShell`.

```tsx
import { Suspense } from 'react'
import {
  PresentationShell,
  StoryHero,
  MondayMorningSection,
  HowItBuiltSection,
  JustPromptsSection,
  CloseSection,
  FutureVisionSection,
  MarketingFooter,
} from '@/layers/features/marketing'

export default function StoryPage() {
  return (
    <Suspense fallback={null}>
      <PresentationShell>
        <StoryHero />
        <MondayMorningSection id="morning" />
        <HowItBuiltSection id="timeline" />
        <JustPromptsSection id="prompts" />
        <CloseSection id="close" />
        <FutureVisionSection id="vision" />
        <MarketingFooter ... />
      </PresentationShell>
    </Suspense>
  )
}
```

`<Suspense>` is required by Next.js because `PresentationShell` calls `useSearchParams()` internally.

---

## Metadata

`app/(marketing)/story/layout.tsx`:

```tsx
export const metadata: Metadata = {
  title: 'The Story | DorkOS',
  description:
    'How one person built an AI operating system for their whole life -- in two months of evenings.',
  openGraph: {
    title: 'The Story | DorkOS',
    description:
      'How one person built an AI operating system for their whole life -- in two months of evenings.',
    url: '/story',
    type: 'website',
  },
};
```

---

## Presentation Mode

### Activation

`?present=true` query parameter. URL: `dorkos.ai/story?present=true`

### `use-presentation-mode.ts`

```ts
'use client';
import { useSearchParams } from 'next/navigation';
export function usePresentationMode() {
  const params = useSearchParams();
  return params.get('present') === 'true';
}
```

### `PresentationShell.tsx`

Client component. When presentation mode is active:

- Adds `data-present` attribute to wrapper div
- CSS via `globals.css` or inline: `scroll-snap-type: y mandatory; overflow-y: scroll; height: 100vh`
- Each child section receives `scroll-snap-align: start; min-height: 100vh` (applied via the `data-present` selector on the parent)
- `MarketingHeader` hidden via `data-present [data-marketing-header] { display: none }`
- Keyboard listener (`useEffect`): `ArrowRight`/`Space` scrolls to next section by index; `ArrowLeft` scrolls to previous
- Progress dots: fixed bottom-right, one dot per section (excluding `FutureVisionSection`), current section highlighted in orange
- Font sizes boosted ~1.3x on slide headings via `data-present h2, data-present h3 { font-size: calc(var(--heading-size) * 1.3) }`

### Keyboard navigation implementation

```ts
const sectionIds = ['morning', 'timeline', 'prompts', 'close'];
// FutureVisionSection excluded from keyboard nav (page-only)

useEffect(() => {
  if (!isPresent) return;
  const handler = (e: KeyboardEvent) => {
    if (e.key === 'ArrowRight' || e.key === ' ') {
      e.preventDefault();
      scrollToSection(currentIndex + 1);
    }
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      scrollToSection(currentIndex - 1);
    }
  };
  window.addEventListener('keydown', handler);
  return () => window.removeEventListener('keydown', handler);
}, [isPresent, currentIndex]);
```

Current section tracked via `IntersectionObserver` on each section element.

---

## Section Designs

### Slide 0: StoryHero

- **Background:** `bg-charcoal` (`#1A1814`)
- **Eyebrow:** `ORIGIN STORY` (monospace, orange, uppercase, tracked)
- **Headline:** "What if the most powerful thing you could do with AI was get Thursday afternoon back?"
  - Large, light weight (`font-weight: 300`), max-width 580px, centered
- **Divider:** 32px orange horizontal rule
- **Attribution:** `DORIAN COLLIER -- 144 STUDIO -- AUSTIN TX` (monospace, small, warm-gray)
- **Animation:** REVEAL + STAGGER (standard marketing pattern)

---

### Slide 1: MondayMorningSection

- **Background:** `#0f0e0c` (near-black, slightly warmer than charcoal)
- **Eyebrow:** `A MONDAY MORNING`
- **Headline:** "Before you touched anything."
- **Subline:** "While you slept, the system ran." (warm-gray)
- **Boot cards grid:** 4-column grid, 8 cards, staggered entrance animation

| Card      | Category color              | Title      | Detail                       |
| --------- | --------------------------- | ---------- | ---------------------------- |
| Health    | orange border               | Synced     | HRV · sleep · steps          |
| Companies | blue                        | 4 loaded   | tasks · projects             |
| ⚑ Overdue | orange border + orange text | 15 days    | flagged for you              |
| Calendar  | purple                      | 3 preps    | meetings identified          |
| Family    | blue border                 | Liam · Thu | therapy · brief outdated     |
| Energy    | green                       | 4 dims     | phys · mental · emo · spirit |
| Coaching  | orange                      | Fear check | priorities → 3               |
| Output    | warm-gray                   | Ready      | calendar · habits · audio    |

Cards animate in sequentially (staggered, ~80ms apart) using STAGGER + REVEAL.

- **Landing line** (below border): _"This isn't ChatGPT. This is a personal operating system."_ — italic, centered, cream-white

---

### Slide 2: HowItBuiltSection

- **Background:** `bg-cream-primary` (`#F5F0E6`)
- **Eyebrow:** `TWO MONTHS OF EVENINGS`
- **Headline:** "Each step hit a ceiling. Each ceiling became the next build."
- **Timeline:** Vertical, 4 numbered steps

Each step:

```
[number circle]  PRODUCT -- DURATION (monospace, small, colored)
                 Description sentence (IBM Plex Sans, medium weight)
                 Ceiling hit: limitation that drove the next step (monospace, warm-gray-light)
```

Steps:

| #   | Color    | Label                 | Description                                                                      | Ceiling                                        |
| --- | -------- | --------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------- |
| 1   | orange   | LifeOS -- A weekend   | Calendar, todos, journaling, coaching. Built for my life -- not for any company. | Needed to manage multiple AI projects at once. |
| 2   | charcoal | DorkOS -- A few weeks | A command layer across all my agents. One place to run everything.               | Still had to be awake for any of it to run.    |
| 3   | charcoal | Pulse -- A few weeks  | Scheduled tasks. The system fires overnight. Texts briefings before I wake up.   | Agents couldn't talk to each other.            |
| 4   | charcoal | Mesh -- A few weeks   | Four companies, each with its own agent. They find each other and coordinate.    | _(closing statement, no ceiling)_              |

- **Footer:** _"Total calendar time from 'I want a to-do list' to 'my agents coordinate while I sleep' -- two months of evenings."_ — italic, warm-gray, border-top

---

### Slide 3: JustPromptsSection

- **Background:** `bg-charcoal film-grain`
- **Eyebrow:** `HERE'S THE THING`
- **Headline:** "Platforms will just be prompts." (bold, large)
- **Subline:** "All open source. Here's what it actually is." (warm-gray)
- **Equation items** (animate in one at a time, ~200ms each):

```
50+ skills              =   text files
~100 coaching Qs        =   one markdown doc
board of advisors       =   configuration
automated hooks         =   small scripts
```

Left column: cream-white, monospace, right-aligned. `=` in orange. Right column: warm-gray, monospace, left-aligned.

- **Divider** (border-top, dark)
- **Closing moment:**
  - "Platforms will just be prompts." (medium weight, cream-white)
  - "Code isn't the scarce thing anymore. Knowing what to ask -- and what to remember -- is." (warm-gray, line-height 1.6)

---

### Slide 4: CloseSection

- **Background:** `bg-charcoal`
- **Maximum whitespace.** Centered, no grid.
- **Top line:** "Anyone has access to the same AI. Not everyone has thought hard about what they actually want." (warm-gray, slightly smaller)
- **Orange divider**
- **Close:** "I built this so the machine could handle the obligations. So I could focus on the parts that are irreplaceable." (cream-white, light weight, large)
- **Footer:** `FUNDAMENTALS FIRST -- 2026` (monospace, very small, warm-gray)

---

### Slide 5: FutureVisionSection (page-only)

- **Background:** `bg-cream-secondary`
- **Hidden in `?present=true`** via `data-present [data-future-vision] { display: none }`
- **Eyebrow:** `WHERE THIS IS GOING`
- **Headline:** "The next layer is already building."
- **Three cards:** Autonomous (orange), Connected (blue), Commerce (green)
  - Each: category label, short title, 1-2 sentence description referencing the DorkOS subsystem

---

## Data File: `story-data.ts`

```ts
export const bootCards = [
  {
    id: 'health',
    label: 'Health',
    value: 'Synced',
    detail: 'HRV · sleep · steps',
    color: 'orange',
    priority: 'high',
  },
  {
    id: 'companies',
    label: 'Companies',
    value: '4 loaded',
    detail: 'tasks · projects',
    color: 'blue',
    priority: 'normal',
  },
  {
    id: 'overdue',
    label: '⚑ Overdue',
    value: '15 days',
    detail: 'flagged for you',
    color: 'orange',
    priority: 'urgent',
  },
  {
    id: 'calendar',
    label: 'Calendar',
    value: '3 preps',
    detail: 'meetings identified',
    color: 'purple',
    priority: 'normal',
  },
  {
    id: 'family',
    label: 'Family',
    value: 'Liam · Thu',
    detail: 'therapy · brief outdated',
    color: 'blue',
    priority: 'high',
  },
  {
    id: 'energy',
    label: 'Energy',
    value: '4 dims',
    detail: 'phys · mental · emo · spirit',
    color: 'green',
    priority: 'normal',
  },
  {
    id: 'coaching',
    label: 'Coaching',
    value: 'Fear check',
    detail: 'priorities → 3',
    color: 'orange',
    priority: 'normal',
  },
  {
    id: 'output',
    label: 'Output',
    value: 'Ready',
    detail: 'calendar · habits · audio',
    color: 'gray',
    priority: 'normal',
  },
];

export const evolutionSteps = [
  {
    step: 1,
    product: 'LifeOS',
    duration: 'A weekend',
    description: 'Calendar, todos, journaling, coaching. Built for my life -- not for any company.',
    ceiling: 'Needed to manage multiple AI projects at once.',
    color: 'orange',
  },
  {
    step: 2,
    product: 'DorkOS',
    duration: 'A few weeks',
    description: 'A command layer across all my agents. One place to run everything.',
    ceiling: 'Still had to be awake for any of it to run.',
    color: 'charcoal',
  },
  {
    step: 3,
    product: 'Pulse',
    duration: 'A few weeks',
    description: 'Scheduled tasks. The system fires overnight. Texts briefings before I wake up.',
    ceiling: "Agents couldn't talk to each other.",
    color: 'charcoal',
  },
  {
    step: 4,
    product: 'Mesh',
    duration: 'A few weeks',
    description: 'Four companies, each with its own agent. They find each other and coordinate.',
    ceiling: null,
    color: 'charcoal',
  },
];

export const equationItems = [
  { lhs: '50+ skills', rhs: 'text files' },
  { lhs: '~100 coaching Qs', rhs: 'one markdown doc' },
  { lhs: 'board of advisors', rhs: 'configuration' },
  { lhs: 'automated hooks', rhs: 'small scripts' },
];

export const futureCards = [
  {
    id: 'autonomous',
    label: 'Autonomous',
    title: 'Agents that run',
    description: 'Pulse. Already shipping. Your agents work while you sleep.',
    color: 'orange',
  },
  {
    id: 'connected',
    label: 'Connected',
    title: 'Agents that talk',
    description: 'Mesh. Agent-to-agent discovery and coordination across teams.',
    color: 'blue',
  },
  {
    id: 'commerce',
    label: 'Commerce',
    title: 'Agents that transact',
    description: 'HTTP 402. Agents negotiate, purchase, settle. The economy reshapes.',
    color: 'green',
  },
];
```

---

## Animation Patterns

All animations use existing `motion-variants.ts` exports:

- `REVEAL` -- fade + slide-up (`opacity: 0, y: 20` → `opacity: 1, y: 0`)
- `STAGGER` -- staggers children at 80ms
- `SPRING` -- overdamped spring (stiffness: 100, damping: 20)
- `VIEWPORT` -- `{ once: true, amount: 0.2 }`

Boot cards use a custom stagger delay per card index:

```tsx
<motion.div
  variants={REVEAL}
  transition={{ delay: index * 0.08 }}
>
```

Equation items animate in sequentially using the same pattern.

---

## Design Conventions

All sections follow existing site conventions:

- `'use client'` at top of every section component
- `import { motion } from 'motion/react'`
- `import { REVEAL, STAGGER, SPRING, VIEWPORT } from '../lib/motion-variants'`
- Use design token class names, never hardcoded colors (`bg-charcoal`, not `#1A1814`)
- IBM Plex Sans for body/headings, IBM Plex Mono for labels/code/data
- No em dashes -- double hyphens (`--`) instead
- File size target: < 300 lines per component; split if exceeded

---

## Navigation

The `MarketingNav` is hidden in presentation mode. In normal reading mode, it is omitted from this page (the story has its own internal flow; a floating nav would compete with the scroll narrative). The `MarketingHeader` is present in normal mode, hidden in presentation mode.

A simple "back to home" link lives in the `MarketingFooter`.

---

## Responsive

- **Desktop (primary):** Full grid layouts, large typography
- **Tablet:** 2-column boot card grid (from 4-column), timeline unchanged
- **Mobile:** Single-column boot cards, reduced heading sizes
- **Presentation mode:** Desktop-only. On mobile/tablet, `?present=true` degrades gracefully to normal scroll (no snap, no keyboard nav, no dots)

---

## Success Criteria

### Presentation (today)

- [ ] Page loads at `dorkos.ai/story?present=true`
- [ ] Each section fills the viewport
- [ ] Arrow keys / spacebar advance and retreat between sections
- [ ] Progress dots visible in bottom-right
- [ ] All text readable from 15+ feet on a large TV
- [ ] MarketingHeader hidden in present mode

### Permanent page

- [ ] Feels native to dorkos.ai -- same typography, motion, color tokens
- [ ] Tells the DorkOS origin story as a personal narrative
- [ ] Works as a standalone page for first-time visitors
- [ ] FutureVisionSection visible in normal reading mode, hidden in present mode
- [ ] Page is linked from MarketingFooter or MarketingNav
