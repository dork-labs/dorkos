/**
 * `recommendConnector` — the routing surface that decides HOW a given service
 * should be connected, in precedence order (connector-gateway spec §Detailed
 * Design 5). The crux for the W4 evals: "Connect to Slack" must route to the
 * purpose-built Relay Slack adapter (richer, two-way, consent-bound), while
 * "Connect to my Gmail" (no purpose-built adapter) routes to the generic
 * gateway.
 *
 * Precedence (ascending `rank`, 0 = best):
 * 1. **relay-adapter** — a purpose-built relay adapter exists for the service,
 *    read through the relay `AdapterManager` PUBLIC accessor `getManifest`
 *    (never its private `manifests` field).
 * 2. **gateway** — a registered {@link ConnectorProvider} gateway backend
 *    (managed Composio / self-host Nango) lists the service as a toolkit;
 *    managed is preferred over self-host. Carries `custody` for the picker.
 * 3. **raw-mcp** — a registered single-account, `external`-custody baseline
 *    provider (the raw-MCP adapter) lists the service.
 *
 * @module services/connectors/routing
 */
import type {
  ConnectorCustody,
  ConnectorProvider,
  ConnectorRecommendation,
} from '@dorkos/shared/connector-provider';
import type { ConnectorRegistry } from './registry.js';

/** Fixed rank per recommendation kind — the documented precedence. */
const RANK = { relayAdapter: 0, gateway: 1, rawMcp: 2 } as const;

/** Tie-break order among gateway custody stances — managed default beats self-host. */
const CUSTODY_PREFERENCE: Record<ConnectorCustody, number> = {
  managed: 0,
  'self-host': 1,
  external: 2,
};

/**
 * The relay adapter catalog, seen only through its public read accessor. The
 * concrete `AdapterManager` satisfies this structurally, so routing never
 * touches the manager's private state (spec §5: read via `getManifest`, never
 * the private `manifests` map).
 */
export interface RelayAdapterCatalog {
  /**
   * Return the manifest for an adapter type, or `undefined` if none is
   * registered — the authority for "is there a purpose-built adapter?".
   *
   * @param type - The adapter type / service slug, e.g. `'slack'`.
   */
  getManifest(type: string): { displayName?: string } | undefined;
}

/** Collaborators `recommendConnector` reads. */
export interface RecommendConnectorDeps {
  /** The connector registry whose gateway/baseline providers list toolkits. */
  registry: ConnectorRegistry;
  /** Optional relay adapter catalog; absent when relay is disabled. */
  relay?: RelayAdapterCatalog;
}

/** True when a provider's custody makes it the single-account raw-MCP baseline. */
function isRawMcp(provider: ConnectorProvider): boolean {
  return provider.getCapabilities().custody === 'external';
}

/**
 * Build the relay-adapter recommendation for a service, or `undefined` when no
 * purpose-built adapter exists.
 *
 * @param serviceSlug - The service slug to route.
 * @param relay - The relay adapter catalog accessor.
 */
function relayRecommendation(
  serviceSlug: string,
  relay: RelayAdapterCatalog | undefined
): ConnectorRecommendation | undefined {
  const manifest = relay?.getManifest(serviceSlug);
  if (!manifest) return undefined;
  const name = manifest.displayName ?? serviceSlug;
  return {
    kind: 'relay-adapter',
    target: serviceSlug,
    provider: serviceSlug,
    rank: RANK.relayAdapter,
    reason: `${name} has a purpose-built two-way adapter in DorkOS — richer than the generic connector.`,
  };
}

/**
 * Build the provider (gateway or raw-mcp) recommendations for a service by
 * asking each registered provider whether it lists the toolkit.
 *
 * @param serviceSlug - The service slug to route.
 * @param registry - The connector registry to scan.
 */
async function providerRecommendations(
  serviceSlug: string,
  registry: ConnectorRegistry
): Promise<ConnectorRecommendation[]> {
  const providers = registry.listProviders();
  const listed = await Promise.all(
    providers.map(async (provider) => {
      try {
        const toolkits = await provider.listToolkits();
        return toolkits.some((tk) => tk.slug === serviceSlug) ? provider : undefined;
      } catch {
        // A provider that cannot list toolkits simply offers no recommendation;
        // routing degrades silently rather than failing the whole surface.
        return undefined;
      }
    })
  );

  const recommendations: ConnectorRecommendation[] = [];
  for (const provider of listed) {
    if (!provider) continue;
    const custody = provider.getCapabilities().custody;
    if (isRawMcp(provider)) {
      recommendations.push({
        kind: 'raw-mcp',
        target: serviceSlug,
        provider: provider.type,
        rank: RANK.rawMcp,
        reason: `Connect ${serviceSlug} directly to its remote MCP server (single account).`,
        custody,
      });
    } else {
      recommendations.push({
        kind: 'gateway',
        target: serviceSlug,
        provider: provider.type,
        rank: RANK.gateway,
        reason: `Connect ${serviceSlug} through the ${provider.type} gateway.`,
        custody,
      });
    }
  }
  return recommendations;
}

/**
 * Sort recommendations by precedence: ascending `rank`, then managed custody
 * before self-host before external (so the managed default gateway leads).
 *
 * @param a - First recommendation.
 * @param b - Second recommendation.
 */
function byPrecedence(a: ConnectorRecommendation, b: ConnectorRecommendation): number {
  if (a.rank !== b.rank) return a.rank - b.rank;
  const pa = a.custody ? CUSTODY_PREFERENCE[a.custody] : Number.MAX_SAFE_INTEGER;
  const pb = b.custody ? CUSTODY_PREFERENCE[b.custody] : Number.MAX_SAFE_INTEGER;
  return pa - pb;
}

/**
 * Recommend how to connect a service, best first. Returns every applicable way
 * (relay adapter, gateway, raw-MCP) sorted ascending by precedence; an empty
 * array means nothing can connect the service yet.
 *
 * @param serviceSlug - The service slug to route, e.g. `'slack' | 'gmail'`.
 * @param deps - The relay catalog and connector registry to read; see {@link RecommendConnectorDeps}.
 */
export async function recommendConnector(
  serviceSlug: string,
  deps: RecommendConnectorDeps
): Promise<ConnectorRecommendation[]> {
  const recommendations: ConnectorRecommendation[] = [];

  const relay = relayRecommendation(serviceSlug, deps.relay);
  if (relay) recommendations.push(relay);

  recommendations.push(...(await providerRecommendations(serviceSlug, deps.registry)));

  return recommendations.sort(byPrecedence);
}
