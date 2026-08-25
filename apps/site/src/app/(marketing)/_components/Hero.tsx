'use client';

import { Fragment, useRef } from 'react';
import { motion, useInView } from 'motion/react';
import { REVEAL, STAGGER } from '@/layers/features/marketing';
import { AgentCard } from './AgentCard';
import { CAST } from './cast';
import { DOWNLOAD, HERO, INSTALL_ASIDE } from './copy';
import { DownloadMacButton } from './DownloadMacButton';
import { Eyebrow } from './Eyebrow';
import { InstallCommand } from './InstallCommand';

/** The headline is two sentences and reads as two lines, one each. */
const HERO_LINES = HERO.title.split(/(?<=\.)\s+/);

/** The opening moment: the claim, the command, and your three agents floating. */
export function Hero({ joined }: { joined: boolean }) {
  const cardsRef = useRef<HTMLUListElement>(null);
  const cardsVisible = useInView(cardsRef);

  return (
    <header className="mx-auto flex max-w-5xl flex-col items-center px-6 pt-36 pb-16 text-center sm:pt-44 sm:pb-24">
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
          className="mt-5 text-[clamp(3rem,9vw,6.5rem)] leading-[0.95] font-semibold tracking-[-0.04em] text-balance text-(--cream)"
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
          className="mt-7 max-w-xl text-lg text-pretty text-(--cream-dim) sm:text-xl"
        >
          {HERO.lede}
        </motion.p>
        <motion.div variants={REVEAL} className="mt-9 flex flex-col items-center gap-3">
          <DownloadMacButton placement="home_hero" />
          <p className="text-2xs font-mono tracking-[0.15em] text-(--cream-dim) uppercase">
            {DOWNLOAD.terms}
          </p>
          <p className="mt-1 flex flex-wrap items-center justify-center gap-1 text-sm text-(--cream-dim)">
            {INSTALL_ASIDE} <InstallCommand variant="quiet" />
          </p>
        </motion.div>
        <motion.ul
          ref={cardsRef}
          variants={STAGGER}
          className="mt-16 flex list-none flex-wrap items-center justify-center gap-4 sm:mt-20"
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
    </header>
  );
}
