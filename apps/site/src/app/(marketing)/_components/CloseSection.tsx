'use client';

import Link from 'next/link';
import { motion } from 'motion/react';
import { siteConfig } from '@/config/site';
import { AWAY_FROM_HOME_LINKS, REVEAL, STAGGER, VIEWPORT } from '@/layers/features/marketing';
import { CLOSE, INSTALL_ASIDE } from './copy';
import { DownloadMacButton } from './DownloadMacButton';
import { InstallCommand } from './InstallCommand';

/**
 * The close: the tagline, the command, and a one-line footer.
 *
 * The footer row is the home page's only path to the rest of the site, and it
 * is derived from the shared destination list rather than typed out again, so
 * a page added to the site menu cannot go missing here.
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
          className="text-[clamp(3rem,10vw,7.5rem)] leading-[0.95] font-semibold tracking-[-0.04em] text-balance text-(--cream)"
        >
          {CLOSE.title}
        </motion.h2>
        <motion.p variants={REVEAL} className="mt-6 text-lg text-(--cream-dim) sm:text-xl">
          {CLOSE.lede}
        </motion.p>
        <motion.div variants={REVEAL} className="mt-10 flex flex-col items-center gap-3">
          <DownloadMacButton placement="home_close" />
          <p className="flex flex-wrap items-center justify-center gap-1 text-sm text-(--cream-dim)">
            {INSTALL_ASIDE} <InstallCommand variant="quiet" />
          </p>
        </motion.div>
        <motion.p
          variants={REVEAL}
          className="text-2xs mt-5 font-mono tracking-[0.15em] text-(--cream-dim) uppercase"
        >
          <Link href="/install" className="hover:text-(--cream)">
            {CLOSE.otherWays}
          </Link>
        </motion.p>
      </motion.div>
      <nav
        aria-label="Site sections"
        className="text-2xs mt-20 flex flex-wrap justify-center gap-x-5 gap-y-2 font-mono tracking-[0.15em] text-(--cream-dim) uppercase"
      >
        {AWAY_FROM_HOME_LINKS.map((link) => (
          <Link key={link.href} href={link.href} className="hover:text-(--cream)">
            {link.label}
          </Link>
        ))}
      </nav>
      <div className="text-2xs mt-8 border-t border-(--line) pt-6 text-center font-mono tracking-[0.15em] text-(--cream-dim) uppercase">
        {CLOSE.colophon}{' '}
        <a href={siteConfig.github} className="hover:text-(--cream)">
          github
        </a>
      </div>
    </footer>
  );
}
