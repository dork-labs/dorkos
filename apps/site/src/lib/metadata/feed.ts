/**
 * @module lib/metadata/feed
 *
 * The RSS feed autodiscovery alternate, shared so every segment that sets its
 * own `alternates` can advertise the feed. Next.js shallow-merges metadata: a
 * segment that defines `alternates` overwrites the parent's `alternates`
 * wholesale (it is not deep-merged), so a page that redeclares `alternates`
 * without re-spreading `types: rssFeedAlternateTypes` silently drops the feed
 * link, even though it still inherits everything else from the root layout.
 *
 * Coverage rule: every route that sets its own `alternates` object must
 * include `types: rssFeedAlternateTypes` in that object — currently the root
 * layout, the marketing layout, and every marketing, public, and blog page
 * that declares a page-specific canonical URL. Routes that never set
 * `alternates` (docs, account, download, admin) need no changes; they inherit
 * the root layout's feed link untouched. Adding a route with its own
 * `alternates`? Spread this in, or the feed link disappears for that page.
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
