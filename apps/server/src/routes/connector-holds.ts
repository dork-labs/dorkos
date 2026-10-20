/**
 * `POST /api/connectors/holds/:holdId/cancel`: cancel an agent's irreversible
 * action in a connected app while it waits out its cancel window (spec
 * `trusted-by-default-flip` §5.6, DOR-2739). The Cancel button on its
 * notification calls this.
 *
 * A person may cancel, and so may any agent except the one that asked: an
 * agent is recognised by its `X-DorkOS-Agent` identity, and the requester's own
 * is refused. The same rule as the `connectors.cancel_held_action` tool.
 *
 * @module routes/connector-holds
 */
import { Hono } from 'hono';
import type { ApiEnv } from '../http/api-chain.js';
import { honoRequestFacts } from '../http/request-facts.js';
import { presentsAgentIdentity } from '../middleware/agent-identity.js';
import type {
  DestructiveHoldService,
  HoldCanceller,
} from '../services/connectors/execution/destructive-hold.js';
import { CANCEL_REFUSALS } from '../services/connectors/execution/hold-capabilities.js';

/** What the hold routes read. */
export interface ConnectorHoldRouterDeps {
  /** The server's held actions. */
  holds: Pick<DestructiveHoldService, 'cancel'>;
}

/**
 * Build the hold routes, for mounting under `/api/connectors`.
 *
 * @param deps - The hold service.
 * @returns The routes.
 */
export function createConnectorHoldRoutes(deps: ConnectorHoldRouterDeps): Hono<ApiEnv> {
  const router = new Hono<ApiEnv>();

  router.post('/holds/:holdId/cancel', (c) => {
    const facts = honoRequestFacts(c);
    const identity = facts.agentIdentity;
    const canceller: HoldCanceller = !presentsAgentIdentity(facts)
      ? { kind: 'person' }
      : identity
        ? { kind: 'agent', agentPath: identity.agentPath, name: identity.displayName }
        : { kind: 'unidentified' };
    const holdId = c.req.param('holdId');
    const result = deps.holds.cancel(holdId, canceller);
    if (!result.ok) {
      return c.json(
        { error: CANCEL_REFUSALS[result.code], code: result.code },
        result.code === 'HOLD_REQUESTER' ? 403 : 404
      );
    }
    return c.json({ status: 'cancelled' as const, holdId });
  });

  return router;
}
