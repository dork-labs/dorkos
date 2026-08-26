'use client';

import { motion, useReducedMotion, type MotionValue } from 'motion/react';
import { BEAT_ORDER } from '../beats';
import { BEATS } from '../copy';

interface StageStepsProps {
  /** Which step the reader is standing in, counting from zero. */
  index: number;
  /**
   * How far through that step they are, 0–1. A motion value, so the scroll
   * drives the rail on the compositor rather than through a React render.
   */
  within: MotionValue<number>;
}

/**
 * The rail's own colours, so the lit and unlit states are decided in one place.
 *
 * The numerals are charcoal on both grounds rather than the white the site's
 * orange buttons carry. Measured in the browser: white on the brand orange is
 * 3.3:1, which is fine on a 15px bubble and not fine on a 9px numeral, and
 * charcoal on the same orange is 5.0:1. The unlit numeral is the site's
 * `warm-gray` for the same reason — the dimmer grey next to it measured 3.2:1
 * against this track.
 */
const RAIL = {
  lit: '#e85d04',
  done: 'rgba(232, 93, 4, 0.45)',
  track: 'rgba(26, 24, 20, 0.12)',
  numeral: '#1a1814',
  numeralDim: '#4a4640',
} as const;

/**
 * Where am I, and how much is left.
 *
 * The complaint this answers is that a pinned stage gives a visitor no idea
 * where they are inside it. A headline that crossfades tells you what beat you
 * are in only if you happen to be looking when it changes, and it never tells
 * you how many are left. So: three numbered steps, each named, the one you are
 * in lit, and under each a rail that fills as you move through that beat.
 * Steps behind you stay filled. Both facts are then readable at any instant
 * without waiting for anything.
 *
 * The names are the beats' own eyebrows rather than their headlines. The
 * headline is already on screen, two lines below, at four times the size;
 * repeating it here would be the same words twice, and "It all happens on
 * your computer." does not fit a 390px row three times over.
 *
 * The steps are a readout and not a control. The stage is steered by
 * scrolling, and every pixel between two beats is a frame of the animation, so
 * a button offering to jump would be offering a cut the stage cannot make.
 *
 * The pulse on the lit number is the beat boundary made perceptible — the
 * click as the stage changes gear, for anyone who scrolled past the crossfade
 * without noticing it. It is the only thing here that moves on its own, so it
 * is the only thing reduced motion removes.
 */
export function StageSteps({ index, within }: StageStepsProps) {
  const reduced = useReducedMotion();

  return (
    <nav aria-label="Stage steps" className="w-full max-w-md">
      <ol className="flex list-none items-start gap-2">
        {BEAT_ORDER.map((beat, i) => {
          const state = i < index ? 'done' : i === index ? 'current' : 'todo';
          const fill = state === 'done' ? 1 : state === 'current' ? within : 0;
          const label = BEATS[beat].eyebrow;

          return (
            <li key={beat} className="min-w-0 flex-1">
              <span aria-current={state === 'current' ? 'step' : undefined} className="block">
                <span className="sr-only">{`Step ${i + 1} of 3: ${BEATS[beat].title}`}</span>
                <span aria-hidden="true" className="block">
                  <span className="flex items-center gap-1.5">
                    <motion.span
                      // Remounts on every boundary, which is what replays the pulse.
                      key={state === 'current' ? 'lit' : 'unlit'}
                      initial={{ scale: 1 }}
                      animate={
                        state === 'current' && !reduced ? { scale: [1, 1.22, 1] } : { scale: 1 }
                      }
                      transition={{ duration: 0.42, ease: 'easeOut' }}
                      className="text-3xs grid size-4 shrink-0 place-items-center rounded-full font-mono"
                      style={{
                        backgroundColor: state === 'todo' ? RAIL.track : RAIL.lit,
                        color: state === 'todo' ? RAIL.numeralDim : RAIL.numeral,
                      }}
                    >
                      {i + 1}
                    </motion.span>
                    <span
                      className={`text-3xs truncate font-mono tracking-[0.14em] uppercase ${
                        state === 'current' ? 'text-charcoal' : 'text-warm-gray-light'
                      }`}
                    >
                      {label}
                    </span>
                  </span>
                  <span
                    className="mt-1.5 block h-[3px] w-full overflow-hidden rounded-full"
                    style={{ backgroundColor: RAIL.track }}
                  >
                    <motion.span
                      className="block h-full w-full origin-left rounded-full"
                      style={{
                        scaleX: fill,
                        backgroundColor: state === 'done' ? RAIL.done : RAIL.lit,
                      }}
                    />
                  </span>
                </span>
              </span>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
