/**
 * What an agent reads when its request for an app cannot go ahead as asked:
 * the refusals for an app id it may not request, and the note for an app no
 * way reaches yet. Each one gives the agent a next step rather than a dead end
 * (DOR-2231, FB-57). Split out of `agent-request-service.ts`, which owns the
 * requests themselves.
 *
 * @module services/connectors/resources/agent-request-messages
 */
import type { ConnectorAppSetupReason } from '@dorkos/shared/connector-resource-schemas';
import {
  serviceNameFromToolkit,
  type ConnectorRequestAccess,
} from '@dorkos/shared/connector-schemas';
import type { ConnectorServiceDirectory } from './operator-query-service.js';
import {
  agentConnectChoices,
  agentSetupReasonLine,
  type AppReachProblem,
} from '../app-connection-way.js';
import { splitWords } from '../recommend/intent-match.js';

const MAX_SERVICE_SUGGESTIONS = 5;

/**
 * Words that name a route DorkOS connects through rather than a service. An
 * agent that has heard of Composio writes `composio-emails`; matching on that
 * word would suggest the unrelated `composio_search` toolkit. The registered
 * routes' types are added to these at request time; their labels are not, since
 * a person may name a route after a service.
 */
const ROUTE_WORDS = ['composio', 'nango', 'dorkos', 'mcp'];

/**
 * Real service ids that share a word with a guessed one, shortest first.
 *
 * `gmail_inbox` and `composio_gmail` both suggest `gmail`. A route name is not
 * a service word, and a word shorter than three letters would match nearly
 * everything, so both are ignored. No match means no suggestion: the refusal
 * then points only at the catalog tool rather than at an unrelated service.
 */
function suggestServices(guess: string, directory: ConnectorServiceDirectory): string[] {
  const ignored = new Set([
    ...ROUTE_WORDS,
    ...directory.routeTypes.flatMap((type) => splitWords(type)),
  ]);
  const guessWords = new Set<string>();
  for (const word of splitWords(guess)) {
    if (word.length < 3 || ignored.has(word)) continue;
    guessWords.add(word);
    if (word.length > 3 && word.endsWith('s')) guessWords.add(word.slice(0, -1));
  }
  if (guessWords.size === 0) return [];
  return directory.services
    .filter((service) => service.requestable)
    .filter((service) => {
      const serviceWords = [
        ...splitWords(service.serviceSlug),
        ...splitWords(service.displayName),
      ].filter((word) => !ignored.has(word));
      return [...guessWords].some((guessWord) =>
        serviceWords.some((word) => word.includes(guessWord) || guessWord.includes(word))
      );
    })
    .map((service) => service.serviceSlug)
    .sort((left, right) => left.length - right.length || left.localeCompare(right))
    .slice(0, MAX_SERVICE_SUGGESTIONS);
}

/**
 * The refusal for a service id an agent may not request, written so the agent
 * has one next step instead of a dead end (DOR-2231): wait out a partial
 * catalog, hand the person the one setup step only they can take, send a
 * Messaging-only service to the person, or look the exact id up. The catalog
 * warning text is not repeated to the agent. A popular app no way reaches is
 * never refused here (DOR-2494): it is requestable, and its card runs the fix.
 */
export function unavailableServiceMessage(
  serviceSlug: string,
  directory: ConnectorServiceDirectory,
  catalogTool: string
): string {
  const listed = directory.services.find((service) => service.serviceSlug === serviceSlug);
  // The agent reads the app's name; the raw id is repeated only where the id
  // itself is the problem (no service has it), since that is what it must fix.
  const app = listed?.displayName ?? serviceNameFromToolkit(serviceSlug);
  if (listed && !listed.requestable && listed.unavailableBecause === 'messaging_only') {
    return (
      `${listed.displayName} connects through Messaging, not an account, so an agent cannot ` +
      'request it. Ask the person to set it up under Messaging in Connections in the DorkOS app.'
    );
  }
  // A chat-only app does not depend on the catalog; anything else missing a
  // route may be missing it because of the outage itself.
  if (directory.warnings.length > 0) return partialCatalogMessage(app);
  // Nothing reached: an id beyond the popular apps cannot be checked until a
  // way works, so the refusal names that way's fix instead of "no such id".
  if (
    directory.reachProblem !== 'app_not_reached' &&
    !directory.services.some((service) => service.requestable && service.reached)
  ) {
    return unreachedDirectoryMessage(app, directory.reachProblem);
  }
  const suggestions = suggestServices(serviceSlug, directory);
  return [
    `DorkOS has no service with the id ${JSON.stringify(serviceSlug)}. Service ids are exact, lowercase names.`,
    ...(suggestions.length > 0 ? [`Close matches: ${suggestions.join(', ')}.`] : []),
    `Search the services by name with ${catalogTool} (for example {"query":"mail"}), then ask ` +
      'again with the exact serviceSlug of an entry in its services list.',
  ].join(' ');
}

/** The refusal while part of the service list failed to load: a retry, not a verdict. */
function partialCatalogMessage(app: string): string {
  return (
    `DorkOS could not load the full list of services just now, so ${app} could not be ` +
    'checked. Try again in a moment.'
  );
}

/** The refusal for an id no way can check, by what stands in the way. */
function unreachedDirectoryMessage(
  app: string,
  problem: Exclude<AppReachProblem, 'app_not_reached'>
): string {
  switch (problem) {
    case 'way_not_answering':
      return partialCatalogMessage(app);
    case 'dorkos_account_unlinked':
    case 'dorkos_account_unavailable':
    case 'own_key_unavailable':
      return (
        `DorkOS cannot check ${app} right now: ${agentSetupReasonLine(problem)}. ` +
        `${agentConnectChoices(problem)} Then ask again.`
      );
    case 'nothing_set_up':
      return (
        `DorkOS is not set up to reach apps yet, so it cannot check ${app}; only the popular ` +
        'apps it lists can be requested now. The first app the person connects in the DorkOS ' +
        `app also sets up how DorkOS reaches apps. ${agentConnectChoices(problem)} Then ask ` +
        "again. Signing in to a service's command-line tool in a shell does not give DorkOS access."
      );
  }
}

/**
 * The note for a request no way can serve yet: why, the choices to offer the
 * person, and that their answer still comes back here (FB-57).
 */
export function setupRequestNote(app: string, reason: ConnectorAppSetupReason): string {
  return (
    `DorkOS can't reach ${app} yet: ${agentSetupReasonLine(reason)}. Before the person can ` +
    `connect it, they choose how DorkOS reaches apps. ${agentConnectChoices(reason)} The card ` +
    `in this chat offers the same choices. Once they connect ${app}, their answer comes back ` +
    "to this chat, so don't ask again."
  );
}

/** What a granted agent can now do in an app, in words. */
export function grantedVerb(held: ReadonlySet<string>): string {
  if (held.has('read') && held.has('write')) return 'read and change things in';
  if (held.has('read')) return 'read';
  if (held.has('write')) return 'change things in';
  return 'use';
}

/**
 * The refusal for an app the agent already asked for in another chat, saying
 * only what is true: whether it was answered, and whether that answer (or
 * ask) covers what this chat needs.
 */
export function elsewhereMessage(
  app: string,
  wanted: ConnectorRequestAccess,
  asked: ConnectorRequestAccess,
  held: ReadonlySet<string> | null
): string {
  const needsChange = wanted === 'read-write';
  if (held) {
    const covered = !needsChange || held.has('write');
    return (
      `The person already allowed you to ${grantedVerb(held)} ${app} when you asked in ` +
      "another chat. List your accounts again to use it here; don't ask again." +
      (covered
        ? ''
        : ` That doesn't cover changing things there. If this chat needs that, ask for ` +
          `"read-write" once that answer reaches the other chat.`)
    );
  }
  const covered = !needsChange || asked === 'read-write';
  return (
    `You already asked for ${app} in another chat, and the person hasn't answered yet. They ` +
    'can answer it there, or under Needs you on the Connections page in DorkOS. ' +
    (covered
      ? `If they allow it, you can use ${app} in this chat too, so don't ask again here.`
      : `That request asks only to read ${app}. If this chat needs to change things there, ` +
        'ask again once the person has answered it.')
  );
}
