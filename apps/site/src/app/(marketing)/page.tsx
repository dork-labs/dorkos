import type { Metadata } from 'next';
import { rssFeedAlternateTypes, twitterFromOpenGraph } from '@/lib/metadata';
import { ExtensionNoiseGuard, HomeExperience, NIGHT_VARS, PageNav } from './_components';

const TITLE = 'DorkOS — All your agents. One place.';
const DESCRIPTION =
  'One home for every AI agent you run: Claude Code, Codex, and OpenCode. Talk to them like a team. Plug in your apps. It all happens on your computer.';

/**
 * The home page's own card, in place of the `(marketing)` layout's defaults.
 *
 * The title is `absolute` so the root layout's `%s | DorkOS` template does not
 * append a second DorkOS to a title that already opens with one.
 *
 * `openGraph` is re-declared in full rather than merged: Next shallow-merges
 * metadata, so naming the key here drops the layout's image list unless it is
 * repeated. The image stays the site's own generated card at
 * `/opengraph-image` — the promo video below ships its own artwork, and the
 * home page is not a campaign page.
 */
export const metadata: Metadata = {
  title: { absolute: TITLE },
  description: DESCRIPTION,
  alternates: { canonical: '/', types: rssFeedAlternateTypes },
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    url: '/',
    type: 'website',
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
 * dorkos.ai — one continuous, scroll-driven animation around a single live
 * chat: the agents fly in, the apps fly in, and the laptop forms around it.
 *
 * `overflow-anchor: none` is load-bearing — without it Chrome's scroll
 * anchoring compensates for each message the pinned chat appends and walks
 * the page down on its own.
 */
export default function HomePage() {
  return (
    <div
      style={NIGHT_VARS}
      className="min-h-screen overflow-x-clip bg-(--pitch) text-(--cream) antialiased [overflow-anchor:none] selection:bg-(--ember) selection:text-(--pitch)"
    >
      <ExtensionNoiseGuard />
      <PageNav />
      <main>
        <HomeExperience />
      </main>
    </div>
  );
}
