'use client';

import { motion } from 'motion/react';
import { REVEAL, STAGGER, VIEWPORT } from '@/layers/features/marketing';
import { Eyebrow } from '../Eyebrow';
import { PANEL } from '../film-tokens';
import { TutorialRail } from './TutorialRail';
import type { TutorialRailConfig } from './tutorials';

/**
 * The band the rail sits in.
 *
 * A slightly warmer, flatter charcoal than the film section's near-black room,
 * because it is a different room: the film band is Dave's cubicle with his own
 * plate behind it, and this one is the page's screening shelf. Same family,
 * not the same place.
 */
const BAND = {
  base: '#141210',
  text: '#fffefb',
  muted: 'rgba(255,254,251,0.55)',
} as const;

/**
 * The page's second dark band: a shelf of short clips.
 *
 * WHY DARK, on a page that is otherwise cream. Two reasons, and both are about
 * the reader rather than the palette. A row of 9:16 video frames is a screen,
 * and screens read on a dark ground the way pictures read on a gallery wall.
 * And the page needed a second beat of punctuation down here: hero, film,
 * bridge, stage, clips, features, questions, close is eight sections, and
 * without this the last four are one unbroken field of cream that a visitor
 * scrolls through rather than reads. The film band and this one bracket the
 * proof between them.
 *
 * The two edges are the film's own grammar. The top is a hard cut, marked by
 * the brand's orange rule, exactly as the film band's is. The bottom dissolves
 * back into the cream page, which is the lights coming up: what follows is the
 * page talking in its own voice again, not another screening.
 *
 * Every word and every tile arrives as one config object, because three
 * sibling pages re-theme this section under their own names and a section
 * whose copy lives in its components is a section re-themed in six files.
 *
 * @param config - The section's words, tiles and end card. See `tutorials.ts`.
 */
export function TutorialsSection({ config }: { config: TutorialRailConfig }) {
  return (
    <section
      id="tutorials"
      tabIndex={-1}
      aria-label={config.title}
      className="relative isolate overflow-hidden focus:outline-none"
      style={{ backgroundColor: BAND.base }}
    >
      <div
        aria-hidden="true"
        className="absolute inset-x-0 top-0 h-1.5"
        style={{ background: PANEL.hairline }}
      />

      <motion.div
        variants={STAGGER}
        initial="hidden"
        whileInView="visible"
        viewport={VIEWPORT}
        className="relative mx-auto max-w-6xl pt-20 pb-24 sm:pt-24 sm:pb-28"
      >
        <div className="px-6">
          <motion.div variants={REVEAL}>
            <Eyebrow>{config.eyebrow}</Eyebrow>
          </motion.div>
          <motion.h2
            variants={REVEAL}
            className="mt-3 text-[clamp(2rem,5vw,3.25rem)] leading-none font-semibold tracking-[-0.03em] text-balance"
            style={{ color: BAND.text }}
          >
            {config.title}
          </motion.h2>
          <motion.p
            variants={REVEAL}
            className="mt-4 max-w-md text-base text-pretty sm:text-lg"
            style={{ color: BAND.muted }}
          >
            {config.lede}
          </motion.p>
        </div>

        <motion.div variants={REVEAL} className="mt-10 sm:mt-12">
          <TutorialRail config={config} />
        </motion.div>
      </motion.div>

      {/* The dissolve out. See the note above: the top edge cuts, this one fades. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 bottom-0 h-24"
        style={{ background: 'linear-gradient(to bottom, transparent, var(--cream-primary))' }}
      />
    </section>
  );
}
