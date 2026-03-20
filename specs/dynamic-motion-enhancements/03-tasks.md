---
slug: dynamic-motion-enhancements
---

# Tasks: Dynamic Motion Enhancements for Marketing Homepage

**Spec:** specs/dynamic-motion-enhancements/02-specification.md
**Created:** 2026-02-17

---

## Phase 1: Foundation

### Task 1.1: Create motion-variants.ts with shared animation constants

**File:** `apps/web/src/layers/features/marketing/lib/motion-variants.ts` (NEW)

Create the shared motion variants file that all animated components will import from. This file defines the animation language for the entire marketing page.

```typescript
import type { Variants, Transition } from 'motion/react';

/** Overdamped spring — physics-based, no bounce. */
export const SPRING: Transition = {
  type: 'spring',
  stiffness: 100,
  damping: 20,
  mass: 1,
};

/** Standard viewport trigger config — fires once at 20% visible. */
export const VIEWPORT = { once: true, amount: 0.2 } as const;

/** Fade + slide up reveal for individual elements. */
export const REVEAL: Variants = {
  hidden: { opacity: 0, y: 20 },
  visible: {
    opacity: 1,
    y: 0,
    transition: SPRING,
  },
};

/** Container variant that staggers children at 80ms intervals. */
export const STAGGER: Variants = {
  hidden: {},
  visible: {
    transition: {
      staggerChildren: 0.08,
    },
  },
};

/** Scale-in variant for SVG nodes. */
export const SCALE_IN: Variants = {
  hidden: { opacity: 0, scale: 0 },
  visible: {
    opacity: 1,
    scale: 1,
    transition: SPRING,
  },
};

/** Path drawing variant using pathLength. */
export const DRAW_PATH: Variants = {
  hidden: { pathLength: 0, opacity: 0 },
  visible: {
    pathLength: 1,
    opacity: 1,
    transition: { duration: 1.2, ease: 'easeInOut' },
  },
};
```

**Acceptance Criteria:**

- [ ] File exists at `apps/web/src/layers/features/marketing/lib/motion-variants.ts`
- [ ] Exports: `SPRING`, `VIEWPORT`, `REVEAL`, `STAGGER`, `SCALE_IN`, `DRAW_PATH`
- [ ] All types import from `motion/react`
- [ ] `npm run typecheck` passes

---

### Task 1.2: Add MotionConfig to marketing layout

**Files:**

- `apps/web/src/app/(marketing)/layout.tsx` (MODIFY)
- `apps/web/src/app/(marketing)/marketing-shell.tsx` (NEW)

The current marketing layout is a server component that exports `metadata` and renders JSON-LD scripts. To add `<MotionConfig reducedMotion="user">`, create a client wrapper component rather than converting the layout itself (which would break Next.js metadata exports).

**Step 1:** Create `apps/web/src/app/(marketing)/marketing-shell.tsx`:

```typescript
'use client'

import { MotionConfig } from 'motion/react'

/** Client wrapper that enables reduced-motion respect for all marketing animations. */
export function MarketingShell({ children }: { children: React.ReactNode }) {
  return <MotionConfig reducedMotion="user">{children}</MotionConfig>
}
```

**Step 2:** Modify `apps/web/src/app/(marketing)/layout.tsx` to wrap `{children}` in `<MarketingShell>`:

- Add import: `import { MarketingShell } from './marketing-shell'`
- Wrap `{children}` inside the existing `<div>` with `<MarketingShell>{children}</MarketingShell>`
- Keep the server component as-is (metadata export, JSON-LD scripts all remain)

The layout remains a server component. Only the new `MarketingShell` is a client component.

**Acceptance Criteria:**

- [ ] `<MotionConfig reducedMotion="user">` wraps all marketing page children
- [ ] `metadata` export still works (page title, OG tags render correctly)
- [ ] JSON-LD scripts still render in the HTML
- [ ] `npm run build` passes (no "metadata cannot be exported from client component" error)
- [ ] `npm run typecheck` passes

---

### Task 1.3: Add global CSS keyframes for dash-flow and draw-pulse animations

**File:** `apps/web/src/app/globals.css` (MODIFY)

Add the following CSS keyframes and reduced-motion overrides to the end of the global CSS file. These are used by the architecture diagram (dash-flow) and pulse animation (draw-pulse).

```css
/* Architecture diagram — animated dashed strokes */
@keyframes dash-flow {
  to {
    stroke-dashoffset: -20;
  }
}

.architecture-dashes {
  stroke-dasharray: 6 4;
  animation: dash-flow 1.5s linear infinite;
}

/* Pulse animation — heartbeat draw */
@keyframes draw-pulse {
  0% {
    stroke-dashoffset: 800;
  }
  50% {
    stroke-dashoffset: 0;
  }
  100% {
    stroke-dashoffset: -800;
  }
}

.animate-pulse-draw {
  stroke-dasharray: 800;
  stroke-dashoffset: 800;
  animation: draw-pulse 3s ease-in-out infinite;
}

/* Reduced motion: disable all CSS and SMIL animations */
@media (prefers-reduced-motion: reduce) {
  .architecture-dashes {
    animation: none !important;
  }

  .architecture-particles animateMotion {
    display: none;
  }

  .animate-pulse-draw {
    animation: none !important;
    stroke-dashoffset: 0;
  }
}
```

**Acceptance Criteria:**

- [ ] `@keyframes dash-flow` is defined in globals.css
- [ ] `@keyframes draw-pulse` is defined in globals.css
- [ ] `.architecture-dashes` class applies dash-flow animation
- [ ] `.animate-pulse-draw` class applies draw-pulse animation
- [ ] `prefers-reduced-motion: reduce` media query disables all animations
- [ ] `npm run build` passes

---

### Task 1.4: Export motion-variants from marketing barrel

**File:** `apps/web/src/layers/features/marketing/index.ts` (MODIFY)

Add the motion-variants exports to the marketing feature barrel file. The current file exports UI components, data, and types. Add the motion constants after the `// Types` section.

Add these lines:

```typescript
// Motion
export { SPRING, VIEWPORT, REVEAL, STAGGER, SCALE_IN, DRAW_PATH } from './lib/motion-variants';
```

**Acceptance Criteria:**

- [ ] All 6 motion constants are re-exported from the barrel
- [ ] Existing exports remain unchanged
- [ ] `npm run typecheck` passes

---

## Phase 2: Architecture Diagram (Flagship)

**Depends on:** Phase 1 (Tasks 1.1, 1.3, 1.4)

### Task 2.1: Convert SystemArchitecture to animated three-layer diagram

**File:** `apps/web/src/layers/features/marketing/ui/SystemArchitecture.tsx` (MODIFY)

This is the flagship animation. The current file is a server component with static `<line>` and `<circle>` SVG elements. Convert it to a client component with three animation layers.

**Current state (to be replaced):**

- 4 `<line>` elements for connections (static dashed lines with `var(--border-warm)` stroke)
- 5 `<g>` elements with `<circle>` and `<text>` for nodes (mapped from inline array)
- Module cards grid with no hover effects

**New implementation:**

```tsx
'use client';

import { useState, useCallback, useRef } from 'react';
import { motion } from 'motion/react';
import type { SystemModule } from '../lib/modules';
import { REVEAL, STAGGER, SCALE_IN, DRAW_PATH, VIEWPORT } from '../lib/motion-variants';

interface SystemArchitectureProps {
  modules: SystemModule[];
}

const nodes = [
  { x: 100, y: 50, label: 'Console' },
  { x: 300, y: 50, label: 'Core' },
  { x: 500, y: 50, label: 'Vault' },
  { x: 200, y: 160, label: 'Pulse' },
  { x: 400, y: 160, label: 'Channels' },
] as const;

const connections = [
  { d: 'M150,50 L250,50', delay: 0 },
  { d: 'M350,50 L450,50', delay: 0.2 },
  { d: 'M300,75 L200,140', delay: 0.4 },
  { d: 'M300,75 L400,140', delay: 0.6 },
] as const;

/** Interactive architecture diagram showing the 5 DorkOS modules as a connected system. */
export function SystemArchitecture({ modules }: SystemArchitectureProps) {
  const [revealComplete, setRevealComplete] = useState(false);

  return (
    <section id="system" className="bg-cream-tertiary px-8 py-32">
      <div className="mx-auto max-w-5xl">
        <motion.div initial="hidden" whileInView="visible" viewport={VIEWPORT} variants={STAGGER}>
          <motion.span
            variants={REVEAL}
            className="text-2xs text-brand-orange mb-6 block text-center font-mono tracking-[0.15em] uppercase"
          >
            The System
          </motion.span>

          <motion.p
            variants={REVEAL}
            className="text-charcoal mx-auto mb-6 max-w-2xl text-center text-[28px] leading-[1.3] font-medium tracking-[-0.02em] md:text-[32px]"
          >
            Five modules. One operating layer.
          </motion.p>

          <motion.p
            variants={REVEAL}
            className="text-warm-gray mx-auto mb-16 max-w-xl text-center text-base leading-[1.7]"
          >
            DorkOS isn&apos;t a chat UI. It&apos;s an autonomous agent system with a heartbeat, a
            knowledge vault, and communication channels.
          </motion.p>
        </motion.div>

        {/* Architecture diagram - SVG connections */}
        <div className="mb-16 hidden md:block">
          <motion.svg
            viewBox="0 0 600 200"
            className="architecture-particles mx-auto h-auto w-full max-w-2xl"
            preserveAspectRatio="xMidYMid meet"
            aria-hidden="true"
            initial="hidden"
            whileInView="visible"
            viewport={VIEWPORT}
            variants={STAGGER}
            onAnimationComplete={() => setRevealComplete(true)}
          >
            {/* Layer 1 + 2: Connection paths with draw-in and post-reveal dashes */}
            {connections.map((conn, i) => (
              <g key={conn.d}>
                <motion.path
                  d={conn.d}
                  variants={DRAW_PATH}
                  fill="none"
                  stroke="var(--color-brand-orange)"
                  strokeWidth="1.5"
                  strokeOpacity="0.6"
                  className={revealComplete ? 'architecture-dashes' : ''}
                  style={revealComplete ? { animationDelay: `${i * 0.3}s` } : undefined}
                />

                {/* Layer 3: SMIL traveling particle */}
                <circle r="2" fill="var(--color-brand-orange)" opacity="0.6">
                  <animateMotion
                    path={conn.d}
                    dur={`${2.5 + i * 0.5}s`}
                    repeatCount="indefinite"
                    begin="1.5s"
                  />
                </circle>
              </g>
            ))}

            {/* Nodes with scale-in */}
            {nodes.map((node) => (
              <motion.g key={node.label} variants={SCALE_IN}>
                <circle
                  cx={node.x}
                  cy={node.y}
                  r="6"
                  fill="var(--color-brand-orange)"
                  opacity="0.8"
                />
                <text
                  x={node.x}
                  y={node.y + 22}
                  textAnchor="middle"
                  className="fill-charcoal font-mono text-[11px]"
                >
                  {node.label}
                </text>
              </motion.g>
            ))}
          </motion.svg>
        </div>

        {/* Module cards grid with spotlight + lift hover */}
        <motion.div
          className="mx-auto grid max-w-4xl grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3"
          initial="hidden"
          whileInView="visible"
          viewport={VIEWPORT}
          variants={STAGGER}
        >
          {modules.map((mod) => (
            <ModuleCard key={mod.id} mod={mod} />
          ))}
        </motion.div>
      </div>
    </section>
  );
}

/** Module card with spotlight cursor-tracking and spring lift hover. */
function ModuleCard({ mod }: { mod: SystemModule }) {
  const cardRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number>(0);

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      const card = cardRef.current;
      if (!card) return;
      const rect = card.getBoundingClientRect();
      card.style.setProperty('--mouse-x', `${e.clientX - rect.left}px`);
      card.style.setProperty('--mouse-y', `${e.clientY - rect.top}px`);
    });
  }, []);

  return (
    <motion.div
      ref={cardRef}
      variants={REVEAL}
      whileHover={{ y: -4 }}
      transition={{ type: 'spring', stiffness: 300, damping: 25 }}
      onMouseMove={handleMouseMove}
      className="bg-cream-white group relative overflow-hidden rounded-lg border border-[var(--border-warm)] p-6"
    >
      {/* Spotlight overlay - desktop only */}
      <div
        className="pointer-events-none absolute inset-0 hidden opacity-0 transition-opacity duration-300 group-hover:opacity-100 [@media(hover:hover)]:block"
        style={{
          background:
            'radial-gradient(250px circle at var(--mouse-x) var(--mouse-y), rgba(207, 114, 43, 0.06), transparent 80%)',
        }}
      />

      <div className="relative z-10">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-charcoal text-lg font-semibold">{mod.name}</h3>
          <span
            className={`text-3xs rounded px-2 py-0.5 font-mono tracking-[0.1em] uppercase ${
              mod.status === 'available'
                ? 'bg-brand-green/10 text-brand-green'
                : 'bg-warm-gray-light/10 text-warm-gray-light'
            }`}
          >
            {mod.status === 'available' ? 'Available' : 'Coming Soon'}
          </span>
        </div>
        <p className="text-3xs text-warm-gray-light mb-2 font-mono tracking-[0.05em] uppercase">
          {mod.label}
        </p>
        <p className="text-warm-gray text-sm leading-relaxed">{mod.description}</p>
      </div>
    </motion.div>
  );
}
```

**Key changes from current implementation:**

- Add `'use client'` directive
- Import `motion` from `motion/react` and motion variants from `../lib/motion-variants`
- Replace 4 `<line>` elements with `<motion.path>` elements using `d="M{x1},{y1} L{x2},{y2}"` format
- Replace static `<g>` node wrappers with `<motion.g>` using `SCALE_IN` variant
- Wrap SVG in `<motion.svg>` with `STAGGER` + `whileInView`
- Add `onAnimationComplete` callback to toggle `revealComplete` state
- When `revealComplete` is true, add `.architecture-dashes` class to paths for CSS animated dashes
- Add SMIL `<animateMotion>` circles (r=2) on each connection path with varying `dur` (2.5-4s) and `begin="1.5s"`
- Extract `ModuleCard` as a separate function component with:
  - `whileHover={{ y: -4 }}` spring lift
  - `onMouseMove` with RAF-throttled cursor tracking setting `--mouse-x` and `--mouse-y`
  - Spotlight overlay div using `radial-gradient(250px circle at var(--mouse-x) var(--mouse-y), ...)`
  - Spotlight hidden on touch devices via `[@media(hover:hover)]` Tailwind arbitrary variant
- Increase connection stroke from `var(--border-warm)` to `var(--color-brand-orange)` at 60% opacity
- Extract node and connection data to module-level constants

**Acceptance Criteria:**

- [ ] Architecture diagram connections draw in when scrolled into view (pathLength 0 to 1)
- [ ] After reveal, connections show continuous animated dashed strokes (CSS dash-flow)
- [ ] Small orange particles (r=2) travel along connection paths via SMIL animateMotion
- [ ] All 5 nodes scale in with stagger
- [ ] Module cards lift on hover with spring physics (y: -4)
- [ ] Module cards show cursor-tracking spotlight on desktop
- [ ] Spotlight is hidden on touch devices
- [ ] `prefers-reduced-motion: reduce` disables particles and dashes
- [ ] No layout shifts (animations use transform/opacity only)
- [ ] `npm run build` passes
- [ ] `npm run typecheck` passes

---

## Phase 3: Scroll Reveals (5 Sections)

**Depends on:** Phase 1 (Tasks 1.1, 1.4)

### Task 3.1: Add stagger entrance animation to Hero section

**File:** `apps/web/src/layers/features/marketing/ui/Hero.tsx` (MODIFY)

Add `'use client'` directive and wrap hero content elements in `motion.div` with stagger entrance animation. The Hero is above the fold, so use `initial` + `animate` (not `whileInView`).

**Changes:**

1. Add `'use client'` at top of file
2. Add import: `import { motion } from 'motion/react'`
3. Add import: `import { REVEAL } from '../lib/motion-variants'`
4. Wrap the content container (`<div className="relative z-10 text-center max-w-4xl mx-auto">`) as a `motion.div` with stagger:

```tsx
<motion.div
  className="relative z-10 text-center max-w-4xl mx-auto"
  initial="hidden"
  animate="visible"
  variants={{
    hidden: {},
    visible: {
      transition: { staggerChildren: 0.1 },
    },
  }}
>
```

5. Wrap each child element in `motion.*` with `variants={REVEAL}`:
   - The label `<p>` becomes `<motion.p variants={REVEAL}>`
   - The `<h1>` becomes `<motion.h1 variants={REVEAL}>`
   - The subhead `<p>` becomes `<motion.p variants={REVEAL}>`
   - The CTA `<Link>` gets wrapped in `<motion.div variants={REVEAL}>`
   - The secondary CTA `<div>` becomes `<motion.div variants={REVEAL}>`
   - The `<PulseAnimation />` gets wrapped in `<motion.div variants={REVEAL}>`
   - The screenshot `<div>` becomes `<motion.div variants={REVEAL}>`

The stagger is 100ms (0.1) for hero elements specifically (slightly wider than the default 80ms) for a more dramatic entrance.

**Acceptance Criteria:**

- [ ] Hero content staggers in on page load (label, headline, subhead, CTA, pulse, screenshot)
- [ ] Animation uses `initial` + `animate` (not `whileInView`) since hero is above the fold
- [ ] Stagger interval is 100ms between elements
- [ ] Each element fades in and slides up 20px
- [ ] `npm run build` passes
- [ ] `npm run typecheck` passes

---

### Task 3.2: Add whileInView stagger to UseCasesGrid

**File:** `apps/web/src/layers/features/marketing/ui/UseCasesGrid.tsx` (MODIFY)

Add `'use client'` directive and wrap the section content with motion stagger and whileInView.

**Changes:**

1. Add `'use client'` at top of file
2. Add import: `import { motion } from 'motion/react'`
3. Add import: `import { REVEAL, STAGGER, VIEWPORT } from '../lib/motion-variants'`
4. Wrap section inner content in `motion.div` with stagger:

```tsx
<section id="features" className="bg-cream-primary px-8 py-40">
  <motion.div initial="hidden" whileInView="visible" viewport={VIEWPORT} variants={STAGGER}>
    <motion.span
      variants={REVEAL}
      className="text-2xs text-brand-orange mb-6 block text-center font-mono tracking-[0.15em] uppercase"
    >
      What This Unlocks
    </motion.span>

    <motion.p
      variants={REVEAL}
      className="text-charcoal mx-auto mb-16 max-w-2xl text-center text-[28px] leading-[1.3] font-medium tracking-[-0.02em] md:text-[32px]"
    >
      Not features. Capabilities.
    </motion.p>

    <div className="mx-auto grid max-w-5xl grid-cols-1 gap-8 md:grid-cols-2 lg:grid-cols-3">
      {useCases.map((uc) => (
        <motion.article key={uc.id} variants={REVEAL} className="text-left">
          <h3 className="text-charcoal mb-2 text-lg font-semibold tracking-[-0.01em]">
            {uc.title}
          </h3>
          <p className="text-warm-gray text-sm leading-relaxed">{uc.description}</p>
        </motion.article>
      ))}
    </div>
  </motion.div>
</section>
```

**Acceptance Criteria:**

- [ ] Section label and heading fade in when scrolled into view
- [ ] Grid items stagger in with 80ms delay between each
- [ ] Animation fires once (does not replay on scroll back)
- [ ] Trigger at 20% visible
- [ ] `npm run build` passes
- [ ] `npm run typecheck` passes

---

### Task 3.3: Replace IntersectionObserver with whileInView in HowItWorksSection

**File:** `apps/web/src/layers/features/marketing/ui/HowItWorksSection.tsx` (MODIFY)

Remove the manual `IntersectionObserver` + `useRef` + `useState` pattern and replace with motion `whileInView`. The file is already `'use client'`.

**Current pattern to remove:**

- `const sectionRef = useRef<HTMLElement>(null)` and `const [isVisible, setIsVisible] = useState(false)`
- The entire `useEffect` with `IntersectionObserver` (lines 65-79)
- `ref={sectionRef}` on the `<section>` element

**New implementation:**

```tsx
'use client';

import { useEffect, useRef, useState } from 'react';
import { motion, useInView } from 'motion/react';
import { REVEAL, STAGGER, VIEWPORT } from '../lib/motion-variants';

// ... steps array remains unchanged ...

function TerminalBlock({ text, animate }: { text: string; animate: boolean }) {
  // ... remains unchanged ...
}

export function HowItWorksSection() {
  const sectionRef = useRef<HTMLDivElement>(null);
  const isInView = useInView(sectionRef, { once: true, amount: 0.3 });

  return (
    <motion.section
      className="bg-cream-primary px-8 py-40"
      initial="hidden"
      whileInView="visible"
      viewport={VIEWPORT}
      variants={STAGGER}
    >
      <motion.span
        variants={REVEAL}
        className="text-2xs text-brand-orange mb-20 block text-center font-mono tracking-[0.15em] uppercase"
      >
        How It Works
      </motion.span>

      <div ref={sectionRef} className="mx-auto grid max-w-5xl grid-cols-1 gap-12 lg:grid-cols-3">
        {steps.map((step, index) => (
          <motion.div key={step.number} variants={REVEAL} className="text-center">
            <span className="text-2xs text-brand-green mb-4 block font-mono tracking-[0.1em]">
              {step.number}
            </span>
            <TerminalBlock text={step.command} animate={isInView && index < 2} />
            <p className="text-warm-gray text-sm leading-relaxed">{step.description}</p>
          </motion.div>
        ))}
      </div>
    </motion.section>
  );
}
```

Key points:

- Use `useInView` hook from `motion/react` instead of raw `IntersectionObserver` to trigger TerminalBlock typing animation
- Keep a `sectionRef` for the `useInView` hook (but remove the manual observer and useState)
- The step cards get `REVEAL` variant for fade+slide entrance
- The `<section>` becomes `<motion.section>`

**Acceptance Criteria:**

- [ ] No raw `IntersectionObserver` code remains
- [ ] Section label and step cards stagger in with whileInView
- [ ] TerminalBlock typing animation still triggers when section enters viewport
- [ ] Animation fires once (does not replay)
- [ ] `npm run build` passes
- [ ] `npm run typecheck` passes

---

### Task 3.4: Add sequential paragraph reveal to HonestySection

**File:** `apps/web/src/layers/features/marketing/ui/HonestySection.tsx` (MODIFY)

Add `'use client'` directive, wrap content with motion stagger, and animate corner brackets with scale-from-corner effect.

**New implementation:**

```tsx
'use client';

import { motion } from 'motion/react';
import { REVEAL, STAGGER, SPRING, VIEWPORT } from '../lib/motion-variants';

/** Corner bracket scale-in variant. */
const BRACKET: typeof REVEAL = {
  hidden: { opacity: 0, scale: 0.5 },
  visible: {
    opacity: 1,
    scale: 1,
    transition: SPRING,
  },
};

export function HonestySection() {
  return (
    <section className="bg-cream-white px-8 py-32">
      <motion.div
        className="relative mx-auto max-w-[600px] text-center"
        initial="hidden"
        whileInView="visible"
        viewport={VIEWPORT}
        variants={STAGGER}
      >
        {/* Corner brackets with scale animation from their respective corners */}
        <motion.div
          variants={BRACKET}
          className="border-warm-gray-light/30 absolute -top-8 -left-8 h-6 w-6 origin-top-left border-t-2 border-l-2"
        />
        <motion.div
          variants={BRACKET}
          className="border-warm-gray-light/30 absolute -top-8 -right-8 h-6 w-6 origin-top-right border-t-2 border-r-2"
        />
        <motion.div
          variants={BRACKET}
          className="border-warm-gray-light/30 absolute -bottom-8 -left-8 h-6 w-6 origin-bottom-left border-b-2 border-l-2"
        />
        <motion.div
          variants={BRACKET}
          className="border-warm-gray-light/30 absolute -right-8 -bottom-8 h-6 w-6 origin-bottom-right border-r-2 border-b-2"
        />

        <motion.span
          variants={REVEAL}
          className="text-2xs text-brand-green mb-10 block font-mono tracking-[0.15em] uppercase"
        >
          Honest by Design
        </motion.span>

        <motion.p variants={REVEAL} className="text-warm-gray mb-6 text-lg leading-[1.7]">
          Claude Code uses Anthropic&apos;s API for inference. Your code context is sent to their
          servers. DorkOS doesn&apos;t change that — and we won&apos;t pretend it does.
        </motion.p>

        <motion.p
          variants={REVEAL}
          className="text-charcoal mb-6 text-lg leading-[1.7] font-semibold"
        >
          Here&apos;s what DorkOS does control.
        </motion.p>

        <motion.p variants={REVEAL} className="text-warm-gray text-lg leading-[1.7]">
          The agent runs on your machine. Sessions are stored locally. Tools execute in your shell.
          The orchestration, the heartbeat, the vault — that&apos;s all yours. We believe in honest
          tools for serious builders.
        </motion.p>
      </motion.div>
    </section>
  );
}
```

Key points:

- Corner brackets use `origin-top-left`, `origin-top-right`, `origin-bottom-left`, `origin-bottom-right` Tailwind classes so they scale from their respective corners
- BRACKET variant scales from 0.5 to 1 (not 0 to 1, since corners are small and scaling from 0 would be too dramatic)
- Paragraphs reveal sequentially via STAGGER (80ms between each)

**Acceptance Criteria:**

- [ ] Corner brackets animate in by scaling from their respective corners
- [ ] Label, paragraphs reveal sequentially (stagger)
- [ ] Animation fires once at 20% viewport visibility
- [ ] `npm run build` passes
- [ ] `npm run typecheck` passes

---

### Task 3.5: Add philosophy card stagger to AboutSection

**File:** `apps/web/src/layers/features/marketing/ui/AboutSection.tsx` (MODIFY)

Add `'use client'` directive and wrap content with motion stagger and whileInView.

**New implementation:**

```tsx
'use client';

import Link from 'next/link';
import { motion } from 'motion/react';
import { PhilosophyCard } from './PhilosophyCard';
import type { PhilosophyItem } from '../lib/types';
import { REVEAL, STAGGER, VIEWPORT } from '../lib/motion-variants';

interface AboutSectionProps {
  bylineText?: string;
  bylineHref?: string;
  description: string;
  philosophyItems?: PhilosophyItem[];
}

export function AboutSection({
  bylineText = 'by Dork Labs',
  bylineHref = 'https://github.com/dork-labs/dorkos',
  description,
  philosophyItems = [],
}: AboutSectionProps) {
  return (
    <section id="about" className="bg-cream-white px-8 py-40 text-center">
      <motion.div initial="hidden" whileInView="visible" viewport={VIEWPORT} variants={STAGGER}>
        <motion.span
          variants={REVEAL}
          className="text-2xs text-charcoal mb-16 block font-mono tracking-[0.15em] uppercase"
        >
          About
        </motion.span>

        <motion.p
          variants={REVEAL}
          className="text-charcoal mx-auto mb-6 max-w-3xl text-[32px] leading-[1.3] font-medium tracking-[-0.02em]"
        >
          DorkOS is an autonomous agent operating system{' '}
          <Link
            href={bylineHref}
            target="_blank"
            rel="noopener noreferrer"
            className="text-brand-orange hover:text-brand-green transition-smooth"
          >
            {bylineText}
          </Link>
          .
        </motion.p>

        <motion.p
          variants={REVEAL}
          className="text-warm-gray mx-auto mb-20 max-w-xl text-base leading-[1.7]"
        >
          {description}
        </motion.p>

        {philosophyItems.length > 0 && (
          <motion.div
            variants={STAGGER}
            className="mx-auto mb-16 grid max-w-4xl grid-cols-1 gap-12 md:grid-cols-2 lg:grid-cols-4"
          >
            {philosophyItems.map((item) => (
              <motion.div key={item.number} variants={REVEAL}>
                <PhilosophyCard item={item} />
              </motion.div>
            ))}
          </motion.div>
        )}

        <motion.p variants={REVEAL} className="text-warm-gray-light text-lg leading-[1.7] italic">
          The name is playful. The tool is serious.
        </motion.p>
      </motion.div>
    </section>
  );
}
```

Key points:

- The philosophy cards grid gets its own nested `STAGGER` variant so cards stagger independently
- Each PhilosophyCard is wrapped in a `motion.div` with `REVEAL` (not modifying the PhilosophyCard component itself)
- Heading with inline Link works fine inside `motion.p`

**Acceptance Criteria:**

- [ ] Section heading and description fade in with stagger
- [ ] Philosophy cards stagger in with 80ms delay
- [ ] Closing line fades in last
- [ ] Animation fires once at 20% viewport visibility
- [ ] `npm run build` passes
- [ ] `npm run typecheck` passes

---

## Phase 4: Polish

**Depends on:** Phase 1 (Tasks 1.2, 1.3)

### Task 4.1: Enhance PulseAnimation with ghost path, glow layer, and CSS migration

**File:** `apps/web/src/layers/features/marketing/ui/PulseAnimation.tsx` (MODIFY)

The current file uses a `<style jsx>` block for keyframes, which is non-standard in Next.js App Router. Move the keyframes to globals.css (already done in Task 1.3) and add ghost path + glow layer.

**New implementation:**

```tsx
'use client';

/** Animated SVG heartbeat/EKG pulse line for the hero section. */
export function PulseAnimation() {
  const pulsePath =
    'M0,30 L80,30 L100,30 L110,10 L120,50 L130,20 L140,40 L150,30 L180,30 L200,30 L210,10 L220,50 L230,20 L240,40 L250,30 L280,30 L300,30 L310,10 L320,50 L330,20 L340,40 L350,30 L400,30';

  return (
    <div className="mx-auto mt-12 w-full max-w-md opacity-40">
      <svg
        viewBox="0 0 400 60"
        className="h-auto w-full"
        preserveAspectRatio="xMidYMid meet"
        aria-hidden="true"
      >
        <defs>
          <filter id="pulse-glow">
            <feGaussianBlur stdDeviation="2" />
          </filter>
        </defs>

        {/* Ghost path — always visible, full shape at low opacity */}
        <path
          d={pulsePath}
          fill="none"
          stroke="var(--color-brand-orange)"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          opacity="0.1"
        />

        {/* Glow layer — blurred duplicate for CRT effect */}
        <path
          d={pulsePath}
          fill="none"
          stroke="var(--color-brand-orange)"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          opacity="0.4"
          filter="url(#pulse-glow)"
          className="animate-pulse-draw"
        />

        {/* Main animated stroke */}
        <path
          d={pulsePath}
          fill="none"
          stroke="var(--color-brand-orange)"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="animate-pulse-draw"
        />
      </svg>
    </div>
  );
}
```

**Key changes:**

- Remove the entire `<style jsx>` block (lines 23-40 of current file)
- The `.animate-pulse-draw` class is now defined in globals.css (Task 1.3)
- Extract the path `d` attribute to a `pulsePath` constant (DRY)
- Add `<defs>` section with `<filter id="pulse-glow">` containing `<feGaussianBlur stdDeviation="2">`
- Add ghost path: same path, `opacity="0.1"`, no animation class (always shows full shape)
- Add glow path: same path, `opacity="0.4"`, `filter="url(#pulse-glow)"`, `strokeWidth="2"`, with `animate-pulse-draw` class
- Keep main animated path with the constant

**Acceptance Criteria:**

- [ ] Ghost path shows full heartbeat shape at low opacity at all times
- [ ] Glow layer creates CRT-style blur effect behind the main stroke
- [ ] Main stroke still animates with draw-pulse keyframes
- [ ] No `<style jsx>` block remains
- [ ] `prefers-reduced-motion: reduce` shows the ghost path without animation (stroke-dashoffset resets to 0 via CSS)
- [ ] `npm run build` passes
- [ ] `npm run typecheck` passes

---

### Task 4.2: Add AnimatePresence email reveal to ContactSection

**File:** `apps/web/src/layers/features/marketing/ui/ContactSection.tsx` (MODIFY)

Replace the hard swap between button and email link with smooth `AnimatePresence` transition. The file is already `'use client'`.

**New implementation:**

```tsx
'use client';

import { useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import posthog from 'posthog-js';

interface ContactSectionProps {
  email: string;
  promptText?: string;
}

export function ContactSection({
  email,
  promptText = 'Have feedback, want to contribute, or just say hello?',
}: ContactSectionProps) {
  const [revealed, setRevealed] = useState(false);

  return (
    <section id="contact" className="bg-cream-secondary px-8 py-32">
      <div className="mx-auto max-w-md text-center">
        <span className="text-2xs text-brand-orange mb-10 block font-mono tracking-[0.15em] uppercase">
          Contact
        </span>

        <p className="text-warm-gray mb-10 text-lg leading-[1.7]">{promptText}</p>

        {/* Terminal-style command */}
        <div className="inline-flex items-center justify-center gap-2">
          <span className="text-warm-gray-light font-mono text-lg select-none">&gt;</span>
          <AnimatePresence mode="wait">
            {revealed ? (
              <motion.a
                key="email"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.2 }}
                href={`mailto:${email}`}
                className="text-brand-orange hover:text-brand-green transition-smooth inline-flex items-center font-mono text-lg tracking-[0.02em]"
              >
                {email}
                <span className="cursor-blink" aria-hidden="true" />
              </motion.a>
            ) : (
              <motion.button
                key="reveal"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.2 }}
                onClick={() => {
                  setRevealed(true);
                  posthog.capture('contact_email_revealed');
                }}
                className="text-brand-orange hover:text-brand-green transition-smooth inline-flex items-center font-mono text-lg tracking-[0.02em]"
              >
                <span>reveal_email</span>
                <span className="cursor-blink" aria-hidden="true" />
              </motion.button>
            )}
          </AnimatePresence>
        </div>
      </div>
    </section>
  );
}
```

**Key changes:**

- Import `AnimatePresence` and `motion` from `motion/react`
- Wrap the conditional in `<AnimatePresence mode="wait">`
- Convert `<a>` to `<motion.a>` with `key="email"`, initial/animate/exit props
- Convert `<button>` to `<motion.button>` with `key="reveal"`, initial/animate/exit props
- Both use `y: 8` to `y: 0` to `y: -8` for smooth upward slide transition
- `mode="wait"` ensures exit animation completes before enter animation starts

**Acceptance Criteria:**

- [ ] Clicking "reveal_email" smoothly transitions: button slides up and fades out, email slides up and fades in
- [ ] Transition takes 200ms per direction
- [ ] posthog event still fires on reveal
- [ ] `prefers-reduced-motion: reduce` via MotionConfig skips the animation (instant swap)
- [ ] `npm run build` passes
- [ ] `npm run typecheck` passes

---

## Dependency Graph

| Phase | Task | Title                                                      | Depends On    |
| ----- | ---- | ---------------------------------------------------------- | ------------- |
| 1     | 1.1  | Create motion-variants.ts                                  | --            |
| 1     | 1.2  | Add MotionConfig to marketing layout                       | --            |
| 1     | 1.3  | Add global CSS keyframes                                   | --            |
| 1     | 1.4  | Export motion-variants from barrel                         | 1.1           |
| 2     | 2.1  | Convert SystemArchitecture to animated three-layer diagram | 1.1, 1.3, 1.4 |
| 3     | 3.1  | Add stagger entrance to Hero                               | 1.1, 1.4      |
| 3     | 3.2  | Add whileInView stagger to UseCasesGrid                    | 1.1, 1.4      |
| 3     | 3.3  | Replace IntersectionObserver in HowItWorksSection          | 1.1, 1.4      |
| 3     | 3.4  | Add sequential reveal to HonestySection                    | 1.1, 1.4      |
| 3     | 3.5  | Add philosophy card stagger to AboutSection                | 1.1, 1.4      |
| 4     | 4.1  | Enhance PulseAnimation with ghost path and glow            | 1.3           |
| 4     | 4.2  | Add AnimatePresence email reveal                           | 1.2           |

## Parallel Execution Opportunities

- **Phase 1:** Tasks 1.1, 1.2, 1.3 can all run in parallel. Task 1.4 depends only on 1.1.
- **Phase 3:** All 5 tasks (3.1-3.5) can run in parallel after Phase 1 completes.
- **Phase 2 and Phase 3:** Can run in parallel after Phase 1.
- **Phase 4:** Tasks 4.1 and 4.2 can run in parallel with each other and with Phase 2/3.
- **Critical path:** 1.1 then 1.4 then 2.1 (longest dependency chain)
