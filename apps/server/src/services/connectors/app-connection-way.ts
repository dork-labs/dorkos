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
  ConnectorAppSetupReason,
  ConnectorAppWay,
  ConnectorWayProblem,
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
  const account = ways.find((candidate) => candidate.kind === 'dorkos_account');
  if (account) {
    return {
      status: 'setup_needed',
      reason:
        account.status === 'unlinked' ? 'dorkos_account_unlinked' : 'dorkos_account_unavailable',
    };
  }
  if (ways.some((candidate) => candidate.kind === 'own_key')) {
    return { status: 'setup_needed', reason: 'own_key_unavailable' };
  }
  return { status: 'setup_needed', reason: 'nothing_set_up' };
}

/**
 * Why no way reaches one app: the reason the one-time step is needed;
 * `way_not_answering` when a way works but could not list its apps just now;
 * or `app_not_reached` when a way works but does not reach this app.
 */
export type AppReachProblem = ConnectorAppSetupReason | 'way_not_answering' | 'app_not_reached';

/**
 * Why no way reaches an app, from which way new apps use.
 *
 * @param newApps - The answer {@link chooseNewAppsWay} gave.
 * @param catalogIncomplete - The app list came back with warnings, so a
 *   working way may reach the app without having said so this time.
 */
export function appReachProblem(
  newApps: ConnectorAppConnections['newApps'],
  catalogIncomplete: boolean
): AppReachProblem {
  if (newApps.status === 'setup_needed') return newApps.reason;
  return catalogIncomplete ? 'way_not_answering' : 'app_not_reached';
}

/**
 * What an agent reads beside an app no way reaches yet: why, what the person
 * does about it, and that asking for the app still works. The request's card
 * walks the person through that fix before sign-in.
 *
 * @param problem - Why no way reaches the app.
 * @param app - The app's display name.
 */
export function agentAppSetupNote(problem: AppReachProblem, app: string): string {
  switch (problem) {
    case 'nothing_set_up':
      return (
        `DorkOS is not set up to reach apps yet. You can still request ${app}: the person ` +
        'sets that up once, in the DorkOS app, when they connect it.'
      );
    case 'way_not_answering':
      return `DorkOS could not reach ${app} just now. Try again in a moment; you can still request it.`;
    case 'app_not_reached':
      return (
        `The way DorkOS reaches apps does not reach ${app}. You can still request it: the ` +
        'person can add another way in the DorkOS app when they connect it.'
      );
    case 'dorkos_account_unlinked':
      return (
        `The person's DorkOS account needs to be linked again before DorkOS can reach ${app}. ` +
        'They link it in Settings › Access in the DorkOS app, and apps they connected through ' +
        `it work again. You can still request ${app}.`
      );
    case 'dorkos_account_unavailable':
      return (
        `The person's DorkOS account is linked but cannot reach apps right now, so DorkOS ` +
        `cannot reach ${app}. You can still request it; the person sees what to do in the ` +
        'DorkOS app.'
      );
    case 'own_key_unavailable':
      return (
        'The key the person set up for reaching apps did not work the last time DorkOS ' +
        `checked it, so DorkOS cannot reach ${app}. They fix it in Settings › Connections in ` +
        `the DorkOS app. You can still request ${app}.`
      );
  }
}

/**
 * Whether the way one connected account goes through is working, and when it
 * is not, which fix brings the account back.
 *
 * @param input.registered - The account's route is registered (it answered its last check).
 * @param input.managed - The route is the DorkOS account's.
 * @param input.managedLinked - A DorkOS account is linked right now.
 */
export function wayProblemFor(input: {
  registered: boolean;
  managed: boolean;
  managedLinked: boolean;
}): ConnectorWayProblem | undefined {
  if (input.registered) return undefined;
  if (!input.managed) return 'own_key_unavailable';
  return input.managedLinked ? 'dorkos_account_unavailable' : 'dorkos_account_unlinked';
}

/**
 * What an agent reads beside an account it was given but cannot use because
 * the way it was connected through is not working: the fix, and that
 * connecting the app again is not it.
 *
 * @param problem - Which way is not working.
 */
export function agentWayProblemNote(problem: ConnectorWayProblem): string {
  switch (problem) {
    case 'dorkos_account_unlinked':
      return (
        "It was connected through the person's DorkOS account, which needs to be linked " +
        'again (Settings › Access in the DorkOS app). It works again once linked; do not ask ' +
        'them to connect it again.'
      );
    case 'dorkos_account_unavailable':
      return (
        "It was connected through the person's DorkOS account, which cannot reach apps right " +
        'now. Try again later; do not ask them to connect it again.'
      );
    case 'own_key_unavailable':
      return (
        "It was connected through the person's own key, which did not work the last time " +
        'DorkOS checked it. They fix it in Settings › Connections in the DorkOS app; do not ' +
        'ask them to connect it again.'
      );
  }
}
