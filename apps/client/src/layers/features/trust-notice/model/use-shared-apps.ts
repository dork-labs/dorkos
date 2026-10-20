import { serviceNameFromToolkit } from '@dorkos/shared/connector-schemas';
import type { ConnectorConnectionSummary } from '@dorkos/shared/connector-resource-schemas';
import { useConnectorConnections } from '@/layers/entities/connectors';

/** One app the Trusted upgrade shared with every agent, as the notice names it. */
export interface SharedApp {
  /** The connection to open on **Choose agents**. */
  connectionId: string;
  /** The app's name, with the account label when two accounts share an app. */
  name: string;
}

/**
 * Whether a connection is shared with every agent now. Read from the level
 * every agent was given, not from the grants: a share whose grants are not in
 * place yet (the app could not be read) is still a share the person must hear
 * about. An older server sends no level, so its grants decide.
 */
function sharedWithEveryAgent(connection: ConnectorConnectionSummary): boolean {
  return connection.everyAgentLevel !== undefined
    ? connection.everyAgentLevel !== null
    : connection.everyAgent !== null;
}

/**
 * The apps among `connectionIds` that still exist and are still shared with
 * every agent, named for the notice. Empty while the apps load.
 *
 * @param connectionIds - `permissions.sharedAtUpgrade`.
 */
export function useSharedApps(connectionIds: readonly string[]): SharedApp[] {
  const { data } = useConnectorConnections();
  const wanted = new Set(connectionIds);
  const shared = (data?.connections ?? []).filter(
    (connection) => wanted.has(connection.connectionId) && sharedWithEveryAgent(connection)
  );
  const perToolkit = new Map<string, number>();
  for (const connection of shared) {
    perToolkit.set(connection.toolkit, (perToolkit.get(connection.toolkit) ?? 0) + 1);
  }
  return shared.map((connection) => {
    const name = serviceNameFromToolkit(connection.toolkit);
    return {
      connectionId: connection.connectionId,
      // Two accounts of one app are told apart by their labels.
      name: (perToolkit.get(connection.toolkit) ?? 0) > 1 ? `${name} (${connection.label})` : name,
    };
  });
}
