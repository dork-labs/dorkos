/**
 * The services the owner's management doors read
 * (`owner-management-capabilities.ts`), kept apart so the connection doors'
 * deps (`owner-capabilities.ts`) can extend them without the two files
 * importing each other.
 *
 * @module services/connectors/resources/owner-door-types
 */
import type { ConnectorGrantExclusionService } from '../access/grant-exclusions.js';
import type { ConnectorAgentRequestService } from '../agent-request-service.js';
import type { ConnectorAccessQueryService } from '../execution/access-query-service.js';
import type { ConnectorManagementReviewService } from '../management-review-service.js';
import type { ConnectorReconciliationService } from '../reconciliation-service.js';

/** What the owner's management doors read, beside the connection doors' deps. */
export interface ConnectionManagementDeps {
  /** Programs' requests for an account change, as the owner reviews them. */
  readonly reviews: Pick<ConnectorManagementReviewService, 'get' | 'list'>;
  /** Agents' requests for an app; absent while agent identity is off. */
  readonly agentRequests?: Pick<
    ConnectorAgentRequestService,
    'pollAuthentication' | 'resolve' | 'startAuthentication'
  >;
  /** Which agents may use what. */
  readonly reconciliation: Pick<ConnectorReconciliationService, 'revokeEveryAgent'>;
  /** Agents left out of a connection's every-agent share. */
  readonly exclusions: Pick<ConnectorGrantExclusionService, 'leaveOut' | 'letBackIn' | 'list'>;
  /** The owner's usage of connected apps. */
  readonly usage: Pick<ConnectorAccessQueryService, 'listOperatorUsage'>;
}
