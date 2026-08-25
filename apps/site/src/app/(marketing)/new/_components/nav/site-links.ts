import { NAV_LINKS, type NavLink } from '@/layers/features/marketing';

/**
 * The rest of the site, folded behind the pill's overflow button.
 *
 * Derived from the shared {@link NAV_LINKS} rather than typed out again, for
 * the same reason `HOME_NAV_LINKS` is: a destination added to the site menu
 * has to appear here too, and a hand-copied list is a list that silently goes
 * stale. Two edits are applied on the way through.
 *
 * Home is dropped. Every entry in this menu leaves the page, and the page you
 * would be leaving for is this one.
 *
 * Features is relabelled. The pill itself now has a "features" entry that
 * scrolls to this page's own feature section, so an identically-named entry
 * one menu deeper would be two different destinations wearing one word. "all
 * features" is what the feature section's own link already calls the catalog.
 */
export const SITE_LINKS: readonly NavLink[] = NAV_LINKS.filter((link) => link.href !== '/').map(
  (link) => (link.href === '/features' ? { ...link, label: 'all features' } : link)
);
