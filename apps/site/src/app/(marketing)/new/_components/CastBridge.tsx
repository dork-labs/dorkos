'use client';

import { useRef } from 'react';
import Image from 'next/image';
import { motion, useInView } from 'motion/react';
import { REVEAL, STAGGER, VIEWPORT } from '@/layers/features/marketing';
import { AgentCard } from './AgentCard';
import { CAST } from './cast';
import { BRIDGE } from './copy';
import { Eyebrow } from './Eyebrow';
import { HANDOFF_STILL } from './promo-cuts';

/**
 * Where the film ends and the product starts.
 *
 * The page has just spent 56 seconds on a man who is not the visitor, so this
 * section turns the camera around. The heading is the approved line's first
 * half, which is the sentence that does the turning: it is the first time the
 * page says "you" after a story told entirely in the third person.
 *
 * Underneath, the film's own frame of the same four faces fades out at its
 * lower edge, and the three agent cards sit across that fade — the cast
 * stepping out of the picture and onto the page. From here they are live: each
 * card carries the runtime actually behind it, and each face holds the shared
 * layout id that flies it into the chat in the section below. That flight is
 * the join: the visitor watches the same three agents leave the film and
 * arrive in a room they can scroll.
 *
 * The still is a frame of the film, not a screenshot of the app, and it is the
 * last retro thing on the page. Everything below it is the product as it is.
 */
export function CastBridge({ joined }: { joined: boolean }) {
  const cardsRef = useRef<HTMLUListElement>(null);
  const cardsVisible = useInView(cardsRef);

  return (
    <section className="mx-auto max-w-3xl px-6 pt-20 pb-4 sm:pt-28">
      <motion.div
        variants={STAGGER}
        initial="hidden"
        whileInView="visible"
        viewport={VIEWPORT}
        className="flex flex-col items-center text-center"
      >
        <motion.div variants={REVEAL}>
          <Eyebrow>{BRIDGE.eyebrow}</Eyebrow>
        </motion.div>
        <motion.h2
          variants={REVEAL}
          className="text-charcoal mt-3 text-[clamp(2rem,5vw,3.25rem)] leading-none font-semibold tracking-[-0.03em] text-balance"
        >
          {BRIDGE.title}
        </motion.h2>
        <motion.p
          variants={REVEAL}
          className="text-warm-gray mt-4 text-base text-pretty sm:text-lg"
        >
          {BRIDGE.lede}
        </motion.p>

        <motion.div variants={REVEAL} className="mt-12 w-full">
          {/*
            The mask is the dissolve. The film cuts hard six times and dissolves
            exactly once, into the beat where a dark panel has to become a bright
            room, "because a straight cut between those two reads as the film
            breaking". This is that same join, and it gets the same treatment.
          */}
          <Image
            src={HANDOFF_STILL.src}
            alt={HANDOFF_STILL.alt}
            width={HANDOFF_STILL.width}
            height={HANDOFF_STILL.height}
            sizes="(max-width: 768px) 100vw, 768px"
            priority={false}
            className="h-auto w-full rounded-2xl [mask-image:linear-gradient(to_bottom,#000_0%,#000_58%,transparent_100%)]"
          />
        </motion.div>

        <motion.ul
          ref={cardsRef}
          variants={STAGGER}
          className="-mt-14 flex list-none flex-wrap items-center justify-center gap-3 sm:-mt-20 sm:gap-4"
        >
          {CAST.map((agent, i) => (
            <AgentCard
              key={agent.key}
              agent={agent}
              index={i}
              joined={joined}
              floating={cardsVisible}
            />
          ))}
        </motion.ul>
      </motion.div>
    </section>
  );
}
