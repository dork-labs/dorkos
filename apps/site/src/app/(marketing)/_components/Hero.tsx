'use client';

import { useRef } from 'react';
import { motion, useInView } from 'motion/react';
import { REVEAL, STAGGER } from '@/layers/features/marketing';
import { AgentCard } from './AgentCard';
import { DownloadMacButton } from './DownloadMacButton';
import { Eyebrow } from './Eyebrow';
import { CAST } from './cast';
import { InstallCommand } from './InstallCommand';

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
          <Eyebrow>claude code · codex · opencode</Eyebrow>
        </motion.div>
        <motion.h1
          variants={REVEAL}
          className="mt-5 text-[clamp(3rem,9vw,6.5rem)] leading-[0.95] font-semibold tracking-[-0.04em] text-balance text-(--cream)"
        >
          All your agents.
          <br />
          One place.
        </motion.h1>
        <motion.p
          variants={REVEAL}
          className="mt-7 max-w-xl text-lg text-pretty text-(--cream-dim) sm:text-xl"
        >
          DorkOS puts every AI agent you run in one window. Watch them work. Step in when you want.
        </motion.p>
        <motion.div variants={REVEAL} className="mt-9 flex flex-col items-center gap-3">
          <DownloadMacButton placement="home_hero" />
          <p className="text-2xs font-mono tracking-[0.15em] text-(--cream-dim) uppercase">
            free · open source · apple silicon
          </p>
          <p className="mt-1 flex flex-wrap items-center justify-center gap-1 text-sm text-(--cream-dim)">
            or run <InstallCommand variant="quiet" />
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
