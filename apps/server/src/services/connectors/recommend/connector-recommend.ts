/**
 * The two halves `connector_recommend` adds to {@link recommendConnector}: going
 * from a plain task description to a few candidate services, and saying for
 * each whether the calling agent already has an account for it.
 *
 * **The `connected` flag reads only the caller's own view.** It is built from
 * the exact list `connectors_list_granted_connections` shows the same agent in
 * the same turn (`listRuntimeConnections`, bound to the turn's runtime
 * principal), never from the owner's account inventory or another agent's
 * grants. Where no turn principal reached the call (the external `/mcp`
 * surface, an HTTP caller, a turn without connector access) or the read fails,
 * the flag is left out. It is never guessed as `false`: a wrong "not connected"
 * makes an agent ask a person to connect an app they already have.
 *
 * How the principal arrives: Codex and OpenCode reach the in-session tools
 * through `createAgentRuntimeMcpServer` (`runtimes/connector-mcp/`), which
 * hands EVERY call its turn principal. Claude Code's in-process server hands it
 * only to the connector tools and to the ids `readsCallerConnections`
 * (`runtime-capability-scope.ts`) names, and only on a turn that lists the
 * connector tools.
 *
 * @module services/connectors/recommend/connector-recommend
 */
import type { ConnectorRecommendation } from '@dorkos/shared/connector-provider';
import type { ConnectorCatalogService } from '@dorkos/shared/connector-resource-schemas';

import type { CapabilityDeps, CapabilityHandlerContext } from '../../core/capabilities/index.js';
import type { ConnectorCapabilityDeps } from '../connector-capabilities.js';
import { matchServicesToIntent, type IntentMatch } from './intent-match.js';
import { isServerPrincipal } from '../principal/server-principal.js';
import type { ConnectorWarning } from '../registry.js';
import { recommendConnector, type RecommendConnectorResult } from '../routing.js';

/** The most services one intent lookup returns. */
const INTENT_RESULT_LIMIT = 5;

/**
 * Catalog pages read for one intent lookup: 5,000 services, several times any
 * catalog a connection service lists today, so in practice the whole catalog is
 * scored. A catalog longer than that is cut off with a warning saying so,
 * because an empty result must only ever mean "nothing fits".
 */
const CATALOG_MAX_PAGES = 50;
/** Services per catalog page (the catalog's own ceiling). */
const CATALOG_PAGE_SIZE = 100;

/** The warning an intent lookup carries when the catalog was longer than it read. */
export const CATALOG_TRUNCATED_WARNING: ConnectorWarning = {
  provider: 'catalog',
  message:
    'The app list is longer than one search reads, so some apps were not checked. ' +
    'An empty or short list may be missing a match.',
};

/** One candidate service for a task description. */
export interface IntentServiceRecommendation {
  /** The id a service request takes. */
  serviceSlug: string;
  /** The app's name. */
  displayName: string;
  /** The shelf it sits on, when the catalog says. */
  category?: string;
  /** What in the description matched it. */
  matchedBy: IntentMatch['matchedBy'];
  /** The ways to connect it, best first — the same list a `service` lookup returns. */
  recommendations: ConnectorRecommendation[];
  /** See {@link connectedFlag}; absent when it could not be told. */
  connected?: boolean;
}

/** What an intent lookup returns. */
export interface IntentRecommendResult {
  /** Candidate services, best first, at most {@link INTENT_RESULT_LIMIT}; empty when nothing fits. */
  services: IntentServiceRecommendation[];
  /** Catalog or provider trouble while looking; results may be incomplete. */
  warnings: ConnectorWarning[];
}

/**
 * The toolkits of every account the calling agent can see in this turn — the
 * same accounts `connectors_list_granted_connections` lists for it, usable or
 * not — or `undefined` when that cannot be read for this call.
 *
 * @param deps - The registry's dependency bag; reads `connectorExecutionDeps.access`.
 * @param context - The handler context; only a runtime turn principal is used.
 */
export async function callerConnectedToolkits(
  deps: CapabilityDeps,
  context: Pick<CapabilityHandlerContext, 'serverPrincipal'>
): Promise<ReadonlySet<string> | undefined> {
  const principal = context.serverPrincipal;
  const access = deps.connectorExecutionDeps?.access;
  if (!access || !isServerPrincipal(principal) || principal.claims.kind !== 'runtime') {
    return undefined;
  }
  try {
    const listed = await access.listRuntimeConnections(principal);
    return new Set(
      [...listed.connections, ...(listed.unavailable ?? [])].map((row) => row.toolkit.toLowerCase())
    );
  } catch {
    // Expired turn, offline registry: unknown, which is not the same as "no".
    return undefined;
  }
}

/**
 * Whether the caller already has an account for a service.
 *
 * `true` when one of its visible accounts is for this service. `false` only
 * when its view was read, holds none, and the service is reached only through
 * an account (a gateway or raw-MCP route, and no chat-app route). Otherwise
 * `undefined`: an app with a chat-app route (Slack, Telegram) may already be
 * set up as a chat app under Messaging, which this view cannot see, and an
 * unread view says nothing.
 *
 * @param serviceSlug - The service id.
 * @param toolkits - The caller's visible account toolkits, or `undefined` when unknown.
 * @param recommendations - The routes found for the service.
 */
function connectedFlag(
  serviceSlug: string,
  toolkits: ReadonlySet<string> | undefined,
  recommendations: readonly ConnectorRecommendation[]
): boolean | undefined {
  if (!toolkits) return undefined;
  if (toolkits.has(serviceSlug.toLowerCase())) return true;
  if (recommendations.some((route) => route.kind === 'relay-adapter')) return undefined;
  return recommendations.length > 0 ? false : undefined;
}

/**
 * {@link recommendConnector} for one exact service, plus the caller's
 * `connected` flag when it can be told.
 *
 * @param serviceSlug - The service id.
 * @param deps - Connector discovery services.
 * @param toolkits - The caller's visible account toolkits, or `undefined`.
 */
export async function recommendService(
  serviceSlug: string,
  deps: ConnectorCapabilityDeps,
  toolkits: ReadonlySet<string> | undefined
): Promise<RecommendConnectorResult & { connected?: boolean }> {
  const result = await recommendConnector(serviceSlug, {
    registry: deps.registry,
    ...(deps.relay && { relay: deps.relay }),
  });
  const connected = connectedFlag(serviceSlug, toolkits, result.recommendations);
  return connected === undefined ? result : { ...result, connected };
}

/**
 * Read the whole catalog in pages, in catalog order, up to {@link CATALOG_MAX_PAGES}.
 * The catalog keeps each connection service's full list, so later pages
 * slice that copy rather than asking the service again.
 *
 * @param deps - Connector discovery services.
 * @param signal - Aborts the lookup.
 */
async function readCatalog(
  deps: ConnectorCapabilityDeps,
  signal: AbortSignal
): Promise<{ services: ConnectorCatalogService[]; warnings: ConnectorWarning[] }> {
  const services: ConnectorCatalogService[] = [];
  const warnings: ConnectorWarning[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < CATALOG_MAX_PAGES; page += 1) {
    const read = await deps.catalog({
      limit: CATALOG_PAGE_SIZE,
      ...(cursor && { cursor }),
      signal,
    });
    services.push(...read.services);
    if (page === 0) {
      warnings.push(...read.warnings.map((w) => ({ provider: 'catalog', message: w.message })));
    }
    cursor = read.nextCursor;
    if (!cursor) return { services, warnings };
  }
  return { services, warnings: [...warnings, CATALOG_TRUNCATED_WARNING] };
}

/**
 * Turn a plain task description into a few candidate services, each with its
 * best ways to connect and, when it can be told, whether the caller already
 * has an account for it.
 *
 * @param intent - What the person wants done, in their own words.
 * @param deps - Connector discovery services.
 * @param toolkits - The caller's visible account toolkits, or `undefined`.
 * @param signal - Aborts the catalog read.
 */
export async function recommendByIntent(
  intent: string,
  deps: ConnectorCapabilityDeps,
  toolkits: ReadonlySet<string> | undefined,
  signal: AbortSignal
): Promise<IntentRecommendResult> {
  const catalog = await readCatalog(deps, signal);
  const matches = matchServicesToIntent(intent, catalog.services, INTENT_RESULT_LIMIT, {
    ...(toolkits && { preferred: toolkits }),
  });
  const routed = await Promise.all(
    matches.map(async ({ service, matchedBy }) => {
      const { recommendations, warnings, connected } = await recommendService(
        service.serviceSlug,
        deps,
        toolkits
      );
      const entry: IntentServiceRecommendation = {
        serviceSlug: service.serviceSlug,
        displayName: service.displayName,
        ...(service.category && { category: service.category }),
        matchedBy,
        recommendations,
        ...(connected !== undefined && { connected }),
      };
      return { entry, warnings };
    })
  );
  // One provider that degraded once per service is one warning, not five.
  const warnings = new Map<string, ConnectorWarning>();
  for (const warning of [...catalog.warnings, ...routed.flatMap((r) => r.warnings)]) {
    warnings.set(`${warning.provider}\u0000${warning.message}`, warning);
  }
  return { services: routed.map((r) => r.entry), warnings: [...warnings.values()] };
}
