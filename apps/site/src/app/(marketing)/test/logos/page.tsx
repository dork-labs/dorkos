'use client';

import { Suspense, lazy, type ComponentType } from 'react';

function lazyLogo(loader: () => Promise<{ [key: string]: ComponentType }>, exportName: string) {
  return lazy(() =>
    loader()
      .then((mod) => ({ default: mod[exportName] }))
      .catch(() => ({
        default: () => (
          <div className="text-warm-gray flex h-32 items-center justify-center font-mono text-sm">
            Loading...
          </div>
        ),
      }))
  );
}

const variants = [
  {
    id: 1,
    title: 'Stencil Block',
    description: 'Heavy stencil-cut letterforms with industrial gaps.',
    Component: lazyLogo(() => import('./variants/l01-stencil-block'), 'Logo01'),
  },
  {
    id: 2,
    title: 'Pixel Grid',
    description: 'Pixel-art style on a visible grid. Retro computing aesthetic.',
    Component: lazyLogo(() => import('./variants/l02-pixel-grid'), 'Logo02'),
  },
  {
    id: 3,
    title: 'Isometric Stack',
    description: '3D isometric letterforms with depth and shadow.',
    Component: lazyLogo(() => import('./variants/l03-isometric'), 'Logo03'),
  },
  {
    id: 4,
    title: 'Circuit Trace',
    description: 'PCB trace paths forming the letters with solder pad terminals.',
    Component: lazyLogo(() => import('./variants/l04-circuit'), 'Logo04'),
  },
  {
    id: 5,
    title: 'Brutalist Slab',
    description: 'Oversized, unapologetic slab type. Raw concrete energy.',
    Component: lazyLogo(() => import('./variants/l05-brutalist'), 'Logo05'),
  },
  {
    id: 6,
    title: 'Terminal Cursor',
    description: 'Monospace terminal type with a blinking block cursor.',
    Component: lazyLogo(() => import('./variants/l06-terminal'), 'Logo06'),
  },
  {
    id: 7,
    title: 'Glitch Slice',
    description: 'Clean type with horizontal slice displacements.',
    Component: lazyLogo(() => import('./variants/l07-glitch'), 'Logo07'),
  },
  {
    id: 8,
    title: 'Maze Paths',
    description: 'Letters formed from maze-like right-angle corridors.',
    Component: lazyLogo(() => import('./variants/l08-maze'), 'Logo08'),
  },
  {
    id: 9,
    title: 'Stacked Bars',
    description: 'Letters built from horizontal bars at varying widths.',
    Component: lazyLogo(() => import('./variants/l09-bars'), 'Logo09'),
  },
  {
    id: 10,
    title: 'Diamond Cut',
    description: 'Angular faceted letterforms with diagonal cuts.',
    Component: lazyLogo(() => import('./variants/l10-diamond'), 'Logo10'),
  },
  {
    id: 11,
    title: 'Dot Matrix',
    description: 'LED dot-matrix display style with rounded squares.',
    Component: lazyLogo(() => import('./variants/l11-dotmatrix'), 'Logo11'),
  },
  {
    id: 12,
    title: 'Negative Space',
    description: 'Letters revealed through cuts in a solid black rectangle.',
    Component: lazyLogo(() => import('./variants/l12-negative'), 'Logo12'),
  },
  {
    id: 13,
    title: 'Modular Grid',
    description: 'Letters composed of square modules on a strict grid.',
    Component: lazyLogo(() => import('./variants/l13-modular'), 'Logo13'),
  },
  {
    id: 14,
    title: 'Sharp Angles',
    description: 'Ultra-angular with 45-degree cuts on every corner.',
    Component: lazyLogo(() => import('./variants/l14-angles'), 'Logo14'),
  },
  {
    id: 15,
    title: 'Inline Split',
    description: 'Bold type with a horizontal inline channel through each letter.',
    Component: lazyLogo(() => import('./variants/l15-inline'), 'Logo15'),
  },
  {
    id: 16,
    title: 'Tetromino',
    description: 'Letters built from Tetris-like block arrangements.',
    Component: lazyLogo(() => import('./variants/l16-tetromino'), 'Logo16'),
  },
  {
    id: 17,
    title: 'Crosshatch',
    description: 'Letters filled with architectural crosshatch patterns.',
    Component: lazyLogo(() => import('./variants/l17-crosshatch'), 'Logo17'),
  },
  {
    id: 18,
    title: 'Layered Offset',
    description: 'Multiple offset copies creating depth and motion.',
    Component: lazyLogo(() => import('./variants/l18-offset'), 'Logo18'),
  },
  {
    id: 19,
    title: 'Monolith',
    description: 'Single continuous path forming all letters. One stroke, no breaks.',
    Component: lazyLogo(() => import('./variants/l19-monolith'), 'Logo19'),
  },
  {
    id: 20,
    title: 'Fragmented',
    description: 'Letters broken into geometric shards with small gaps between.',
    Component: lazyLogo(() => import('./variants/l20-fragmented'), 'Logo20'),
  },
];

function LogoFallback() {
  return (
    <div className="text-warm-gray flex h-32 animate-pulse items-center justify-center font-mono text-sm">
      Loading logo...
    </div>
  );
}

export default function LogoTestPage() {
  return (
    <div className="bg-cream-primary min-h-screen">
      {/* Header */}
      <div className="px-8 py-16 text-center">
        <span className="text-2xs text-brand-orange mb-4 block font-mono tracking-[0.15em] uppercase">
          Exploration
        </span>
        <h1 className="text-charcoal mb-6 text-[40px] leading-[1.0] font-semibold tracking-[-0.04em] md:text-[56px]">
          Logo Variants
        </h1>
        <p className="text-warm-gray mx-auto max-w-xl text-base leading-[1.7]">
          Twenty vector logo concepts for DorkOS. Solid black, blocky and angular. Text options:
          DORK, DorkOS, or DOS.
        </p>
      </div>

      {/* Logo grid — 2 columns on desktop, 1 on mobile */}
      <div className="mx-auto grid max-w-6xl grid-cols-1 gap-12 px-8 pb-32 md:grid-cols-2">
        {variants.map((v) => (
          <section key={v.id} className="scroll-mt-8">
            {/* Variant label */}
            <div className="mb-4 flex items-baseline gap-3">
              <span className="text-3xs text-brand-orange font-mono tracking-[0.15em] uppercase">
                L{String(v.id).padStart(2, '0')}
              </span>
              <h2 className="text-charcoal text-[18px] font-semibold tracking-[-0.02em]">
                {v.title}
              </h2>
            </div>
            <p className="text-warm-gray mb-4 text-sm leading-[1.7]">{v.description}</p>

            {/* Logo container */}
            <div className="bg-cream-white flex min-h-[200px] items-center justify-center overflow-hidden rounded-xl border border-[var(--border-warm)] p-8">
              <Suspense fallback={<LogoFallback />}>
                <v.Component />
              </Suspense>
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
