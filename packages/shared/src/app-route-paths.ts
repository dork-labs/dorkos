/**
 * Every path the app's router serves, the definition of an in-app link.
 *
 * Shared so the client's link seam (`layers/shared/lib/link-navigation.ts`)
 * and the server's check on the links an extension hands core
 * (`services/extensions/extension-links.ts`, spec `flow-multiproject` §7.1)
 * read one list and cannot disagree about what "in-app" means.
 * `apps/client/src/__tests__/app-route-paths.test.ts` builds the real router
 * and fails if the two ever drift.
 *
 * **Static paths only.** Both readers match a pathname by exact set
 * membership, so a parameterised route cannot be represented by adding its
 * literal here. Extension pages live under their own `/x/<id>` prefix and are
 * matched separately.
 *
 * @module shared/app-route-paths
 */
export const APP_ROUTE_PATHS = [
  '/',
  '/activity',
  '/agents',
  '/channels',
  '/connections',
  '/feedback-requests',
  '/marketplace',
  '/marketplace/sources',
  '/session',
  '/tasks',
  '/team',
  '/workspaces',
] as const;

/** One path the app's router serves. */
export type AppRoutePath = (typeof APP_ROUTE_PATHS)[number];
