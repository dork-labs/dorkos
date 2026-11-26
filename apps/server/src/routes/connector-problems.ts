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
import type { Problem } from '@dorkos/shared/problem';
import { logger } from '../lib/logger.js';
import type { NarrowingRefusal } from '../services/connectors/access/access-narrowing.js';
import type { ConnectorEventAccessError } from '../services/connectors/events/access-query-service.js';
import type { ConnectorAppActionsError } from '../services/connectors/resources/app-actions-service.js';
import type { ConnectorSessionAccessError } from '../services/connectors/resources/session-access-service.js';

import {
  AGENT_GONE,
  APP_NOT_SET_UP,
  BAD_CURSOR,
  type ConnectorProblem,
} from '../services/connectors/resources/owner-refusals.js';

// The tables the capability mount also answers with live beside the connection
// doors, so the hand routes and the mount say each refusal the same way (DOR-4978).
export {
  ACCESS_QUERY_PROBLEM,
  AGENT_REQUEST_PROBLEM,
  AUTHENTICATION_FLOW_PROBLEM,
  GRANT_EXCLUSION_PROBLEM,
  LIFECYCLE_PROBLEM,
  MANAGEMENT_REVIEW_PROBLEM,
  OPERATOR_QUERY_PROBLEM,
  RECONCILIATION_PROBLEM,
  SUBSCRIPTION_PROBLEM,
  type ConnectorProblem,
} from '../services/connectors/resources/owner-refusals.js';

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

/** A program's reads of an agent's notifications. */
export const EVENT_ACCESS_PROBLEM: Record<ConnectorEventAccessError['code'], ConnectorProblem> = {
  credential_unavailable: {
    code: 'unauthenticated',
    detail: 'That API key isn’t valid anymore. Use another key.',
  },
  agent_not_owned: AGENT_GONE,
  invalid_cursor: BAD_CURSOR,
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
