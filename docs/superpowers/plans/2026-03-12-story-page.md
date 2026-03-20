---
title: Story Page Implementation Plan
---

# Story Page Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `/story` page on dorkos.ai -- a scroll-driven narrative page telling the DorkOS origin story, doubling as a live presentation tool via `?present=true`.

**Architecture:** New section components added to `layers/features/marketing/ui/story/`, following the exact existing homepage pattern. A `PresentationShell` client component reads `?present=true` from the URL and switches the page into full-screen snap mode with keyboard navigation. Data is extracted to `story-data.ts` in the lib layer.

**Tech Stack:** Next.js 16 (App Router), React 19, Tailwind CSS v4, motion/react, TypeScript, Vitest + React Testing Library

**Spec:** `docs/superpowers/specs/2026-03-12-story-page-design.md`

---

## Chunk 1: Foundation

Data layer, presentation mode hook, and global CSS additions.

### Task 1: Create `story-data.ts`

**Files:**

- Create: `apps/site/src/layers/features/marketing/lib/story-data.ts`

- [ ] **Step 1: Create the data file**

```typescript
// apps/site/src/layers/features/marketing/lib/story-data.ts

/** Boot card displayed in the MondayMorningSection grid. */
export interface BootCard {
  id: string;
  label: string;
  value: string;
  detail: string;
  /** Design token color name for the border accent. */
  color: 'orange' | 'blue' | 'purple' | 'green' | 'gray';
  /** Whether the card has an urgent/flagged treatment. */
  urgent?: boolean;
}

/** One step in the LifeOS -> DorkOS evolution timeline. */
export interface EvolutionStep {
  step: number;
  product: string;
  duration: string;
  description: string;
  /** What limitation drove the next step. Null for the final step. */
  ceiling: string | null;
  /** Design token color for the step number circle. */
  color: 'orange' | 'charcoal';
}

/** One line in the "platforms will just be prompts" equation. */
export interface EquationItem {
  lhs: string;
  rhs: string;
}

/** One card in the FutureVisionSection. */
export interface FutureCard {
  id: string;
  label: string;
  title: string;
  description: string;
  color: 'orange' | 'blue' | 'green';
}

export const bootCards: BootCard[] = [
  {
    id: 'health',
    label: 'Health',
    value: 'Synced',
    detail: 'HRV · sleep · steps',
    color: 'orange',
  },
  {
    id: 'companies',
    label: 'Companies',
    value: '4 loaded',
    detail: 'tasks · projects',
    color: 'blue',
  },
  {
    id: 'overdue',
    label: '⚑ Overdue',
    value: '15 days',
    detail: 'flagged for you',
    color: 'orange',
    urgent: true,
  },
  {
    id: 'calendar',
    label: 'Calendar',
    value: '3 preps',
    detail: 'meetings identified',
    color: 'purple',
  },
  {
    id: 'family',
    label: 'Family',
    value: 'Liam · Thu',
    detail: 'therapy · brief outdated',
    color: 'blue',
  },
  {
    id: 'energy',
    label: 'Energy',
    value: '4 dims',
    detail: 'phys · mental · emo · spirit',
    color: 'green',
  },
  {
    id: 'coaching',
    label: 'Coaching',
    value: 'Fear check',
    detail: 'priorities → 3',
    color: 'orange',
  },
  {
    id: 'output',
    label: 'Output',
    value: 'Ready',
    detail: 'calendar · habits · audio',
    color: 'gray',
  },
];

export const evolutionSteps: EvolutionStep[] = [
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

export const equationItems: EquationItem[] = [
  { lhs: '50+ skills', rhs: 'text files' },
  { lhs: '~100 coaching Qs', rhs: 'one markdown doc' },
  { lhs: 'board of advisors', rhs: 'configuration' },
  { lhs: 'automated hooks', rhs: 'small scripts' },
];

export const futureCards: FutureCard[] = [
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

- [ ] **Step 2: Verify TypeScript compiles**

```bash
pnpm typecheck --filter=@dorkos/site
```

Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add apps/site/src/layers/features/marketing/lib/story-data.ts
git commit -m "feat(site/story): add story-data types and content"
```

---

### Task 2: `use-presentation-mode` hook + test

**Files:**

- Create: `apps/site/src/layers/features/marketing/lib/use-presentation-mode.ts`
- Create: `apps/site/src/layers/features/marketing/lib/__tests__/use-presentation-mode.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// apps/site/src/layers/features/marketing/lib/__tests__/use-presentation-mode.test.ts
/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { usePresentationMode } from '../use-presentation-mode';

vi.mock('next/navigation', () => ({
  useSearchParams: vi.fn(),
}));

import { useSearchParams } from 'next/navigation';

describe('usePresentationMode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns false when ?present param is absent', () => {
    vi.mocked(useSearchParams).mockReturnValue(new URLSearchParams() as any);
    const { result } = renderHook(() => usePresentationMode());
    expect(result.current).toBe(false);
  });

  it('returns true when ?present=true', () => {
    vi.mocked(useSearchParams).mockReturnValue(new URLSearchParams('present=true') as any);
    const { result } = renderHook(() => usePresentationMode());
    expect(result.current).toBe(true);
  });

  it('returns false when ?present=false', () => {
    vi.mocked(useSearchParams).mockReturnValue(new URLSearchParams('present=false') as any);
    const { result } = renderHook(() => usePresentationMode());
    expect(result.current).toBe(false);
  });

  it('returns false when ?present has an unexpected value', () => {
    vi.mocked(useSearchParams).mockReturnValue(new URLSearchParams('present=1') as any);
    const { result } = renderHook(() => usePresentationMode());
    expect(result.current).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm vitest run apps/site/src/layers/features/marketing/lib/__tests__/use-presentation-mode.test.ts
```

Expected: FAIL with "Cannot find module '../use-presentation-mode'"

- [ ] **Step 3: Create the hook**

```typescript
// apps/site/src/layers/features/marketing/lib/use-presentation-mode.ts
'use client';

import { useSearchParams } from 'next/navigation';

/**
 * Returns true when the page is in presentation mode (?present=true).
 * Used by PresentationShell to activate full-screen snap navigation.
 */
export function usePresentationMode(): boolean {
  const params = useSearchParams();
  return params.get('present') === 'true';
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm vitest run apps/site/src/layers/features/marketing/lib/__tests__/use-presentation-mode.test.ts
```

Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/site/src/layers/features/marketing/lib/use-presentation-mode.ts \
        apps/site/src/layers/features/marketing/lib/__tests__/use-presentation-mode.test.ts
git commit -m "feat(site/story): add usePresentationMode hook"
```

---

### Task 3: Add presentation mode CSS to `globals.css`

**Files:**

- Modify: `apps/site/src/app/globals.css`

- [ ] **Step 1: Append the presentation mode styles**

Find the end of `globals.css` and add:

```css
/* ─── Presentation mode ──────────────────────────────────────────────────── */

/**
 * PresentationShell applies [data-present="true"] to its root div.
 * In this mode the container becomes a fixed fullscreen scroll-snap viewport.
 */
[data-present='true'].presentation-shell {
  position: fixed;
  inset: 0;
  overflow-y: scroll;
  scroll-snap-type: y mandatory;
  z-index: 50;
  background: var(--charcoal);
}

/* Each section fills the viewport and snaps into place */
[data-present='true'].presentation-shell [data-slide] {
  scroll-snap-align: start;
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  justify-content: center;
}

/* Boost heading sizes ~1.3x in presentation mode for TV readability */
[data-present='true'].presentation-shell h2 {
  font-size: calc(1em * 1.3);
}
[data-present='true'].presentation-shell h3 {
  font-size: calc(1em * 1.3);
}

/* Hide chrome in presentation mode */
[data-present='true'].presentation-shell [data-marketing-header],
[data-present='true'].presentation-shell [data-marketing-footer] {
  display: none;
}

/* Hide the future vision section in presentation mode */
[data-present='true'].presentation-shell [data-future-vision] {
  display: none;
}

/* Progress dots */
.presentation-dots {
  position: fixed;
  bottom: 24px;
  right: 24px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  z-index: 60;
}

.presentation-dots .dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--warm-gray-light);
  border: none;
  cursor: pointer;
  transition: background 0.2s ease;
  padding: 0;
}

.presentation-dots .dot-active {
  background: var(--brand-orange);
}

/* Cursor blink for terminal art (used in VillainSection -- included here for reuse) */
@keyframes tab-pulse-urgent {
  0%,
  100% {
    opacity: 0.45;
  }
  50% {
    opacity: 0.9;
  }
}
```

- [ ] **Step 2: Verify site builds without CSS errors**

```bash
pnpm build --filter=@dorkos/site 2>&1 | tail -20
```

Expected: build completes, no CSS parse errors

- [ ] **Step 3: Commit**

```bash
git add apps/site/src/app/globals.css
git commit -m "feat(site/story): add presentation mode CSS"
```

---

## Chunk 2: PresentationShell + Section Components

### Task 4: `PresentationShell`

**Files:**

- Create: `apps/site/src/layers/features/marketing/ui/PresentationShell.tsx`

- [ ] **Step 1: Create the component**

```tsx
// apps/site/src/layers/features/marketing/ui/PresentationShell.tsx
'use client';

import { useEffect, useRef, useState } from 'react';
import { usePresentationMode } from '../lib/use-presentation-mode';

/** Section IDs navigated by keyboard in presentation mode. FutureVisionSection is excluded. */
const PRESENTATION_SECTION_IDS = ['hero', 'morning', 'timeline', 'prompts', 'close'] as const;

interface PresentationShellProps {
  children: React.ReactNode;
}

/**
 * Wraps the story page. When ?present=true is in the URL:
 * - Switches to fixed full-screen scroll-snap layout
 * - Enables ArrowRight/Space (next) and ArrowLeft (prev) keyboard nav
 * - Renders progress dots in the bottom-right corner
 */
export function PresentationShell({ children }: PresentationShellProps) {
  const isPresent = usePresentationMode();
  const [currentIndex, setCurrentIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);

  // Track which section is in view via IntersectionObserver
  useEffect(() => {
    if (!isPresent || !containerRef.current) return;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const slideId = entry.target.getAttribute('data-slide');
            const idx = PRESENTATION_SECTION_IDS.indexOf(
              slideId as (typeof PRESENTATION_SECTION_IDS)[number]
            );
            if (idx !== -1) setCurrentIndex(idx);
          }
        }
      },
      { threshold: 0.5 }
    );

    const slides = containerRef.current.querySelectorAll('[data-slide]');
    slides.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [isPresent]);

  // Keyboard navigation
  useEffect(() => {
    if (!isPresent) return;

    const scrollToIndex = (idx: number) => {
      const clamped = Math.max(0, Math.min(idx, PRESENTATION_SECTION_IDS.length - 1));
      const target = containerRef.current?.querySelector(
        `[data-slide="${PRESENTATION_SECTION_IDS[clamped]}"]`
      );
      target?.scrollIntoView({ behavior: 'smooth' });
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight' || e.key === ' ') {
        e.preventDefault();
        scrollToIndex(currentIndex + 1);
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        scrollToIndex(currentIndex - 1);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isPresent, currentIndex]);

  return (
    <div
      ref={containerRef}
      className="presentation-shell"
      {...(isPresent ? { 'data-present': 'true' } : {})}
    >
      {children}

      {isPresent && (
        <nav className="presentation-dots" aria-label="Presentation navigation">
          {PRESENTATION_SECTION_IDS.map((id, i) => (
            <button
              key={id}
              className={i === currentIndex ? 'dot dot-active' : 'dot'}
              aria-label={`Go to slide ${i + 1}`}
              onClick={() => {
                const target = containerRef.current?.querySelector(`[data-slide="${id}"]`);
                target?.scrollIntoView({ behavior: 'smooth' });
              }}
            />
          ))}
        </nav>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
pnpm typecheck --filter=@dorkos/site
```

Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add apps/site/src/layers/features/marketing/ui/PresentationShell.tsx
git commit -m "feat(site/story): add PresentationShell with keyboard nav and progress dots"
```

---

### Task 5: `StoryHero`

**Files:**

- Create: `apps/site/src/layers/features/marketing/ui/story/StoryHero.tsx`

- [ ] **Step 1: Create the directory and component**

```bash
mkdir -p apps/site/src/layers/features/marketing/ui/story
```

```tsx
// apps/site/src/layers/features/marketing/ui/story/StoryHero.tsx
'use client';

import { motion } from 'motion/react';
import { REVEAL, STAGGER, VIEWPORT } from '../../lib/motion-variants';

interface StoryHeroProps {
  /** data-slide value used by PresentationShell for keyboard navigation. */
  slideId?: string;
}

/** Opening title card. Sets the "Thursday afternoon" frame for the whole page. */
export function StoryHero({ slideId = 'hero' }: StoryHeroProps) {
  return (
    <section
      className="bg-charcoal relative flex min-h-[80vh] flex-col items-center justify-center px-8 py-20 text-center"
      data-slide={slideId}
    >
      <motion.div
        className="mx-auto max-w-2xl"
        initial="hidden"
        whileInView="visible"
        viewport={VIEWPORT}
        variants={STAGGER}
      >
        <motion.div
          variants={REVEAL}
          className="text-brand-orange mb-6 font-mono text-[9px] tracking-[0.2em] uppercase"
        >
          Origin Story
        </motion.div>

        <motion.p
          variants={REVEAL}
          className="text-cream-white mb-6 text-[clamp(22px,3.5vw,40px)] leading-[1.4] font-light"
        >
          What if the most powerful thing you could do with AI was get Thursday afternoon back?
        </motion.p>

        <motion.div
          variants={REVEAL}
          className="bg-brand-orange mx-auto mb-8 h-px w-8"
          aria-hidden="true"
        />

        <motion.p
          variants={REVEAL}
          className="text-warm-gray-light font-mono text-[10px] tracking-[0.1em] uppercase"
        >
          Dorian Collier &mdash; 144 Studio &mdash; Austin TX
        </motion.p>
      </motion.div>
    </section>
  );
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
pnpm typecheck --filter=@dorkos/site
```

Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add apps/site/src/layers/features/marketing/ui/story/StoryHero.tsx
git commit -m "feat(site/story): add StoryHero section"
```

---

### Task 6: `MondayMorningSection`

**Files:**

- Create: `apps/site/src/layers/features/marketing/ui/story/MondayMorningSection.tsx`

- [ ] **Step 1: Create the component**

```tsx
// apps/site/src/layers/features/marketing/ui/story/MondayMorningSection.tsx
'use client';

import { motion } from 'motion/react';
import { REVEAL, STAGGER, SPRING, VIEWPORT } from '../../lib/motion-variants';
import { bootCards } from '../../lib/story-data';
import type { BootCard } from '../../lib/story-data';

interface MondayMorningSectionProps {
  slideId?: string;
}

const BORDER_COLOR: Record<BootCard['color'], string> = {
  orange: 'border-brand-orange',
  blue: 'border-brand-blue',
  purple: 'border-brand-purple',
  green: 'border-brand-green',
  gray: 'border-warm-gray/20',
};

const LABEL_COLOR: Record<BootCard['color'], string> = {
  orange: 'text-brand-orange',
  blue: 'text-brand-blue',
  purple: 'text-brand-purple',
  green: 'text-brand-green',
  gray: 'text-warm-gray-light',
};

/** The "Monday Morning" boot dashboard -- 8 cards that appear before you touch anything. */
export function MondayMorningSection({ slideId = 'morning' }: MondayMorningSectionProps) {
  return (
    <section
      className="flex min-h-screen flex-col justify-center bg-[#0f0e0c] px-8 py-16"
      data-slide={slideId}
    >
      <div className="mx-auto w-full max-w-4xl">
        {/* Header */}
        <motion.div
          initial="hidden"
          whileInView="visible"
          viewport={VIEWPORT}
          variants={STAGGER}
          className="mb-8"
        >
          <motion.div
            variants={REVEAL}
            className="text-brand-orange mb-3 font-mono text-[9px] tracking-[0.2em] uppercase"
          >
            A Monday Morning
          </motion.div>
          <motion.h2
            variants={REVEAL}
            className="text-cream-white mb-2 text-[clamp(22px,3vw,36px)] font-semibold tracking-tight"
          >
            Before you touched anything.
          </motion.h2>
          <motion.p variants={REVEAL} className="text-warm-gray text-sm">
            While you slept, the system ran.
          </motion.p>
        </motion.div>

        {/* Boot cards grid */}
        <motion.div
          initial="hidden"
          whileInView="visible"
          viewport={VIEWPORT}
          variants={STAGGER}
          className="mb-8 grid grid-cols-2 gap-3 sm:grid-cols-4"
        >
          {bootCards.map((card, i) => (
            <motion.div
              key={card.id}
              variants={REVEAL}
              transition={{ delay: i * 0.08, ...SPRING }}
              className={`bg-charcoal rounded-md border p-3 ${BORDER_COLOR[card.color]}`}
            >
              <div
                className={`mb-1 font-mono text-[8px] tracking-[0.1em] uppercase ${LABEL_COLOR[card.color]}`}
              >
                {card.label}
              </div>
              <div
                className={`mb-1 font-mono text-[13px] font-medium ${card.urgent ? 'text-brand-orange' : 'text-cream-white'}`}
              >
                {card.value}
              </div>
              <div className="text-warm-gray-light font-mono text-[8px]">{card.detail}</div>
            </motion.div>
          ))}
        </motion.div>

        {/* Landing line */}
        <motion.div
          initial="hidden"
          whileInView="visible"
          viewport={VIEWPORT}
          variants={REVEAL}
          className="border-warm-gray/10 border-t pt-5 text-center"
        >
          <p className="text-cream-white text-[15px] font-semibold italic">
            &ldquo;This isn&apos;t ChatGPT. This is a personal operating system.&rdquo;
          </p>
        </motion.div>
      </div>
    </section>
  );
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
pnpm typecheck --filter=@dorkos/site
```

Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add apps/site/src/layers/features/marketing/ui/story/MondayMorningSection.tsx
git commit -m "feat(site/story): add MondayMorningSection boot dashboard"
```

---

### Task 7: `HowItBuiltSection`

**Files:**

- Create: `apps/site/src/layers/features/marketing/ui/story/HowItBuiltSection.tsx`

- [ ] **Step 1: Create the component**

```tsx
// apps/site/src/layers/features/marketing/ui/story/HowItBuiltSection.tsx
'use client';

import { motion } from 'motion/react';
import { REVEAL, STAGGER, VIEWPORT } from '../../lib/motion-variants';
import { evolutionSteps } from '../../lib/story-data';

interface HowItBuiltSectionProps {
  slideId?: string;
}

/** 4-step evolution timeline: LifeOS -> DorkOS -> Pulse -> Mesh. */
export function HowItBuiltSection({ slideId = 'timeline' }: HowItBuiltSectionProps) {
  return (
    <section
      className="bg-cream-primary flex min-h-screen flex-col justify-center px-8 py-16"
      data-slide={slideId}
    >
      <div className="mx-auto w-full max-w-2xl">
        {/* Header */}
        <motion.div
          initial="hidden"
          whileInView="visible"
          viewport={VIEWPORT}
          variants={STAGGER}
          className="mb-10"
        >
          <motion.div
            variants={REVEAL}
            className="text-brand-orange mb-3 font-mono text-[9px] tracking-[0.2em] uppercase"
          >
            Two Months of Evenings
          </motion.div>
          <motion.h2
            variants={REVEAL}
            className="text-charcoal text-[clamp(20px,2.8vw,32px)] font-semibold tracking-tight"
          >
            Each step hit a ceiling. Each ceiling became the next build.
          </motion.h2>
        </motion.div>

        {/* Timeline steps */}
        <motion.div
          initial="hidden"
          whileInView="visible"
          viewport={VIEWPORT}
          variants={STAGGER}
          className="flex flex-col gap-6"
        >
          {evolutionSteps.map((step) => (
            <motion.div key={step.step} variants={REVEAL} className="flex gap-4">
              {/* Step number */}
              <div
                className={`text-cream-white mt-0.5 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full font-mono text-[11px] font-bold ${step.color === 'orange' ? 'bg-brand-orange' : 'bg-charcoal'}`}
              >
                {step.step}
              </div>

              {/* Content */}
              <div className="min-w-0">
                <div
                  className={`mb-0.5 font-mono text-[9px] tracking-[0.1em] uppercase ${step.color === 'orange' ? 'text-brand-orange' : 'text-warm-gray'}`}
                >
                  {step.product} &mdash; {step.duration}
                </div>
                <p className="text-charcoal mb-1 text-[14px] font-medium">{step.description}</p>
                {step.ceiling && (
                  <p className="text-warm-gray-light font-mono text-[10px]">
                    Ceiling hit: {step.ceiling}
                  </p>
                )}
              </div>
            </motion.div>
          ))}
        </motion.div>

        {/* Footer quote */}
        <motion.div
          initial="hidden"
          whileInView="visible"
          viewport={VIEWPORT}
          variants={REVEAL}
          className="border-cream-tertiary mt-8 border-t pt-6"
        >
          <p className="text-warm-gray text-[13px] leading-relaxed italic">
            &ldquo;Total calendar time from &lsquo;I want a to-do list&rsquo; to &lsquo;my agents
            coordinate while I sleep&rsquo; &mdash;&mdash; about two months of evenings.&rdquo;
          </p>
        </motion.div>
      </div>
    </section>
  );
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
pnpm typecheck --filter=@dorkos/site
```

Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add apps/site/src/layers/features/marketing/ui/story/HowItBuiltSection.tsx
git commit -m "feat(site/story): add HowItBuiltSection timeline"
```

---

### Task 8: `JustPromptsSection`

**Files:**

- Create: `apps/site/src/layers/features/marketing/ui/story/JustPromptsSection.tsx`

- [ ] **Step 1: Create the component**

```tsx
// apps/site/src/layers/features/marketing/ui/story/JustPromptsSection.tsx
'use client';

import { motion } from 'motion/react';
import { REVEAL, STAGGER, SPRING, VIEWPORT } from '../../lib/motion-variants';
import { equationItems } from '../../lib/story-data';

interface JustPromptsSectionProps {
  slideId?: string;
}

/** Equation reveal: strips away the magic and shows what LifeOS actually is. */
export function JustPromptsSection({ slideId = 'prompts' }: JustPromptsSectionProps) {
  return (
    <section
      className="film-grain bg-charcoal flex min-h-screen flex-col justify-center px-8 py-16 text-center"
      data-slide={slideId}
    >
      <div className="mx-auto w-full max-w-xl">
        {/* Header */}
        <motion.div
          initial="hidden"
          whileInView="visible"
          viewport={VIEWPORT}
          variants={STAGGER}
          className="mb-10"
        >
          <motion.div
            variants={REVEAL}
            className="text-brand-orange mb-4 font-mono text-[9px] tracking-[0.2em] uppercase"
          >
            Here&apos;s the Thing
          </motion.div>
          <motion.h2
            variants={REVEAL}
            className="text-cream-white mb-2 text-[clamp(22px,3vw,36px)] font-bold tracking-tight"
          >
            Platforms will just be prompts.
          </motion.h2>
          <motion.p variants={REVEAL} className="text-warm-gray text-[13px]">
            All open source. Here&apos;s what it actually is.
          </motion.p>
        </motion.div>

        {/* Equation items */}
        <motion.div
          initial="hidden"
          whileInView="visible"
          viewport={VIEWPORT}
          variants={STAGGER}
          className="mb-8 flex flex-col gap-4"
        >
          {equationItems.map((item, i) => (
            <motion.div
              key={item.lhs}
              variants={REVEAL}
              transition={{ delay: i * 0.15, ...SPRING }}
              className="flex items-center justify-center gap-4"
            >
              <span className="text-cream-white min-w-[160px] text-right font-mono text-[14px] font-medium">
                {item.lhs}
              </span>
              <span className="text-brand-orange text-[20px] font-light">=</span>
              <span className="text-warm-gray min-w-[160px] text-left font-mono text-[14px]">
                {item.rhs}
              </span>
            </motion.div>
          ))}
        </motion.div>

        {/* Landing moment */}
        <motion.div
          initial="hidden"
          whileInView="visible"
          viewport={VIEWPORT}
          variants={STAGGER}
          className="border-warm-gray/10 border-t pt-7"
        >
          <motion.p variants={REVEAL} className="text-cream-white mb-2 text-[16px] font-medium">
            Platforms will just be prompts.
          </motion.p>
          <motion.p variants={REVEAL} className="text-warm-gray text-[14px] leading-relaxed">
            Code isn&apos;t the scarce thing anymore. Knowing what to ask &mdash;&mdash; and what to
            remember &mdash;&mdash; is.
          </motion.p>
        </motion.div>
      </div>
    </section>
  );
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
pnpm typecheck --filter=@dorkos/site
```

Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add apps/site/src/layers/features/marketing/ui/story/JustPromptsSection.tsx
git commit -m "feat(site/story): add JustPromptsSection equation reveal"
```

---

### Task 9: `CloseSection`

**Files:**

- Create: `apps/site/src/layers/features/marketing/ui/story/CloseSection.tsx`

- [ ] **Step 1: Create the component**

```tsx
// apps/site/src/layers/features/marketing/ui/story/CloseSection.tsx
'use client';

import { motion } from 'motion/react';
import { REVEAL, STAGGER, VIEWPORT } from '../../lib/motion-variants';

interface CloseSectionProps {
  slideId?: string;
}

/** Minimal close. Breathing room. The line people leave with. */
export function CloseSection({ slideId = 'close' }: CloseSectionProps) {
  return (
    <section
      className="bg-charcoal flex min-h-screen flex-col items-center justify-center px-8 py-16 text-center"
      data-slide={slideId}
    >
      <motion.div
        className="mx-auto max-w-xl"
        initial="hidden"
        whileInView="visible"
        viewport={VIEWPORT}
        variants={STAGGER}
      >
        <motion.p
          variants={REVEAL}
          className="text-warm-gray mb-8 text-[clamp(14px,1.8vw,18px)] leading-[1.7]"
        >
          Anyone has access to the same AI. Not everyone has thought hard about what they actually
          want.
        </motion.p>

        <motion.div
          variants={REVEAL}
          className="bg-brand-orange mx-auto mb-8 h-px w-8"
          aria-hidden="true"
        />

        <motion.p
          variants={REVEAL}
          className="text-cream-white mb-10 text-[clamp(18px,2.5vw,28px)] leading-[1.5] font-light"
        >
          I built this so the machine could handle the obligations.
          <br />
          So I could focus on the parts that are irreplaceable.
        </motion.p>

        <motion.p
          variants={REVEAL}
          className="text-warm-gray-light font-mono text-[10px] tracking-[0.1em] uppercase"
        >
          Fundamentals First &mdash; 2026
        </motion.p>
      </motion.div>
    </section>
  );
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
pnpm typecheck --filter=@dorkos/site
```

Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add apps/site/src/layers/features/marketing/ui/story/CloseSection.tsx
git commit -m "feat(site/story): add CloseSection"
```

---

### Task 10: `FutureVisionSection`

**Files:**

- Create: `apps/site/src/layers/features/marketing/ui/story/FutureVisionSection.tsx`

- [ ] **Step 1: Create the component**

```tsx
// apps/site/src/layers/features/marketing/ui/story/FutureVisionSection.tsx
'use client';

import { motion } from 'motion/react';
import { REVEAL, STAGGER, VIEWPORT } from '../../lib/motion-variants';
import { futureCards } from '../../lib/story-data';
import type { FutureCard } from '../../lib/story-data';

interface FutureVisionSectionProps {
  slideId?: string;
}

const LABEL_COLOR: Record<FutureCard['color'], string> = {
  orange: 'text-brand-orange',
  blue: 'text-brand-blue',
  green: 'text-brand-green',
};

/**
 * Permanent-page-only section. Hidden in ?present=true via CSS.
 * Shows where DorkOS is heading: autonomous -> connected -> commerce.
 */
export function FutureVisionSection({ slideId = 'vision' }: FutureVisionSectionProps) {
  return (
    <section className="bg-cream-secondary px-8 py-16" data-future-vision data-slide={slideId}>
      <div className="mx-auto max-w-3xl">
        <motion.div
          initial="hidden"
          whileInView="visible"
          viewport={VIEWPORT}
          variants={STAGGER}
          className="mb-10"
        >
          <motion.div
            variants={REVEAL}
            className="text-brand-orange mb-3 font-mono text-[9px] tracking-[0.2em] uppercase"
          >
            Where This Is Going
          </motion.div>
          <motion.h2
            variants={REVEAL}
            className="text-charcoal text-[clamp(20px,2.5vw,28px)] font-semibold tracking-tight"
          >
            The next layer is already building.
          </motion.h2>
        </motion.div>

        <motion.div
          initial="hidden"
          whileInView="visible"
          viewport={VIEWPORT}
          variants={STAGGER}
          className="grid grid-cols-1 gap-4 sm:grid-cols-3"
        >
          {futureCards.map((card) => (
            <motion.div key={card.id} variants={REVEAL} className="bg-cream-primary rounded-lg p-5">
              <div
                className={`mb-2 font-mono text-[9px] tracking-[0.1em] uppercase ${LABEL_COLOR[card.color]}`}
              >
                {card.label}
              </div>
              <h3 className="text-charcoal mb-2 text-[13px] font-semibold">{card.title}</h3>
              <p className="text-warm-gray text-[11px] leading-relaxed">{card.description}</p>
            </motion.div>
          ))}
        </motion.div>
      </div>
    </section>
  );
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
pnpm typecheck --filter=@dorkos/site
```

Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add apps/site/src/layers/features/marketing/ui/story/FutureVisionSection.tsx
git commit -m "feat(site/story): add FutureVisionSection (page-only)"
```

---

## Chunk 3: Wiring

Connect everything to the barrel, page, and layout.

### Task 11: Update the marketing barrel `index.ts`

**Files:**

- Modify: `apps/site/src/layers/features/marketing/index.ts`

- [ ] **Step 1: Add story exports to the barrel**

After the existing `// UI components — chrome` block, add a new story block:

```typescript
// UI components — story page
export { PresentationShell } from './ui/PresentationShell';
export { StoryHero } from './ui/story/StoryHero';
export { MondayMorningSection } from './ui/story/MondayMorningSection';
export { HowItBuiltSection } from './ui/story/HowItBuiltSection';
export { JustPromptsSection } from './ui/story/JustPromptsSection';
export { CloseSection } from './ui/story/CloseSection';
export { FutureVisionSection } from './ui/story/FutureVisionSection';
```

After the existing `// Data` block, add:

```typescript
export { bootCards, evolutionSteps, equationItems, futureCards } from './lib/story-data';
export type { BootCard, EvolutionStep, EquationItem, FutureCard } from './lib/story-data';
```

After the `// Motion` line, add the hook export:

```typescript
// Hooks
export { usePresentationMode } from './lib/use-presentation-mode';
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
pnpm typecheck --filter=@dorkos/site
```

Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add apps/site/src/layers/features/marketing/index.ts
git commit -m "feat(site/story): export story components and data from marketing barrel"
```

---

### Task 12: Story page layout and page files

**Files:**

- Create: `apps/site/src/app/(marketing)/story/layout.tsx`
- Create: `apps/site/src/app/(marketing)/story/page.tsx`

- [ ] **Step 1: Create the layout (metadata)**

```typescript
// apps/site/src/app/(marketing)/story/layout.tsx
import type { Metadata } from 'next';
import { siteConfig } from '@/config/site';

export const metadata: Metadata = {
  title: `The Story | ${siteConfig.name}`,
  description:
    'How one person built an AI operating system for their whole life -- in two months of evenings.',
  openGraph: {
    title: `The Story | ${siteConfig.name}`,
    description:
      'How one person built an AI operating system for their whole life -- in two months of evenings.',
    url: `${siteConfig.url}/story`,
    type: 'website',
  },
  alternates: {
    canonical: '/story',
  },
};

export default function StoryLayout({ children }: { children: React.ReactNode }) {
  return children;
}
```

- [ ] **Step 2: Create the page**

```tsx
// apps/site/src/app/(marketing)/story/page.tsx
import { Suspense } from 'react';
import { siteConfig } from '@/config/site';
import {
  PresentationShell,
  StoryHero,
  MondayMorningSection,
  HowItBuiltSection,
  JustPromptsSection,
  CloseSection,
  FutureVisionSection,
  MarketingHeader,
  MarketingFooter,
} from '@/layers/features/marketing';

// Reuse the same social links defined on the homepage
const socialLinks = [
  {
    name: 'GitHub',
    href: siteConfig.github,
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
      </svg>
    ),
  },
];

/**
 * The DorkOS origin story -- Dorian's personal arc from LifeOS to multi-agent coordination.
 *
 * Add ?present=true for presentation mode: full-screen snap sections + keyboard navigation.
 */
export default function StoryPage() {
  return (
    // Suspense required: PresentationShell uses useSearchParams internally
    <Suspense fallback={null}>
      <PresentationShell>
        <div data-marketing-header>
          <MarketingHeader />
        </div>

        <StoryHero />
        <MondayMorningSection />
        <HowItBuiltSection />
        <JustPromptsSection />
        <CloseSection />
        <FutureVisionSection />

        <div data-marketing-footer>
          <MarketingFooter email={siteConfig.contactEmail} socialLinks={socialLinks} />
        </div>
      </PresentationShell>
    </Suspense>
  );
}
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
pnpm typecheck --filter=@dorkos/site
```

Expected: no errors

- [ ] **Step 4: Start the dev server and verify the page renders**

```bash
dotenv -- turbo dev --filter=@dorkos/site
```

Open http://localhost:6244/story -- verify all 6 sections render with correct content and animations.

Open http://localhost:6244/story?present=true -- verify:

- Fixed fullscreen container active
- Sections snap to viewport on scroll
- ArrowRight/Space advances slides
- ArrowLeft goes back
- Progress dots visible in bottom-right
- MarketingHeader and MarketingFooter hidden
- FutureVisionSection not visible

- [ ] **Step 5: Verify site builds cleanly**

```bash
pnpm build --filter=@dorkos/site 2>&1 | tail -20
```

Expected: build completes successfully, no errors

- [ ] **Step 6: Run the full test suite**

```bash
pnpm test -- --run
```

Expected: all tests pass

- [ ] **Step 7: Final commit**

```bash
git add apps/site/src/app/(marketing)/story/layout.tsx \
        apps/site/src/app/(marketing)/story/page.tsx
git commit -m "feat(site): add /story page with dual-mode presentation support

Adds dorkos.ai/story -- the DorkOS origin story told through
Dorian's personal arc from LifeOS to multi-agent coordination.

- Normal mode: continuous scroll narrative
- ?present=true: fullscreen snap sections, keyboard nav, progress dots

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## Quick Reference

| URL                            | Behavior                                         |
| ------------------------------ | ------------------------------------------------ |
| `dorkos.ai/story`              | Normal reading mode, continuous scroll           |
| `dorkos.ai/story?present=true` | Presentation mode: snap, keyboard nav, no chrome |

**Keyboard nav (presentation mode):**

- `ArrowRight` or `Space` → next slide
- `ArrowLeft` → previous slide

**Section order (presentation):** Hero → Monday Morning → How It Built → Just Prompts → Close

**FutureVisionSection** is rendered in DOM but hidden via CSS in presentation mode.
