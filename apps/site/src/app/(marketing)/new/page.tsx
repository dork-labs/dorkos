import type { Metadata } from 'next';
import { siteConfig } from '@/config/site';
import { MarketingFooter } from '@/layers/features/marketing';
import { ExtensionNoiseGuard, FOOTER_SOCIAL_LINKS, HomeExperience, HomeNav } from './_components';

const TITLE = 'All your agents. One place.';
const DESCRIPTION = 'A work in progress: the next version of the DorkOS home page.';

/**
 * Deliberately not indexed, and deliberately plain.
 *
 * `/new` is an iteration page, not a published one: it is where the next home
 * page is being worked out, and it changes from day to day. `noindex,
 * nofollow` keeps a half-finished argument out of search results while it is
 * still an argument, and it is in no sitemap and linked from nowhere.
 *
 * `openGraph` is declared anyway, because the `(marketing)` layout's block is
 * written for `/` — inheriting it would put `og:url` of the published home
 * page on this one. No RSS `alternates.types` for the same reason: there is
 * nothing to subscribe to here. The published home page keeps its own
 * metadata and is untouched by this route.
 */
export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: '/new' },
  openGraph: { title: TITLE, description: DESCRIPTION, url: '/new', type: 'website' },
  robots: { index: false, follow: false },
};

/**
 * `/new` — the film leads.
 *
 * A hero half a screen tall, then the 56-second film at full width, then the
 * turn out of Dave's story into the visitor's: the cast steps out of the last
 * frame and into a pinned, scroll-driven chat that only ever shows things the
 * product ships. Watch him win, see it is real, get it.
 *
 * Navigation is this page's own fork of the site's floating pill. It keeps the
 * shared component's shape and its yield-while-you-read behaviour, and changes
 * what the entries are for: on a page that is one long scroll, a signpost to
 * eight other pages is the wrong instrument, so the pill steers this page's
 * own sections and folds the rest of the site behind "⋯". See `nav/HomeNav`
 * for the full divergence. The shared `MarketingNav` is untouched, and so is
 * every page that renders it.
 *
 * The page ends in the site's own footer, imported unmodified: the same logo,
 * the same links, and the same newsletter box every other page on dorkos.ai
 * ends with. A visitor who reads to the bottom of a home page is the visitor
 * most likely to want the mailing list, and a page that reinvents that ending
 * has to reinvent the box too.
 *
 * `overflow-anchor: none` is load-bearing — without it Chrome's scroll
 * anchoring compensates for each message the pinned chat appends and walks
 * the page down on its own.
 */
export default function NewHomePage() {
  return (
    <div className="bg-cream-primary text-charcoal selection:bg-brand-orange selection:text-cream-white min-h-screen overflow-x-clip antialiased [overflow-anchor:none]">
      <ExtensionNoiseGuard />
      <main>
        <HomeExperience />
      </main>
      <MarketingFooter email={siteConfig.contactEmail} socialLinks={FOOTER_SOCIAL_LINKS} />
      <HomeNav />
    </div>
  );
}
