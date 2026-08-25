import type { Metadata } from 'next';
import { MarketingNav, NAV_LINKS } from '@/layers/features/marketing';
import { ExtensionNoiseGuard, HomeExperience } from './_components';

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
 * `/new` — one continuous, scroll-driven animation around a single live chat:
 * the agents fly in, the things you add fly in, and the laptop forms around
 * it. The promo film sits between the animation and the close.
 *
 * Navigation is the site's own floating pill, unchanged: it already yields
 * while you read downward and comes back when you scroll up, which is exactly
 * what a page built around one long scroll needs.
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
      <MarketingNav links={NAV_LINKS} />
    </div>
  );
}
