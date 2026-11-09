/**
 * Re-export of `@dork-labs/connector-providers/connector-schemas`, kept so the
 * `@dorkos/shared/connector-schemas` subpath stays one import for everything in this repo.
 *
 * The module itself lives in `packages/connector-providers`, which publishes it
 * so hosted services can read the same connector contract without this
 * private package. Edit it there; this file forwards it, with one exception
 * below.
 *
 * @module shared/connector-schemas
 */
import type { ConnectorAgentRequestItem as ProviderAgentRequestItem } from '@dork-labs/connector-providers/connector-schemas';
import type { ConnectorAgentApproval } from './connector-exclusion-schemas.js';

export * from '@dork-labs/connector-providers/connector-schemas';
export type { ConnectorAgentApproval } from './connector-exclusion-schemas.js';

/**
 * One agent's request for an app, as its owner reads it: the connector contract's item, plus who
 * approved it when another agent did (`approvedBy`). That one field is DorkOS's, not the
 * connector contract's: the owner's request routes add it from the access-change ledger, so it
 * lives here and the published contract stays as it is. This name shadows the forwarded one.
 */
export type ConnectorAgentRequestItem = ProviderAgentRequestItem & {
  approvedBy?: ConnectorAgentApproval;
};
