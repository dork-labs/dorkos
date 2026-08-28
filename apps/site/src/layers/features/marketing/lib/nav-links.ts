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
