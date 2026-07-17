/**
 * @module lib/metadata/twitter
 *
 * Derives a Twitter card block from a page's Open Graph values
 * so every route ships a page-specific Twitter preview instead of falling back
 * to the sitewide root default. Keeping this in one place means the twelve-plus
 * routes that need it stay DRY.
 */
import type { Metadata } from 'next';

/** The Open Graph fields the Twitter block is derived from. */
export interface TwitterSource {
  /** The page's Open Graph title. */
  title: string;
  /** The page's Open Graph description. */
  description: string;
}

/**
 * Derive a `summary_large_image` Twitter card from a page's Open Graph title and
 * description. Twitter falls back to the root layout's metadata whenever a route
 * omits its own `twitter` block, so every page with page-specific Open Graph
 * copy should spread this into its metadata to keep the two previews in sync.
 *
 * The image is inherited from the route's Open Graph image automatically (Next
 * reuses the OG image for Twitter when no `twitter.images` is set), so callers
 * only need to supply the copy.
 *
 * @param source - The Open Graph title and description to mirror.
 */
export function twitterFromOpenGraph(source: TwitterSource): NonNullable<Metadata['twitter']> {
  return {
    card: 'summary_large_image',
    title: source.title,
    description: source.description,
  };
}
