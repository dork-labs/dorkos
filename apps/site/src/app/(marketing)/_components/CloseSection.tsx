'use client';

import Link from 'next/link';
import { motion } from 'motion/react';
import { REVEAL, STAGGER, VIEWPORT } from '@/layers/features/marketing';
import { CLOSE, INSTALL_ASIDE, NPX_REQUIREMENT } from './copy';
import { DownloadMacButton } from './DownloadMacButton';
import { InstallCommand } from './InstallCommand';

/**
 * The close: the tagline, the download, and the bill.
 *
 * It is a section, not a footer. The site's own `MarketingFooter` follows it
 * on this page and that is the page's one footer — a landmark repeated twice
 * is a landmark that means nothing, and the second copy was repeating the
 * source link the real footer already carries.
 *
 * What did not survive that footer is the Marketplace, which the site footer
 * does not list, so it stays here on the close's own quiet line. It moved out
 * of the pill when the pill started steering this page's sections: browsing
 * packages is somewhere you go once you already run DorkOS, which puts it at
 * the end of the page rather than in the reading path. It is still one press
 * away from every screen, in the pill's overflow menu.
 */
export function CloseSection() {
  return (
    <section className="mx-auto max-w-5xl px-6 pt-24 pb-16 sm:pt-36">
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
          <DownloadMacButton placement="close" />
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
          className="text-2xs text-warm-gray mt-5 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 font-mono tracking-[0.15em] uppercase"
        >
          <Link href="/install" className="hover:text-charcoal">
            {CLOSE.otherWays}
          </Link>
          <span aria-hidden="true">·</span>
          <Link href="/marketplace" className="hover:text-charcoal">
            {CLOSE.marketplace}
          </Link>
        </motion.p>
      </motion.div>
    </section>
  );
}
