'use client';

import { Suspense, lazy, type ComponentType } from 'react';

interface HeroProps {
  headline: string;
  subhead: string;
  ctaText: string;
  ctaHref: string;
}

function lazyHero(
  loader: () => Promise<{ [key: string]: ComponentType<HeroProps> }>,
  exportName: string
) {
  return lazy(() =>
    loader()
      .then((mod) => ({ default: mod[exportName] }))
      .catch(() => ({
        default: () => (
          <div className="text-warm-gray flex h-[60vh] items-center justify-center font-mono text-sm">
            Loading... (agent still working)
          </div>
        ),
      }))
  );
}

const heroProps: HeroProps = {
  headline: 'Your AI Never Sleeps.',
  subhead:
    'DorkOS is an open-source operating system for autonomous AI agents. Built on Claude Code. Powered by a heartbeat. Connected through an agent mesh.',
  ctaText: 'npm install -g dorkos',
  ctaHref: 'https://www.npmjs.com/package/dorkos',
};

const variants = [
  {
    id: 1,
    title: 'Device Showcase — Floating Screens',
    description:
      'Desktop, tablet, and phone mockups floating in perspective, showing the DorkOS console. Emphasizes access from anywhere.',
    Component: lazyHero(() => import('./variants/h1-device-showcase'), 'HeroV1'),
  },
  {
    id: 2,
    title: 'Split Screen — Terminal + Browser',
    description:
      'Left side shows a terminal with the install command typing out. Right side shows a browser mockup with DorkOS UI. Conveys the CLI-to-web bridge.',
    Component: lazyHero(() => import('./variants/h2-split-terminal'), 'HeroV2'),
  },
  {
    id: 3,
    title: 'Globe + Connection Lines',
    description:
      'An SVG globe with animated connection arcs. "Access from anywhere" as the visual metaphor. Devices appear at arc endpoints.',
    Component: lazyHero(() => import('./variants/h3-globe-connections'), 'HeroV3'),
  },
  {
    id: 4,
    title: 'Typewriter Command Flow',
    description:
      'A terminal that types commands sequentially, showing the DorkOS workflow. Each step reveals with a satisfying animation. Conversion-focused with prominent CTA.',
    Component: lazyHero(() => import('./variants/h4-typewriter-flow'), 'HeroV4'),
  },
  {
    id: 5,
    title: 'Bento Grid Hero',
    description:
      'A bento-style grid layout with the headline in a large cell, product screenshot in another, device mockups in a third, and stats/badges in smaller cells.',
    Component: lazyHero(() => import('./variants/h5-bento-grid'), 'HeroV5'),
  },
  {
    id: 6,
    title: 'Traveling Laptop — Airport/Cafe Scene',
    description:
      'Illustrated scene of someone using DorkOS on a laptop at an airport or cafe, with agents working autonomously in the background. Storytelling approach.',
    Component: lazyHero(() => import('./variants/h6-travel-scene'), 'HeroV6'),
  },
  {
    id: 7,
    title: 'Animated Gradient + Large Typography',
    description:
      'Oversized headline with an animated gradient mesh background. Minimal, bold, typography-driven. Apple-style confidence.',
    Component: lazyHero(() => import('./variants/h7-gradient-typography'), 'HeroV7'),
  },
  {
    id: 8,
    title: 'Interactive Device Carousel',
    description:
      'Users can swipe/click between desktop, tablet, and mobile views of DorkOS. Each device shows a different feature. Interactive and engaging.',
    Component: lazyHero(() => import('./variants/h8-device-carousel'), 'HeroV8'),
  },
  {
    id: 9,
    title: 'Agent Activity Feed — Live Dashboard',
    description:
      'A simulated real-time feed showing agents working: "Agent committed 3 files", "Pulse executed roadmap step 4", etc. Creates FOMO — your AI could be doing this right now.',
    Component: lazyHero(() => import('./variants/h9-activity-feed'), 'HeroV9'),
  },
  {
    id: 10,
    title: 'Spotlight Headline + Product Video Placeholder',
    description:
      'Dramatic spotlight on the headline text, with a large product video/screenshot area below. Cinematic but conversion-optimized with CTA above the fold.',
    Component: lazyHero(() => import('./variants/h10-spotlight-cinematic'), 'HeroV10'),
  },
];

function HeroFallback() {
  return (
    <div className="text-warm-gray flex h-[60vh] animate-pulse items-center justify-center font-mono text-sm">
      Loading hero...
    </div>
  );
}

export default function HeroTestPage() {
  return (
    <div className="bg-cream-primary min-h-screen">
      {/* Header */}
      <div className="px-8 py-16 text-center">
        <span className="text-2xs text-brand-orange mb-4 block font-mono tracking-[0.15em] uppercase">
          Exploration
        </span>
        <h1 className="text-charcoal mb-6 text-[40px] leading-[1.0] font-semibold tracking-[-0.04em] md:text-[56px]">
          Hero Section Variants
        </h1>
        <p className="text-warm-gray mx-auto max-w-xl text-base leading-[1.7]">
          Ten different hero concepts exploring device showcases, typography, interactivity, and
          conversion strategies. All use the warm cream palette.
        </p>
      </div>

      {/* Variants */}
      <div className="mx-auto max-w-7xl space-y-32 px-8 pb-32">
        {variants.map((v) => (
          <section key={v.id} className="scroll-mt-8">
            {/* Variant label */}
            <div className="mb-8 flex items-baseline gap-4">
              <span className="text-3xs text-brand-orange font-mono tracking-[0.15em] uppercase">
                H{String(v.id).padStart(2, '0')}
              </span>
              <h2 className="text-charcoal text-[24px] font-semibold tracking-[-0.02em]">
                {v.title}
              </h2>
            </div>
            <p className="text-warm-gray mb-8 max-w-xl text-sm leading-[1.7]">{v.description}</p>

            {/* Hero container — simulates viewport */}
            <div className="bg-cream-primary overflow-hidden rounded-xl border border-[var(--border-warm)]">
              <Suspense fallback={<HeroFallback />}>
                <v.Component {...heroProps} />
              </Suspense>
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
