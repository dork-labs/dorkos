'use client';

import { Suspense, lazy, type ComponentType } from 'react';
import type { SystemModule } from '@/layers/features/marketing/lib/modules';
import { systemModules } from '@/layers/features/marketing';

interface DiagramProps {
  modules: SystemModule[];
}

/** Lazily load a variant — renders placeholder if file doesn't exist yet. */
function lazyVariant(
  loader: () => Promise<{ [key: string]: ComponentType<DiagramProps> }>,
  exportName: string
) {
  return lazy(() =>
    loader()
      .then((mod) => ({ default: mod[exportName] }))
      .catch(() => ({
        default: () => (
          <div className="text-warm-gray flex h-64 items-center justify-center font-mono text-sm">
            Loading... (agent still working)
          </div>
        ),
      }))
  );
}

const variants = [
  {
    id: 1,
    title: 'Radial Orbit',
    description:
      'Engine sits at the center with modules orbiting around it. Connections shown as orbital paths with traveling particles.',
    Component: lazyVariant(() => import('./variants/v1-radial-orbit'), 'DiagramV1'),
  },
  {
    id: 2,
    title: 'Circuit Board',
    description:
      'PCB-trace aesthetic with right-angle connections, solder joints at nodes, and signal-pulse animations along traces.',
    Component: lazyVariant(() => import('./variants/v2-circuit-board'), 'DiagramV2'),
  },
  {
    id: 3,
    title: 'Constellation',
    description:
      'Star map visualization with twinkling nodes and light-trail connections. Deep space background feel.',
    Component: lazyVariant(() => import('./variants/v3-constellation'), 'DiagramV3'),
  },
  {
    id: 4,
    title: 'Hexagonal Grid',
    description:
      'Honeycomb layout with hexagonal cells for each module. Connections flow through shared hex edges.',
    Component: lazyVariant(() => import('./variants/v4-hexagonal'), 'DiagramV4'),
  },
  {
    id: 5,
    title: 'Neural Network',
    description:
      'Brain-inspired visualization with dendrite-like branching connections and synaptic pulse animations.',
    Component: lazyVariant(() => import('./variants/v5-neural-network'), 'DiagramV5'),
  },
  {
    id: 6,
    title: 'Isometric Blocks',
    description:
      'Pseudo-3D isometric blocks connected by pipes/conduits. Depth gives hierarchy a physical presence.',
    Component: lazyVariant(() => import('./variants/v6-isometric'), 'DiagramV6'),
  },
  {
    id: 7,
    title: 'Metro Map',
    description:
      'Transit-style diagram with colored lines for different connection types. Clean, wayfinding aesthetic.',
    Component: lazyVariant(() => import('./variants/v7-metro-map'), 'DiagramV7'),
  },
  {
    id: 8,
    title: 'Concentric Rings',
    description:
      'Layered rings radiating outward from Engine. Inner ring = available, outer ring = coming soon. Radar sweep animation.',
    Component: lazyVariant(() => import('./variants/v8-concentric-rings'), 'DiagramV8'),
  },
  {
    id: 9,
    title: 'DNA Helix',
    description:
      'Double helix with modules as base pairs connected by rungs. Rotation animation suggests living system.',
    Component: lazyVariant(() => import('./variants/v9-dna-helix'), 'DiagramV9'),
  },
  {
    id: 10,
    title: 'Particle Flow',
    description:
      'Nodes connected by flowing particle streams. Direction and density of particles indicate data flow relationships.',
    Component: lazyVariant(() => import('./variants/v10-particle-flow'), 'DiagramV10'),
  },
  {
    id: 11,
    title: '3D Tilt Cards + Tracing Beams',
    description:
      'Aceternity-inspired 3D perspective tilt cards with mouse tracking. Connected by animated tracing beams that draw on scroll. Interactive: hover to tilt, click to expand details.',
    Component: lazyVariant(() => import('./variants/v11-3d-tilt-beam'), 'DiagramV11'),
  },
  {
    id: 12,
    title: 'Glowing Border Network',
    description:
      'Cards with animated gradient borders that trace around their perimeter. Connections are glowing beams with traveling light pulses. Dark theme, neon aesthetic.',
    Component: lazyVariant(() => import('./variants/v12-glowing-network'), 'DiagramV12'),
  },
  {
    id: 13,
    title: 'Canvas Dot Matrix Reveal',
    description:
      'A canvas-based dot matrix that reveals the architecture on hover. Move your cursor to illuminate regions and discover modules. Hidden until explored.',
    Component: lazyVariant(() => import('./variants/v13-canvas-reveal'), 'DiagramV13'),
  },
  {
    id: 14,
    title: 'Spotlight Cards + Background Beams',
    description:
      'Full-section background beams with cards that have spotlight cursor-following effects. Hover a card to see it illuminate with a radial gradient.',
    Component: lazyVariant(() => import('./variants/v14-spotlight-beams'), 'DiagramV14'),
  },
  {
    id: 15,
    title: 'Interactive Node Graph',
    description:
      'Draggable nodes with spring-physics connections. Click and drag modules to rearrange. Connections stretch and bounce. The most interactive variant.',
    Component: lazyVariant(() => import('./variants/v15-draggable-graph'), 'DiagramV15'),
  },
];

function DiagramFallback() {
  return (
    <div className="text-warm-gray flex h-64 animate-pulse items-center justify-center font-mono text-sm">
      Loading diagram...
    </div>
  );
}

export default function DiagramTestPage() {
  return (
    <div className="bg-cream-primary min-h-screen">
      {/* Header */}
      <div className="px-8 py-16 text-center">
        <span className="text-2xs text-brand-orange mb-4 block font-mono tracking-[0.15em] uppercase">
          Exploration
        </span>
        <h1 className="text-charcoal mb-6 text-[40px] leading-[1.0] font-semibold tracking-[-0.04em] md:text-[56px]">
          System Architecture Variants
        </h1>
        <p className="text-warm-gray mx-auto max-w-xl text-base leading-[1.7]">
          Fifteen different approaches to visualizing the DorkOS six-module architecture. Each
          explores a distinct metaphor, layout, and animation strategy. V11-V15 are
          Aceternity-inspired with heavy interactivity.
        </p>
      </div>

      {/* Variants */}
      <div className="mx-auto max-w-7xl space-y-24 px-8 pb-32">
        {variants.map((v) => (
          <section key={v.id} className="scroll-mt-8">
            {/* Variant label */}
            <div className="mb-8 flex items-baseline gap-4">
              <span className="text-3xs text-brand-orange font-mono tracking-[0.15em] uppercase">
                V{String(v.id).padStart(2, '0')}
              </span>
              <h2 className="text-charcoal text-[24px] font-semibold tracking-[-0.02em]">
                {v.title}
              </h2>
            </div>
            <p className="text-warm-gray mb-8 max-w-xl text-sm leading-[1.7]">{v.description}</p>

            {/* Diagram container */}
            <div className="bg-cream-tertiary overflow-hidden rounded-xl border border-[var(--border-warm)] p-8">
              <Suspense fallback={<DiagramFallback />}>
                <v.Component modules={systemModules} />
              </Suspense>
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
