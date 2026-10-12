/**
 * `PUT /api/heartbeats/triage-credits` (spec `heartbeats` §6.3): a person's
 * answer to "Run cheap checks on DorkOS credits?". **Use credits** sets
 * `heartbeats.triageOnCredits` to `true`; **Not now** sets it to `false`.
 *
 * It spends the account owner's credits, so only the owner may answer, and
 * never an agent: the same owner bar every DorkOS account write runs
 * (`cloud-owner-bar.ts`). The answer is a record row.
 *
 * @module routes/heartbeat-triage
 */
import { Hono } from 'hono';
import { TriageCreditsChoiceSchema } from '@dorkos/shared/heartbeat-schemas';
import type { ApiEnv } from '../http/api-chain.js';
import { readJsonBody } from '../http/request-body.js';
import { honoRequestFacts } from '../http/request-facts.js';
import { validationFailureBody } from '../lib/route-utils.js';
import { errorRefusalUnlessOwner } from './cloud-owner-bar.js';

/** What the route reads and writes. */
export interface HeartbeatTriageRouterDeps {
  /** `heartbeats.triageOnCredits` now. */
  choice(): boolean | null;
  /** Store the person's answer. */
  setChoice(useCredits: boolean): void;
  /** Record the change. */
  record(before: boolean | null, after: boolean): void;
}

/**
 * Build the routes, mounted at `/api/heartbeats/triage-credits`.
 *
 * @param deps - Where the choice lives.
 */
export function createHeartbeatTriageRoutes(deps: HeartbeatTriageRouterDeps): Hono<ApiEnv> {
  const router = new Hono<ApiEnv>();
  router.put('/', (c) => {
    const refusal = errorRefusalUnlessOwner(honoRequestFacts(c), {
      personOnly: 'Only you can choose what pays for checks, from the DorkOS app.',
      action: 'choose what pays for checks',
    });
    if (refusal) return c.json(refusal, 403);
    const parsed = TriageCreditsChoiceSchema.safeParse(readJsonBody(c, { emptyAs: {} }));
    if (!parsed.success) return c.json(validationFailureBody(parsed.error), 400);
    const { useCredits } = parsed.data;
    const before = deps.choice();
    deps.setChoice(useCredits);
    if (before !== useCredits) deps.record(before, useCredits);
    return c.json({ useCredits });
  });
  return router;
}
