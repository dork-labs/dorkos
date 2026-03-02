---
title: "Aceternity UI: Component Deep Dive for Onboarding Flows"
date: 2026-03-01
type: external-best-practices
status: active
tags: [aceternity, ui-effects, onboarding, ftue, animations, motion, components]
---

# Aceternity UI: Component Deep Dive for Onboarding Flows

**Research Date**: 2026-03-01
**Mode**: Deep Research
**Objective**: Comprehensive survey of Aceternity UI component library — specific component names, visual effects, implementation techniques, and which components are most relevant for a first-time user experience / onboarding flow.

**Note**: A prior research file (`20260228_aceternity_creative_ui_effects_for_marketing.md`) covers the broader effect ecosystem and section-by-section marketing page mapping. This report focuses specifically on Aceternity's component catalog with implementation-level detail, and maps components to onboarding use cases.

---

## Research Summary

Aceternity UI is a copy-paste React component library with 200+ components built on **Tailwind CSS v4** and **Motion (formerly Framer Motion)**. Components are installed via the shadcn CLI (`npx shadcn@latest add @aceternity/<component-name>`) or copied manually. There is no Aceternity npm package — the library is source-code based, dropping `.tsx` files directly into your project. The library does not use WebGL or React Three Fiber by default; the vast majority of effects are achieved with CSS animations, SVG manipulation, HTML Canvas, and Framer Motion. For onboarding flows specifically, the highest-value components are: Multi Step Loader, Timeline, Card Spotlight, Text Generate Effect, Sparkles, Glowing Effect, Animated Modal, Canvas Reveal Effect, and Background Beams.

---

## Key Findings

### 1. Tech Stack and Installation Approach

**Core technologies (used by nearly every component):**
- `motion` (npm, formerly `framer-motion`) — the primary animation layer
- Tailwind CSS v4 — styling and responsive layout
- `clsx` + `tailwind-merge` (via a shared `cn()` utility) — conditional class composition
- HTML5 Canvas — particle systems, wavy backgrounds, sparkles, canvas text
- SVG — beam effects, background lines, spotlight masks
- CSS `@keyframes` — aurora, shooting stars, gradient animations

**Installation model:**
```bash
# Via shadcn CLI (preferred):
npx shadcn@latest add @aceternity/multi-step-loader

# Alternatively: copy raw .tsx source from ui.aceternity.com/components/<name>
```

No Aceternity npm package exists. Components are dropped into your project as source files you own and customize. This is the shadcn pattern.

**Required base utility (`utils.ts`):**
```typescript
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
```

**Key Motion APIs used across the library:**
- `useScroll` + `useTransform` — scroll-linked parallax and value mapping
- `useInView` — trigger animations when element enters viewport
- `AnimatePresence` — enter/exit animations for conditional renders
- `staggerChildren` — sequential reveal of list items
- `whileHover`, `whileTap` — declarative gesture animations
- `MotionValue` — derived values from scroll/pointer for physics feel
- Spring physics via `type: "spring"` transitions

---

### 2. Complete Component Catalog by Category

#### Background Effects (Atmospheric)

| Component | Visual Effect | Implementation Technique |
|-----------|--------------|--------------------------|
| **Aurora Background** | Northern Lights flowing gradient | CSS `@keyframes` on `background-position` (60s linear infinite loop), `hue-rotate` filter |
| **Background Beams** | SVG path-following beam strokes fanning from a point | Animated SVG `stroke-dashoffset` on path elements |
| **Background Beams With Collision** | Beams that explode on contact with surface | Framer Motion + collision detection via `containerRef`/`parentRef` |
| **Background Boxes** | Full-width grid of boxes that highlight amber on hover | CSS hover states on grid children |
| **Background Gradient** | Animated gradient background | CSS `background-position` animation over oversized gradient |
| **Background Lines** | Wavy SVG line pattern animation | Animated SVG path with wave pattern |
| **Background Ripple Effect** | Grid cells that ripple outward on click | Click-event triggered CSS animation cascade |
| **Canvas Reveal Effect** | Expanding dot grid revealed on hover (Clerk-inspired) | HTML Canvas 2D, dots expand from center on hover |
| **Dotted Glow Background** | Grid of dots with opacity/glow animation | CSS `box-shadow` + `@keyframes` on grid nodes |
| **Glowing Stars** | Animated star field background | CSS `@keyframes` opacity/scale on star elements |
| **Google Gemini Effect** | SVG effects visualization | SVG manipulation, canvas |
| **Grid and Dot Backgrounds** | Simple CSS grid or dot pattern | CSS `background-image: radial-gradient` or `linear-gradient` |
| **Lamp Effect** | Lamp/cone visualization above section header | SVG cone shape with radial gradient glow |
| **Meteors** | Diagonal meteor-like beams | CSS `@keyframes` translateX+opacity on pseudo-elements |
| **Shooting Stars + Stars Background** | Shooting stars over star field | SVG/Canvas, customizable speed/delay/color |
| **Spotlight** | Static spotlight cone that animates in on load | SVG-based, CSS `@keyframes` scale+opacity with 0.75s delay |
| **SVG Mask Effect** | SVG mask revealed as cursor moves | `clip-path` or SVG `<mask>` driven by `mousemove` |
| **Tracing Beam** | Beam that follows scroll position down the page | Scroll-linked SVG path fill, `useScroll` + `useTransform` |
| **Vortex** | Swirling vortex canvas background | HTML Canvas 2D, sine wave physics simulation |
| **Wavy Background** | Moving wave animation | HTML Canvas 2D, configurable colors/speed |

**Onboarding relevance:** Aurora Background (step completion celebration), Spotlight (draw attention to CTA), Canvas Reveal Effect (reveal content on interaction), Background Beams (visual depth for hero/welcome screen).

---

#### Card Effects

| Component | Visual Effect | Implementation Technique |
|-----------|--------------|--------------------------|
| **3D Card Effect** | Perspective tilt on mouse movement | CSS `perspective` + `rotateX`/`rotateY` driven by `mousemove` |
| **Card Hover Effect** | Animated gradient slides in from hover direction | Direction-aware CSS transform on hover |
| **Card Spotlight** | Radial gradient follows cursor within card | `radial-gradient` at `mousemove` coordinates via CSS custom props |
| **Card Stack** | Stack of testimonial cards | Framer Motion `AnimatePresence` with stacking offsets |
| **Comet Card** | 3D tilt (Perplexity Comet style) | `rotateX`/`rotateY` with spring physics |
| **Direction Aware Hover** | Gradient enters from direction of cursor approach | `mousemove` + border detection logic |
| **Draggable Card** | Tiltable, draggable card with physics | Drag constraints + tilt on cursor position |
| **Evervault Card** | Encrypted text reveal with gradient on hover | Random char substitution + radial gradient |
| **Expandable Card** | Card expands to full detail on click | Framer Motion `layoutId` shared layout animation |
| **Focus Cards** | Hover blurs siblings, sharpens hovered | CSS `filter: blur()` on non-hovered items |
| **Glare Card** | Linear glare/shine effect (Linear-inspired) | Pseudo-element shine layer at `mousemove` position |
| **Infinite Moving Cards** | Horizontally looping card row | CSS `@keyframes` translate on a duplicated row |
| **Wobble Card** | Subtle translation+scale on mouse proximity | `translate` + `scale` driven by `mousemove` |

**Onboarding relevance:** Card Spotlight (step selection, feature highlights), Expandable Card (progressive disclosure of features), Focus Cards (one-at-a-time step reading), 3D Card Effect (agent selection / configuration cards).

---

#### Text Animation Effects

| Component | Visual Effect | Implementation Technique |
|-----------|--------------|--------------------------|
| **Canvas Text** | Animated colored curves clipped to text shape | HTML Canvas with color curves + `clip-path` to text outline |
| **Colourful Text** | Multi-color text with animated color transitions | CSS `animation` cycling through gradient `background-clip: text` |
| **Container Text Flip** | Word flipping within container | Framer Motion `AnimatePresence` + `y` translate |
| **Encrypted Text** | Gibberish scramble that gradually reveals real text | `setInterval` random char substitution that resolves left-to-right |
| **Flip Words** | Word-swapping animation cycling through array | Framer Motion `AnimatePresence`, words array, configurable duration |
| **Hero Highlight** | Text with animated background highlight (pulsing warmth) | Radial gradient background on inline `<span>`, Motion animation |
| **Layout Text Flip** | Text flip with layout changes | Framer Motion shared layout + `AnimatePresence` |
| **Text Generate Effect** | Text fades in word-by-word on load | Framer Motion `staggerChildren` on split words, `opacity: 0 → 1` |
| **Text Hover Effect** | Animated outline gradient on hover | CSS gradient stroke animation on text |
| **Text Reveal Card** | Hidden text revealed as cursor moves over card | SVG `<mask>` driven by `mousemove` |
| **Typewriter Effect** | Character-by-character typing animation | Two variants: `TypewriterEffect` (janky/authentic) and `TypewriterEffectSmooth` (polished) |

**Props for Text Generate Effect:**
```typescript
interface TextGenerateEffectProps {
  words: string;          // Full text string to animate
  className?: string;     // Container CSS classes
  duration?: number;      // Animation duration (ms)
  filter?: boolean;       // Apply blur filter during reveal
}
```

**Props for Typewriter Effect:**
```typescript
interface TypewriterEffectProps {
  words: Array<{ text: string; className?: string }>;
  className?: string;
  cursorClassName?: string;
}
```

**Props for Flip Words:**
```typescript
interface FlipWordsProps {
  words: string[];     // Array of words to cycle through
  duration?: number;   // Display time per word (default: 3000ms)
  className?: string;
}
```

**Onboarding relevance:** Text Generate Effect (welcome message reveal), Typewriter Effect (animated instructions or step descriptions), Flip Words (rotating value propositions in hero), Hero Highlight (emphasize key action), Encrypted Text (terminal-flavored reveals).

---

#### Navigation Components

| Component | Visual Effect | Implementation Technique |
|-----------|--------------|--------------------------|
| **Floating Dock** | macOS-style dock with magnification | Framer Motion `useMotionValue` + spring physics for magnification |
| **Floating Navbar** | Sticky navbar that hides on scroll down | `useScroll` + visibility toggle with Motion |
| **Navbar Menu** | Animated dropdown on hover | Framer Motion `AnimatePresence` children |
| **Resizable Navbar** | Navbar shrinks/expands on scroll | CSS + scroll listener |
| **Sidebar** | Expandable hover sidebar | Framer Motion width animation |
| **Sticky Banner** | Sticky top banner | CSS `position: sticky` |
| **Tabs** | Animated tab switching with underline indicator | Framer Motion `layoutId` for shared sliding underline |

**Onboarding relevance:** Tabs (multi-step or multi-section onboarding navigation), Floating Dock (persistent action access during onboarding).

---

#### Scroll and Parallax Effects

| Component | Visual Effect | Implementation Technique |
|-----------|--------------|--------------------------|
| **Container Scroll Animation** | 3D perspective rotation that reverses on scroll | `useScroll` + `useTransform` for `rotateX` |
| **Hero Parallax** | Multi-layer rotation/translation/opacity on scroll | `useScroll` + `useTransform` on multiple layers |
| **Macbook Scroll** | Image slides out of MacBook frame on scroll | Scroll-linked image transform |
| **Parallax Scroll** | Two columns scrolling in opposite directions | Dual `useTransform` at inverted rates |
| **Sticky Scroll Reveal** | Left content sticky, right content scrolls through sections | `position: sticky` + scroll-linked right panel |
| **Tracing Beam** | Vertical beam fills as user scrolls page | `useScroll` + SVG `stroke-dashoffset` driven by scroll progress |

**Onboarding relevance:** Tracing Beam (progress visualization), Sticky Scroll Reveal (step-by-step guided tour pattern).

---

#### Progress and Loader Components

| Component | Visual Effect | Implementation Technique |
|-----------|--------------|--------------------------|
| **Multi Step Loader** | Sequential text states with progress indicator | React state cycling through `loadingStates` array, Framer Motion transitions |
| **Loader** | Minimal animated loaders | CSS animations |

**Multi Step Loader props:**
```typescript
interface MultiStepLoaderProps {
  loadingStates: Array<{ text: string }>;  // Sequential messages to display
  loading?: boolean;                        // Show/hide the loader
  duration?: number;                        // Ms between state transitions (default: 2000)
  loop?: boolean;                           // Loop back to start (default: true)
  value?: number;                           // Current state index (0-based)
}
```

**This is the most directly applicable component for onboarding step progress.** It shows sequential status messages with a visual indicator between them. Ideal for: "Scanning for agents..." → "Configuring Pulse..." → "Setting up Relay..." → "Ready."

---

#### Timeline Component

```typescript
interface TimelineEntry {
  title: string;           // Section heading (e.g. step name or date)
  content: React.ReactNode; // Rich content: text, images, checklists
}

interface TimelineProps {
  data: TimelineEntry[];
}
```

The Timeline component features a **sticky header** and a **scroll-activated beam** that fills downward as the user reads. The beam visually indicates reading progress through the timeline. This makes it ideal for multi-step onboarding journeys displayed as a vertical flow.

**Onboarding relevance:** Can serve as a "your setup journey" visualization, or a "what happens next" explainer with interactive content at each step.

---

#### Particle and Celebration Effects

| Component | Visual Effect | Implementation Technique |
|-----------|--------------|--------------------------|
| **Sparkles** | Canvas-rendered configurable sparkle bursts | HTML Canvas, configurable density/size/speed/color/particle count |
| **Shooting Stars** | Shooting star streaks across the background | CSS/SVG animation |
| **Glowing Stars** | Twinkling star field | CSS `@keyframes` on star elements |

**Sparkles props:**
```typescript
interface SparklesProps {
  id?: string;
  className?: string;
  background?: string;
  particleSize?: number;
  minSize?: number;
  maxSize?: number;
  speed?: number;
  particleColor?: string;
  particleDensity?: number;
}
```

**Note:** Aceternity does NOT have a dedicated confetti component. For celebration/confetti effects, use `react-confetti` (npm) or `tsparticles` with a confetti preset. The `Sparkles` component is the closest built-in option — it fires upward bursts of particles that read as celebration when colored appropriately (gold/amber).

---

#### Border and Glow Effects

| Component | Visual Effect | Implementation Technique |
|-----------|--------------|--------------------------|
| **Glowing Effect** | Mouse-proximity border glow (Cursor-inspired) | Mouse tracking + CSS `box-shadow` / border animation |
| **Hover Border Gradient** | Gradient border that expands on hover | CSS gradient on `::after` pseudo-element |
| **Moving Border** | Animated gradient that travels around border | CSS `@keyframes` on `border-image` or animated gradient |

**Glowing Effect props:**
```typescript
interface GlowingEffectProps {
  blur?: number;             // Glow blur (px)
  spread?: number;           // Angular spread (degrees, default: 20)
  proximity?: number;        // Distance threshold beyond element
  inactiveZone?: number;     // Center radius where effect is disabled (0-1, default: 0.7)
  glow?: boolean;            // Force-show effect (default: false)
  borderWidth?: number;      // Border thickness (px, default: 1)
  variant?: "default" | "white";
  disabled?: boolean;        // Disable the effect (default: true)
  movementDuration?: number; // Glow movement animation duration (s, default: 2)
  className?: string;
}
```

**Onboarding relevance:** Glowing Effect on selectable cards/options, Moving Border on the primary CTA button, Hover Border Gradient on step navigation controls.

---

#### Modal and Overlay Components

| Component | Visual Effect | Implementation Technique |
|-----------|--------------|--------------------------|
| **Animated Modal** | Compound modal with scale/rotation transitions on child images | Framer Motion `scale` + random `rotate` (-10° to 10°) on images; `ModalProvider` compound pattern |
| **Animated Tooltip** | Tooltip reveals on hover with spring animation | Framer Motion `AnimatePresence` + spring `y` |
| **Link Preview** | Dynamic link preview popover on hover | Hover + async fetch of page preview |

**Animated Modal structure:**
```typescript
// Compound component pattern
<ModalProvider>
  <ModalTrigger>Open</ModalTrigger>
  <ModalBody>
    <ModalContent>...</ModalContent>
    <ModalFooter>...</ModalFooter>
  </ModalBody>
</ModalProvider>
```

**Onboarding relevance:** Animated Modal for optional detail dialogs (e.g., "What is Pulse?" explanation modals within an onboarding step), Animated Tooltip for contextual help hints.

---

#### Layout Grid Components

| Component | Visual Effect | Implementation Technique |
|-----------|--------------|--------------------------|
| **Bento Grid** | Asymmetric grid with skewed layout | CSS Grid with `md:col-span-2` responsive spanning; Motion hover effects |
| **Layout Grid** | Click-animated grid with expand-on-click | Framer Motion `layoutId` for smooth expansion |

**Bento Grid props:**
```typescript
interface BentoGridItemProps {
  title: string;
  description: string;
  header: React.ReactNode;   // Visual component for top of card
  icon: React.ReactNode;     // Small icon
  className?: string;        // Includes col-span for asymmetric layout
}
```

**Onboarding relevance:** Bento Grid for feature showcase screens (e.g., a "What DorkOS can do" step with 6 module cards in asymmetric layout).

---

#### Interactive and Cursor Effects

| Component | Visual Effect | Implementation Technique |
|-----------|--------------|--------------------------|
| **Canvas Reveal Effect** | Expanding dot grid on hover (Clerk-inspired) | HTML Canvas 2D; dots grow outward from hover point |
| **Following Pointer** | Custom animated cursor that follows mouse | CSS absolute positioning + Framer Motion spring tracking |
| **Lens** | Zoom/magnify lens over images/video | CSS `transform: scale()` within a circular clip |
| **Pointer Highlight** | Text highlight activated on scroll into view | `useInView` + CSS background highlight animation |
| **SVG Mask Effect** | Reveal content through cursor-following mask | SVG `<mask>` + `mousemove` positioning |

---

#### Input and Form Components

| Component | Visual Effect | Implementation Technique |
|-----------|--------------|--------------------------|
| **File Upload** | Drag-and-drop upload with animated indicators | `dragover` events + Framer Motion feedback |
| **Placeholders And Vanish Input** | Placeholder cycles through options, vanishes on input | `AnimatePresence` on placeholder text + canvas particle vanish |
| **Signup Form** | shadcn form with motion transitions | Framer Motion on form field entry |

**Onboarding relevance:** Placeholders and Vanish Input for search-based steps (e.g., "Enter your project directory"), File Upload for configuration import.

---

#### Carousel / Slider Components

| Component | Visual Effect | Implementation Technique |
|-----------|--------------|--------------------------|
| **Animated Testimonials** | Auto-cycling image + quote testimonials | Framer Motion `AnimatePresence` + `autoplay` timer (5s) |
| **Apple Cards Carousel** | Minimal Apple-style horizontal carousel | Framer Motion drag + snap |
| **Carousel** | Customizable carousel with interactions | Drag/swipe with momentum |
| **Images Slider** | Full-page keyboard-navigable image slider | Keyboard events + Framer Motion page transitions |

---

#### Data Visualization and Special Components

| Component | Visual Effect | Implementation Technique |
|-----------|--------------|--------------------------|
| **Compare** | Side-by-side image comparison slider | Drag-to-reveal with CSS clip |
| **GitHub Globe** | Interactive 3D globe with data points | Three.js sphere |
| **Timeline** | Scroll-activated beam + sticky headers | `useScroll` + SVG stroke fill |
| **World Map** | Animated map with connecting arcs | SVG paths with Motion stroke animation |

---

### 3. Implementation Techniques: How Aceternity Creates Premium Feels

**Technique 1: Mouse-tracking radial gradients (Spotlight / Card Spotlight)**
The most used Aceternity pattern. A `radial-gradient` is positioned at the exact mouse coordinates within a container. The hot spot color is configurable (warm white, amber, or blue by default).

```css
/* CSS custom property approach */
background: radial-gradient(
  circle at var(--mouse-x) var(--mouse-y),
  rgba(255, 255, 255, 0.15),
  transparent 60%
);
```

```typescript
// React implementation pattern
const handleMouseMove = (e: React.MouseEvent) => {
  const rect = containerRef.current?.getBoundingClientRect();
  if (rect) {
    setMousePosition({
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    });
  }
};
```

**Technique 2: Framer Motion staggerChildren for text/list reveals**
Used by Text Generate Effect, Bento Grid entry animations, timeline entries. Split content into word or character spans, then use `staggerChildren` with `delay` increments.

```typescript
const container = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: { staggerChildren: 0.05, delayChildren: 0.2 }
  }
};
const item = {
  hidden: { opacity: 0, filter: "blur(4px)" },
  visible: { opacity: 1, filter: "blur(0)" }
};
```

**Technique 3: AnimatePresence for word cycling (Flip Words)**
Words are rendered conditionally; `AnimatePresence` handles the exit animation of the outgoing word while the incoming word animates in.

**Technique 4: useScroll + useTransform for scroll-linked effects**
All scroll-based parallax and tracing beams use this pattern. The scroll progress (0 to 1) is mapped to CSS values (translate, opacity, strokeDashoffset).

**Technique 5: CSS @keyframes with long duration for ambient effects**
Aurora: 60s loop. Background gradient: variable. These create "alive" backgrounds without any JavaScript after initial render.

**Technique 6: Canvas 2D for particle and wave effects**
Wavy Background, Sparkles, Canvas Reveal Effect, Vortex — all use `<canvas>` with `requestAnimationFrame` loops. No WebGL required. Props control color, speed, density.

**Technique 7: SVG path animation for beams**
Background Beams use animated SVG `<path>` elements with `stroke-dashoffset` animation, giving the appearance of light traveling along a path.

**Technique 8: spring physics for gesture responses**
`whileHover`, `whileTap`, and drag handlers all use `type: "spring"` transitions with configurable `stiffness` and `damping`. This is what gives Aceternity components the "physical object" feel.

---

### 4. Components Most Relevant for Onboarding Flows

Ranked by relevance to a first-time user experience:

#### Tier 1 — Direct fit, use as-is or lightly adapted

**Multi Step Loader** — The canonical "setup progress" component. Shows sequential status messages with animated transitions between states. Perfect for: background agent scanning, service initialization, config file writing.

**Timeline** — Scroll-activated vertical progress beam with sticky headers. Ideal for: showing the onboarding journey ("Step 1: Discovery → Step 2: Configure → Step 3: Launch") as a navigable overview.

**Card Spotlight** — Radial gradient follows cursor within each option card. Perfect for: agent selection, preset selection, configuration option cards. Makes each option feel "examined" rather than static.

**Text Generate Effect** — Word-by-word fade-in. Perfect for: welcome message, step descriptions, congratulatory copy at step completion. Creates a reading rhythm.

**Hero Highlight** — Animated warm highlight behind a key word. Perfect for: emphasizing the action word in a step title ("Discover your agents", "Configure Pulse").

**Animated Modal** — Compound modal with spring transitions. Perfect for: "What is this?" help modals accessible from any onboarding step without leaving the flow.

**Glowing Effect** — Mouse-proximity border glow on cards. Perfect for: reinforcing that a hovered card is interactive/selectable.

#### Tier 2 — Strong fit, requires some adaptation

**Canvas Reveal Effect** — Expanding dot grid on hover. Can serve as a "selected state" visual for a card — trigger the reveal when a step option is chosen.

**Sparkles** — Particle bursts. Use on step completion: when a step is marked complete, fire amber sparkles from the step indicator. Closest built-in equivalent to confetti.

**Typewriter Effect** — Character-by-character typing. Use for agent discovery output ("Found agent at /workspace/myproject...") — communicates "real terminal output, not canned text."

**Focus Cards** — Hover blurs siblings. Use when presenting multiple feature cards or preset options — the blur creates natural "one at a time" focus.

**Flip Words** — Rotating word animation. Use in the onboarding hero ("DorkOS is ready to manage your agents / schedule your tasks / connect your tools").

**Moving Border** — Animated gradient border. Use on the primary CTA button for each step ("Continue", "Finish Setup"). The animated border signals the button is active and waiting.

**Background Beams** — Low-opacity beams behind a step completion screen. Adds depth to the "you're done" moment without competing with the message.

**Encrypted Text** — Scramble-to-reveal on directory paths, config values, agent IDs. Reinforces the terminal/developer character of the product.

#### Tier 3 — Situational, use selectively

**Aurora Background** — For a final "welcome to DorkOS" completion screen. The aurora creates a celebratory ambient backdrop. Use only for the completion state, not throughout onboarding.

**Tracing Beam** — If onboarding is a long scrollable page rather than a modal flow, the tracing beam communicates scroll progress naturally.

**Bento Grid** — For a "Here's everything DorkOS can do" feature overview step.

**Animated Testimonials** — If there are user quotes available, the auto-cycling testimonials can fill a "while you wait" interstitial during a longer loading step.

**Parallax Scroll / Sticky Scroll Reveal** — If the onboarding has a "learn DorkOS" educational section, sticky scroll reveal is the gold standard for step-by-step guided content.

---

### 5. Onboarding Flow Component Recipe

For the DorkOS onboarding flow specifically (discovery → presets → adapters → complete), the recommended component composition:

```
OnboardingFlow/
├── Step indicator:      Multi Step Loader (shows which phase is active)
├── Welcome screen:      Text Generate Effect headline + Background Beams (low opacity)
├── Agent discovery:
│   ├── Scanning state:  Multi Step Loader with "Scanning..." messages
│   ├── Results:         Card Spotlight cards (one per discovered agent)
│   └── Selection:       Glowing Effect + Moving Border on selected card
├── Pulse presets:
│   ├── Layout:          Bento Grid (asymmetric preset cards)
│   ├── Hover:           Canvas Reveal Effect on preset cards
│   └── Selected:        Sparkles burst on selection
├── Adapter setup:
│   ├── Type selection:  Focus Cards (blur unselected adapters)
│   └── Config input:    Placeholders And Vanish Input
└── Completion screen:
    ├── Background:      Aurora Background or Background Beams
    ├── Headline:        Hero Highlight on "Ready"
    ├── Celebration:     Sparkles (amber particles, 2-3 bursts)
    └── CTA:             Moving Border on "Open DorkOS" button
```

---

### 6. No-Go Components for Onboarding

These Aceternity components are visually impressive but wrong for onboarding UX:

| Component | Why to Avoid |
|-----------|-------------|
| 3D Globe / World Map | No semantic connection to local developer tooling |
| Vortex | Disorienting; communicates chaos not clarity |
| Macbook Scroll | Hero/marketing pattern, not functional UI |
| Shooting Stars / Meteors | Decoration with no meaning |
| Dither Shader | Live camera access — inappropriate in setup flow |
| Parallax Scroll (two-column opposite) | Disorienting during a decision-making flow |
| Canvas Text (curves clipped to text) | Hard to read; decoration over legibility |

---

## Research Gaps and Limitations

- No confetti/fireworks component exists natively in Aceternity UI. For true confetti celebration on step completion, use `react-confetti` or `@tsparticles/react` with a confetti preset, neither of which is from Aceternity.
- No accessibility audit data found for Aceternity components (ARIA roles, keyboard nav, screen reader behavior). Onboarding flows require keyboard navigability — verify each component before shipping.
- Performance benchmarks not available. Canvas-heavy components (Wavy Background, Vortex, Sparkles) should be tested on lower-powered hardware before inclusion in an onboarding flow.
- The Pro tier of Aceternity UI (ui.aceternity.com/pro) has additional premium block templates not covered here. These include pre-built onboarding-like flows, but require a paid license.

---

## Sources

- [Aceternity UI Component List](https://ui.aceternity.com/components)
- [Aceternity UI Homepage](https://ui.aceternity.com)
- [Aceternity UI Categories](https://ui.aceternity.com/categories)
- [Multi Step Loader](https://ui.aceternity.com/components/multi-step-loader)
- [Timeline Component](https://ui.aceternity.com/components/timeline)
- [Sparkles Component](https://ui.aceternity.com/components/sparkles)
- [Card Spotlight](https://ui.aceternity.com/components/card-spotlight)
- [Canvas Reveal Effect](https://ui.aceternity.com/components/canvas-reveal-effect)
- [Text Generate Effect](https://ui.aceternity.com/components/text-generate-effect)
- [Typewriter Effect](https://ui.aceternity.com/components/typewriter-effect)
- [Flip Words](https://ui.aceternity.com/components/flip-words)
- [Aurora Background](https://ui.aceternity.com/components/aurora-background)
- [Background Beams With Collision](https://ui.aceternity.com/components/background-beams-with-collision)
- [Hero Highlight](https://ui.aceternity.com/components/hero-highlight)
- [Glowing Effect](https://ui.aceternity.com/components/glowing-effect)
- [Animated Modal](https://ui.aceternity.com/components/animated-modal)
- [Wavy Background](https://ui.aceternity.com/components/wavy-background)
- [Spotlight Component](https://ui.aceternity.com/components/spotlight)
- [Bento Grid](https://ui.aceternity.com/components/bento-grid)
- [Shooting Stars Background](https://ui.aceternity.com/components/shooting-stars-and-stars-background)
- [Add Utilities Docs](https://ui.aceternity.com/docs/add-utilities)
- [Prior research: Creative UI Effects for Marketing](./20260228_aceternity_creative_ui_effects_for_marketing.md)

---

## Search Methodology

- Searches performed: 12
- Most productive: direct component page fetches from ui.aceternity.com
- Supplemented by: component category pages, search queries for specific sub-topics (confetti, implementation techniques, tech stack)
- Research depth: Deep (12+ tool calls)
