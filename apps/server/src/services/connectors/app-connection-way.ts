/**
 * Which way DorkOS uses to reach a new app — the one rule, in one place.
 *
 * A person can have up to three ways set up: their linked DorkOS account, their
 * own Composio key, their own Nango server. The Connections list, the one-time
 * setup step and Settings all read the answer from here (through the catalog
 * and provider-status routes), so no two surfaces can disagree about it.
 *
 * The rule (connections-one-list design §6):
 * - Exactly one way works: use it without asking.
 * - More than one works: prefer the person's own key, because adding a key is a
 *   deliberate choice; otherwise the DorkOS account.
 * - None works: the one-time step shows, with the reason when something is set
 *   up but not answering (a linked account that cannot connect apps, or a key
 *   that failed its last check).
 *
 * No config field backs this: the answer follows from what is set up.
 *
 * @module services/connectors/app-connection-way
 */
import type {
  ConnectorAppConnections,
  ConnectorAppWay,
} from '@dorkos/shared/connector-resource-schemas';

/**
 * The connection service each route type signs in through — the name an app's
 * own consent page shows. The DorkOS account route runs on Composio, so it
 * names Composio too. A type absent here names nothing rather than guessing:
 * raw MCP signs in directly, and a self-hosted Nango server signs in with the
 * OAuth app the person registered themselves, so the consent page shows their
 * own app's name, not Nango's.
 */
const SIGN_IN_THROUGH: Readonly<Record<string, string>> = {
  composio: 'Composio',
  'dorkos-managed': 'Composio',
};

/**
 * The connection service a route type signs in through, if it names one.
 *
 * @param type - Route type, e.g. `'composio'`, `'dorkos-managed'`, `'raw-mcp'`.
 */
export function signInThroughFor(type: string): string | undefined {
  return SIGN_IN_THROUGH[type];
}

/**
 * Decide which way new apps use, from every way the person has set up.
 *
 * @param ways - Every way set up, ready or not, in preference order within each
 *   kind (the first ready own key wins among own keys).
 * @returns The way new apps use, or why the one-time setup step is needed.
 */
export function chooseNewAppsWay(
  ways: readonly ConnectorAppWay[]
): ConnectorAppConnections['newApps'] {
  const ready = ways.filter((way) => way.status === 'ready');
  const way =
    ready.find((candidate) => candidate.kind === 'own_key') ??
    ready.find((candidate) => candidate.kind === 'dorkos_account');
  if (way) return { status: 'ready', way };
  if (ways.some((candidate) => candidate.kind === 'dorkos_account')) {
    return { status: 'setup_needed', reason: 'dorkos_account_unavailable' };
  }
  if (ways.some((candidate) => candidate.kind === 'own_key')) {
    return { status: 'setup_needed', reason: 'own_key_unavailable' };
  }
  return { status: 'setup_needed', reason: 'nothing_set_up' };
}
