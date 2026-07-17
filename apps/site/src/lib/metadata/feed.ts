/**
 * @module lib/metadata/feed
 *
 * The RSS feed autodiscovery alternate, shared so every segment that sets its
 * own `alternates` can advertise the feed. Next.js shallow-merges metadata: a
 * segment that defines `alternates` overwrites the parent's `alternates`
 * wholesale (it is not deep-merged), so the feed link must be attached at every
 * segment that declares `alternates` — the root layout, the marketing layout,
 * and the blog index and post pages — not only once at the root.
 */
import type { Metadata } from 'next';

/** The blog RSS feed, served by `app/blog/feed.xml/route.ts`. */
export const RSS_FEED_PATH = '/blog/feed.xml';

/**
 * The `alternates.types` value that advertises the blog RSS feed for
 * autodiscovery. Spread into any route's `alternates` so readers can find the
 * feed from that page.
 */
export const rssFeedAlternateTypes: NonNullable<Metadata['alternates']>['types'] = {
  'application/rss+xml': RSS_FEED_PATH,
};
