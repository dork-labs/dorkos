---
slug: dynamic-motion-enhancements
number: 40
created: 2026-02-17
status: ideation
---

# Dynamic Motion Enhancements for Marketing Homepage

**Slug:** dynamic-motion-enhancements
**Author:** Claude Code
**Date:** 2026-02-17
**Branch:** preflight/dynamic-motion-enhancements
**Related:** N/A

---

## 1) Intent & Assumptions

- **Task brief:** Add world-class, tasteful motion and animation to the DorkOS marketing homepage. Primary focus: the architecture diagram in "The System" section needs animated data flow between connected nodes. Secondary: scroll-triggered section reveals, card hover micro-interactions, and improved heartbeat animation across all sections.
- **Assumptions:**
  - `motion` (motion.dev) v12.23.26 is already installed in `apps/web`
  - All animations must respect `prefers-reduced-motion` via `MotionConfig`
  - Design system forbids bounces, spins, and elastic effects — "physics, not decoration"
  - GPU-composited properties only (transform, opacity) — no `width`/`height`/`margin` animation
  - `once: true` on all `whileInView` — reveals don't replay on scroll-back
  - Server components converted to `'use client'` only when motion is needed
- **Out of scope:**
  - Video content, 3D/WebGL, Lottie animations
  - LazyMotion / `m` component optimization (premature for a marketing page)
  - Complete component rewrites — enhance existing structure

## 2) Pre-reading Log

- `apps/web/src/layers/features/marketing/ui/Hero.tsx`: No entrance animation. Static graph paper + radial glow. PulseAnimation included.
- `apps/web/src/layers/features/marketing/ui/PulseAnimation.tsx`: CSS `@keyframes draw-pulse` with `stroke-dashoffset`. Already animated but uses `<style jsx>` — could improve with delay-until-visible.
- `apps/web/src/layers/features/marketing/ui/SystemArchitecture.tsx`: Static SVG diagram with dashed `<line>` elements and `<circle>` nodes. Zero animation. **Highest-value target.**
- `apps/web/src/layers/features/marketing/ui/UseCasesGrid.tsx`: Static grid of `<article>` elements. No motion.
- `apps/web/src/layers/features/marketing/ui/HowItWorksSection.tsx`: Has `IntersectionObserver` + typing animation. Step cards lack entrance animation.
- `apps/web/src/layers/features/marketing/ui/HonestySection.tsx`: Static. Corner brackets could animate. Paragraphs should reveal sequentially.
- `apps/web/src/layers/features/marketing/ui/AboutSection.tsx`: Static. Philosophy cards could stagger.
- `apps/web/src/layers/features/marketing/ui/ContactSection.tsx`: Has `useState` for email reveal. Hard swap — needs `AnimatePresence`.
- `apps/web/src/layers/features/marketing/ui/MarketingNav.tsx`: **Only marketing component currently using `motion/react`** — the scroll-to-top arrow.
- `apps/web/src/layers/features/marketing/ui/MarketingHeader.tsx`: CSS transition on scroll. No motion library.
- `contributing/design-system.md`: "Calm Tech" aesthetic. Acceptable: fade + slide (y: 16-20px, 200-300ms ease-out). Stagger: 60-100ms. Hover: scale 1.02-1.05 max.
- `contributing/animations.md`: App uses `<MotionConfig reducedMotion="user">` — marketing site needs this too.

## 3) Codebase Map

**Primary components to modify:**

- `apps/web/src/layers/features/marketing/ui/SystemArchitecture.tsx` — Interactive architecture diagram
- `apps/web/src/layers/features/marketing/ui/Hero.tsx` — Staggered hero entrance
- `apps/web/src/layers/features/marketing/ui/UseCasesGrid.tsx` — Card stagger reveal
- `apps/web/src/layers/features/marketing/ui/HonestySection.tsx` — Paragraph reveal
- `apps/web/src/layers/features/marketing/ui/AboutSection.tsx` — Philosophy card stagger
- `apps/web/src/layers/features/marketing/ui/HowItWorksSection.tsx` — Replace raw IntersectionObserver
- `apps/web/src/layers/features/marketing/ui/ContactSection.tsx` — AnimatePresence email reveal
- `apps/web/src/layers/features/marketing/ui/PulseAnimation.tsx` — Add glow layer + delay

**New files needed:**

- `apps/web/src/layers/features/marketing/lib/motion-variants.ts` — Shared animation variants (REVEAL, STAGGER)

**Config/Provider files:**

- `apps/web/src/app/(marketing)/layout.tsx` — Add `<MotionConfig reducedMotion="user">`

**Data flow:** Static data (modules.ts, use-cases.ts, philosophy.ts) → UI components → motion wraps around existing JSX

**Potential blast radius:** Marketing pages only. No impact on `apps/client`, `apps/server`, or `packages/`.

## 4) Root Cause Analysis

N/A — this is a feature enhancement, not a bug fix.

## 5) Research

### Potential Solutions

**1. Architecture Diagram — Three-Layer Animated System**

The flagship enhancement. Replace static SVG with:

- **Layer 1 (CSS):** Animated dashed strokes on connection paths using `stroke-dasharray` + `@keyframes dash-flow`. Creates ambient "data flowing" feeling with zero JS cost.
- **Layer 2 (SMIL):** `<animateMotion>` for traveling particles (small orange circles) along each connection path. Zero JS, native SVG animation. Each edge gets a particle on a different timing/delay cycle.
- **Layer 3 (Framer Motion):** `motion.path` with `pathLength` for scroll-triggered "wiring up" reveal — connections draw in when section enters viewport. Nodes stagger in with `scale: 0 → 1`.

- Pros: Deeply impressive visual. Three layers create depth. SMIL particles are zero-JS.
- Cons: Highest implementation complexity. Requires converting to `'use client'`. SMIL may need `prefers-reduced-motion` CSS override.
- Complexity: High
- Maintenance: Medium (CSS + SMIL are native, Framer is declarative)

**2. Scroll-Triggered Section Reveals (All Sections)**

Add `whileInView` to every content section:

```tsx
const REVEAL = { hidden: { opacity: 0, y: 20 }, visible: { opacity: 1, y: 0 } };
const STAGGER = { hidden: {}, visible: { transition: { staggerChildren: 0.08 } } };
```

- Viewport config: `{ once: true, amount: 0.2 }` — triggers when 20% visible, fires once
- Spring: `{ type: "spring", stiffness: 100, damping: 20, mass: 1 }` — overdamped, no bounce
- Sections: Hero (on mount), SystemArchitecture, UseCasesGrid, HowItWorks, HonestySection, AboutSection

- Pros: Single set of shared variants. Consistent reveal rhythm. Proven pattern (Linear, Vercel).
- Cons: 6-7 components need `'use client'` conversion.
- Complexity: Low
- Maintenance: Low

**3. Card Hover Micro-Interactions**

For module cards in SystemArchitecture:

- **Spotlight effect:** Cursor-tracking radial gradient overlay. Desktop-only, pure CSS repaints via `onMouseMove` + `style` prop.
- **Lift:** `whileHover={{ y: -4 }}` with spring `{ stiffness: 300, damping: 25 }`.
- **Variant propagation:** Parent `whileHover` triggers child icon/badge animations automatically.

- Pros: High polish. Spotlight effect is distinctive and impressive.
- Cons: Spotlight requires RAF throttling on complex cards. Touch devices get lift only.
- Complexity: Medium
- Maintenance: Low

**4. Improved Heartbeat/Pulse**

Enhance PulseAnimation.tsx:

- Add a dim ghost path (full line at 10% opacity) under the animated stroke so the shape is always visible.
- Add a glow layer: duplicate path with `blur-[2px]` and `opacity: 0.4` for retro-monitor aesthetic.
- Replace `<style jsx>` with proper CSS in globals.css or Tailwind `@theme`.

- Pros: More polished. Ghost path shows shape even when dash hasn't reached.
- Cons: Minimal — straightforward enhancement.
- Complexity: Low
- Maintenance: Low

**5. Contact Section Email Reveal**

Wrap the revealed/hidden state swap in `AnimatePresence`:

```tsx
<AnimatePresence mode="wait">
  {revealed ? <motion.a key="email" ... /> : <motion.button key="reveal" ... />}
</AnimatePresence>
```

- Pros: Smooth transition instead of hard swap. Small delight.
- Cons: Very minor enhancement.
- Complexity: Low
- Maintenance: Low

### Recommendation

**Implement all 5 in priority order:**

1. Architecture diagram (3-layer system) — the "wow" moment
2. Scroll reveals across all sections — creates rhythm and polish
3. Card hover spotlight + lift — interactive feel
4. Improved heartbeat pulse — retro-monitor glow
5. Contact email reveal — small delight

**Shared infrastructure first:** Create `motion-variants.ts` with REVEAL/STAGGER variants, and add `MotionConfig` to the marketing layout.

## 6) Clarification

1. **Architecture diagram complexity level:** Should the diagram have traveling particles (`<animateMotion>`) in addition to animated dashed strokes? The full three-layer approach (reveal + dashes + particles) is the "world-class" option but takes ~2x more implementation time. Alternatively, just animated dashes + scroll reveal is still impressive and simpler.

2. **Module card hover:** Should module cards have the spotlight cursor-tracking effect (expensive but impressive) or just the simpler spring lift? The spotlight requires a new `SpotlightCard` wrapper component.

3. **Scope of scroll reveals:** Should every section get `whileInView` (Hero, CredibilityBar, SystemArchitecture, UseCases, HowItWorks, Honesty, About, Contact) or only the major content sections? The credibility bar and footer are likely below the fold already — adding reveals there may feel excessive.

4. **`'use client'` boundary strategy:** Converting 6-7 server components to client components increases the JS bundle. An alternative is creating thin `AnimatedSection` wrapper components that each server component renders inside. Which approach is preferred?
