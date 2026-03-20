---
title: 'Marketing Page UI Visualization Libraries Research'
date: 2026-02-28
type: external-best-practices
status: active
tags: [marketing, visualization, libraries, animation, three-js, canvas]
feature_slug: dynamic-motion-enhancements
---

# Marketing Page UI Visualization Libraries Research

**Date**: 2026-02-28
**Context**: DorkOS marketing site (`apps/web`) — Next.js 16, Tailwind CSS 4, `motion` (motion/react) already in use. Goal: visual storytelling without bundle bloat.
**Depth**: Deep Research

---

## Research Summary

Five categories of visual storytelling libraries were evaluated for use on a Next.js 16 App Router marketing site. The most bundle-friendly options are pure SVG/CSS animation (zero cost) and Magic UI's copy-paste terminal components (zero runtime dependency). React Flow is viable for topology demos but carries a ~150 kB gzipped cost and requires `'use client'`. React Three Fiber is the heaviest option (~400+ kB combined with Three.js) and should only be used for hero sections that genuinely justify the weight. Lottie is strong for pre-built icons/illustrations but requires either `dynamic({ ssr: false })` or a WASM loader. Motion (already installed) is the best tool for SVG drawing effects and should be preferred over adding GSAP.

---

## Key Findings

### 1. React Flow — Topology Visualization

React Flow v12 (`@xyflow/react`) is the current package name. It fully supports SSR as of v12 (released late 2024). Key facts:

- **Bundle size**: ~150 kB min+gzip (from Bundlephobia data). The full unminified package is ~1.19 MB.
- **Requires `'use client'`**: Yes — the `<ReactFlow>` component uses browser APIs (ResizeObserver, pointer events). Must be wrapped in a client component or loaded via `next/dynamic`.
- **SSR support**: v12 introduced proper SSR. You must supply `width`, `height`, `initialWidth`, `initialHeight` on nodes and handle positions explicitly so the server can render edges. Without these, nodes render as empty on the server.
- **Non-interactive display**: Fully supported. Set `nodesDraggable={false}`, `nodesConnectable={false}`, `elementsSelectable={false}`, `panOnDrag={false}`, `zoomOnScroll={false}`, `preventScrolling={false}`, and `proOptions={{ hideAttribution: true }}` (for paid plans) to create a locked, animated display.
- **Animated edges**: Two built-in approaches:
  1. `animated={true}` on edge objects — renders a dashed animated stroke (CSS animation, lightweight)
  2. Custom `AnimatedSVGEdge` using `<animateMotion>` — animates a shape (dot, circle) along the edge path at a configurable `dur`
- **Auto-play**: All edge animations are CSS/SVG driven and run automatically with no user interaction required.

**Minimal non-interactive setup:**

```tsx
'use client';
import { ReactFlow, Background } from '@xyflow/react';
import '@xyflow/react/dist/style.css';

const nodes = [
  { id: '1', position: { x: 0, y: 0 }, data: { label: 'Agent A' }, width: 120, height: 40 },
  { id: '2', position: { x: 200, y: 100 }, data: { label: 'Agent B' }, width: 120, height: 40 },
];
const edges = [{ id: 'e1-2', source: '1', target: '2', animated: true }];

export function TopologyDemo() {
  return (
    <div style={{ height: 400 }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        panOnDrag={false}
        zoomOnScroll={false}
        fitView
      >
        <Background />
      </ReactFlow>
    </div>
  );
}
```

**Recommendation for DorkOS**: Use for a mesh topology or agent communication diagram. The ~150 kB cost is justified for a dedicated "how it works" section. Lazy-load it with `next/dynamic` to keep initial page load fast.

---

### 2. Lottie for React

**Package landscape (2026):**

| Package                        | Maintainer     | Format         | Min+Gzip | Status                   |
| ------------------------------ | -------------- | -------------- | -------- | ------------------------ |
| `lottie-react`                 | Community      | JSON           | ~15 kB   | Active, v2.4.1           |
| `@lottiefiles/dotlottie-react` | LottieFiles    | .lottie + JSON | ~51 kB   | Official, recommended    |
| `react-lottie`                 | Airbnb-derived | JSON           | ~20 kB   | Largely abandoned, avoid |

**SSR compatibility**: All Lottie renderers need browser Canvas or DOM APIs. **None work in RSC/SSR without `{ ssr: false }`**. The standard pattern:

```tsx
// app/components/HeroAnimation.tsx (server component wrapper)
import dynamic from 'next/dynamic';

const LottiePlayer = dynamic(() => import('./LottiePlayerClient'), {
  ssr: false,
  loading: () => <div className="bg-muted h-48 animate-pulse rounded" />,
});

export function HeroAnimation() {
  return <LottiePlayer />;
}
```

```tsx
// app/components/LottiePlayerClient.tsx
'use client';
import { DotLottieReact } from '@lottiefiles/dotlottie-react';

export default function LottiePlayerClient() {
  return <DotLottieReact src="/animations/agent-pulse.lottie" loop autoplay />;
}
```

**Creating Lottie animations without After Effects:**

- **Lottielab** (lottielab.com) — Browser-based, Figma import, exports `.lottie`. Best option for developers.
- **LottieFiles Creator** (lottiefiles.com/lottie-creator) — AI-powered, free tier (5 exports), state machines.
- **Glaxnimate** — Open-source desktop app, SVG-based workflow.
- **SVG-to-Lottie converters** — LottieFiles' tool can convert animated SVGs.
- **Programmatic JSON**: Lottie files are plain JSON. You can write them by hand for simple animations (bouncing dot, spinner), but it's tedious for complex paths.

**Bundle size note**: The `.lottie` format (used by `@lottiefiles/dotlottie-react`) compresses animation files by up to 80% vs plain JSON. The trade-off is the WASM-based renderer adds ~30 kB over `lottie-react`. For simple icons/illustrations, `lottie-react` at ~15 kB is lighter.

**Recommendation for DorkOS**: Use `lottie-react` (lighter) for decorative icon animations. Use `@lottiefiles/dotlottie-react` for complex hero animations where file size of the animation JSON matters. Always use `dynamic({ ssr: false })`. Create animations in Lottielab.

---

### 3. React Three Fiber (R3F)

**Version compatibility (critical):**

- `@react-three/fiber@8` pairs with React 18
- `@react-three/fiber@9` (RC) pairs with React 19 — required for Next.js 16

**Required packages:**

```bash
pnpm add three @react-three/fiber@rc @react-three/drei
```

**Next.js config (`next.config.ts`):**

```ts
const nextConfig = {
  transpilePackages: ['three'],
};
```

**Bundle sizes (combined, min+gzip):**

- `three`: ~155-170 kB
- `@react-three/fiber`: ~236 kB (includes Three.js renderer integration)
- `@react-three/drei`: varies widely by what you import, but adds 50-200+ kB
- **Total realistic cost**: 400-600 kB min+gzip for a basic 3D scene

**SSR**: Three.js requires WebGL, which is browser-only. **Always use `{ ssr: false }`** via `next/dynamic` for the Canvas component.

**Minimal particle field setup:**

```tsx
'use client';
import { Canvas, useFrame } from '@react-three/fiber';
import { useRef, useMemo } from 'react';
import * as THREE from 'three';

function ParticleField({ count = 2000 }: { count?: number }) {
  const ref = useRef<THREE.Points>(null);

  const positions = useMemo(() => {
    const arr = new Float32Array(count * 3);
    for (let i = 0; i < count * 3; i++) {
      arr[i] = (Math.random() - 0.5) * 10;
    }
    return arr;
  }, [count]);

  useFrame((_, delta) => {
    if (ref.current) {
      ref.current.rotation.y += delta * 0.05;
    }
  });

  return (
    <points ref={ref}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
      </bufferGeometry>
      <pointsMaterial size={0.02} color="#6366f1" transparent opacity={0.6} />
    </points>
  );
}

// Loaded via next/dynamic with ssr: false in the page component
export function ParticleCanvas() {
  return (
    <Canvas camera={{ position: [0, 0, 5] }} dpr={[1, 1.5]}>
      <ParticleField />
    </Canvas>
  );
}
```

**Performance considerations:**

- Always cap `dpr` (device pixel ratio) at 1.5 — `dpr={[1, 1.5]}` lets Three.js pick based on device but caps it
- Use `frameloop="demand"` if the scene only needs to render on state changes
- Dispose of geometries and materials explicitly (R3F does not auto-dispose)
- Avoid adding Drei's `<Environment>` or HDR loaders unless needed — these add significant bundle and network weight
- On mobile, 3D scenes can hit 28 FPS at 85% CPU (per benchmark data). Consider a static image fallback for `prefers-reduced-motion`

**Alternative: CSS 3D transforms** for subtle depth effects without Three.js weight. Pure CSS perspective transforms can create convincing floating/parallax effects.

**Recommendation for DorkOS**: Only use R3F for a single high-impact hero visual. The ~400 kB total bundle cost is only justifiable for the absolute centerpiece of the marketing page. Lazy-load with `next/dynamic({ ssr: false })`. For everything else, use SVG animations.

---

### 4. SVG Animation Techniques

This is the highest-value option: zero bundle cost, works in Server Components, and can be visually stunning.

#### Technique 1: Stroke-Dasharray Path Drawing (Pure CSS)

The classic "self-drawing line" effect:

```tsx
// Server Component — no 'use client' needed
export function AnimatedPath() {
  return (
    <svg viewBox="0 0 200 100" xmlns="http://www.w3.org/2000/svg">
      <style>{`
        .draw-path {
          stroke-dasharray: 300;
          stroke-dashoffset: 300;
          animation: draw 2s ease forwards;
        }
        @keyframes draw {
          to { stroke-dashoffset: 0; }
        }
        @media (prefers-reduced-motion: reduce) {
          .draw-path { animation: none; stroke-dashoffset: 0; }
        }
      `}</style>
      <path
        className="draw-path"
        d="M 10 50 Q 100 10 190 50"
        stroke="#6366f1"
        strokeWidth="2"
        fill="none"
        strokeLinecap="round"
      />
    </svg>
  );
}
```

The `stroke-dasharray` value should equal the path's total length (use `path.getTotalLength()` in browser console to measure, then hardcode it).

#### Technique 2: motion/react `pathLength` (Client Component, minimal cost)

Motion is already installed. Use `motion.path` with `pathLength` for scroll-triggered or entrance drawing effects:

```tsx
'use client';
import { motion, useInView } from 'motion/react';
import { useRef } from 'react';

export function DrawingPath() {
  const ref = useRef(null);
  const isInView = useInView(ref, { once: true });

  return (
    <svg ref={ref} viewBox="0 0 200 100">
      <motion.path
        d="M 10 50 Q 100 10 190 50"
        stroke="#6366f1"
        strokeWidth="2"
        fill="none"
        strokeLinecap="round"
        initial={{ pathLength: 0, opacity: 0 }}
        animate={isInView ? { pathLength: 1, opacity: 1 } : {}}
        transition={{ duration: 1.5, ease: 'easeOut' }}
      />
    </svg>
  );
}
```

`pathLength` is a Motion shorthand that automatically handles `stroke-dasharray`/`stroke-dashoffset` calculation — no need to measure the path manually.

#### Technique 3: Pulsing Node Animation (Pure CSS, Server Component)

For network topology visualizations:

```tsx
// Server Component
export function NetworkNode() {
  return (
    <svg viewBox="0 0 100 100">
      <style>{`
        .pulse-ring {
          transform-origin: 50px 50px;
          animation: pulse 2s ease-out infinite;
        }
        @keyframes pulse {
          0% { opacity: 0.8; transform: scale(0.8); }
          100% { opacity: 0; transform: scale(1.5); }
        }
      `}</style>
      <circle
        className="pulse-ring"
        cx="50"
        cy="50"
        r="20"
        fill="none"
        stroke="#6366f1"
        strokeWidth="2"
      />
      <circle cx="50" cy="50" r="12" fill="#6366f1" />
    </svg>
  );
}
```

#### CSS vs. SMIL vs. Motion — Decision Matrix

| Scenario                               | Best Tool                                            |
| -------------------------------------- | ---------------------------------------------------- |
| Simple path drawing, no scroll trigger | Pure CSS `stroke-dashoffset` animation               |
| Scroll-triggered path drawing          | `motion/react` `pathLength` + `useInView`            |
| Complex morphing between shapes        | GSAP MorphSVG (adds ~30 kB, avoid unless critical)   |
| SMIL (`<animate>` tags)                | **Avoid** — deprecated, inconsistent browser support |
| Entrance animations on SVG elements    | `motion/react` (already installed, zero added cost)  |
| Looping decorative animations          | Pure CSS `@keyframes` (no JS, RSC-safe)              |

**Performance benchmark from research:**

- CSS transform: 60 FPS, 5% CPU
- CSS color change: 58 FPS, 15% CPU
- JS-driven morphing: 59 FPS desktop, 28 FPS mobile at 85% CPU

**Recommendation for DorkOS**: This is the **primary tool** for marketing visualizations. Use `motion/react` (already installed) for entrance/scroll animations, and pure CSS `@keyframes` for looping decorative effects. No new dependencies needed. SVG can illustrate the agent topology, relay message flows, and pulse scheduling with zero bundle cost.

---

### 5. Terminal / Code Mockup Components

#### Option A: Magic UI Terminal (Recommended — Zero Runtime Dependency)

Magic UI (magicui.design) provides copy-paste components — **you copy the source into your codebase**, no npm package needed. The Terminal component implements a macOS-style terminal window with animated line-by-line output.

Source code pattern (from Magic UI docs):

```tsx
'use client';
import { AnimatedSpan, Terminal, TypingAnimation } from '@/components/magicui/terminal';

export function DorkOSTerminal() {
  return (
    <Terminal>
      <TypingAnimation>&gt; dorkos --dir ~/projects/my-agent</TypingAnimation>
      <AnimatedSpan delay={1500} className="text-green-400">
        ✓ Agent session initialized
      </AnimatedSpan>
      <AnimatedSpan delay={2000} className="text-muted-foreground">
        Relay endpoint registered: relay.agent.abc123
      </AnimatedSpan>
      <AnimatedSpan delay={2500} className="text-green-400">
        ✓ Mesh discovery complete — 3 agents found
      </AnimatedSpan>
      <TypingAnimation delay={3000} className="text-white">
        Ready.
      </TypingAnimation>
    </Terminal>
  );
}
```

The actual Magic UI implementation uses `motion/react` (already in your stack) for the typing animation. Since you're copying the source, you control the bundle completely.

#### Option B: Shiki-powered Code Blocks (Server Component safe)

For showing code snippets, Shiki is the standard in the Next.js ecosystem (used by Next.js docs itself):

```tsx
// Server Component — no 'use client', zero client JS
import { codeToHtml } from 'shiki';

export async function CodeBlock({ code, lang = 'bash' }: { code: string; lang?: string }) {
  const html = await codeToHtml(code, {
    lang,
    theme: 'github-dark',
  });
  // Note: html here is generated server-side from trusted code strings, not user input
  return <div dangerouslySetInnerHTML={{ __html: html }} />;
}
```

Shiki runs at build/request time on the server. **Zero client-side JS**. Perfect for marketing pages.

#### Option C: react-terminal-ui (For interactive demos)

`react-terminal-ui` (v1.4.0) is a lightweight terminal UI component. Use only if you need actual interactivity (user typing). For static/animated demos, Magic UI is better.

#### Option D: Custom CSS Terminal Mockup (Zero Dependencies)

The simplest approach — a pure CSS terminal window with Tailwind:

```tsx
// Server Component
export function TerminalMockup({ lines }: { lines: string[] }) {
  return (
    <div className="overflow-hidden rounded-lg bg-zinc-900 font-mono text-sm">
      <div className="flex items-center gap-1.5 bg-zinc-800 px-4 py-3">
        <span className="h-3 w-3 rounded-full bg-red-500" />
        <span className="h-3 w-3 rounded-full bg-yellow-500" />
        <span className="h-3 w-3 rounded-full bg-green-500" />
      </div>
      <div className="space-y-1 p-4">
        {lines.map((line, i) => (
          <div key={i} className="text-zinc-300">
            {line}
          </div>
        ))}
      </div>
    </div>
  );
}
```

Add CSS `@keyframes` typewriter effect for the last line if desired.

**Recommendation for DorkOS**: Use Magic UI's Terminal component (copy-paste, uses motion which is already installed) for animated CLI demos. Use Shiki server-side for code snippets. Avoid adding `react-terminal-ui` as an npm dependency unless you need real interactivity.

---

## Detailed Analysis

### Bundle Cost Comparison

| Library                            | Min+Gzip    | `'use client'`    | SSR Support             | Recommendation                  |
| ---------------------------------- | ----------- | ----------------- | ----------------------- | ------------------------------- |
| Pure CSS SVG animations            | 0 kB        | No                | Full RSC                | Primary tool — use everywhere   |
| `motion/react` (already installed) | 0 kB added  | Yes               | Partial (layout in RSC) | Use for scroll-triggered SVG    |
| Magic UI Terminal (copy-paste)     | ~0 kB added | Yes (uses motion) | No                      | Use for terminal demos          |
| Shiki (code blocks)                | 0 kB client | No                | Full RSC                | Use for all code snippets       |
| `lottie-react`                     | ~15 kB      | Yes (ssr:false)   | No                      | Use for icons/decorative        |
| `@lottiefiles/dotlottie-react`     | ~51 kB      | Yes (ssr:false)   | No                      | Use for complex hero animations |
| `@xyflow/react`                    | ~150 kB     | Yes               | Partial (v12)           | One topology section only       |
| `@react-three/fiber` + `three`     | ~400 kB+    | Yes (ssr:false)   | No                      | One hero section only           |

### Strategy for DorkOS Marketing Site

Given the existing `motion/react` dependency, the zero-cost path is:

1. **Agent topology diagram**: SVG with `motion.path` and `motion.circle` — animated node pulsing and line drawing. No new dependencies. Can live in a Server Component with a thin `'use client'` wrapper for scroll-triggered animations.

2. **CLI/terminal demo**: Magic UI Terminal component (copy the source). Uses motion (already installed). Shows the `dorkos` CLI starting up, agents connecting, Relay messages flowing.

3. **Code samples**: Shiki in Server Components. No client JS.

4. **Relay/Mesh flow visualization**: SVG with CSS `@keyframes` arrows and pulse animations. React Flow optional if a richer interactive demo is needed.

5. **Hero section**: If a 3D effect is genuinely needed, use R3F with `next/dynamic({ ssr: false })` and a loading skeleton. Otherwise, an SVG particle/node effect with CSS animation is nearly as compelling at zero cost.

### SSR / App Router Compatibility Summary

In Next.js App Router, the default is Server Components. Libraries fall into three categories:

**RSC-safe (no `'use client'` needed):**

- Pure CSS animations in SVG/HTML
- Shiki (async server-side code highlighting)
- Static SVG markup

**Requires `'use client'` but SSR-renders HTML:**

- `motion/react` — renders initial state on server, hydrates animations on client
- `@xyflow/react` v12 — can SSR with explicit node dimensions and handle positions

**Must use `dynamic({ ssr: false })` (no server render):**

- `lottie-react`, `@lottiefiles/dotlottie-react` — needs Canvas API
- `@react-three/fiber` — needs WebGL
- Any component using `window`, `document`, `ResizeObserver` directly at module level

---

## Specific Code Recipes for DorkOS

### Recipe 1: Animated Agent Topology (SVG + motion/react, ~0 kB)

```tsx
'use client';
import { motion } from 'motion/react';

const agents = [
  { id: 'relay', label: 'Relay', x: 200, y: 100 },
  { id: 'agent-a', label: 'Agent A', x: 50, y: 250 },
  { id: 'agent-b', label: 'Agent B', x: 200, y: 250 },
  { id: 'agent-c', label: 'Agent C', x: 350, y: 250 },
];

const connections = [
  { from: agents[0], to: agents[1] },
  { from: agents[0], to: agents[2] },
  { from: agents[0], to: agents[3] },
];

export function AgentTopology() {
  return (
    <svg viewBox="0 0 400 350" className="mx-auto w-full max-w-lg">
      {/* Connection lines */}
      {connections.map((conn, i) => (
        <motion.line
          key={i}
          x1={conn.from.x}
          y1={conn.from.y}
          x2={conn.to.x}
          y2={conn.to.y}
          stroke="currentColor"
          strokeWidth="1"
          className="text-border"
          initial={{ pathLength: 0, opacity: 0 }}
          animate={{ pathLength: 1, opacity: 1 }}
          transition={{ delay: i * 0.2, duration: 0.8 }}
        />
      ))}
      {/* Nodes */}
      {agents.map((agent, i) => (
        <motion.g
          key={agent.id}
          initial={{ scale: 0, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ delay: 0.8 + i * 0.15, type: 'spring' }}
          style={{ transformOrigin: `${agent.x}px ${agent.y}px` }}
        >
          <circle
            cx={agent.x}
            cy={agent.y}
            r="24"
            className="fill-card stroke-border"
            strokeWidth="1.5"
          />
          <text
            x={agent.x}
            y={agent.y + 4}
            textAnchor="middle"
            className="fill-foreground"
            fontSize="10"
          >
            {agent.label}
          </text>
        </motion.g>
      ))}
    </svg>
  );
}
```

### Recipe 2: CSS offset-path Message Pulse on Connection

```css
/* In your Tailwind CSS or component styles — pure CSS, no JS */
@keyframes message-pulse {
  0% {
    offset-distance: 0%;
    opacity: 1;
  }
  90% {
    opacity: 1;
  }
  100% {
    offset-distance: 100%;
    opacity: 0;
  }
}

.message-dot {
  offset-path: path('M 200 100 L 50 250'); /* match your SVG path */
  animation: message-pulse 2s ease-in-out infinite;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #6366f1;
  position: absolute;
}
```

### Recipe 3: Lazy-loaded React Flow Topology

```tsx
// app/components/TopologySection.tsx (Server Component)
import dynamic from 'next/dynamic';

const FlowDiagram = dynamic(() => import('./FlowDiagramClient'), {
  ssr: false,
  loading: () => <div className="bg-muted h-[400px] animate-pulse rounded-lg" />,
});

export function TopologySection() {
  return (
    <section className="py-24">
      <h2>How DorkOS connects your agents</h2>
      <FlowDiagram />
    </section>
  );
}
```

---

## Research Gaps and Limitations

- Exact bundlephobia numbers for `@xyflow/react` gzipped were not fetchable directly (Bundlephobia renders via JS). The ~150 kB figure is from search result snippets and may vary by version.
- `@react-three/fiber@9` (RC) was just entering the React 19 ecosystem in early 2026 — API stability should be verified before shipping.
- Magic UI Terminal source code was not directly fetchable (JS-rendered page), but the copy-paste pattern is well-documented in their docs and community examples.
- Lottielab export format compatibility with `@lottiefiles/dotlottie-react` should be tested — the `.lottie` format is still evolving.

## Contradictions and Disputes

- **React Flow SSR**: Some community posts claim React Flow still requires `{ ssr: false }`, but the official v12 docs explicitly document SSR support with explicit node dimensions. The catch is that interactive features (drag, zoom) do require client hydration regardless.
- **R3F v9 + React 19**: Some forum posts report compatibility issues; the official docs say v9 targets React 19. Use the `@rc` tag and test carefully.
- **lottie-react vs dotlottie-react**: The community is split. `lottie-react` is lighter and more battle-tested; `@lottiefiles/dotlottie-react` is the official direction. For a marketing site where you control the animations, `lottie-react` is the pragmatic choice for its lighter weight.

---

## Search Methodology

- Searches performed: 14
- Most productive search terms: "react flow animated edges marketing page", "motion/react SVG pathLength Next.js App Router", "lottie-react SSR Next.js dynamic import", "magic ui terminal component"
- Primary information sources: reactflow.dev, bundlephobia.com, svgai.org, magicui.design, npmjs.com, motion.dev, LottieFiles docs

---

## Sources

- [React Flow SSR/SSG Configuration](https://reactflow.dev/learn/advanced-use/ssr-ssg-configuration)
- [React Flow Animating Edges Example](https://reactflow.dev/examples/edges/animating-edges)
- [@xyflow/react on npm](https://www.npmjs.com/package/@xyflow/react)
- [@xyflow/react on Bundlephobia](https://bundlephobia.com/package/@xyflow/react)
- [React Three Fiber Installation](https://r3f.docs.pmnd.rs/getting-started/installation)
- [react-three-next starter](https://github.com/pmndrs/react-three-next)
- [react-particles-webgl (SSR-compatible particle field)](https://github.com/tim-soft/react-particles-webgl)
- [lottie-react on npm](https://www.npmjs.com/package/lottie-react)
- [@lottiefiles/dotlottie-react bundle size issue (+30kB)](https://github.com/LottieFiles/dotlottie-web/issues/357)
- [How to Use Lottie in React App](https://lottiefiles.com/blog/working-with-lottie-animations/how-to-use-lottie-in-react-app)
- [Render Lottie in Next.js (No errors)](https://medium.com/@titoadeoye/render-lottie-animations-from-json-file-in-next-js-no-errors-4b4386bb107c)
- [Lottielab — Create and Edit Lottie Animations](https://www.lottielab.com/)
- [SVG Animation Encyclopedia 2025](https://www.svgai.org/blog/research/svg-animation-encyclopedia-complete-guide)
- [How SVG Line Animation Works — CSS-Tricks](https://css-tricks.com/svg-line-animation-works/)
- [SVG stroke-dasharray Drawing Effect — DEV](https://dev.to/paulryan7/simple-svg-drawing-effect-with-stroke-dasharray-stroke-dashoffset-3m8e)
- [Magic UI Terminal Component](https://magicui.design/docs/components/terminal)
- [Magic UI Components](https://magicui.design/docs/components)
- [Animate UI — Animated React Components](https://animate-ui.com/)
- [Shiki Next.js Integration](https://shiki.style/packages/next)
- [react-terminal-ui on npm](https://www.npmjs.com/package/react-terminal-ui)
- [react-terminal-ui on GitHub](https://github.com/jonmbake/react-terminal-ui)
- [Xyflow (React Flow + Svelte Flow)](https://xyflow.com/)
- [How to Use motion in Next.js](https://staticmania.com/blog/how-to-use-framer-motion-for-animations-in-next-js)
- [Synergy Codes — React Flow Deep Dive](https://www.synergycodes.com/blog/react-flow-everything-you-need-to-know)
