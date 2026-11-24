/**
 * How each connected-app service refusal becomes a problem document
 * (DOR-4979): one code and one fixed sentence per refusal code, never the
 * error's own message. The services keep their own vocabulary for logs, the
 * agent tools and their tests; these tables are only its projection onto the
 * API. Each is total by type, so a new service code cannot reach a response
 * without a row here.
 *
 * @module routes/connector-problems
 */
import type { Context } from 'hono';
import { problemBody, sendProblem } from '@dorkos/http-kit';
import type { Problem, ProblemCode } from '@dorkos/shared/problem';
import { logger } from '../lib/logger.js';
import type { ConnectorAgentRequestError } from '../services/connectors/agent-request-service.js';
import type { ConnectorGrantExclusionErrorCode } from '../services/connectors/access/grant-exclusions.js';
import type { NarrowingRefusal } from '../services/connectors/access/access-narrowing.js';
import type { ConnectorAccessQueryError } from '../services/connectors/execution/access-query-service.js';
import type { ConnectorEventAccessError } from '../services/connectors/events/access-query-service.js';
import type { ConnectorSubscriptionError } from '../services/connectors/events/subscription-store.js';
import type { ConnectorManagementReviewErrorCode } from '../services/connectors/management-review-service.js';
import type { ConnectorReconciliationErrorCode } from '../services/connectors/reconciliation/reconciliation-error.js';
import type { ConnectorAppActionsError } from '../services/connectors/resources/app-actions-service.js';
import type { ConnectorAuthenticationFlowError } from '../services/connectors/resources/authentication-flow-service.js';
import type { ConnectorLifecycleError } from '../services/connectors/resources/lifecycle-service.js';
import type { ConnectorOperatorQueryError } from '../services/connectors/resources/operator-query-service.js';
import type { ConnectorSessionAccessError } from '../services/connectors/resources/session-access-service.js';

/** One refusal's answer: its problem code and the sentence the person reads. */
export interface ConnectorProblem {
  readonly code: ProblemCode;
  readonly detail: string;
}

/** A connected account that is gone, or never was this owner's. */
const CONNECTION_GONE: ConnectorProblem = {
  code: 'not_found',
  detail: 'That app isn’t connected anymore. Pick it again from the list.',
};

/** An agent id this owner doesn't have. */
const AGENT_GONE: ConnectorProblem = { code: 'not_found', detail: 'That agent isn’t here.' };

/** A page cursor that isn't one of ours. */
const BAD_CURSOR: ConnectorProblem = {
  code: 'invalid_request',
  detail: 'That page link has expired. Start the list again.',
};

/** No working way to reach the app: nothing to sign in to or list. */
const APP_NOT_SET_UP: ConnectorProblem = {
  code: 'app_not_set_up',
  detail: 'DorkOS can’t reach this app right now. Check Settings › Connections.',
};

/** Signing in to an app (`POST /authentication-flows`, its poll). */
export const AUTHENTICATION_FLOW_PROBLEM: Record<
  ConnectorAuthenticationFlowError['code'],
  ConnectorProblem
> = {
  provider_not_found: APP_NOT_SET_UP,
  authentication_unavailable: APP_NOT_SET_UP,
  flow_not_found: { code: 'not_found', detail: 'That sign-in isn’t here anymore. Start again.' },
  idempotency_conflict: {
    code: 'conflict',
    detail: 'That sign-in was already used for other details. Start again.',
  },
  connection_not_found: CONNECTION_GONE,
  connection_cleanup_pending: {
    code: 'account_cleanup_pending',
    detail: 'DorkOS is still ending this account’s earlier access. Try again soon.',
  },
};

/** What agents can do in an app. */
export const APP_ACTIONS_PROBLEM: Record<ConnectorAppActionsError['code'], ConnectorProblem> = {
  provider_not_found: APP_NOT_SET_UP,
  actions_unavailable: {
    code: 'upstream_unavailable',
    detail: 'Couldn’t load what agents can do in this app. Try again.',
  },
};

/** One chat's switch for an app. */
export const SESSION_ACCESS_PROBLEM: Record<ConnectorSessionAccessError['code'], ConnectorProblem> =
  {
    session_access_other_agent: {
      code: 'other_agent_chat',
      detail: 'This chat’s access is set for another agent, so it can’t change here.',
    },
  };

/** Pausing, resuming, renaming, disconnecting and removing an account. */
export const LIFECYCLE_PROBLEM: Record<ConnectorLifecycleError['code'], ConnectorProblem> = {
  connection_not_found: CONNECTION_GONE,
  managed_sync_unavailable: {
    code: 'temporarily_unavailable',
    detail: 'DorkOS couldn’t reach your account’s apps. Try again soon.',
  },
  connection_not_disconnected: {
    code: 'still_connected',
    detail: 'Disconnect this app before removing it.',
  },
};

/** The owner's reads of accounts, agents and chats. */
export const OPERATOR_QUERY_PROBLEM: Record<ConnectorOperatorQueryError['code'], ConnectorProblem> =
  {
    connection_not_found: CONNECTION_GONE,
    agent_not_found: AGENT_GONE,
    session_not_found: { code: 'session_not_found', detail: 'That chat isn’t here anymore.' },
    invalid_cursor: BAD_CURSOR,
  };

/** A program's reads of what an agent may use. */
export const ACCESS_QUERY_PROBLEM: Record<ConnectorAccessQueryError['code'], ConnectorProblem> = {
  agent_not_owned: AGENT_GONE,
  connection_not_found: CONNECTION_GONE,
  invalid_cursor: BAD_CURSOR,
  runtime_authority_expired: {
    code: 'expired',
    detail: 'This agent’s access ended. Start a new turn, then try again.',
  },
};

/** A program's reads of an agent's notifications. */
export const EVENT_ACCESS_PROBLEM: Record<ConnectorEventAccessError['code'], ConnectorProblem> = {
  credential_unavailable: {
    code: 'unauthenticated',
    detail: 'That API key isn’t valid anymore. Use another key.',
  },
  agent_not_owned: AGENT_GONE,
  invalid_cursor: BAD_CURSOR,
};

/** Notifications from an app: choosing, setting up and removing them. */
export const SUBSCRIPTION_PROBLEM: Record<ConnectorSubscriptionError['code'], ConnectorProblem> = {
  not_found: { code: 'not_found', detail: 'That notification isn’t set up anymore.' },
  definition_changed: {
    code: 'precondition_failed',
    detail: 'These updates changed since you looked. Choose them again.',
  },
  invalid_filter: { code: 'invalid_request', detail: 'Check the filter values, then try again.' },
  destination_unavailable: {
    code: 'destination_unavailable',
    detail: 'That place can’t take notifications now. Pick another.',
  },
  events_unavailable: {
    code: 'temporarily_unavailable',
    detail: 'Notifications aren’t available right now. Try again later.',
  },
  review_conflict: {
    code: 'precondition_failed',
    detail: 'Those updates changed while you chose them. Pick them again.',
  },
};

/** An agent's request for an app, as its owner answers it. */
export const AGENT_REQUEST_PROBLEM: Record<ConnectorAgentRequestError['code'], ConnectorProblem> = {
  principal_required: {
    code: 'forbidden',
    detail: 'Only an agent answering in a chat can ask for access.',
  },
  authority_expired: {
    code: 'expired',
    detail: 'This request can’t go on anymore. Ask the agent to ask again.',
  },
  service_unavailable: {
    code: 'temporarily_unavailable',
    detail: 'Signing in isn’t available right now. Try again soon.',
  },
  request_not_found: { code: 'not_found', detail: 'That request isn’t here anymore.' },
  request_expired: {
    code: 'expired',
    detail: 'This request expired. Ask the agent to ask again.',
  },
  request_already_resolved: {
    code: 'already_resolved',
    detail: 'This request was already answered.',
  },
  // Not `invalid_request`: that is the bad-update-choice answer, whose way out differs.
  selection_invalid: {
    code: 'conflict',
    detail: 'That account isn’t ready for this request yet. Try again.',
  },
  event_selection_unavailable: {
    code: 'invalid_request',
    detail: 'Those updates can’t be set up. Choose again, or answer without them.',
  },
  authority_sync_failed: {
    code: 'temporarily_unavailable',
    detail: 'This agent’s access is still being applied. Try again in a moment.',
  },
  session_access_off: {
    code: 'app_off_in_chat',
    detail: 'This app is turned off for this chat. Turn it on first.',
  },
  request_open_elsewhere: {
    code: 'conflict',
    detail: 'Signing in already started another way. Finish or close that first.',
  },
  request_rate_limited: {
    code: 'rate_limited',
    detail: 'This agent asked for too many apps lately. Try again later.',
  },
};

/** A program's request for an account change, as the owner reviews it. */
export const MANAGEMENT_REVIEW_PROBLEM: Record<
  ConnectorManagementReviewErrorCode,
  ConnectorProblem
> = {
  review_not_found: { code: 'not_found', detail: 'That review isn’t here anymore.' },
  review_expired: { code: 'expired', detail: 'This review expired. Ask for the change again.' },
  review_resolving: {
    code: 'review_resolving',
    detail: 'This review is being settled now. Check it again shortly.',
  },
  idempotency_conflict: {
    code: 'conflict',
    detail: 'That request id was already used for another change.',
  },
  target_not_found: CONNECTION_GONE,
  action_failed: {
    code: 'conflict',
    detail: 'The change didn’t go through. Check the app, then try again.',
  },
};

/** Agents left out of a connection's every-agent share. */
export const GRANT_EXCLUSION_PROBLEM: Record<ConnectorGrantExclusionErrorCode, ConnectorProblem> = {
  connection_not_found: CONNECTION_GONE,
  agent_not_found: AGENT_GONE,
};

/** Saving which agents may use what. */
export const RECONCILIATION_PROBLEM: Record<ConnectorReconciliationErrorCode, ConnectorProblem> = {
  connection_not_found: CONNECTION_GONE,
  operations_unsupported: {
    code: 'app_not_supported',
    detail: 'This app doesn’t offer those actions. Choose again.',
  },
  catalog_incomplete: {
    code: 'temporarily_unavailable',
    detail: 'The app’s full list of actions isn’t loaded yet. Try again soon.',
  },
  preview_stale: {
    code: 'precondition_failed',
    detail: 'Access changed since you looked. Review it again.',
  },
  invalid_selection: {
    code: 'invalid_request',
    detail: 'Those choices don’t fit this app. Choose again.',
  },
  every_agent_unavailable: {
    code: 'app_not_supported',
    detail: 'This app can’t be shared with every agent.',
  },
};

/** Undoing an agent's change to another agent's access. */
export const NARROWING_PROBLEM: Record<NarrowingRefusal, ConnectorProblem> = {
  UNDO_STALE: {
    code: 'precondition_failed',
    detail: 'Access changed since then. Set it on the Connections page.',
  },
  UNDO_NOT_FOUND: { code: 'not_found', detail: 'Nothing to undo there.' },
  GRANT_NOT_FOUND: { code: 'not_found', detail: 'That app or agent isn’t here.' },
  GRANT_MANAGED_UNAVAILABLE: {
    code: 'temporarily_unavailable',
    detail: 'This app’s DorkOS account isn’t linked right now.',
  },
  GRANT_REASON_REQUIRED: { code: 'invalid_request', detail: 'Say why, in one line.' },
  GRANT_NARROW_RATE: {
    code: 'rate_limited',
    detail: 'Too many access changes this hour. Try again later.',
  },
  GRANT_NOT_A_NARROWING: { code: 'invalid_request', detail: 'That would add access.' },
  GRANT_NOTHING_TO_NARROW: {
    code: 'invalid_request',
    detail: 'That agent has no access of its own on this app.',
  },
  GRANT_MARKS_UNREADABLE: {
    code: 'forbidden',
    detail: 'This turn can’t change access. Ask a person.',
  },
  GRANT_MARKED_TURN: { code: 'forbidden', detail: 'This turn can’t change access. Ask a person.' },
  GRANT_AGENT_STARTED: {
    code: 'forbidden',
    detail: 'This turn can’t change access. Ask a person.',
  },
};

/**
 * The problem document for one mapped refusal. The service's own message goes
 * to the log, never to the caller.
 *
 * @param mapped - The refusal's row in one of the tables above.
 * @param error - The service's error, for the log line.
 * @returns The problem.
 */
export function connectorProblemBody(mapped: ConnectorProblem, error: Error): Problem {
  logger.info('[connectors] a request was refused', { name: error.name, message: error.message });
  return problemBody(mapped.code, { detail: mapped.detail });
}

/**
 * Answer a mapped refusal ({@link connectorProblemBody}).
 *
 * @param c - The Hono context.
 * @param mapped - The refusal's row.
 * @param error - The service's error, for the log line.
 * @returns The response.
 */
export function sendConnectorProblem(c: Context, mapped: ConnectorProblem, error: Error): Response {
  return sendProblem(c, connectorProblemBody(mapped, error));
}
