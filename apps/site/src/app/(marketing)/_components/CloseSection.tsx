'use client';

import Link from 'next/link';
import { motion } from 'motion/react';
import { siteConfig } from '@/config/site';
import { REVEAL, STAGGER, VIEWPORT } from '@/layers/features/marketing';
import { DownloadMacButton } from './DownloadMacButton';
import { InstallCommand } from './InstallCommand';

/** The close: the tagline, the command, and a one-line footer. */
export function CloseSection() {
  return (
    <footer className="mx-auto max-w-5xl px-6 pt-24 pb-16 sm:pt-36">
      <motion.div
        variants={STAGGER}
        initial="hidden"
        whileInView="visible"
        viewport={VIEWPORT}
        className="flex flex-col items-center text-center"
      >
        <motion.h2
          variants={REVEAL}
          className="text-[clamp(3rem,10vw,7.5rem)] leading-[0.95] font-semibold tracking-[-0.04em] text-balance text-(--cream)"
        >
          You, multiplied.
        </motion.h2>
        <motion.p variants={REVEAL} className="mt-6 text-lg text-(--cream-dim) sm:text-xl">
          We built it for ourselves. Now it&rsquo;s yours.
        </motion.p>
        <motion.div variants={REVEAL} className="mt-10 flex flex-col items-center gap-3">
          <DownloadMacButton />
          <p className="flex flex-wrap items-center justify-center gap-1 text-sm text-(--cream-dim)">
            or run <InstallCommand variant="quiet" />
          </p>
        </motion.div>
        <motion.p
          variants={REVEAL}
          className="text-2xs mt-5 font-mono tracking-[0.15em] text-(--cream-dim) uppercase"
        >
          <Link href="/install" className="hover:text-(--cream)">
            other ways to install
          </Link>
          {' · '}
          <Link href="/docs" className="hover:text-(--cream)">
            read the docs
          </Link>
        </motion.p>
      </motion.div>
      <div className="text-2xs mt-24 border-t border-(--line) pt-6 text-center font-mono tracking-[0.15em] text-(--cream-dim) uppercase">
        dorkos · open source, mit ·{' '}
        <a href={siteConfig.github} className="hover:text-(--cream)">
          github
        </a>
      </div>
    </footer>
  );
}
