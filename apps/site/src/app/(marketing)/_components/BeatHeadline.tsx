'use client';

import { motion } from 'motion/react';
import { BEAT_ORDER, type Beat } from './stage/beats';
import { BEATS } from './copy';
import { Eyebrow } from './Eyebrow';

/** How long one headline takes to fade, in seconds. */
const FADE = 0.3;

/** How far a headline sits from home while it is waiting or leaving, in pixels. */
const OFFSET = 18;

/**
 * Where a headline rests: home if it is the one on screen, below the line if
 * the scroll has not reached it, above it once it has been passed.
 */
function restingOffset(index: number, current: number): number {
  if (index === current) return 0;
  return index < current ? -OFFSET : OFFSET;
}

/**
 * The stage's headline, crossfading as the scroll moves between beats.
 *
 * All three are always in the document, and only their opacity moves. The
 * obvious shape — mount the one that is current and unmount the rest — put
 * two-thirds of the page's argument out of reach of anything that reads the
 * served HTML rather than scrolling it: a search engine, a model, a preview
 * card, a reader with scripting off. "Your files stay home" is one of the
 * three best sentences on this page and it never reached the document at all.
 *
 * The handoff still reads as a wait rather than a dissolve: the leaving
 * headline fades out first, and the arriving one starts a beat later, which is
 * what the delay below buys. A headline that has not been reached waits below
 * the line and one that is finished leaves above it, the same directions the
 * scroll is moving in.
 */
export function BeatHeadline({ beat }: { beat: Beat }) {
  const at = BEAT_ORDER.indexOf(beat);

  return (
    <div className="relative h-44 w-full">
      {BEAT_ORDER.map((each, index) => {
        const copy = BEATS[each];
        const current = index === at;
        return (
          <motion.div
            key={each}
            // `false` rather than a hidden state: the server renders whatever
            // `animate` says, so the served markup is the page as it looks,
            // and the first paint does not animate a headline nobody has
            // scrolled to yet.
            initial={false}
            animate={{ opacity: current ? 1 : 0, y: restingOffset(index, at) }}
            transition={{ duration: FADE, ease: 'easeOut', delay: current ? FADE : 0 }}
            // The two that are not current are still painted, so they are
            // hidden from a screen reader and cannot take a press or a
            // selection meant for the one on screen.
            aria-hidden={!current}
            className={`absolute inset-x-0 top-0 flex flex-col items-center text-center ${
              current ? '' : 'pointer-events-none select-none'
            }`}
          >
            <Eyebrow>{copy.eyebrow}</Eyebrow>
            <h2 className="text-charcoal mt-3 text-[clamp(2rem,4.5vw,3.25rem)] leading-none font-semibold tracking-[-0.03em] text-balance">
              {copy.title}
            </h2>
            <p className="text-warm-gray mt-3 max-w-xl text-base text-pretty sm:text-lg">
              {copy.lede}
            </p>
          </motion.div>
        );
      })}
    </div>
  );
}
