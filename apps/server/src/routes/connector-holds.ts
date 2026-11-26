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
import { problem } from '@dorkos/http-kit';
import type { ApiEnv } from '../http/api-chain.js';
import { honoRequestFacts } from '../http/request-facts.js';
import { presentsAgentIdentity } from '../lib/http/agent-identity-header.js';
import type {
  DestructiveHoldService,
  HoldCanceller,
} from '../services/connectors/execution/destructive-hold.js';
import type { CancelHoldResult } from '../services/connectors/execution/destructive-hold.js';
import type { ConnectorProblem } from './connector-problems.js';

/** Each cancel refusal's problem: a fixed sentence per code (DOR-4979). */
const CANCEL_PROBLEM: Record<Exclude<CancelHoldResult, { ok: true }>['code'], ConnectorProblem> = {
  HOLD_NOT_FOUND: {
    code: 'not_found',
    detail: 'Nothing is waiting under that id. It ran, was cancelled, or DorkOS restarted.',
  },
  HOLD_REQUESTER: {
    code: 'forbidden',
    detail: 'The agent that asked for this can’t cancel it. Anyone else can.',
  },
};

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
      const { code, detail } = CANCEL_PROBLEM[result.code];
      return problem(c, code, { detail });
    }
    return c.json({ status: 'cancelled' as const, holdId });
  });

  return router;
}
