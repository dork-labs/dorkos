'use client';

import { motion } from 'motion/react';
import { REVEAL, STAGGER, VIEWPORT } from '@/layers/features/marketing';
import { FILM, FILM_TURN } from '../copy';
import { Eyebrow } from '../Eyebrow';
import { PANEL, ROOM } from './film-tokens';
import { PromoPlayer } from './PromoPlayer';
import { ROOM_PLATE } from './promo-cuts';

/**
 * The film, second on the page and treated as the main event.
 *
 * The whole bet of this page is here. The 56 seconds are the strongest thing
 * the product has, and a film buried under six screens of argument is a film
 * nobody presses. So it sits one scroll under the headline, where the visitor
 * still has patience, and the page spends its best real estate on it.
 *
 * The section goes dark and full width on purpose: it is a hard cut out of the
 * cream page into Dave's world, the same grammar the film uses for six of its
 * seven transitions. The backdrop is the film's own cubicle plate under its own
 * two gradients, so the band is not a stylized guess at 1999 but the exact room
 * the story happens in. What stays out of it is the product: the retro lives in
 * this section's framing and photography and nowhere near the chat below, since
 * the moment the app looks period the page argues that the software is old.
 *
 * The brand's orange rule appears twice here, at the top edge and under the
 * player, which is the signature's own rule in the video tokens.
 */
export function FilmSection() {
  return (
    <section
      id="film"
      tabIndex={-1}
      className="relative isolate overflow-hidden focus:outline-none"
      style={{ backgroundColor: ROOM.base }}
      aria-label="The film"
    >
      <div
        aria-hidden="true"
        className="absolute inset-0 bg-cover bg-center"
        style={{ backgroundImage: `url(${ROOM_PLATE})`, opacity: ROOM.plateOpacity }}
      />
      <div aria-hidden="true" className="absolute inset-0" style={{ background: ROOM.glow }} />
      <div aria-hidden="true" className="absolute inset-0" style={{ background: ROOM.vignette }} />
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
        // Deliberately top-light and bottom-heavy. The band is entered from a
        // bright page, so "Meet Dave." has to clear the fold on a laptop or the
        // hook is a scroll away; the air belongs under the turn line instead.
        className="relative mx-auto flex max-w-6xl flex-col items-center px-6 pt-14 pb-20 text-center sm:pt-16 sm:pb-28"
      >
        <motion.div variants={REVEAL}>
          <Eyebrow>{FILM.eyebrow}</Eyebrow>
        </motion.div>
        <motion.h2
          variants={REVEAL}
          className="mt-4 text-[clamp(2.5rem,7vw,4.5rem)] leading-[0.95] font-semibold tracking-[-0.03em] text-balance"
          style={{ color: ROOM.text }}
        >
          {FILM.title}
        </motion.h2>
        <motion.p
          variants={REVEAL}
          className="mt-3 text-lg sm:text-xl"
          style={{ color: ROOM.muted }}
        >
          {FILM.lede}
        </motion.p>

        <motion.div variants={REVEAL} className="mt-10 w-full sm:mt-12">
          <PromoPlayer />
        </motion.div>

        <motion.div variants={REVEAL} className="mt-10 flex flex-col items-center sm:mt-12">
          <span
            aria-hidden="true"
            className="h-1 w-24 rounded-full"
            style={{ background: PANEL.hairline }}
          />
          <p
            className="mt-5 text-[clamp(1.5rem,3.5vw,2.25rem)] leading-tight font-semibold tracking-[-0.02em] text-balance"
            style={{ color: ROOM.text }}
          >
            {FILM_TURN}
          </p>
        </motion.div>
      </motion.div>
    </section>
  );
}
