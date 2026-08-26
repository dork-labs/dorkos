import type { Metadata } from 'next';
import { siteConfig } from '@/config/site';
import { FOOTER_SOCIAL_LINKS, MarketingFooter } from '@/layers/features/marketing';
import { rssFeedAlternateTypes, twitterFromOpenGraph } from '@/lib/metadata';
import { HomeExperience, HomeNav } from './_components';

const TITLE = 'DorkOS — All your agents. One place.';
const DESCRIPTION =
  'One place for every AI agent you run: Claude Code, Codex, and OpenCode. Put them on a schedule, get a message when they finish, and keep everything on your own computer. Open source, MIT.';

/**
 * The home page's own metadata, declared here rather than inherited.
 *
 * `title.absolute` skips the root layout's `%s | DorkOS` template — the title
 * already says DorkOS, and letting the template run appends it a second time.
 *
 * `openGraph` is re-declared in full: image list, site name and locale
 * included. Next shallow-merges metadata, so naming the key at all replaces
 * the root layout's block outright — an `openGraph` that omits `images` ships
 * the home page with no card picture, and one that omits `siteName` ships the
 * site's most-shared URL as the only page whose card does not say what site it
 * is from. Same reason `alternates.types` repeats the RSS feed —
 * setting `alternates` here replaces the layout's, and the feed link would
 * vanish from the one page most likely to be subscribed from.
 */
export const metadata: Metadata = {
  title: { absolute: TITLE },
  description: DESCRIPTION,
  alternates: { canonical: '/', types: rssFeedAlternateTypes },
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    url: siteConfig.url,
    type: 'website',
    siteName: siteConfig.name,
    locale: 'en_US',
    images: [
      {
        url: '/opengraph-image',
        width: 1200,
        height: 630,
        alt: 'DorkOS: one place for every AI agent you run',
      },
    ],
  },
  twitter: twitterFromOpenGraph({ title: TITLE, description: DESCRIPTION }),
};

/**
 * `/` — the film leads.
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
export default function HomePage() {
  return (
    <div className="bg-cream-primary text-charcoal selection:bg-brand-orange selection:text-cream-white min-h-screen overflow-x-clip antialiased [overflow-anchor:none]">
      <main>
        <HomeExperience />
      </main>
      <MarketingFooter email={siteConfig.contactEmail} socialLinks={FOOTER_SOCIAL_LINKS} />
      <HomeNav />
    </div>
  );
}
