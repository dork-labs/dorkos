/**
 * Team widget — the `/team` roster page and the route that serves it.
 *
 * {@link TeamRoute} is the route component: it owns the search params and picks
 * a view. {@link TeamPage} is the cards roster it renders by default, kept
 * separate so it can be driven by a test or the playground without a router.
 *
 * @module widgets/team
 */
export { TeamRoute } from './ui/TeamRoute';
export { TeamPage } from './ui/TeamPage';
export type { TeamPageProps } from './ui/TeamPage';
