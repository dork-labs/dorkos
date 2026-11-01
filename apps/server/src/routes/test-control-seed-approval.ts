/**
 * `POST /api/test/seed-approval`, one of the test-control routes: raise a
 * request card for an action no agent can reach yet. Test runtime only, like
 * every route under `/api/test`.
 *
 * @module routes/test-control-seed-approval
 */
import type { Hono } from 'hono';
import { z } from 'zod';
import { PERMISSION_AREA_IDS } from '@dorkos/shared/permissions';
import { hashApprovalInput } from '../services/core/approvals/index.js';
import { isRepoPinCapabilityId } from '../services/runtimes/claude-code/repo-settings/repo-config-approval.js';
import type { ApiEnv } from '../http/api-chain.js';
import { readJsonBody } from '../http/request-body.js';
import { validationFailureBody } from '../lib/route-utils.js';
import type { TestControlDeps } from './test-control.js';

/** What `POST /api/test/seed-approval` needs to raise one request card. */
const seedApprovalSchema = z.object({
  /**
   * A real capability id, so the card's title and tier come from the registry.
   * Never a repo-pin card: only the launch raises those (DOR-3359).
   */
  capabilityId: z
    .string()
    .min(1)
    .refine((id) => !isRepoPinCapabilityId(id), 'Repo-pin cards are raised only by a launch.'),
  /** The registered agent the card says asked. */
  agentPath: z.string().min(1),
  /** The permission area the request is in. A floor area draws the floor card. */
  area: z.enum(PERMISSION_AREA_IDS),
  /** The sentence the card shows. */
  summary: z.string().min(1).max(500),
});

/**
 * Mount `POST /seed-approval`: raise a request card for an action no agent can
 * reach yet in this phase, such as one in a floor area (spec
 * `agent-permissions` phase 2 verification). It records the approval exactly
 * as the gate's `ask()` would, through the real approval service, so the card a
 * test answers is the production card. The agent must be registered here, for
 * the reason `/agent-token` gives.
 *
 * @param router - The test-control router.
 * @param deps - Where the mesh and the approval service come from.
 */
export function registerSeedApprovalRoute(
  router: Hono<ApiEnv>,
  deps: Pick<TestControlDeps, 'meshCore' | 'approvals'>
): void {
  router.post('/seed-approval', async (c) => {
    const parsed = seedApprovalSchema.safeParse(readJsonBody(c));
    if (!parsed.success) {
      return c.json(validationFailureBody(parsed.error), 400);
    }
    const { capabilityId, agentPath, area, summary } = parsed.data;
    const agent = deps.meshCore?.()?.getByPath(agentPath);
    if (!agent) {
      return c.json({ error: `No agent is registered at ${agentPath}.` }, 404);
    }
    const approvals = deps.approvals?.();
    if (!approvals) {
      return c.json({ error: 'The approval service is not running on this server.' }, 503);
    }
    const ticket = approvals.request({
      capabilityId,
      inputHash: hashApprovalInput({ seeded: summary }),
      summary,
      requestedBy: agent.displayName ?? agent.name,
      requestedByPath: agentPath,
      area,
    });
    return c.json({ approvalId: ticket.approvalId });
  });
}
