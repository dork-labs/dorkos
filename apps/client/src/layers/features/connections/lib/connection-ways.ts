/**
 * Which connected apps go through which "way DorkOS reaches your apps": the
 * DorkOS account, or one of the person's own keys (Composio, Nango).
 *
 * Exact, not inferred: every connection carries the `providerInstanceId` it
 * was made through, and every key's status carries the instance id it runs
 * as. `mode: 'managed'` is the DorkOS account (paid through it). A connection
 * that matches no listed key (a raw MCP server) belongs to no row, and a
 * disconnected app counts nowhere.
 *
 * @module features/connections/lib/connection-ways
 */
import type { ConnectorConnectionSummary } from '@dorkos/shared/connector-resource-schemas';
import type { ConnectorProviderStatus } from '@dorkos/shared/connector-provider';
import { dorkosAccountApps, toImpactApp, type ImpactApp } from '@/layers/entities/connectors';
import { providerName } from './presentation';

/** Connected apps grouped by the way each one reaches its service. */
export interface AppsByWay {
  /** Apps connected through the DorkOS account. */
  dorkosAccount: ImpactApp[];
  /** Apps connected through one of the person's own keys, keyed by the key's instance id. */
  byKeyInstance: Record<string, ImpactApp[]>;
}

/**
 * Group the live connections by the way each one reaches its service.
 *
 * @param connections - Every connection the owner can see.
 * @param providers - Every key's setup status, from `GET /api/connectors/providers`.
 * @returns The DorkOS-account apps, and each key's apps by instance id.
 */
export function groupAppsByWay(
  connections: readonly ConnectorConnectionSummary[],
  providers: readonly ConnectorProviderStatus[]
): AppsByWay {
  const keyInstances = new Set<string>(providers.map((provider) => provider.providerInstanceId));
  const grouped: AppsByWay = { dorkosAccount: dorkosAccountApps(connections), byKeyInstance: {} };
  for (const connection of connections) {
    if (connection.readiness.state === 'gone' || connection.mode === 'managed') continue;
    if (!keyInstances.has(connection.providerInstanceId)) continue;
    (grouped.byKeyInstance[connection.providerInstanceId] ??= []).push(toImpactApp(connection));
  }
  return grouped;
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
