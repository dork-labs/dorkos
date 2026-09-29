/**
 * Pure choices the connect dialog makes before sign-in: which route an app
 * signs in through, whether the one-time setup step is needed, and the plain
 * lines that say whose page comes next and why setup is being asked for.
 *
 * Which way new apps use is decided on the server (`appConnections.newApps`);
 * this module only applies that answer to one app's routes.
 *
 * @module features/connections/lib/connect-route
 */
import type {
  ConnectorAppConnections,
  ConnectorAppWay,
  ConnectorCatalogProviderRoute,
  ConnectorCatalogService,
} from '@dorkos/shared/connector-resource-schemas';
import { connectionWayName } from '@dorkos/shared/connector-schemas';

/** Every route that can sign in to the app, in the catalog's order. */
export function accountRoutes(
  service: ConnectorCatalogService | null
): ConnectorCatalogProviderRoute[] {
  return service?.intents.find((intent) => intent.kind === 'account')?.routes ?? [];
}

/**
 * The route a new sign-in uses: the way the server marked for new apps when it
 * reaches this app, otherwise the first available route (a DorkOS-account
 * route before a person's own).
 *
 * @param routes - The app's account routes.
 * @param newApps - The server's answer for which way new apps use, when known.
 */
export function chooseConnectRoute(
  routes: readonly ConnectorCatalogProviderRoute[],
  newApps: ConnectorAppConnections['newApps'] | undefined
): ConnectorCatalogProviderRoute | null {
  const available = routes.filter(
    (route) => route.capabilities.authentication.status === 'available'
  );
  const preferred =
    newApps?.status === 'ready'
      ? available.find((route) => route.providerInstanceId === newApps.way.providerInstanceId)
      : undefined;
  return (
    preferred ??
    available.find((route) => route.mode === 'managed') ??
    available.find((route) => route.mode === 'byo') ??
    null
  );
}

/**
 * Whether connecting the app has to start with the one-time setup step: it is
 * an app a person signs in to, and no route that is set up can sign in to it —
 * none at all, or only routes whose sign-in is not available (a linked DorkOS
 * account before it can connect apps). Never a dead end: the step always offers
 * another way. Chat-only apps never qualify; they have no account to sign in to.
 */
export function needsFirstConnectStep(service: ConnectorCatalogService | null): boolean {
  const account = service?.intents.find((intent) => intent.kind === 'account');
  return (
    account?.kind === 'account' &&
    !account.routes.some((route) => route.capabilities.authentication.status === 'available')
  );
}

/**
 * Whether the app is out of reach only because a working way could not be
 * asked just now: something is set up and working, but the catalog came back
 * partial. Offering setup then would be wrong — the answer is to try again.
 *
 * @param page - The catalog page the app was read from.
 */
export function isCatalogOutage(
  page: { warnings: readonly unknown[]; appConnections?: ConnectorAppConnections } | undefined
): boolean {
  return (page?.warnings.length ?? 0) > 0 && page?.appConnections?.newApps.status === 'ready';
}

/** How the person knows a way: their DorkOS account, or the service their key is for. */
export function wayName(way: ConnectorAppWay): string {
  return connectionWayName(way.kind === 'dorkos_account' ? 'dorkos-managed' : way.type);
}

/**
 * The line said before the app's own sign-in page opens, naming the service
 * that page will ask about — so nobody learns it only after the fact. `null`
 * when the route signs in directly, or asks for no sign-in page at all.
 *
 * @param route - The route the sign-in goes through.
 * @param service - The app being connected.
 */
export function signInLine(
  route: ConnectorCatalogProviderRoute | null,
  service: ConnectorCatalogService | null
): string | null {
  if (!route?.signInThrough || route.authKind !== 'oauth2' || !service) return null;
  const who = service.signInName ?? service.displayName;
  return `${who} will ask you to allow ${route.signInThrough} — that’s the service DorkOS uses to connect.`;
}

/**
 * Why the one-time step is showing when something is already set up, in one
 * plain line; `null` when nothing is set up, which needs no explaining.
 *
 * @param appConnections - Every way set up and the one new apps use.
 * @param service - The app being connected.
 */
export function firstConnectReason(
  appConnections: ConnectorAppConnections | undefined,
  service: ConnectorCatalogService | null
): string | null {
  const serviceName = service?.displayName ?? 'this app';
  const unsupported = accountRoutes(service)
    .map((route) => route.capabilities.authentication)
    .find((authentication) => authentication.status === 'unsupported');
  if (unsupported?.status === 'unsupported') return unsupported.reason;
  const newApps = appConnections?.newApps;
  if (!newApps) return null;
  if (newApps.status === 'ready') return `${wayName(newApps.way)} can’t reach ${serviceName} yet.`;
  switch (newApps.reason) {
    case 'dorkos_account_unavailable':
      return 'Your DorkOS account is linked, but it can’t connect apps right now.';
    case 'dorkos_account_unlinked':
      return 'Your DorkOS account isn’t linked anymore.';
    case 'own_key_unavailable':
      return 'Your saved key didn’t work the last time DorkOS checked it.';
    case 'nothing_set_up':
      return null;
  }
}
