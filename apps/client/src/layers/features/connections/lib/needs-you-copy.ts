/**
 * What the "Needs you" strip says about each waiting decision: who is asking,
 * for what, and what it means, in the person's words rather than the review's
 * internal action names.
 *
 * @module features/connections/lib/needs-you-copy
 */
import type { ConnectorCatalogService } from '@dorkos/shared/connector-resource-schemas';
import type { ConnectorManagementReviewItem } from '@dorkos/shared/connector-schemas';
import { accountAppName } from './app-list';

/** One line pair for the strip. */
export interface NeedsYouLine {
  /** Who asks for what: "A program asks to pause Gmail (work)". */
  title: string;
  /** What it means: "Agents can't use it until you resume it." */
  detail: string;
}

type Services = ReadonlyMap<string, ConnectorCatalogService>;

/**
 * Who asks: "A program", or "Something using your sign-in" when the request
 * came in with the owner's own sign-in from outside the page (the command
 * line, an API call). It may not have been the person, so it never says "you".
 */
function requester(review: ConnectorManagementReviewItem): string {
  return review.requesterKind === 'program' ? 'A program' : 'Something using your sign-in';
}

/** "Gmail (work)", named by the catalog with the account's own label. */
function appAndAccount(toolkit: string, label: string | undefined, services: Services): string {
  const app = accountAppName(toolkit, services);
  return label ? `${app} (${label})` : app;
}

/** "1 action", "3 actions". */
function actions(count: number): string {
  return count === 1 ? '1 action' : `${count} actions`;
}

/**
 * The strip's words for a review still waiting on a decision.
 *
 * @param review - A pending management review.
 * @param services - Catalog services by id, for app names.
 */
export function pendingReviewLine(
  review: ConnectorManagementReviewItem,
  services: Services
): NeedsYouLine {
  const who = requester(review);
  const context = review.context;
  switch (context.kind) {
    case 'unavailable':
      return {
        title: `${who} asks to change a connection`,
        detail: 'Open it to see what it asks for.',
      };
    case 'connect':
      return {
        title: `${who} asks to connect ${appAndAccount(context.toolkit, context.label, services)}`,
        detail: 'You sign in before it is added. No agent can use it until you choose.',
      };
    case 'edit':
      return {
        title: `${who} asks to rename ${appAndAccount(context.connection.toolkit, context.connection.label, services)}`,
        detail: 'Only its name changes.',
      };
    case 'pause':
      return {
        title: `${who} asks to pause ${appAndAccount(context.connection.toolkit, context.connection.label, services)}`,
        detail: 'Agents can’t use it until you resume it.',
      };
    case 'resume':
      return {
        title: `${who} asks to resume ${appAndAccount(context.connection.toolkit, context.connection.label, services)}`,
        detail: 'Agents it is shared with can use it again.',
      };
    case 'disconnect':
      return {
        title: `${who} asks to disconnect ${appAndAccount(context.connection.toolkit, context.connection.label, services)}`,
        detail: context.everyAgent
          ? 'Every agent loses access.'
          : context.affectedAgentCount === 0
            ? 'No agent uses it right now.'
            : `${context.affectedAgentCount === 1 ? '1 agent loses' : `${context.affectedAgentCount} agents lose`} access.`,
      };
    case 'set_agent_access':
      return {
        title: `${who} asks to let ${context.agent.displayName} use ${appAndAccount(context.connection.toolkit, context.connection.label, services)}`,
        detail: `${actions(context.requestedOperations.length)} to review.`,
      };
    case 'remove_agent_access':
      return {
        title: `${who} asks to stop ${context.agent.displayName} using ${appAndAccount(context.connection.toolkit, context.connection.label, services)}`,
        detail:
          context.keptThroughEveryAgent.length > 0
            ? `It keeps ${actions(context.keptThroughEveryAgent.length)}, because the app is still shared with every agent.`
            : 'It loses its access to this app.',
      };
  }
}

/**
 * The strip's words for a decided review that still needs the person, or
 * `null` when a decided review needs nothing more.
 *
 * - Approved, and a sign-in is still open: finish signing in.
 * - Approved, but DorkOS could not confirm the change applied: check first.
 *
 * @param review - A resolved management review.
 * @param services - Catalog services by id, for app names.
 */
export function unsettledReviewLine(
  review: ConnectorManagementReviewItem,
  services: Services
): NeedsYouLine | null {
  if (review.state !== 'approved') return null;
  const context = review.context;
  const app =
    context.kind === 'connect'
      ? appAndAccount(context.toolkit, context.label, services)
      : context.kind === 'unavailable'
        ? 'the connection'
        : appAndAccount(context.connection.toolkit, context.connection.label, services);
  if (review.resolution.kind === 'connect_authentication_required') {
    return {
      title: `Approved: finish signing in to ${app}`,
      detail: 'Open it to finish signing in, or to see that it finished.',
    };
  }
  if (review.resolution.kind === 'outcome_unknown') {
    return {
      title: `Check ${app} before another change`,
      detail: 'DorkOS couldn’t confirm whether the approved change applied.',
    };
  }
  return null;
}
