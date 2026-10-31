/**
 * The guard a sensitive route calls instead of running its action: hold it,
 * and ask the person to confirm it's them (DOR-3234).
 *
 * A guarded route does everything it would before committing, its own person
 * bar and input checks included, then hands its commit to
 * {@link holdForStepUp} rather than calling it. The answer is `428` with the
 * held action's id. The action runs only when the person confirms that id
 * with their password (`routes/step-up.ts`), and the route that confirms it
 * answers with the action's own status and body.
 *
 * Step-up is about who is at the keyboard, never where a message came from: a
 * held action waits on a person's password whatever started the request, and
 * it never lowers or raises any agent's level.
 *
 * @module routes/step-up-guard
 */
import type { Context } from 'hono';

import { STEP_UP_REQUIRED_CODE, type StepUpRequiredBody } from '@dorkos/shared/step-up';

import type { ApiEnv } from '../http/api-chain.js';
import { honoRequestFacts } from '../http/request-facts.js';
import { holdStepUp, type StepUpActionInput } from '../services/core/auth/step-up/step-up-holds.js';
import { ApprovalInputNotBindableError } from '../services/core/approvals/approval-input-hash.js';
import { errorBody } from '../lib/route-utils.js';

/**
 * Hold a route's action until the person confirms it's them, and answer with
 * the held action's id. Nothing is written here.
 *
 * @param c - The request that asked for the action.
 * @param action - What to hold. See {@link StepUpActionInput}.
 * @returns The `428` answer.
 */
export function holdForStepUp(c: Context<ApiEnv>, action: StepUpActionInput): Response {
  let statement;
  try {
    statement = holdStepUp(action, honoRequestFacts(c).user?.sessionId ?? null);
  } catch (error) {
    if (error instanceof ApprovalInputNotBindableError) {
      return c.json(errorBody('That can’t be confirmed as asked.', 'NOT_BINDABLE'), 400);
    }
    throw error;
  }
  const body: StepUpRequiredBody = {
    error: 'Confirm it’s you to do this.',
    code: STEP_UP_REQUIRED_CODE,
    heldActionId: statement.heldActionId,
    expiresAt: statement.expiresAt,
  };
  c.header('Cache-Control', 'no-store');
  return c.json(body, 428);
}
