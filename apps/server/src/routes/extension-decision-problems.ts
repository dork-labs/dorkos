/**
 * How the extension decision routes answer a refusal: as problem documents
 * (DOR-4979), whether the answer goes out at once or after a step-up confirm.
 *
 * The inbox keeps its own words for a refused answer (`already_resolved`,
 * `stale_decision`, …). Each goes out as the code on the problem code list
 * that means it, which the app and extension pages branch on: a question
 * that changed is `precondition_failed`, a settled one or a closed offer is
 * `already_resolved`, an extension that is off is `not_running`.
 *
 * @module routes/extension-decision-problems
 */
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { problemBody, sendProblem, type ProblemStatus } from '@dorkos/http-kit';
import { isProblem, type Problem, type ProblemCode } from '@dorkos/shared/problem';
import type { StepUpCommitResult } from '../services/core/auth/step-up/step-up-holds.js';
import { logger } from '../lib/logger.js';

/** How one inbox refusal code goes out. */
interface Wire {
  code: ProblemCode;
  /** The fixed sentence for it: the inbox's own message is logged, never sent. */
  detail: string;
  status?: ProblemStatus;
}

/** The inbox's refusal codes, as problem codes. */
const WIRE: Readonly<Record<string, Wire>> = {
  not_found: { code: 'not_found', detail: 'There is no such decision.' },
  bad_answer: { code: 'invalid_request', detail: 'That answer doesn’t fit this question.' },
  already_resolved: { code: 'already_resolved', detail: 'This was already settled.' },
  not_running: { code: 'not_running', detail: 'That extension isn’t running right now.' },
  stale_decision: {
    code: 'precondition_failed',
    detail: 'This question changed. Take another look.',
  },
  offer_gone: { code: 'already_resolved', detail: 'That offer is no longer open.' },
  busy: {
    code: 'conflict',
    detail: 'The extension is still working on this. Try again soon.',
  },
  extension_timeout: {
    code: 'temporarily_unavailable',
    detail: 'The extension didn’t answer in time. Try again.',
    status: 504,
  },
  extension_error: {
    code: 'temporarily_unavailable',
    detail: 'The extension couldn’t take that. Try again.',
    status: 502,
  },
  offer_project_unavailable: {
    code: 'conflict',
    detail: 'That project is no longer available.',
  },
  offer_failed: { code: 'internal_error', detail: 'Couldn’t change that. Try again.' },
};

/** A code the table does not know, by its status. */
function byStatus(status: number): Wire {
  if (status === 400) return { code: 'invalid_request', detail: 'That answer wasn’t accepted.' };
  if (status === 404) return { code: 'not_found', detail: 'There is no such decision.' };
  if (status === 409)
    return { code: 'conflict', detail: 'That changed meanwhile. Take another look.' };
  return { code: 'internal_error', detail: 'The answer wasn’t saved. Try again.' };
}

/**
 * The problem document for an inbox refusal.
 *
 * @param refusal - The inbox's status, code and sentence.
 * @returns The status and the problem document, as a step-up commit carries them.
 */
export function decisionRefusal(refusal: {
  status: number;
  code: string;
  message: string;
}): StepUpCommitResult {
  const wire = Object.hasOwn(WIRE, refusal.code) ? WIRE[refusal.code]! : byStatus(refusal.status);
  if (!Object.hasOwn(WIRE, refusal.code) || wire.code === 'internal_error')
    logger.warn('[Extensions] A decision answer was refused', {
      code: refusal.code,
      why: refusal.message,
    });
  const body = problemBody(wire.code, {
    detail: wire.detail,
    ...(wire.status === undefined ? {} : { status: wire.status }),
  });
  return { status: body.status, body };
}

/**
 * The problem document for a yes refused because it came over Wi-Fi.
 *
 * @param refusal - The Wi-Fi bar's sentence.
 * @returns The document.
 */
export function wifiRefusal(refusal: { error: string }): Problem {
  return problemBody('not_from_wifi', { detail: refusal.error });
}

/**
 * Answer what an answer route's run came to: a problem document when it
 * refused, its JSON otherwise.
 *
 * @param c - The Hono context.
 * @param outcome - The status and body.
 * @returns The response.
 */
export function answerOutcome(c: Context, outcome: StepUpCommitResult): Response {
  if (outcome.status >= 400 && isProblem(outcome.body)) return sendProblem(c, outcome.body);
  return c.json(outcome.body as never, outcome.status as ContentfulStatusCode);
}
