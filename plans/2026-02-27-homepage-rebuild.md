---
title: Homepage Rebuild Implementation Plan
---

# Homepage Rebuild Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Rebuild the DorkOS marketing homepage with new narrative copy, preserving the existing cream palette, IBM Plex fonts, and motion variant system.

**Architecture:** The homepage moves from a feature-first product page to a narrative-driven emotional arc: Prelude -> Hero -> Villain -> Pivot -> Timeline -> Modules -> Honesty -> Install -> Identity Close -> Footer. All new components live in `apps/web/src/layers/features/marketing/ui/` and reuse the existing `motion-variants.ts` animation system. No new CSS variables, fonts, or design tokens.

**Tech Stack:** Next.js 16 (App Router), React 19, Tailwind CSS 4, Motion (motion/react), IBM Plex Sans/Mono, PostHog analytics

**Key References:**

- Approved copy: `meta/website-copy/rounds/02-homepage/synthesis.md`
- Design decisions: `meta/website-copy/decisions.md` (Decisions 1-15)
- Design review: `meta/website-copy/rounds/02-homepage/design-review-synthesis.md`
- Current barrel: `apps/web/src/layers/features/marketing/index.ts`
- Motion variants: `apps/web/src/layers/features/marketing/lib/motion-variants.ts`

---

## Task 1: Create Prelude Component

**Files:**

- Create: `apps/web/src/layers/features/marketing/ui/Prelude.tsx`

**Context:** A brief fullscreen dark overlay showing "DorkOS is starting." in monospaced type, character-by-character, then fading to reveal the cream page beneath. Uses charcoal (#1A1814) background transitioning to cream. Holds ~1.2s total, then fades out.

**Step 1: Create the Prelude component**

```tsx
'use client';

import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';

/** Boot-sequence prelude — types "DorkOS is starting." then fades to reveal the page. */
export function Prelude() {
  const [text, setText] = useState('');
  const [visible, setVisible] = useState(true);
  const fullText = 'DorkOS is starting.';

  useEffect(() => {
    let i = 0;
    const typeInterval = setInterval(() => {
      i++;
      setText(fullText.slice(0, i));
      if (i >= fullText.length) {
        clearInterval(typeInterval);
        // Hold for 600ms after typing completes, then fade out
        setTimeout(() => setVisible(false), 600);
      }
    }, 45);
    return () => clearInterval(typeInterval);
  }, []);

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          className="fixed inset-0 z-50 flex items-center justify-center"
          style={{ background: '#1A1814' }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.4, ease: 'easeOut' }}
        >
          <p className="font-mono text-sm tracking-[0.08em]" style={{ color: '#F5F0E6' }}>
            {text}
            <span className="cursor-blink" aria-hidden="true" />
          </p>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
```

**Step 2: Verify the build compiles**

Run: `cd /Users/doriancollier/Keep/dork-os/core && pnpm turbo build --filter=@dorkos/web --force 2>&1 | tail -20`
Expected: Build succeeds (component not yet imported)

**Step 3: Commit**

```bash
git add apps/web/src/layers/features/marketing/ui/Prelude.tsx
git commit -m "feat(web): add Prelude boot-sequence component"
```

---

## Task 2: Create Villain Section Component

**Files:**

- Create: `apps/web/src/layers/features/marketing/ui/VillainSection.tsx`
- Create: `apps/web/src/layers/features/marketing/lib/villain-cards.ts`

**Context:** Four pain-point cards that name the problems developers face with current AI agents. Styled as system alerts — flatter than ModuleCards, with left-border accent. Uses existing REVEAL/STAGGER variants.

**Step 1: Create the villain card data file**

```ts
export interface VillainCard {
  id: string;
  label: string;
  body: string;
}

export const villainCards: VillainCard[] = [
  {
    id: 'dead-terminal',
    label: 'The Dead Terminal',
    body: 'Your agent finished at 11:47pm. Clean code. Tests passing. PR ready. Then the terminal closed. The work sat there for three days until you found it by accident.\n\nYour best teammate shipped \u2014 and had no way to tell you.',
  },
  {
    id: 'goldfish',
    label: 'The Goldfish',
    body: '"Let me give you some context\u2026"\n\nYou have typed this sentence four hundred times. Every session begins at zero. Every session, you re-introduce yourself to something that was brilliant five minutes ago.',
  },
  {
    id: 'tab-graveyard',
    label: 'The Tab Graveyard',
    body: 'Ten agents. Ten terminals. One of them is waiting for approval. One finished twenty minutes ago. One broke something. You are alt-tabbing between them like it is 2005 and you are managing browser bookmarks.',
  },
  {
    id: '3am-build',
    label: 'The 3am Build',
    body: 'CI went red at 2:47am. The fix was three lines of code. Your agent knew exactly what to do. Your terminal was closed. The build stayed red until morning.',
  },
];
```

**Step 2: Create the VillainSection component**

```tsx
'use client';

import { motion } from 'motion/react';
import { villainCards } from '../lib/villain-cards';
import { REVEAL, STAGGER, VIEWPORT } from '../lib/motion-variants';

/** Pain-point recognition section — four villain cards that name the problem. */
export function VillainSection() {
  return (
    <section className="bg-cream-primary px-8 py-32">
      <motion.div
        className="mx-auto max-w-3xl"
        initial="hidden"
        whileInView="visible"
        viewport={VIEWPORT}
        variants={STAGGER}
      >
        {/* Section header */}
        <motion.div variants={REVEAL} className="mb-20 text-center">
          <h2 className="text-charcoal mb-4 text-[28px] leading-[1.3] font-medium tracking-[-0.02em] md:text-[32px]">
            What your agents do when you leave.
          </h2>
          <p className="text-warm-gray text-lg">Nothing.</p>
        </motion.div>

        {/* Villain cards */}
        <motion.div variants={STAGGER} className="space-y-6">
          {villainCards.map((card) => (
            <motion.article
              key={card.id}
              variants={REVEAL}
              className="rounded-lg px-6 py-5"
              style={{
                background: '#FFFEFB',
                borderLeft: '3px solid rgba(122, 117, 106, 0.3)',
              }}
            >
              <span className="text-2xs text-warm-gray-light mb-3 block font-mono tracking-[0.12em] uppercase">
                {card.label}
              </span>
              {card.body.split('\n\n').map((paragraph, i) => (
                <p key={i} className="text-warm-gray mb-3 text-[15px] leading-[1.75] last:mb-0">
                  {paragraph}
                </p>
              ))}
            </motion.article>
          ))}
        </motion.div>

        {/* Below cards */}
        <motion.div variants={REVEAL} className="mt-16 text-center">
          <p className="text-charcoal text-lg leading-[1.7]">
            You pay for the most powerful AI coding agent available.
          </p>
          <p className="text-charcoal text-lg leading-[1.7]">
            It only works when you are sitting in front of it.
          </p>
        </motion.div>
      </motion.div>
    </section>
  );
}
```

**Step 3: Verify build**

Run: `cd /Users/doriancollier/Keep/dork-os/core && pnpm turbo build --filter=@dorkos/web --force 2>&1 | tail -20`

**Step 4: Commit**

```bash
git add apps/web/src/layers/features/marketing/ui/VillainSection.tsx apps/web/src/layers/features/marketing/lib/villain-cards.ts
git commit -m "feat(web): add VillainSection pain-point cards"
```

---

## Task 3: Create Pivot Section Component

**Files:**

- Create: `apps/web/src/layers/features/marketing/ui/PivotSection.tsx`

**Context:** Centered text block that reframes "operating system" from marketing term to inevitability. Four-line build-up (cron, IPC, registries, filesystems). Generous padding, single motion.div with REVEAL.

**Step 1: Create the PivotSection component**

```tsx
'use client';

import { motion } from 'motion/react';
import { REVEAL, STAGGER, VIEWPORT } from '../lib/motion-variants';

/** The OS metaphor reframe — makes "operating system" feel inevitable, not claimed. */
export function PivotSection() {
  return (
    <section className="bg-cream-secondary px-8 py-40">
      <motion.div
        className="mx-auto max-w-2xl text-center"
        initial="hidden"
        whileInView="visible"
        viewport={VIEWPORT}
        variants={STAGGER}
      >
        <motion.p
          variants={REVEAL}
          className="text-charcoal mb-10 text-[24px] leading-[1.4] font-medium tracking-[-0.02em] md:text-[28px]"
        >
          We solved this for applications fifty years ago.
        </motion.p>

        <motion.div variants={STAGGER} className="mb-10 space-y-3">
          {[
            'Processes needed scheduling. We built cron.',
            'Processes needed communication. We built IPC.',
            'Processes needed discovery. We built registries.',
            'Processes needed memory. We built filesystems.',
          ].map((line) => (
            <motion.p
              key={line}
              variants={REVEAL}
              className="text-warm-gray text-[15px] leading-[1.7] md:text-base"
            >
              {line}
            </motion.p>
          ))}
        </motion.div>

        <motion.p
          variants={REVEAL}
          className="text-charcoal mb-4 text-[24px] leading-[1.4] font-medium tracking-[-0.02em] md:text-[28px]"
        >
          We called it an operating system.
        </motion.p>

        <motion.p variants={REVEAL} className="text-warm-gray-light text-base">
          Your agents need the same thing.
        </motion.p>
      </motion.div>
    </section>
  );
}
```

**Step 2: Verify build**

Run: `cd /Users/doriancollier/Keep/dork-os/core && pnpm turbo build --filter=@dorkos/web --force 2>&1 | tail -20`

**Step 3: Commit**

```bash
git add apps/web/src/layers/features/marketing/ui/PivotSection.tsx
git commit -m "feat(web): add PivotSection OS metaphor reframe"
```

---

## Task 4: Create Timeline Section Component

**Files:**

- Create: `apps/web/src/layers/features/marketing/ui/TimelineSection.tsx`
- Create: `apps/web/src/layers/features/marketing/lib/timeline-entries.ts`

**Context:** The largest new build. Vertical timeline with timestamps on the left, narrative on the right. Each entry activates on scroll. Module names appear inline in monospaced orange. Asymmetric layout breaks the centered symmetry of other sections.

**Step 1: Create the timeline data file**

```ts
export interface TimelineEntry {
  id: string;
  time: string;
  paragraphs: string[];
}

export const timelineEntries: TimelineEntry[] = [
  {
    id: '1114pm',
    time: '11:14 PM',
    paragraphs: [
      'You queue three tasks. A test suite that needs expanding. A dependency upgrade across two services. A refactor you\u2019ve been putting off.',
      'You type one command. [PULSE] schedules all three.',
      'You close the laptop.',
    ],
  },
  {
    id: '1115pm',
    time: '11:15 PM',
    paragraphs: [
      'The first agent picks up the test suite. It reads the coverage report, identifies the gaps, starts writing.',
      'You are brushing your teeth.',
    ],
  },
  {
    id: '247am',
    time: '2:47 AM',
    paragraphs: [
      'CI breaks on the dependency upgrade. [PULSE] detects it. Dispatches an agent. The agent reads the error, traces the cause, opens a fix. Tests go green.',
      'Your phone buzzes once. A Telegram message from [RELAY]: \u201CCI was red. Fixed. PR #247 ready for review.\u201D',
      'You do not see it until morning.',
    ],
  },
  {
    id: '248am',
    time: '2:48 AM',
    paragraphs: [
      'The agent that fixed CI notices the test suite agent is working in the same service. [MESH] routes a coordination signal \u2014 one waits for the other to merge first, avoiding a conflict.',
      'No human involved. No terminal open.',
    ],
  },
  {
    id: '700am',
    time: '7:00 AM',
    paragraphs: [
      'You open your laptop. [CONSOLE] shows the night at a glance: three PRs ready for review, one CI fix merged, the refactor at 80% \u2014 waiting on a design question it queued for you. The overnight cost: $4.20 in API calls.',
    ],
  },
  {
    id: '704am',
    time: '7:04 AM',
    paragraphs: [
      'You approve two PRs. You request a change on the third. You queue two more tasks for the day.',
      'Your agents have been productive for eight hours. You have been awake for four minutes.',
    ],
  },
];
```

**Step 2: Create the TimelineSection component**

This component renders module references like `[PULSE]` as orange monospaced text inline.

```tsx
'use client';

import { Fragment } from 'react';
import { motion } from 'motion/react';
import { timelineEntries } from '../lib/timeline-entries';
import { REVEAL, STAGGER, VIEWPORT } from '../lib/motion-variants';

const MODULE_NAMES = ['PULSE', 'RELAY', 'MESH', 'CONSOLE', 'WING', 'LOOP', 'ENGINE'];

/** Render text with [MODULE] references highlighted in brand orange monospace. */
function renderWithModules(text: string) {
  const parts = text.split(/(\[[A-Z]+\])/);
  return parts.map((part, i) => {
    const match = part.match(/^\[([A-Z]+)\]$/);
    if (match && MODULE_NAMES.includes(match[1])) {
      return (
        <span key={i} className="text-brand-orange font-mono">
          {match[1]}
        </span>
      );
    }
    return <Fragment key={i}>{part}</Fragment>;
  });
}

/** "A Night with DorkOS" — vertical timeline showing the product through story. */
export function TimelineSection() {
  return (
    <section className="bg-cream-white px-8 py-32">
      <motion.div
        className="mx-auto max-w-3xl"
        initial="hidden"
        whileInView="visible"
        viewport={VIEWPORT}
        variants={STAGGER}
      >
        {/* Section header */}
        <motion.div variants={REVEAL} className="mb-20">
          <span className="text-2xs text-brand-orange mb-6 block text-center font-mono tracking-[0.2em] uppercase">
            A Night with DorkOS
          </span>
        </motion.div>

        {/* Timeline entries */}
        <div className="relative">
          {/* Vertical line */}
          <div
            className="absolute top-0 bottom-0 left-[72px] hidden w-px md:block"
            style={{ background: 'rgba(139, 90, 43, 0.12)' }}
          />

          <motion.div variants={STAGGER} className="space-y-12">
            {timelineEntries.map((entry) => (
              <motion.div
                key={entry.id}
                variants={REVEAL}
                className="flex flex-col gap-4 md:flex-row md:gap-8"
              >
                {/* Timestamp */}
                <div className="shrink-0 md:w-[72px] md:text-right">
                  <span
                    className="font-mono text-xs tracking-[0.04em]"
                    style={{ color: '#7A756A' }}
                  >
                    {entry.time}
                  </span>
                </div>

                {/* Dot on the timeline line (desktop only) */}
                <div className="hidden items-start pt-1.5 md:flex">
                  <div
                    className="h-2 w-2 shrink-0 rounded-full"
                    style={{ background: '#E85D04' }}
                  />
                </div>

                {/* Narrative */}
                <div className="flex-1 space-y-3">
                  {entry.paragraphs.map((p, i) => (
                    <p key={i} className="text-warm-gray text-[15px] leading-[1.75]">
                      {renderWithModules(p)}
                    </p>
                  ))}
                </div>
              </motion.div>
            ))}
          </motion.div>
        </div>
      </motion.div>
    </section>
  );
}
```

**Step 3: Verify build**

Run: `cd /Users/doriancollier/Keep/dork-os/core && pnpm turbo build --filter=@dorkos/web --force 2>&1 | tail -20`

**Step 4: Commit**

```bash
git add apps/web/src/layers/features/marketing/ui/TimelineSection.tsx apps/web/src/layers/features/marketing/lib/timeline-entries.ts
git commit -m "feat(web): add TimelineSection overnight narrative"
```

---

## Task 5: Create Module Reference (Subsystems) Component

**Files:**

- Create: `apps/web/src/layers/features/marketing/ui/SubsystemsSection.tsx`
- Create: `apps/web/src/layers/features/marketing/lib/subsystems.ts`

**Context:** Compact two-column table: the gap on the left, the module fix on the right. Module names in monospaced orange. Replaces the full SystemArchitecture SVG diagram.

**Step 1: Create the subsystems data file**

```ts
export interface Subsystem {
  id: string;
  gap: string;
  name: string;
  description: string;
  status: 'available' | 'coming-soon';
}

export const subsystems: Subsystem[] = [
  {
    id: 'pulse',
    gap: 'No schedule',
    name: 'Pulse',
    description: 'Cron-based autonomous execution. Your agents run while you sleep.',
    status: 'available',
  },
  {
    id: 'relay',
    gap: 'No communication',
    name: 'Relay',
    description:
      'Built-in messaging. Telegram, webhooks, inter-agent channels. Your agents reach you.',
    status: 'available',
  },
  {
    id: 'mesh',
    gap: 'No coordination',
    name: 'Mesh',
    description: 'Agent discovery and network. Your agents find each other and collaborate.',
    status: 'available',
  },
  {
    id: 'wing',
    gap: 'No memory',
    name: 'Wing',
    description: 'Persistent context across sessions. Your agents remember.',
    status: 'coming-soon',
  },
  {
    id: 'console',
    gap: 'No oversight',
    name: 'Console',
    description: 'Browser-based command center. You see everything, from anywhere.',
    status: 'available',
  },
  {
    id: 'loop',
    gap: 'No feedback loop',
    name: 'Loop',
    description: 'Signal, hypothesis, dispatch, measure. Your agents improve.',
    status: 'available',
  },
];
```

**Step 2: Create the SubsystemsSection component**

```tsx
'use client';

import { motion } from 'motion/react';
import { subsystems } from '../lib/subsystems';
import { REVEAL, STAGGER, VIEWPORT } from '../lib/motion-variants';

/** Compact subsystems reference — gap on the left, module fix on the right. */
export function SubsystemsSection() {
  return (
    <section className="bg-cream-primary px-8 py-32">
      <motion.div
        className="mx-auto max-w-[720px]"
        initial="hidden"
        whileInView="visible"
        viewport={VIEWPORT}
        variants={STAGGER}
      >
        <motion.span
          variants={REVEAL}
          className="text-2xs text-brand-orange mb-16 block text-center font-mono tracking-[0.2em] uppercase"
        >
          Subsystems
        </motion.span>

        <motion.div variants={STAGGER} className="space-y-0">
          {subsystems.map((sub) => (
            <motion.div
              key={sub.id}
              variants={REVEAL}
              className="flex items-baseline gap-6 py-4"
              style={{ borderBottom: '1px solid rgba(139, 90, 43, 0.06)' }}
            >
              {/* Gap label */}
              <span className="text-2xs text-warm-gray-light w-[140px] shrink-0 text-right font-mono tracking-[0.06em]">
                {sub.gap}
              </span>

              {/* Status indicator */}
              <div
                className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full"
                style={{ background: '#E85D04' }}
              />

              {/* Module name + description */}
              <div className="flex-1">
                <span className="text-brand-orange font-mono text-sm">{sub.name}</span>
                {sub.status === 'coming-soon' && (
                  <span className="text-2xs text-warm-gray-light ml-2 font-mono">Coming soon</span>
                )}
                <span className="text-warm-gray text-sm"> — {sub.description}</span>
              </div>
            </motion.div>
          ))}
        </motion.div>
      </motion.div>
    </section>
  );
}
```

**Step 3: Verify build and commit**

```bash
git add apps/web/src/layers/features/marketing/ui/SubsystemsSection.tsx apps/web/src/layers/features/marketing/lib/subsystems.ts
git commit -m "feat(web): add SubsystemsSection compact module reference"
```

---

## Task 6: Create Install Moment Component

**Files:**

- Create: `apps/web/src/layers/features/marketing/ui/InstallMoment.tsx`

**Context:** The gravitational center of the page. `npm install -g dorkos` sits alone with maximum breathing room. Reuses the typing animation pattern from HowItWorksSection's TerminalBlock. Credibility facts ("Open source. Self-hosted. Yours.") appear here instead of in a standalone CredibilityBar.

**Step 1: Create the InstallMoment component**

```tsx
'use client';

import { useState, useEffect, useRef } from 'react';
import Link from 'next/link';
import { motion, useInView } from 'motion/react';
import { REVEAL, STAGGER, VIEWPORT } from '../lib/motion-variants';

/** The install command with typing animation, positioned at peak desire. */
export function InstallMoment() {
  const ref = useRef<HTMLDivElement>(null);
  const isInView = useInView(ref, { once: true, amount: 0.5 });
  const [displayText, setDisplayText] = useState('');
  const hasAnimated = useRef(false);
  const command = 'npm install -g dorkos';

  useEffect(() => {
    if (!isInView || hasAnimated.current) return;
    hasAnimated.current = true;
    let i = 0;
    const interval = setInterval(() => {
      i++;
      setDisplayText(command.slice(0, i));
      if (i >= command.length) clearInterval(interval);
    }, 50);
    return () => clearInterval(interval);
  }, [isInView]);

  return (
    <section ref={ref} className="bg-cream-tertiary px-8 py-40">
      <motion.div
        className="mx-auto max-w-xl text-center"
        initial="hidden"
        whileInView="visible"
        viewport={VIEWPORT}
        variants={STAGGER}
      >
        {/* The command */}
        <motion.div variants={REVEAL} className="mb-10">
          <div className="bg-cream-secondary inline-block rounded-lg px-8 py-5">
            <p className="text-charcoal font-mono text-lg md:text-xl">
              <span style={{ color: '#7A756A' }}>$ </span>
              {displayText || command}
              <span className="cursor-blink" aria-hidden="true" />
            </p>
          </div>
        </motion.div>

        {/* Trust line */}
        <motion.p
          variants={REVEAL}
          className="text-2xs text-warm-gray-light mb-6 font-mono tracking-[0.1em]"
        >
          Built on the Claude Agent SDK&nbsp;&nbsp;&middot;&nbsp;&nbsp;Open
          Source&nbsp;&nbsp;&middot;&nbsp;&nbsp;MIT
          Licensed&nbsp;&nbsp;&middot;&nbsp;&nbsp;Self-Hosted
        </motion.p>

        {/* Taglines */}
        <motion.p variants={REVEAL} className="text-charcoal mb-2 text-lg font-medium">
          Open source. Self-hosted. Yours.
        </motion.p>
        <motion.p variants={REVEAL} className="text-warm-gray text-base">
          One person. Ten agents. Ship around the clock.
        </motion.p>

        {/* CTA links */}
        <motion.div variants={REVEAL} className="mt-8 flex items-center justify-center gap-6">
          <Link
            href="https://www.npmjs.com/package/dorkos"
            target="_blank"
            rel="noopener noreferrer"
            className="marketing-btn hidden items-center gap-2 lg:inline-flex"
            style={{ background: '#E85D04', color: '#FFFEFB' }}
          >
            npm install -g dorkos
            <span className="cursor-blink" aria-hidden="true" />
          </Link>
          <Link
            href="/docs/getting-started/quickstart"
            className="marketing-btn inline-flex items-center gap-2 lg:hidden"
            style={{ background: '#E85D04', color: '#FFFEFB' }}
          >
            Get started
          </Link>
          <Link
            href="/docs/getting-started/quickstart"
            className="text-button text-warm-gray-light hover:text-brand-orange transition-smooth font-mono tracking-[0.08em]"
          >
            Read the docs
          </Link>
        </motion.div>
      </motion.div>
    </section>
  );
}
```

**Step 2: Verify build and commit**

```bash
git add apps/web/src/layers/features/marketing/ui/InstallMoment.tsx
git commit -m "feat(web): add InstallMoment section at peak desire"
```

---

## Task 7: Create Identity Close Component

**Files:**

- Create: `apps/web/src/layers/features/marketing/ui/IdentityClose.tsx`

**Context:** Replaces AboutSection. Origin story + tribal declaration + email reveal absorbed as postscript. Combines the tribal statement ("Built by dorks. For dorks. Run by you."), the origin story, and the boldness invitation. The email reveal interaction from ContactSection is integrated as a quiet line at the bottom.

**Step 1: Create the IdentityClose component**

```tsx
'use client';

import { useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import posthog from 'posthog-js';
import { REVEAL, STAGGER, VIEWPORT } from '../lib/motion-variants';

interface IdentityCloseProps {
  email: string;
}

/** Tribal identity close — origin story, boldness invitation, and contact postscript. */
export function IdentityClose({ email }: IdentityCloseProps) {
  const [revealed, setRevealed] = useState(false);

  return (
    <section id="about" className="bg-cream-white px-8 py-40">
      <motion.div
        className="mx-auto max-w-2xl text-center"
        initial="hidden"
        whileInView="visible"
        viewport={VIEWPORT}
        variants={STAGGER}
      >
        {/* Tribal statement */}
        <motion.h2
          variants={REVEAL}
          className="text-charcoal mb-12 text-[28px] leading-[1.3] font-medium tracking-[-0.02em] md:text-[32px]"
        >
          Built by dorks. For dorks. Run by you.
        </motion.h2>

        {/* Origin story */}
        <motion.div variants={STAGGER} className="mb-12 space-y-6">
          <motion.p variants={REVEAL} className="text-warm-gray text-[15px] leading-[1.75]">
            Dork was never an insult to us.
          </motion.p>
          <motion.p variants={REVEAL} className="text-warm-gray text-[15px] leading-[1.75]">
            It is what you call someone who cares too much about something most people do not care
            about at all. Someone who has opinions about cron expressions. Someone who names their
            agents. Someone who wakes up at 6am to check a CI pipeline that nobody asked them to
            check.
          </motion.p>
          <motion.p variants={REVEAL} className="text-warm-gray text-[15px] leading-[1.75]">
            We build at 3am because we cannot stop. Not because someone is paying us to. Because the
            problem is right there and walking away from it feels worse than staying up.
          </motion.p>
        </motion.div>

        {/* Provenance */}
        <motion.p variants={REVEAL} className="text-warm-gray-light mb-12 text-sm leading-[1.8]">
          One developer. Section 8 housing. Library books. Code before graduation.
          <br />
          Thirty million users. An exit in twelve months. Warner Bros. Art Blocks.
          <br />
          And then this — because the tools that matter most are built by the people who need them.
        </motion.p>

        {/* Boldness invitation */}
        <motion.div variants={REVEAL} className="mb-16">
          <p className="text-charcoal text-lg leading-[1.7]">
            The developers building agent teams will outship everyone.
          </p>
          <p className="text-charcoal text-lg leading-[1.7]">Not because they are better.</p>
          <p className="text-charcoal text-lg leading-[1.7]">Because they never stop.</p>
        </motion.div>

        {/* Email postscript */}
        <motion.div
          variants={REVEAL}
          className="pt-8"
          style={{ borderTop: '1px solid rgba(139, 90, 43, 0.08)' }}
        >
          <div className="inline-flex items-center gap-2">
            <span className="text-warm-gray text-sm">
              Questions, ideas, or just want to say hello —
            </span>
            <AnimatePresence mode="wait">
              {revealed ? (
                <motion.a
                  key="email"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  href={`mailto:${email}`}
                  className="text-brand-orange hover:text-brand-green transition-smooth font-mono text-sm"
                >
                  {email}
                </motion.a>
              ) : (
                <motion.button
                  key="reveal"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  onClick={() => {
                    setRevealed(true);
                    posthog.capture('contact_email_revealed');
                  }}
                  className="text-brand-orange hover:text-brand-green transition-smooth font-mono text-sm"
                >
                  reveal_email
                  <span className="cursor-blink" aria-hidden="true" />
                </motion.button>
              )}
            </AnimatePresence>
          </div>
        </motion.div>
      </motion.div>
    </section>
  );
}
```

**Step 2: Verify build and commit**

```bash
git add apps/web/src/layers/features/marketing/ui/IdentityClose.tsx
git commit -m "feat(web): add IdentityClose tribal identity section"
```

---

## Task 8: Create The Close Component

**Files:**

- Create: `apps/web/src/layers/features/marketing/ui/TheClose.tsx`

**Context:** The final section before the footer. "Your agents are ready. Leave the rest to them." followed by "Ready." in monospaced brand-orange. The boot sequence completes.

**Step 1: Create TheClose component**

```tsx
'use client';

import { motion } from 'motion/react';
import { REVEAL, STAGGER, VIEWPORT } from '../lib/motion-variants';

/** Final page close — the boot sequence completes. */
export function TheClose() {
  return (
    <section className="bg-cream-primary px-8 py-32">
      <motion.div
        className="mx-auto max-w-xl text-center"
        initial="hidden"
        whileInView="visible"
        viewport={VIEWPORT}
        variants={STAGGER}
      >
        <motion.p
          variants={REVEAL}
          className="text-charcoal mb-10 text-xl leading-[1.4] font-medium tracking-[-0.02em] md:text-2xl"
        >
          Your agents are ready. Leave the rest to them.
        </motion.p>

        <motion.p variants={REVEAL} className="text-brand-orange font-mono text-base">
          Ready.
        </motion.p>
      </motion.div>
    </section>
  );
}
```

**Step 2: Verify build and commit**

```bash
git add apps/web/src/layers/features/marketing/ui/TheClose.tsx
git commit -m "feat(web): add TheClose boot-complete section"
```

---

## Task 9: Update Honesty Section Copy

**Files:**

- Modify: `apps/web/src/layers/features/marketing/ui/HonestySection.tsx`

**Context:** Keep the component structure, corner brackets, and green eyebrow. Tighten the copy per Ogilvy's recommendation. The section will be repositioned in the page composition (Task 11).

**Step 1: Update the copy in HonestySection**

Replace the three `<motion.p>` body paragraphs with the tightened version:

```tsx
// Replace the three body paragraphs with:
<motion.p variants={REVEAL} className="text-warm-gray text-lg leading-[1.7] mb-6">
  Claude Code uses Anthropic&apos;s API. Your code context is sent to their
  servers. DorkOS does not change that.
</motion.p>

<motion.p variants={REVEAL} className="text-charcoal font-semibold text-lg leading-[1.7] mb-6">
  What DorkOS controls: the orchestration runs on your machine. Sessions
  are stored locally. Tools execute in your shell. The scheduling, the
  messaging, the coordination — yours.
</motion.p>

<motion.p variants={REVEAL} className="text-warm-gray text-lg leading-[1.7]">
  We believe in honest tools for serious builders.
</motion.p>
```

**Step 2: Verify build and commit**

```bash
git add apps/web/src/layers/features/marketing/ui/HonestySection.tsx
git commit -m "feat(web): tighten HonestySection copy"
```

---

## Task 10: Rebuild the Hero Component

**Files:**

- Modify: `apps/web/src/layers/features/marketing/ui/ActivityFeedHero.tsx`

**Context:** Major restructure. The headline now spans full width at top ("Your agents are brilliant. They just can't do anything when you leave."). Activity feed appears below, subordinate. Eyebrow becomes "the operating system for autonomous AI agents". Tagline becomes "You slept. They shipped." The CTA moves to the bottom. Remove humor entries from ACTIVITY_POOL per Wieden's recommendation.

**Step 1: Update the ActivityFeedHero props and copy**

The component interface changes:

- `headline` prop removed (hardcoded to approved copy)
- `subhead` prop removed (hardcoded)
- Keep `ctaText`, `ctaHref`, `githubHref`

Key layout changes:

1. Eyebrow → "the operating system for autonomous AI agents"
2. Headline → full-width, two lines: "Your agents are brilliant." / "They just can't do anything when you leave."
3. Tagline → "You slept. They shipped." (between headline and feed)
4. Activity feed → full-width below the headline block, not side-by-side
5. CTA → below the feed
6. Remove humorous ACTIVITY_POOL entries ("world domination", "passive income bot", "applied to 30 jobs", "optimized your portfolio")

The `useActivityFeed`, `FeedDot`, `FeedBadge`, `FeedItem`, and `ActivityFeedPanel` sub-components stay intact. Only the main export layout and ACTIVITY_POOL change.

**Step 2: Remove humor entries from ACTIVITY_POOL**

Delete these entries:

- `'Mesh coordinating world domination — ETA 47 minutes'`
- `'Agent wrote a passive income bot — estimated $300/mo on autopilot'`
- `'Agent applied to 30 jobs on your behalf — 4 interviews booked'`
- `'Pulse optimized your portfolio — up 12% since last rebalance'`

**Step 3: Restructure the grid layout**

Change from `grid-cols-[55%_1fr]` side-by-side to a single-column stacked layout:

- Full-width eyebrow
- Full-width headline (spans viewport)
- Full-width tagline
- Full-width activity feed (max-width constrained)
- Full-width CTA group

**Step 4: Verify build and commit**

```bash
git add apps/web/src/layers/features/marketing/ui/ActivityFeedHero.tsx
git commit -m "feat(web): rebuild hero with stacked layout and new copy"
```

---

## Task 11: Update the Footer

**Files:**

- Modify: `apps/web/src/layers/features/marketing/ui/MarketingFooter.tsx`

**Context:** Add "You slept. They shipped." tagline. Update version badge. Keep retro brand stripes. Keep social icons. Move email from ContactSection to here (it's also in IdentityClose, but footer provides a fallback).

**Step 1: Update the footer**

Add the tagline below the logo/wordmark area. Update the version to v0.4. Replace "System Online" with the tagline.

Key changes:

- After the byline link, add: `<p className="font-mono text-2xs ...">You slept. They shipped.</p>`
- Update version badge: `v0.4 · System Online` → `v0.4.0`
- Add footer links: GitHub | Docs | Discord (centered)

**Step 2: Verify build and commit**

```bash
git add apps/web/src/layers/features/marketing/ui/MarketingFooter.tsx
git commit -m "feat(web): update footer with tagline and simplified layout"
```

---

## Task 12: Update Barrel Exports and Compose the New Homepage

**Files:**

- Modify: `apps/web/src/layers/features/marketing/index.ts`
- Modify: `apps/web/src/app/(marketing)/page.tsx`
- Modify: `apps/web/src/app/(marketing)/layout.tsx` (update meta description)

**Context:** This is the final assembly task. Update the barrel to export new components. Rewrite page.tsx with the new section order. Update metadata.

**Step 1: Update barrel exports**

Add new exports:

```ts
export { Prelude } from './ui/Prelude';
export { VillainSection } from './ui/VillainSection';
export { PivotSection } from './ui/PivotSection';
export { TimelineSection } from './ui/TimelineSection';
export { SubsystemsSection } from './ui/SubsystemsSection';
export { InstallMoment } from './ui/InstallMoment';
export { IdentityClose } from './ui/IdentityClose';
export { TheClose } from './ui/TheClose';
```

Remove exports that are no longer used on the homepage (keep the components in case other pages reference them):

- `CredibilityBar` — no longer imported by page.tsx
- `UseCasesGrid` — no longer imported
- `SystemArchitecture` — no longer imported
- `AboutSection` — no longer imported
- `ContactSection` — no longer imported (email reveal absorbed into IdentityClose)
- `useCases`, `philosophyItems`, `systemModules` data exports — no longer needed by page.tsx

**Step 2: Rewrite page.tsx with new section order**

```tsx
import { siteConfig } from '@/config/site';
import {
  Prelude,
  ActivityFeedHero,
  VillainSection,
  PivotSection,
  TimelineSection,
  SubsystemsSection,
  HonestySection,
  InstallMoment,
  IdentityClose,
  TheClose,
  MarketingNav,
  MarketingHeader,
  MarketingFooter,
} from '@/layers/features/marketing';

const navLinks = [
  { label: 'about', href: '#about' },
  { label: 'blog', href: '/blog' },
  { label: 'docs', href: '/docs' },
];

const socialLinks = [
  // ... same GitHub + npm SVG icons as current
];

export default function HomePage() {
  return (
    <>
      <Prelude />
      <MarketingHeader />

      <main>
        <ActivityFeedHero
          ctaText="npm install -g dorkos"
          ctaHref={siteConfig.npm}
          githubHref={siteConfig.github}
        />
        <VillainSection />
        <PivotSection />
        <TimelineSection />
        <SubsystemsSection />
        <HonestySection />
        <InstallMoment />
        <IdentityClose email={siteConfig.contactEmail} />
        <TheClose />
      </main>

      <MarketingFooter email={siteConfig.contactEmail} socialLinks={socialLinks} />

      <MarketingNav links={navLinks} />
    </>
  );
}
```

**Step 3: Update layout.tsx metadata**

Update the description to match the new meta copy:

```
"Your AI agents are brilliant. They just can't do anything when you leave. DorkOS gives them scheduling, communication, memory, and a command center. Open source. Self-hosted. You slept. They shipped."
```

**Step 4: Verify full build**

Run: `cd /Users/doriancollier/Keep/dork-os/core && pnpm turbo build --filter=@dorkos/web --force 2>&1 | tail -30`
Expected: Build succeeds with zero errors.

**Step 5: Verify dev server**

Run: `cd /Users/doriancollier/Keep/dork-os/core && pnpm turbo dev --filter=@dorkos/web`
Expected: Dev server starts, homepage loads at localhost:3000 with new section order.

**Step 6: Commit**

```bash
git add apps/web/src/layers/features/marketing/index.ts apps/web/src/app/\(marketing\)/page.tsx apps/web/src/app/\(marketing\)/layout.tsx
git commit -m "feat(web): compose new homepage with narrative arc"
```

---

## Task 13: Update Nav Links

**Files:**

- Modify: `apps/web/src/layers/features/marketing/ui/MarketingNav.tsx` (if needed)

**Context:** The floating nav currently has links to #system, #features, #about, #contact. These section IDs no longer exist. Update to match new sections. Consider whether the nav needs section anchors at all — the page is now a narrative scroll, not a feature index. Keep #about (on IdentityClose), add blog and docs. Remove the rest.

**Step 1: Review if the nav needs changes beyond what page.tsx already provides**

The navLinks array in page.tsx is already updated in Task 12. Verify MarketingNav doesn't hardcode any section IDs internally.

**Step 2: Commit if changes needed**

---

## Task 14: Visual QA and Polish

**Files:**

- Various — based on what needs adjustment

**Context:** After all components are in place, do a visual review of the full page flow. Check:

1. Section background alternation (cream-primary / cream-white / cream-secondary / cream-tertiary) — should create subtle rhythm
2. Vertical spacing between sections feels consistent
3. Mobile responsiveness — every section should be readable on 375px width
4. The Prelude dark-to-cream transition is smooth
5. Activity feed entries cycle correctly without humorous entries
6. Timeline vertical line alignment on desktop
7. Module names render in orange monospace within timeline paragraphs
8. Honesty section corner brackets still animate correctly in new position
9. Install moment typing animation triggers on scroll
10. Footer tagline visible and properly styled

**Step 1: Run dev server and test at multiple viewports**

Run: `pnpm turbo dev --filter=@dorkos/web`
Test at: 375px (mobile), 768px (tablet), 1280px (desktop), 1536px (wide)

**Step 2: Fix any visual issues found**

**Step 3: Final commit**

```bash
git add -A
git commit -m "fix(web): visual QA polish for homepage rebuild"
```

---

## Summary

| Task | Component             | Complexity | Dependencies |
| ---- | --------------------- | ---------- | ------------ |
| 1    | Prelude               | Low        | None         |
| 2    | VillainSection        | Medium     | None         |
| 3    | PivotSection          | Low        | None         |
| 4    | TimelineSection       | High       | None         |
| 5    | SubsystemsSection     | Low        | None         |
| 6    | InstallMoment         | Low        | None         |
| 7    | IdentityClose         | Medium     | None         |
| 8    | TheClose              | Low        | None         |
| 9    | HonestySection update | Low        | None         |
| 10   | Hero rebuild          | High       | None         |
| 11   | Footer update         | Low        | None         |
| 12   | Page composition      | Medium     | Tasks 1-11   |
| 13   | Nav update            | Low        | Task 12      |
| 14   | Visual QA             | Medium     | Task 12      |

Tasks 1-11 are independent and can be parallelized. Task 12 depends on all of them. Tasks 13-14 depend on Task 12.
