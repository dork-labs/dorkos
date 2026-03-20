---
slug: dynamic-motion-enhancements
---

# Specification: Dynamic Motion Enhancements for Marketing Homepage

**Spec Number:** 40
**Author:** Claude Code
**Date:** 2026-02-17
**Source:** specs/dynamic-motion-enhancements/01-ideation.md

---

## 1. Overview

Add tasteful, world-class motion and animation to the DorkOS marketing homepage (`apps/web`). The flagship enhancement is a three-layer animated architecture diagram in "The System" section showing animated data flow between connected nodes. Supporting enhancements include scroll-triggered section reveals, card hover micro-interactions with spotlight effect, improved heartbeat pulse with glow, and an AnimatePresence email reveal in the contact section.

All animations use the already-installed `motion` library (motion.dev v12.x), respect `prefers-reduced-motion` via `<MotionConfig reducedMotion="user">`, and only animate GPU-composited properties (transform, opacity). The design system forbids bounces, spins, and elastic effects — animations follow "physics, not decoration."

---

## 2. Goals & Non-Goals

### Goals

- Animate the architecture diagram with three distinct layers: scroll-triggered path drawing, CSS animated dashed strokes, and SMIL traveling particles
- Add scroll-triggered entrance reveals to 5 major content sections
- Add spotlight cursor-tracking + spring lift hover effects to module cards
- Enhance the heartbeat pulse with ghost path and glow layer
- Smooth the contact email reveal with AnimatePresence
- Create shared motion variants (REVEAL, STAGGER) for consistent animation language
- Wrap the marketing layout in `<MotionConfig reducedMotion="user">`

### Non-Goals

- Video content, 3D/WebGL, Lottie animations
- LazyMotion / `m` component tree-shaking optimization
- Complete component rewrites — enhance existing structure
- Animations on CredibilityBar, MarketingHeader, MarketingFooter, or MarketingNav (already has motion)
- Mobile-specific animation variants (reduced motion handles accessibility)

---

## 3. Technical Design

### 3.1 Shared Infrastructure

#### 3.1.1 Motion Variants File

Create `apps/web/src/layers/features/marketing/lib/motion-variants.ts`:

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

#### 3.1.2 MotionConfig in Marketing Layout

Modify `apps/web/src/app/(marketing)/layout.tsx`:

- Add `'use client'` directive (required for MotionConfig)
- Import `{ MotionConfig }` from `motion/react`
- Wrap `{children}` in `<MotionConfig reducedMotion="user">`
- Move metadata export to a separate `metadata.ts` file (metadata exports cannot be in client components in Next.js)

```typescript
'use client'

import { MotionConfig } from 'motion/react'

export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  return (
    <MotionConfig reducedMotion="user">
      <div className="min-h-screen bg-cream-primary">
        {children}
      </div>
    </MotionConfig>
  )
}
```

The JSON-LD scripts and metadata should move to a separate server component or `metadata.ts` file to preserve SSR metadata.

### 3.2 Architecture Diagram — Three-Layer Animation

This is the flagship enhancement. The current `SystemArchitecture.tsx` has static `<line>` and `<circle>` SVG elements. Replace with a three-layer animated system:

#### Layer 1: Scroll-Triggered Reveal (Framer Motion)

When the section enters the viewport (20% visible, once):

- Connection paths draw in using `motion.path` with `pathLength: 0 → 1` over 1.2s
- Nodes scale in from `scale: 0 → 1` with stagger (80ms between nodes)
- The entire reveal orchestrates: paths draw first (0-1.2s), then nodes appear (staggered, starting at 0.8s)

Replace `<line>` elements with `<path>` elements to enable `pathLength` animation. Each connection becomes:

```tsx
<motion.path
  d="M150,50 L250,50"
  variants={DRAW_PATH}
  fill="none"
  stroke="var(--color-brand-orange)"
  strokeWidth="1.5"
  strokeOpacity="0.6"
/>
```

Nodes become:

```tsx
<motion.g variants={SCALE_IN}>
  <circle cx={node.x} cy={node.y} r="6" fill="var(--color-brand-orange)" opacity="0.8" />
  <text ... />
</motion.g>
```

The parent SVG uses `motion.svg` with `STAGGER` variant, triggered by `whileInView`.

#### Layer 2: Animated Dashed Strokes (CSS)

After the reveal completes, connection paths show ambient "data flowing" animation via CSS:

```css
@keyframes dash-flow {
  to {
    stroke-dashoffset: -20;
  }
}
```

Each path gets:

- `stroke-dasharray="6 4"` (visible dash pattern)
- `animation: dash-flow 1.5s linear infinite` (continuous flow)
- Different delays per edge for visual variety

This is pure CSS, zero JS cost. Applied via a class after the reveal animation completes (use `onAnimationComplete` callback or a delayed class addition).

#### Layer 3: Traveling Particles (SMIL)

Small orange circles (r=2) travel along each connection path using SVG `<animateMotion>`:

```svg
<circle r="2" fill="var(--color-brand-orange)" opacity="0.6">
  <animateMotion
    path="M150,50 L250,50"
    dur="3s"
    repeatCount="indefinite"
    begin="1.5s"
  />
</circle>
```

Each edge gets one particle with different `dur` (2-4s) and `begin` delays for organic feeling. Particles begin after the initial reveal is complete (begin="1.5s" or later).

**Reduced motion handling:** Add CSS rule:

```css
@media (prefers-reduced-motion: reduce) {
  .architecture-particles animateMotion,
  .architecture-dashes {
    animation: none !important;
  }
  animateMotion {
    display: none;
  }
}
```

#### Implementation Notes

- Convert `SystemArchitecture.tsx` to `'use client'`
- Replace `<line>` elements with `<path>` elements (same endpoints, expressed as `d="M{x1},{y1} L{x2},{y2}"`)
- Increase connection stroke opacity from current `var(--border-warm)` (10% opacity) to brand-orange at 40-60% opacity for better visibility
- Add `<defs>` section for reusable path definitions if needed
- Module cards grid remains below the SVG — cards get separate animation (see 3.4)

### 3.3 Scroll-Triggered Section Reveals

Add `whileInView` reveals to 5 major sections. Each section wraps its content in a `motion.div` with STAGGER parent and REVEAL children.

**Sections receiving reveals:**

1. **SystemArchitecture** — Already animated via 3.2; module cards grid gets stagger reveal
2. **UseCasesGrid** — Section header fades in, grid items stagger
3. **HowItWorksSection** — Replace raw `IntersectionObserver` with `whileInView`; step cards stagger
4. **HonestySection** — Paragraphs reveal sequentially; corner brackets animate in (scale from corner)
5. **AboutSection** — Philosophy cards stagger; heading fades in

**Pattern for each section:**

```tsx
'use client';

import { motion } from 'motion/react';
import { REVEAL, STAGGER, VIEWPORT } from '../lib/motion-variants';

// Wrap section content:
<motion.div initial="hidden" whileInView="visible" viewport={VIEWPORT} variants={STAGGER}>
  <motion.span variants={REVEAL}>Section Label</motion.span>
  <motion.p variants={REVEAL}>Heading</motion.p>
  {items.map((item) => (
    <motion.div key={item.id} variants={REVEAL}>
      {/* Card content */}
    </motion.div>
  ))}
</motion.div>;
```

**Hero section:** Uses `initial` + `animate` (not `whileInView`) since it's above the fold. Stagger the label → headline → subhead → CTA → pulse → screenshot with 100ms stagger.

**HowItWorksSection refactor:** Remove the manual `IntersectionObserver` + `useRef` + `useState` pattern. Replace with `whileInView` on a `motion.section`. The typing animation in `TerminalBlock` should trigger when `whileInView` fires — pass a motion-based `animate` boolean instead of the current `isVisible` state.

### 3.4 Card Hover — Spotlight + Lift

Module cards in the SystemArchitecture section get two hover effects:

#### Spotlight Effect

A cursor-tracking radial gradient overlay. Desktop-only (hidden on touch devices).

Implementation:

- Track mouse position relative to card via `onMouseMove`
- Set CSS custom properties `--mouse-x` and `--mouse-y` on the card element
- Render a `::before` pseudo-element (or absolute-positioned div) with:
  ```css
  background: radial-gradient(
    250px circle at var(--mouse-x) var(--mouse-y),
    rgba(var(--color-brand-orange-rgb), 0.06),
    transparent 80%
  );
  ```
- Use `onMouseEnter`/`onMouseLeave` to toggle visibility
- Throttle `onMouseMove` updates via `requestAnimationFrame` for performance

#### Spring Lift

```tsx
<motion.div
  whileHover={{ y: -4 }}
  transition={{ type: 'spring', stiffness: 300, damping: 25 }}
>
```

Both effects combine in the module card wrapper. The spotlight div is `pointer-events-none` and overlays the card content.

**Touch devices:** Only the lift applies (spotlight hidden via `@media (hover: hover)` check or `onMouseMove` not firing). No hover state persists on touch.

### 3.5 Improved Heartbeat Pulse

Enhance `PulseAnimation.tsx`:

1. **Ghost path:** Add a second `<path>` with the same `d` attribute but `opacity="0.1"` — shows the full shape at all times
2. **Glow layer:** Duplicate the animated path with `filter="blur(2px)"` and `opacity="0.4"` — retro monitor CRT aesthetic
3. **Delay until visible:** Only start the CSS animation when the component is in the viewport. Use `whileInView` on the parent or trigger via IntersectionObserver
4. **Replace `<style jsx>`** with a `@keyframes` rule in the global CSS or use Tailwind's `@theme` directive. The `<style jsx>` pattern is non-standard in Next.js App Router

Updated structure:

```tsx
<svg ...>
  {/* Ghost path — always visible, full shape at low opacity */}
  <path d="..." fill="none" stroke="var(--color-brand-orange)" strokeWidth="1.5" opacity="0.1" />

  {/* Glow layer — blurred duplicate for CRT effect */}
  <path d="..." fill="none" stroke="var(--color-brand-orange)" strokeWidth="2"
    opacity="0.4" filter="url(#pulse-glow)" className="animate-pulse-draw" />

  {/* Main animated stroke */}
  <path d="..." fill="none" stroke="var(--color-brand-orange)" strokeWidth="1.5"
    className="animate-pulse-draw" />

  <defs>
    <filter id="pulse-glow">
      <feGaussianBlur stdDeviation="2" />
    </filter>
  </defs>
</svg>
```

### 3.6 Contact Email Reveal

Replace the hard swap between button and email link with `AnimatePresence`:

```tsx
import { AnimatePresence, motion } from 'motion/react'

<AnimatePresence mode="wait">
  {revealed ? (
    <motion.a
      key="email"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      transition={{ duration: 0.2 }}
      href={`mailto:${email}`}
      ...
    >
      {email}
    </motion.a>
  ) : (
    <motion.button
      key="reveal"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      transition={{ duration: 0.2 }}
      onClick={() => { setRevealed(true); posthog.capture('contact_email_revealed') }}
      ...
    >
      reveal_email
    </motion.button>
  )}
</AnimatePresence>
```

---

## 4. Files to Modify

### New Files

| File                                                            | Purpose                                                                                    |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `apps/web/src/layers/features/marketing/lib/motion-variants.ts` | Shared REVEAL, STAGGER, SCALE_IN, DRAW_PATH variants + SPRING transition + VIEWPORT config |

### Modified Files

| File                                                               | Changes                                                                                                                                                              |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/src/app/(marketing)/layout.tsx`                          | Add `'use client'`, wrap in `<MotionConfig reducedMotion="user">`, extract metadata to separate file                                                                 |
| `apps/web/src/app/(marketing)/metadata.ts`                         | NEW: Extracted metadata + JSON-LD from layout (Next.js requires metadata in server components)                                                                       |
| `apps/web/src/layers/features/marketing/ui/SystemArchitecture.tsx` | Add `'use client'`, replace `<line>` with `motion.path`, add SMIL particles, add dash-flow CSS animation, add whileInView reveal, add spotlight+lift to module cards |
| `apps/web/src/layers/features/marketing/ui/Hero.tsx`               | Add `'use client'`, wrap content elements in `motion.div` with stagger entrance animation                                                                            |
| `apps/web/src/layers/features/marketing/ui/UseCasesGrid.tsx`       | Add `'use client'`, wrap grid in motion stagger with whileInView                                                                                                     |
| `apps/web/src/layers/features/marketing/ui/HonestySection.tsx`     | Add `'use client'`, sequential paragraph reveal, corner bracket scale animation                                                                                      |
| `apps/web/src/layers/features/marketing/ui/AboutSection.tsx`       | Add `'use client'`, philosophy card stagger with whileInView                                                                                                         |
| `apps/web/src/layers/features/marketing/ui/HowItWorksSection.tsx`  | Replace IntersectionObserver with motion whileInView, add step card stagger                                                                                          |
| `apps/web/src/layers/features/marketing/ui/ContactSection.tsx`     | Add AnimatePresence for email reveal transition                                                                                                                      |
| `apps/web/src/layers/features/marketing/ui/PulseAnimation.tsx`     | Add ghost path, glow layer with SVG blur filter, move keyframes to CSS                                                                                               |
| `apps/web/src/layers/features/marketing/index.ts`                  | Export motion-variants                                                                                                                                               |
| `apps/web/src/app/globals.css` (or equivalent)                     | Add `@keyframes dash-flow` and `@keyframes draw-pulse`, add `prefers-reduced-motion` overrides for SMIL                                                              |

---

## 5. Implementation Phases

### Phase 1: Foundation (motion-variants + MotionConfig)

1. Create `motion-variants.ts` with all shared variants
2. Add `MotionConfig` to marketing layout (extract metadata to separate file)
3. Add global CSS keyframes (`dash-flow`, `draw-pulse`)
4. Export from barrel

### Phase 2: Architecture Diagram (flagship)

1. Convert SystemArchitecture to `'use client'`
2. Replace `<line>` elements with `<path>` elements
3. Add Layer 1: Framer Motion scroll-triggered path drawing + node scale-in
4. Add Layer 2: CSS animated dashed strokes (post-reveal)
5. Add Layer 3: SMIL traveling particles
6. Add spotlight + lift hover to module cards
7. Add `prefers-reduced-motion` CSS overrides

### Phase 3: Scroll Reveals (5 sections)

1. Hero — stagger entrance on mount
2. UseCasesGrid — whileInView stagger
3. HowItWorksSection — replace IntersectionObserver with whileInView
4. HonestySection — sequential paragraph reveal + corner bracket animation
5. AboutSection — philosophy card stagger

### Phase 4: Polish

1. Enhanced PulseAnimation (ghost path + glow + CSS keyframes migration)
2. ContactSection AnimatePresence email reveal

---

## 6. Acceptance Criteria

- [ ] Architecture diagram connections draw in when scrolled into view
- [ ] After reveal, connections show continuous animated dashed strokes
- [ ] Small orange particles travel along connection paths
- [ ] All 5 nodes scale in with stagger
- [ ] Module cards lift on hover with spring physics
- [ ] Module cards show cursor-tracking spotlight on desktop
- [ ] All 5 major sections have scroll-triggered entrance animations
- [ ] Hero content staggers in on page load
- [ ] HowItWorksSection no longer uses raw IntersectionObserver
- [ ] Pulse animation shows ghost path and glow layer
- [ ] Contact email reveal has smooth AnimatePresence transition
- [ ] `prefers-reduced-motion: reduce` disables all motion (particles hidden, no dashes, no scroll reveals animate in immediately at full opacity)
- [ ] No layout shifts (CLS) — all animations use transform/opacity only
- [ ] Page builds successfully (`npm run build`)
- [ ] TypeScript passes (`npm run typecheck`)
- [ ] No console errors in development
- [ ] Animations feel "calm tech" — no bounces, spins, or elastic overshoots
- [ ] Mobile: spotlight disabled, all other animations work normally

---

## 7. Constraints & Assumptions

- `motion` (motion.dev) v12.23.26 is already installed in `apps/web`
- Only GPU-composited properties: `transform` (x, y, scale, rotate) and `opacity`
- `once: true` on all `whileInView` — reveals don't replay on scroll-back
- Design system limits: fade + slide (y: 16-20px, 200-300ms), stagger 60-100ms, hover scale max 1.02-1.05
- SMIL `<animateMotion>` has broad browser support (all modern browsers)
- Converting 7 server components to `'use client'` is acceptable for a marketing page (bundle impact is minor)
- No tests needed for animation behavior (visual/interaction testing is manual)

---

## 8. Risks & Mitigations

| Risk                                                                      | Likelihood | Impact | Mitigation                                                                                    |
| ------------------------------------------------------------------------- | ---------- | ------ | --------------------------------------------------------------------------------------------- |
| SMIL particles not visible in some browsers                               | Low        | Low    | Particles are enhancement-only; page works without them                                       |
| `'use client'` conversion breaks metadata                                 | Medium     | High   | Extract metadata to separate `metadata.ts` server file before converting layout               |
| Spotlight effect causes jank on slow devices                              | Low        | Medium | RAF throttling on `onMouseMove`; desktop-only via `@media (hover: hover)`                     |
| Animation overload feels "too much"                                       | Medium     | Medium | Design system constraints (small y offset, fast timing, overdamped spring) keep motion subtle |
| CSS `dash-flow` animation and SMIL conflict with `prefers-reduced-motion` | Medium     | Medium | Explicit CSS media query to disable both; tested in reduced-motion mode                       |

---

## 9. Testing Strategy

This is a visual/interaction enhancement. Testing approach:

1. **Manual visual review:** Check each animation in Chrome, Firefox, Safari
2. **Reduced motion:** Enable `prefers-reduced-motion: reduce` in dev tools, verify all motion is disabled
3. **Mobile:** Test on iOS Safari and Chrome Android — spotlight hidden, reveals work
4. **Performance:** Chrome DevTools Performance tab — verify 60fps during scroll reveals and diagram animation
5. **Build verification:** `npm run build` and `npm run typecheck` pass
6. **No CLS:** Lighthouse audit shows no layout shift from animations

---

## 10. Changelog

_Initial specification — no changes yet._
