/**
 * The refusals a person meets on the connection doors the capability mount
 * serves (`owner-capabilities.ts`, `owner-management-capabilities.ts`,
 * DOR-4978), with the problem codes and fixed sentences the hand routes
 * answered with. `routes/connector-problems.ts`
 * reads the same tables for the routes still served by hand, and
 * `routes/capability-refusals.ts` spreads {@link CONNECTION_OWNER_TOOL_REFUSALS}
 * into its table, so one sentence is said the same way on either.
 *
 * Imports nothing but types, so the refusal table can load it.
 *
 * @module services/connectors/resources/owner-refusals
 */
import type { ProblemCode } from '@dorkos/shared/problem';
import type { ManagedConnectorCloudErrorCode } from '../../core/auth/cloud-link-client.js';
import type { ConnectorGrantExclusionErrorCode } from '../access/grant-exclusions.js';
import type { ConnectorAgentRequestError } from '../agent-request-service.js';
import type { ConnectorSubscriptionError } from '../events/subscription-store.js';
import type { ConnectorAccessQueryError } from '../execution/access-query-service.js';
import type { ConnectorManagementReviewErrorCode } from '../management-review-service.js';
import type { ConnectorReconciliationErrorCode } from '../reconciliation/reconciliation-error.js';
import type { ConnectorAuthenticationFlowError } from './authentication-flow-service.js';
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

/** No working way to reach the app: nothing to sign in to or list. */
export const APP_NOT_SET_UP: ConnectorProblem = {
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

/** Notifications from an app: choosing, setting up and removing them. */
export const SUBSCRIPTION_PROBLEM: Record<ConnectorSubscriptionError['code'], ConnectorProblem> = {
  not_found: { code: 'not_found', detail: 'That notification isn’t set up anymore.' },
  definition_changed: {
    code: 'updates_changed',
    detail: 'These updates changed since you looked. Choose them again.',
  },
  invalid_filter: { code: 'invalid_filter', detail: 'Check the filter values, then try again.' },
  destination_unavailable: {
    code: 'destination_unavailable',
    detail: 'That place can’t take notifications now. Pick another.',
  },
  events_unavailable: {
    code: 'updates_unavailable',
    detail: 'Notifications aren’t available right now. Try again later.',
  },
  review_conflict: {
    code: 'updates_changed',
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
  // A retry can work once the account is ready, so not `updates_unavailable`.
  selection_invalid: {
    code: 'conflict',
    detail: 'That account isn’t ready for this request yet. Try again.',
  },
  event_selection_unavailable: {
    code: 'updates_unavailable',
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
    code: 'request_open_elsewhere',
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

/** A refused call to DorkOS's managed cloud; the cloud's own reason stays in the log. */
const CLOUD_UNAVAILABLE: ConnectorProblem = {
  code: 'cloud_unavailable',
  detail: 'DorkOS’s servers aren’t answering. Nothing changed. Try again soon.',
};

const CLOUD_REFUSED: ConnectorProblem = {
  code: 'cloud_refused',
  detail: 'DorkOS’s servers couldn’t finish this. Nothing changed here. Try again later.',
};

/** Every refused managed-cloud call (`routes/managed-cloud-error.ts`). */
export const MANAGED_CLOUD_PROBLEM: Record<ManagedConnectorCloudErrorCode, ConnectorProblem> = {
  unauthorized: {
    code: 'cloud_link_required',
    detail: 'This computer isn’t linked to your DorkOS account. Link it again in Settings.',
  },
  permission_upgrade_required: {
    code: 'cloud_link_required',
    detail: 'This computer’s link to your DorkOS account needs updating. Link it again.',
  },
  unavailable: CLOUD_UNAVAILABLE,
  network_error: CLOUD_UNAVAILABLE,
  request_failed: CLOUD_REFUSED,
  invalid_response: CLOUD_REFUSED,
  not_found: CLOUD_REFUSED,
  conflict: CLOUD_REFUSED,
};

/** An agent's request read while agent identity is off. */
export const AGENT_REQUESTS_OFF: ConnectorProblem = {
  code: 'temporarily_unavailable',
  detail: 'Agents’ requests aren’t available while agent identity is off.',
};

/** The tool code {@link AGENT_REQUESTS_OFF} is thrown with. */
export const AGENT_REQUESTS_OFF_TOOL_CODE = 'CONNECTION_AGENT_REQUESTS_OFF';

/** The tool code a lifecycle refusal is thrown with. */
export function lifecycleToolCode(code: ConnectorLifecycleError['code']): string {
  return `CONNECTION_LIFECYCLE_${code.toUpperCase()}`;
}

/** The tool code an owner-read refusal is thrown with. */
export function ownerQueryToolCode(code: ConnectorOperatorQueryError['code']): string {
  return `CONNECTION_QUERY_${code.toUpperCase()}`;
}

/**
 * The families of refusals the account doors throw, each with its tool-code
 * prefix: `CONNECTION_<FAMILY>_<CODE>`.
 */
const REFUSAL_FAMILIES = {
  REVIEW: MANAGEMENT_REVIEW_PROBLEM,
  AGENT_REQUEST: AGENT_REQUEST_PROBLEM,
  SUBSCRIPTION: SUBSCRIPTION_PROBLEM,
  EXCLUSION: GRANT_EXCLUSION_PROBLEM,
  RECONCILIATION: RECONCILIATION_PROBLEM,
  SIGN_IN: AUTHENTICATION_FLOW_PROBLEM,
  USAGE: ACCESS_QUERY_PROBLEM,
  CLOUD: MANAGED_CLOUD_PROBLEM,
} as const;

/** One family of {@link REFUSAL_FAMILIES}. */
export type ConnectionRefusalFamily = keyof typeof REFUSAL_FAMILIES;

/**
 * The tool code a service refusal of one family is thrown with.
 *
 * @param family - Which table the code is a row of.
 * @param code - The service's own refusal code.
 */
export function connectionToolCode(family: ConnectionRefusalFamily, code: string): string {
  return `CONNECTION_${family}_${code.toUpperCase()}`;
}

/** One table's rows, by tool code. */
function byToolCode<C extends string>(
  table: Readonly<Record<C, ConnectorProblem>>,
  toolCode: (code: C) => string
): [string, ConnectorProblem][] {
  return Object.entries<ConnectorProblem>(table).map(([code, problem]) => [
    toolCode(code as C),
    problem,
  ]);
}

/** Every refusal the connection doors answer with, by tool code. */
export const CONNECTION_OWNER_TOOL_REFUSALS: Readonly<Record<string, ConnectorProblem>> = {
  ...Object.fromEntries([
    ...byToolCode(LIFECYCLE_PROBLEM, lifecycleToolCode),
    ...byToolCode(OPERATOR_QUERY_PROBLEM, ownerQueryToolCode),
    ...Object.entries(REFUSAL_FAMILIES).flatMap(([family, table]) =>
      byToolCode<string>(table, (code) =>
        connectionToolCode(family as ConnectionRefusalFamily, code)
      )
    ),
  ]),
  CONNECTION_REQUEST_FAILED,
  [AGENT_REQUESTS_OFF_TOOL_CODE]: AGENT_REQUESTS_OFF,
};
