'use client';

import { Fragment } from 'react';
import { motion } from 'motion/react';
import { REVEAL, STAGGER } from '@/layers/features/marketing';
import { DOWNLOAD, HERO, INSTALL_ASIDE, NPX_REQUIREMENT } from './copy';
import { DownloadMacButton } from './DownloadMacButton';
import { Eyebrow } from './Eyebrow';
import { InstallCommand } from './InstallCommand';

/** The headline is two sentences and reads as two lines, one each. */
const HERO_LINES = HERO.title.split(/(?<=\.)\s+/);

/**
 * The claim and the button, and then out of the way.
 *
 * This hero is deliberately about half a screen tall, because the strongest
 * thing this page owns is the film directly beneath it, and a hero that fills
 * the viewport is a hero that hides it. Everything a visitor needs in order to
 * leave happy is here — what it is, and how to get it — and everything that
 * argues for it is below.
 *
 * The cast lives further down, in the hand-off out of the film, so the agents
 * are introduced by the story rather than by a row of cards nobody has been
 * given a reason to care about yet.
 */
export function Hero() {
  return (
    <header className="mx-auto flex max-w-4xl flex-col items-center px-6 pt-28 pb-10 text-center sm:pt-32 sm:pb-12">
      <motion.div
        variants={STAGGER}
        initial="hidden"
        animate="visible"
        className="flex w-full flex-col items-center"
      >
        <motion.div variants={REVEAL}>
          <Eyebrow>{HERO.eyebrow}</Eyebrow>
        </motion.div>
        <motion.h1
          variants={REVEAL}
          className="text-charcoal mt-4 text-[clamp(2.75rem,8vw,5.5rem)] leading-[0.95] font-semibold tracking-[-0.04em] text-balance"
        >
          {HERO_LINES.map((line, i) => (
            <Fragment key={line}>
              {i > 0 && <br />}
              {line}
            </Fragment>
          ))}
        </motion.h1>
        <motion.p
          variants={REVEAL}
          className="text-warm-gray mt-5 max-w-lg text-lg text-pretty sm:text-xl"
        >
          {HERO.lede}
        </motion.p>
        <motion.div variants={REVEAL} className="mt-8 flex flex-col items-center gap-3">
          <DownloadMacButton placement="hero" />
          <p className="text-2xs text-warm-gray font-mono tracking-[0.15em] uppercase">
            {DOWNLOAD.terms}
          </p>
          <p className="text-warm-gray mt-1 flex flex-wrap items-center justify-center gap-1 text-sm">
            {INSTALL_ASIDE} <InstallCommand variant="quiet" />
            <span className="text-2xs font-mono tracking-[0.1em] uppercase">{NPX_REQUIREMENT}</span>
          </p>
        </motion.div>
      </motion.div>
    </header>
  );
}
