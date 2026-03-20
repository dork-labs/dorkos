# Aceternity UI Research — Architecture Diagram Use Cases

**Date**: 2026-02-17
**Research Depth**: Deep
**Sources**: 18 tool calls across official docs, component pages, and search results

---

## Research Summary

Aceternity UI is a copy-paste React component library built on **Tailwind CSS + Framer Motion** (now the `motion` package). It ships 200+ components oriented toward visually striking landing pages and SaaS marketing sites. There is no dedicated node-connection diagram component — but a combination of its card, background, border, and particle components can be composed into a world-class interactive architecture diagram. The key insight: Aceternity has the _nodes_ (3D cards, glare cards, spotlight cards) and the _environments_ (grids, aurora, sparkles, vortex) but not the _edges_. For animated connection lines between nodes, Magic UI's `AnimatedBeam` is the purpose-built solution and shares the same tech stack.

---

## Key Findings

1. **Installation method**: Primarily copy-paste via shadcn CLI. Individual components are added with `npx shadcn@latest add @aceternity/[component-name]`. There is no monolithic npm package to install — you own the source.

2. **Tech stack**: React + TypeScript + Tailwind CSS v4 + `motion` (Framer Motion v12+). Canvas is used for particle-heavy effects (Sparkles, Vortex). CSS keyframes and gradients power lightweight effects (Aurora, Grid/Dot backgrounds, Meteors). Framer Motion powers interactive transforms (3D Card, Wobble Card, Moving Border, Lamp).

3. **React 19 / Next.js 15 compatibility**: Requires overrides in `package.json` because Framer Motion is not yet fully stable on React 19. Use `"motion": "^12.0.0-alpha.1"` with React 19 peer dep overrides.

4. **For an architecture diagram with 6 connected nodes**: The optimal stack is Aceternity cards (nodes) + Aceternity backgrounds (environment) + Magic UI AnimatedBeam (edges/connections).

---

## Detailed Analysis

### 1. Installation

**Core dependencies** (required for nearly all components):

```bash
npm i motion clsx tailwind-merge
```

**Utility function** — create `lib/utils.ts`:

```typescript
import { ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
```

**Adding individual components via shadcn CLI**:

```bash
# Initialize shadcn in the project first
npx shadcn@latest init

# Then add specific Aceternity components
npx shadcn@latest add @aceternity/card-spotlight
npx shadcn@latest add @aceternity/wobble-card
npx shadcn@latest add @aceternity/moving-border
npx shadcn@latest add @aceternity/3d-marquee

# Or by registry URL
npx shadcn@latest add https://ui.aceternity.com/registry/[component].json
```

**React 19 / Next.js 15 override** — add to root `package.json`:

```json
{
  "overrides": {
    "motion": {
      "react": "19.0.0-rc-66855b96-20241106",
      "react-dom": "19.0.0-rc-66855b96-20241106"
    }
  }
}
```

---

### 2. Background Effects

These establish the visual environment around the diagram. Layer them as absolute-positioned elements beneath node cards.

#### Aurora Background

- **Tech**: Pure CSS `@keyframes` — animates `background-position` over 60 seconds continuously
- **Effect**: Slow-shifting gradient layers that simulate Northern Lights
- **Props**: `children`, `className`, `showRadialGradient` (boolean, default true)
- **Diagram use**: Full-section background behind the entire 6-node diagram. Deep blues/purples/greens create a "system/space" aesthetic. Wrap the whole diagram container.

```tsx
<AuroraBackground showRadialGradient={true} className="min-h-screen">
  <YourDiagramLayout />
</AuroraBackground>
```

#### Grid and Dot Backgrounds

- **Tech**: CSS `background-image` with two `linear-gradient` layers (no JS, no SVG)
- **Effect**: Crisp grid lines or dot grid. Adapts automatically to dark/light mode.
- **Grid sizes**: 40px x 40px (standard), 20px x 20px (fine)
- **Layering pattern**: Background div is `absolute inset-0`; content is `relative z-20`. A radial gradient mask fades edges.
- **Diagram use**: Ideal for a technical "graph paper" aesthetic that grounds nodes spatially. Strongly communicates "system architecture."

```tsx
// Grid background
<div className="relative h-screen w-full bg-white dark:bg-black">
  <div
    className="absolute inset-0 z-0"
    style={{
      backgroundImage: `linear-gradient(#e4e4e7 1px, transparent 1px),
                        linear-gradient(to right, #e4e4e7 1px, transparent 1px)`,
      backgroundSize: '40px 40px',
    }}
  />
  <div className="pointer-events-none absolute inset-0 z-10 bg-white [mask-image:radial-gradient(ellipse_at_center,transparent_20%,black)]" />
  <div className="relative z-20">
    <YourDiagram />
  </div>
</div>
```

#### Sparkles

- **Tech**: Canvas-based particle renderer
- **Effect**: Shimmering star/sparkle particles floating in a defined area
- **Props**: `background`, `particleSize`, `minSize`, `maxSize`, `speed`, `particleColor`, `particleDensity`, `className`, `id`
- **Diagram use**: Position around individual node cards to make them feel "active" or "alive." Works well as a tight background for a highlighted/selected node. Use `particleColor` to theme per node type.

#### Vortex

- **Tech**: Canvas-based (inspired by AmbientCanvasBackgrounds on GitHub)
- **Effect**: 700 animated particles spiraling in a whirlpool pattern
- **Props**: `particleCount` (default 700), `rangeY` (default 100), `baseHue` (default 220), `baseSpeed`, `rangeSpeed`, `baseRadius`, `backgroundColor`, `className`, `children`
- **Diagram use**: Striking full-section CTA-style background. Too chaotic for a node diagram background, but excellent as an attention-grabbing surrounding canvas. Scale down with `particleCount: 150` for subtlety.

#### Background Beams

- **Tech**: SVG path-following animation
- **Effect**: Multiple light beams radiate from a central point following SVG paths — classic hero-section "rays from the center" look
- **Props**: `className` only (paths are internal)
- **Diagram use**: Place behind the diagram to create a "light source" focal point. The beams create directionality without adding noise. Good for suggesting "data flow" visually.

#### Background Beams With Collision

- **Tech**: Framer Motion — beams animate using `translateX/translateY` with collision detection via React refs
- **Effect**: Beams move across the viewport and "explode" when they hit a boundary
- **Props**: `children`, `className`; internal `beamOptions` includes `initialX`, `translateX`, `initialY`, `translateY`, `rotate`, `duration` (default 8s), `delay`, `repeatDelay`
- **Diagram use**: A spectacular ambient background. The explosions read as "activity" in a data system. However, paths are fixed, not programmable to travel between specific nodes.

#### Meteors

- **Tech**: CSS `@keyframes meteor` — elements rotate 215deg and translate -500px over 5 seconds, infinite
- **Effect**: Diagonal streaks that fall across the container like shooting stars
- **Props**: `number` (count), `className`
- **Diagram use**: Apply inside a card container to add motion. Excellent for a "receiving data" or "processing" node card. Contained to parent bounds.

---

### 3. Card Components (Node Representations)

These are the primary candidates for representing the 6 nodes.

#### 3D Card Effect (CardContainer / CardBody / CardItem)

- **Tech**: CSS `perspective` + JS mouse tracking + CSS `transform: rotate3d()` and `translateZ()`
- **Effect**: On hover, child elements float up with different Z-depths, creating genuine parallax 3D
- **Component parts**:
  - `CardContainer` — establishes 3D perspective context
  - `CardBody` — the card surface
  - `CardItem` — individual floating elements within the card; accepts `translateZ`, `rotateX`, `rotateY`, `rotateZ`, `as`, `className`
- **Diagram use**: Each of the 6 nodes gets a `CardContainer`. Stack icons, labels, and status badges at different `translateZ` values (e.g., icon at `translateZ={60}`, label at `translateZ={40}`, description at `translateZ={20}`). Creates enormous depth and premium feel.

```tsx
<CardContainer className="inter-var">
  <CardBody className="group/card relative h-48 w-48 rounded-xl border-black/10 bg-gray-50 p-4 dark:bg-black">
    <CardItem translateZ="50" className="text-xl font-bold">
      Agent Manager
    </CardItem>
    <CardItem translateZ="60" as="div" className="mt-4">
      <AgentIcon />
    </CardItem>
    <CardItem translateZ="40" className="mt-2 text-xs text-neutral-500">
      Manages Claude sessions
    </CardItem>
  </CardBody>
</CardContainer>
```

#### Card Spotlight

- **Tech**: JavaScript mouse tracking — dynamically injects a CSS radial gradient that follows the cursor position within the card bounds
- **Effect**: A visible cone of light sweeps across the card surface on hover
- **Props**: `children`, `radius` (default 350px), `color` (default "#262616"), `className`
- **Installation**: `npx shadcn@latest add @aceternity/card-spotlight`
- **Diagram use**: Excellent for dark-themed architecture diagrams. Each node card gets a spotlight that activates on hover, communicating "this node is active." Adjust `color` per node type (blue for data nodes, green for processing nodes, red for output nodes).

#### Glare Card

- **Tech**: CSS/JS — tracks mouse position and applies a specular highlight (reflective glare) that moves across the card surface
- **Effect**: A "Linear website"-style card with a physical glass/metal sheen on hover
- **Props**: `children`, `className`
- **Diagram use**: Premium finish for node cards. The glare physically suggests "hardware" or "physical infrastructure." Best for 3–4 primary nodes rather than all 6 (visual overload risk).

#### Wobble Card

- **Tech**: Framer Motion `mousemove` handlers — translates and scales the card as the pointer moves across it
- **Effect**: Card physically wobbles and follows the cursor with elastic springback
- **Props**: `children`, `containerClassName`, `className`
- **Diagram use**: Makes nodes feel tactile and interactive. Pairs well with a grid/dot background. Use for "leaf" nodes (endpoints) rather than "hub" nodes (center of the diagram) to avoid confusion with the connection lines.

#### Evervault Card

- **Effect**: On hover, reveals "encrypted gibberish text" that slowly decodes — creates a mysterious, data-system aesthetic
- **Diagram use**: Perfect for a "black box" or "AI model" node in the architecture diagram. The encryption effect visually communicates "opaque processing."

#### Expandable Cards

- **Effect**: Click to expand and reveal more content below
- **Diagram use**: Excellent for progressive disclosure — nodes show a compact view by default, expand on click to reveal implementation details, API docs, or sub-components.

---

### 4. Border & Glow Effects

Apply these to node card containers for connective visual weight.

#### Moving Border

- **Tech**: Framer Motion — animates a gradient element along the perimeter of the container on a continuous loop
- **Effect**: A light or color pulse travels clockwise around the element's border
- **Props**: `borderRadius` (default "1.75rem"), `children`, `duration` (ms, default 2000), `className`, `containerClassName`, `borderClassName`, `as` (default "button")
- **Diagram use**: Wrap active or "live" nodes in a `MovingBorder` to indicate they are currently processing. Use different `duration` values per node to create asynchronous activity.

```tsx
<MovingBorder duration={3000} borderRadius="0.75rem" as="div">
  <NodeCard name="Session Broadcaster" />
</MovingBorder>
```

#### Glowing Effect

- **Tech**: Interactive JS — monitors mouse position relative to element bounds; dynamically adjusts a conic gradient glow
- **Effect**: Adaptive border glow that intensifies as the cursor approaches — as seen on Cursor's enterprise page
- **Props**: `blur` (px), `inactiveZone` (0–1, center dead zone), `proximity` (px outside bounds), `spread` (degrees), `variant` ("default" or "white"), `glow` (boolean, force-show), `movementDuration` (s), `borderWidth` (px), `disabled`, `className`
- **Diagram use**: Apply to ALL 6 node cards. When the user's cursor sweeps across the diagram, adjacent nodes light up as they pass proximity. Creates a "field of influence" effect that is highly memorable.

---

### 5. Text Effects (Node Labels)

#### Text Generate Effect

- **Effect**: Words fade in sequentially on load, like a terminal printing output
- **Diagram use**: Perfect for diagram section headings (e.g., "DorkOS Architecture") that reveal on scroll or mount. Creates a "system boot" narrative.

#### Typewriter Effect

- **Effect**: Characters appear one by one as if being typed
- **Diagram use**: Use in individual node cards to show "active status" text like "Processing... connecting... ready."

#### Flip Words

- **Effect**: A component that cycles through a list of words with a flip animation
- **Diagram use**: For nodes with multiple roles, cycle through their capabilities: "Streaming → Broadcasting → Recording"

#### Text Hover Effect

- **Effect**: Animates and outlines a gradient on hover over text
- **Diagram use**: Node labels that reveal color on hover — helps communicate the node's type/category through color.

#### Colourful Text

- **Effect**: Multi-color text with filter and scale animations
- **Diagram use**: Title/heading treatment for the overall diagram section.

#### Encrypted Text (Evervault)

- **Effect**: Text reveals gradually from gibberish to readable on hover
- **Diagram use**: For "internal" label details that reveal on interaction — reinforces the idea that the system is decoding itself.

---

### 6. Connection Lines — The Gap (and Solution)

**Aceternity UI does NOT have a dedicated node-connection component.** The beam components (Background Beams, Tracing Beam) follow fixed SVG paths and cannot be dynamically directed between arbitrary DOM elements.

**The solution is Magic UI's `AnimatedBeam`**, which is purpose-built for this:

- **Tech**: SVG `<path>` drawn between two React `ref`-attached elements using `getBoundingClientRect()`. Framer Motion animates a gradient dot along the path.
- **Effect**: A glowing beam of light travels from source node to target node along a curved SVG path. The path auto-recalculates on resize.
- **Installation**: `npx shadcn@latest add "https://magicui.design/r/animated-beam"`
- **Shared tech stack**: React + Framer Motion + Tailwind — fully compatible with Aceternity components

```tsx
// Magic UI AnimatedBeam connects two ref'd elements
const containerRef = useRef<HTMLDivElement>(null);
const nodeARef = useRef<HTMLDivElement>(null);
const nodeBRef = useRef<HTMLDivElement>(null);

<div ref={containerRef} className="relative">
  <div ref={nodeARef}>
    <AgentManagerCard />
  </div>
  <div ref={nodeBRef}>
    <TranscriptReaderCard />
  </div>
  <AnimatedBeam
    containerRef={containerRef}
    fromRef={nodeARef}
    toRef={nodeBRef}
    curvature={50}
    gradientStartColor="#6344F5"
    gradientStopColor="#18CCFC"
  />
</div>;
```

---

### 7. Recommended Component Stack for a 6-Node Architecture Diagram

This is the optimal composition for a visually stunning, interactive architecture diagram:

**Background layer**:

- Grid/Dot Background (CSS, zero perf cost) — establishes spatial grid
- Sparkles (Canvas) — ambient particle field

**Section wrapper**:

- Aurora Background (CSS) — slow color shift beneath the entire section

**Node cards (x6)** — pick one card type per node, or mix:

- `CardContainer` + `CardBody` + `CardItem` for the primary "hub" nodes (most impressive)
- `CardSpotlight` for secondary/leaf nodes
- `GlowingEffect` border on all cards for proximity-reactive glowing
- `Meteors` inside 1–2 cards to indicate active processing

**Connection edges (x N)**:

- Magic UI `AnimatedBeam` — one per directed connection, with curvature to avoid overlap
- Vary `gradientStartColor`/`gradientStopColor` per connection type (data flow, control flow, etc.)

**Labels and headings**:

- `TextGenerateEffect` for the diagram section title
- `TypewriterEffect` inside node cards for status text
- `FlipWords` for nodes with multiple roles

**Interactive borders**:

- `MovingBorder` on 2–3 "active" nodes to show live activity
- `GlowingEffect` on all cards for cursor-proximity glow

---

## Visual Aesthetic Summary

What makes Aceternity UI "dope":

1. **Dark-first**: Nearly all components look best on dark backgrounds (black, near-black). The library is designed for the dark web aesthetic.

2. **Depth**: 3D card effects, parallax Z-layers, glare, and spotlight effects create genuine visual depth that flat design cannot replicate.

3. **Reactivity**: Almost everything responds to mouse position — the components feel alive before any content loads.

4. **Light as a metaphor**: Beams, spotlights, glows, auroras — the library uses light to communicate importance. Hot = important, dark = background.

5. **Premium SaaS references**: Effects are explicitly described as "as seen on Linear," "as seen on Cursor," "as seen on Perplexity" — the library is curated from the most visually respected SaaS interfaces.

6. **Performance consciousness**: Lightweight effects (Aurora, Grids, Meteors) use pure CSS. Particle effects (Sparkles, Vortex) use Canvas. Only interactive components use Framer Motion JS.

---

## Research Gaps & Limitations

- Aceternity UI has no built-in SVG/canvas diagram engine (no React Flow equivalent)
- No built-in node-connection / edge component — must use Magic UI AnimatedBeam or custom SVG
- The `evervault-card` and some other components were not individually fetched — descriptions are from the component list page, not detailed docs
- React 19 compatibility is not fully resolved as of research date; the alpha `motion` package may have instability
- Some components (Comet Card, Draggable Card) could not be fetched individually due to 404 errors — they may be in the Pro tier

---

## Contradictions & Notes

- The library refers to both `framer-motion` and `motion` across different pages. They are the same library: Framer Motion v12 rebranded the package to `motion`. Install `motion`, not `framer-motion`.
- The shadcn CLI registry (`@aceternity/[component]`) may not have all components indexed — some require fetching by the full registry URL.

---

## Search Methodology

- Number of tool calls: 18
- Most productive searches: Direct component page fetches, `site:ui.aceternity.com` filtered searches
- Primary sources: `ui.aceternity.com` component pages, `magicui.design` AnimatedBeam docs, Aceternity install docs

---

## Sources

- [Aceternity UI — Homepage](https://ui.aceternity.com)
- [Aceternity UI — All Components](https://ui.aceternity.com/components)
- [Aceternity UI — Install Next.js](https://ui.aceternity.com/docs/install-nextjs)
- [Aceternity UI — Add Utilities](https://ui.aceternity.com/docs/add-utilities)
- [Aceternity UI — CLI Docs](https://ui.aceternity.com/docs/cli)
- [Aceternity UI — Aurora Background](https://ui.aceternity.com/components/aurora-background)
- [Aceternity UI — Background Beams](https://ui.aceternity.com/components/background-beams)
- [Aceternity UI — Background Beams With Collision](https://ui.aceternity.com/components/background-beams-with-collision)
- [Aceternity UI — Background Boxes](https://ui.aceternity.com/components/background-boxes)
- [Aceternity UI — Card Spotlight](https://ui.aceternity.com/components/card-spotlight)
- [Aceternity UI — 3D Card Effect](https://ui.aceternity.com/components/3d-card-effect)
- [Aceternity UI — Glare Card](https://ui.aceternity.com/components/glare-card)
- [Aceternity UI — Wobble Card](https://ui.aceternity.com/components/wobble-card)
- [Aceternity UI — Moving Border](https://ui.aceternity.com/components/moving-border)
- [Aceternity UI — Glowing Effect](https://ui.aceternity.com/components/glowing-effect)
- [Aceternity UI — Spotlight](https://ui.aceternity.com/components/spotlight)
- [Aceternity UI — Sparkles](https://ui.aceternity.com/components/sparkles)
- [Aceternity UI — Vortex](https://ui.aceternity.com/components/vortex)
- [Aceternity UI — Meteors](https://ui.aceternity.com/components/meteors)
- [Aceternity UI — Lamp Effect](https://ui.aceternity.com/components/lamp-effect)
- [Aceternity UI — Grid and Dot Backgrounds](https://ui.aceternity.com/components/grid-and-dot-backgrounds)
- [Aceternity UI — Tracing Beam](https://ui.aceternity.com/components/tracing-beam)
- [Magic UI — Animated Beam](https://magicui.design/docs/components/animated-beam)
- [Magic UI v3 — Animated Beam](https://v3.magicui.design/docs/components/animated-beam)
