/**
 * Which connected apps go through which "way DorkOS reaches your apps": the
 * DorkOS account, or one of the person's own keys (Composio, Nango).
 *
 * The server does not say this directly. A connection summary carries its
 * provider instance id (an opaque hash), its payer `mode` and its `custody`,
 * and the provider status list carries each key's `type` and `custody` but no
 * instance id. So the grouping is derived here, client-side, from two facts the
 * wire already guarantees:
 *
 * - `mode: 'managed'` is exactly "paid through the DorkOS account".
 * - A BYO connection's `custody` names its key's kind: Composio is `managed`
 *   custody (Composio holds the logins), Nango is `self-host`.
 *
 * Raw MCP servers (`external` custody) are not a way anyone sets up here, so
 * they belong to no row. Only apps that are not disconnected count: a
 * disconnected row stops nothing when its way goes away.
 *
 * @module features/connections/lib/connection-ways
 */
import type { ConnectorConnectionSummary } from '@dorkos/shared/connector-resource-schemas';
import type { ConnectorProviderStatus } from '@dorkos/shared/connector-provider';
import { providerName } from './presentation';

/** One connected app as the ways section lists it. */
export interface WayApp {
  /** Stable connection id. */
  connectionId: string;
  /** "Gmail (work)": the service name with the account's label. */
  name: string;
  /** How many agents may use this app today. */
  agentCount: number;
}

/** Connected apps grouped by the way each one reaches its service. */
export interface AppsByWay {
  /** Apps connected through the DorkOS account. */
  dorkosAccount: WayApp[];
  /** Apps connected through one of the person's own keys, keyed by key type. */
  byKeyType: Record<string, WayApp[]>;
}

/** Title-case a toolkit slug the same way the account rows name it. */
function serviceName(toolkit: string): string {
  return toolkit.charAt(0).toUpperCase() + toolkit.slice(1);
}

/**
 * Pick the key a BYO connection runs through from the keys that share its
 * custody. Production has one key per custody (Composio, Nango); test mode adds
 * a scripted key beside Composio, so the one that is actually working wins,
 * then one that is at least saved, then any.
 */
function keyTypeFor(
  custody: ConnectorConnectionSummary['custody'],
  providers: readonly ConnectorProviderStatus[]
): string | undefined {
  const candidates = providers.filter((provider) => provider.custody === custody);
  return (
    candidates.find((provider) => provider.registered) ??
    candidates.find((provider) => provider.configured) ??
    candidates[0]
  )?.type;
}

/**
 * Group the live connections by the way each one reaches its service.
 *
 * @param connections - Every connection the owner can see.
 * @param providers - Every key's setup status, from `GET /api/connectors/providers`.
 * @returns The DorkOS-account apps, and each key type's apps.
 */
export function groupAppsByWay(
  connections: readonly ConnectorConnectionSummary[],
  providers: readonly ConnectorProviderStatus[]
): AppsByWay {
  const grouped: AppsByWay = { dorkosAccount: [], byKeyType: {} };
  for (const connection of connections) {
    if (connection.lifecycle === 'disconnected') continue;
    const app: WayApp = {
      connectionId: connection.connectionId,
      name: `${serviceName(connection.toolkit)} (${connection.label})`,
      agentCount: connection.agentCount,
    };
    if (connection.mode === 'managed') {
      grouped.dorkosAccount.push(app);
      continue;
    }
    if (connection.custody === 'external') continue;
    const type = keyTypeFor(connection.custody, providers);
    if (!type) continue;
    (grouped.byKeyType[type] ??= []).push(app);
  }
  return grouped;
}

/**
 * "1 app" / "4 apps".
 *
 * @param count - How many apps.
 */
export function appCount(count: number): string {
  return `${count} ${count === 1 ? 'app' : 'apps'}`;
}

/**
 * What a person calls one of their own keys: "Your Composio key". Nango is a
 * server the person runs, so it is named as one.
 *
 * @param type - The key's type, e.g. `'composio'`.
 */
export function keyWayName(type: string): string {
  if (type === 'nango') return 'Your Nango server';
  return `Your ${providerName(type)} key`;
}
