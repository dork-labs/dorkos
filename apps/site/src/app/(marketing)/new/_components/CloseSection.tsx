'use client';

import Link from 'next/link';
import { motion } from 'motion/react';
import { siteConfig } from '@/config/site';
import { REVEAL, STAGGER, VIEWPORT } from '@/layers/features/marketing';
import { CLOSE, INSTALL_ASIDE, NPX_REQUIREMENT } from './copy';
import { DownloadMacButton } from './DownloadMacButton';
import { InstallCommand } from './InstallCommand';

/**
 * The close: the tagline, the download, the bill, and a one-line colophon.
 *
 * It carries no list of site sections. The floating pill does that, on every
 * screen of the page, so a second copy down here would only repeat it.
 */
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
          className="text-charcoal text-[clamp(3rem,10vw,7.5rem)] leading-[0.95] font-semibold tracking-[-0.04em] text-balance"
        >
          {CLOSE.title}
        </motion.h2>
        <motion.p variants={REVEAL} className="text-warm-gray mt-6 text-lg sm:text-xl">
          {CLOSE.lede}
        </motion.p>
        <motion.div variants={REVEAL} className="mt-10 flex flex-col items-center gap-3">
          <DownloadMacButton placement="preview_close" />
          <p className="text-warm-gray flex flex-wrap items-center justify-center gap-1 text-sm">
            {INSTALL_ASIDE} <InstallCommand variant="quiet" />
            <span className="text-2xs font-mono tracking-[0.1em] uppercase">{NPX_REQUIREMENT}</span>
          </p>
        </motion.div>
        <motion.p variants={REVEAL} className="text-warm-gray mt-6 max-w-md text-sm text-pretty">
          {CLOSE.cost}
        </motion.p>
        <motion.p
          variants={REVEAL}
          className="text-2xs text-warm-gray mt-5 font-mono tracking-[0.15em] uppercase"
        >
          <Link href="/install" className="hover:text-charcoal">
            {CLOSE.otherWays}
          </Link>
        </motion.p>
      </motion.div>
      <div className="text-2xs border-border-warm text-warm-gray mt-24 border-t pt-6 text-center font-mono tracking-[0.15em] uppercase">
        {CLOSE.colophon}{' '}
        <a href={siteConfig.github} className="hover:text-charcoal">
          github
        </a>
      </div>
    </footer>
  );
}
