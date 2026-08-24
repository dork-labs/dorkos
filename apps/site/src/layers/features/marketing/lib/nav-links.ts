import type { NavLink } from './types';

/**
 * Bottom pill-nav destinations, shared across every marketing page.
 *
 * Order is the reader's journey: what it is, what it does, what you can add,
 * what's new, how to use it — with Compare sitting next to Features, because
 * "what does it do" and "how does it stack up" are the same question asked
 * twice.
 */
export const NAV_LINKS: NavLink[] = [
  // Home yields on a phone: the header logo goes home from every page.
  { label: 'home', href: '/', yieldsOnMobile: true },
  { label: 'features', href: '/features' },
  { label: 'compare', href: '/compare' },
  { label: 'marketplace', href: '/marketplace' },
  { label: 'blog', href: '/blog' },
  { label: 'docs', href: '/docs' },
];

/** Where the homepage's first pill entry points, in place of Home. */
const HOME_PAGE_FIRST_ENTRY: NavLink = {
  label: 'about',
  href: '#about',
  // Yields on a phone for the same reason Home does: it is an in-page anchor,
  // still reachable by scrolling the page you are already on.
  yieldsOnMobile: true,
};

/**
 * The homepage's pill destinations.
 *
 * Derived from {@link NAV_LINKS} rather than written out again, so a
 * destination added to the site menu can never go missing on the homepage —
 * which is exactly how Compare came to be absent from dorkos.ai itself. The
 * homepage's only difference is its first entry: linking home from the
 * homepage is a no-op, so it points at the About section instead.
 */
export const HOME_NAV_LINKS: NavLink[] = NAV_LINKS.map((link) =>
  link.href === '/' ? HOME_PAGE_FIRST_ENTRY : link
);

/**
 * Whether a nav destination covers the page currently being viewed.
 *
 * Sections match their whole subtree, so `/compare/cursor` lights up Compare.
 * Home is the exception: every path starts with `/`, so it matches only itself.
 *
 * @param pathname - The current path, as `usePathname()` reports it.
 * @param href - The nav destination to test.
 */
export function isNavLinkActive(pathname: string | null, href: string): boolean {
  if (!pathname) return false;
  if (href === '/') return pathname === '/';
  return pathname === href || pathname.startsWith(`${href}/`);
}
