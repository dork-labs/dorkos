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
import { Router } from 'express';
import { TriageCreditsChoiceSchema } from '@dorkos/shared/heartbeat-schemas';
import { parseBody } from '../lib/route-utils.js';
import { refuseErrorUnlessOwner } from './cloud-owner-bar.js';

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
 * Build the router, mounted at `/api/heartbeats/triage-credits`.
 *
 * @param deps - Where the choice lives.
 */
export function createHeartbeatTriageRouter(deps: HeartbeatTriageRouterDeps): Router {
  const router = Router();
  router.put('/', (req, res) => {
    if (
      refuseErrorUnlessOwner(req, res, {
        personOnly: 'Only you can choose what pays for checks, from the DorkOS app.',
        action: 'choose what pays for checks',
      })
    ) {
      return;
    }
    const body = parseBody(TriageCreditsChoiceSchema, req.body ?? {}, res);
    if (!body) return;
    const before = deps.choice();
    deps.setChoice(body.useCredits);
    if (before !== body.useCredits) deps.record(before, body.useCredits);
    res.json({ useCredits: body.useCredits });
  });
  return router;
}
