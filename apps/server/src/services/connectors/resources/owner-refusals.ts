/**
 * The refusals a person meets on the connection doors the capability mount
 * serves (`owner-capabilities.ts`, DOR-4978), with the problem codes and fixed
 * sentences the hand routes answered with. `routes/connector-problems.ts`
 * reads the same tables for the routes still served by hand, and
 * `routes/capability-refusals.ts` spreads {@link CONNECTION_OWNER_TOOL_REFUSALS}
 * into its table, so one sentence is said the same way on either.
 *
 * Imports nothing but types, so the refusal table can load it.
 *
 * @module services/connectors/resources/owner-refusals
 */
import type { ProblemCode } from '@dorkos/shared/problem';
import type { ConnectorLifecycleError } from './lifecycle-service.js';
import type { ConnectorOperatorQueryError } from './operator-query-service.js';

/** One refusal's answer: its problem code and the sentence the person reads. */
export interface ConnectorProblem {
  readonly code: ProblemCode;
  readonly detail: string;
}

/** A connected account that is gone, or never was this owner's. */
export const CONNECTION_GONE: ConnectorProblem = {
  code: 'not_found',
  detail: 'That app isn’t connected anymore. Pick it again from the list.',
};

/** An agent id this owner doesn't have. */
export const AGENT_GONE: ConnectorProblem = { code: 'not_found', detail: 'That agent isn’t here.' };

/** A page cursor that isn't one of ours. */
export const BAD_CURSOR: ConnectorProblem = {
  code: 'invalid_request',
  detail: 'That page link has expired. Start the list again.',
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

/** What a connection request that failed for no known reason answers. */
export const CONNECTION_REQUEST_FAILED: ConnectorProblem = {
  code: 'internal_error',
  detail: 'DorkOS couldn’t finish that for this app. Try again.',
};

/** The tool code a lifecycle refusal is thrown with. */
export function lifecycleToolCode(code: ConnectorLifecycleError['code']): string {
  return `CONNECTION_LIFECYCLE_${code.toUpperCase()}`;
}

/** The tool code an owner-read refusal is thrown with. */
export function ownerQueryToolCode(code: ConnectorOperatorQueryError['code']): string {
  return `CONNECTION_QUERY_${code.toUpperCase()}`;
}

/** Every refusal the connection doors answer with, by tool code. */
export const CONNECTION_OWNER_TOOL_REFUSALS: Readonly<Record<string, ConnectorProblem>> = {
  ...Object.fromEntries(
    Object.entries(LIFECYCLE_PROBLEM).map(([code, problem]) => [
      lifecycleToolCode(code as ConnectorLifecycleError['code']),
      problem,
    ])
  ),
  ...Object.fromEntries(
    Object.entries(OPERATOR_QUERY_PROBLEM).map(([code, problem]) => [
      ownerQueryToolCode(code as ConnectorOperatorQueryError['code']),
      problem,
    ])
  ),
  CONNECTION_REQUEST_FAILED,
};
