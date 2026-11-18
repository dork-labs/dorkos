/** Shared HTTP answers for account writes. */
import type { Context } from 'hono';
import type { Problem } from '@dork-labs/cloud-api';
import type { ApiEnv } from '../http/api-chain.js';
import { isAbsent, problemOf } from '../services/core/cloud/v1-client.js';
import { logger, logError } from '../lib/logger.js';

/** What a refusal envelope looks like on the wire, whichever write produced it. */
type CloudWriteRefusal = { ok: false; problem: Problem } | { ok: false; message: string };

/** How one write words the refusals the service did not describe. */
interface WriteFailureWording {
  /** What was being done, for the log line. */
  what: string;
  /**
   * What to tell the person when the service answers "not found". The service
   * gives the same answer for a route it does not serve and for a thing the
   * write named that it cannot find, so this one sentence has to be true in
   * both cases. Without it, such a refusal is passed through like any other.
   */
  absent?: string;
  /**
   * What to tell the person when the service gave no answer it could read (a
   * timeout, a broken body) for a write that may have done something anyway.
   * Without it, such a failure reads as the account being out of reach.
   */
  unconfirmed?: string;
}

/**
 * Answer a failed cloud write: the service's own refusal verbatim, or one plain
 * sentence of ours.
 *
 * This is the whole reason the app can say "this needs a plan change" without
 * knowing a single plan: the words, including `requiredPlanDisplayName`, are the
 * service's.
 *
 * A "not found" is the exception. Its words are written for developers, not
 * people, so a write that can meet one names its own plain sentence in
 * `wording.absent`. That one sentence covers both things "not found" can mean
 * here, because the answer looks the same either way: the service does not
 * serve this write, or it cannot find what the write named.
 *
 * **It answers 200, and that is not sloppiness.** A refusal a plan change would
 * lift is an ANSWER this route succeeded in obtaining, not a failure of this
 * route — and the client's `fetchJSON` throws on every non-2xx, discarding the
 * body into an exception whose shape the caller would have to reverse-engineer.
 * Passing the status through would therefore make the one affordance this whole
 * feature exists for — explaining a refusal in the service's own words —
 * unreachable in the running app while still passing a mocked test. The
 * `{ ok: false, problem }` envelope carries the service's status inside
 * `problem.status`, so nothing is lost.
 *
 * @param c - The request's context.
 * @param error - The value the write rejected with.
 * @param wording - What was being done, and what to say when it is not served.
 */
export function cloudWriteFailed(c: Context<ApiEnv>, error: unknown, wording: WriteFailureWording) {
  if (wording.absent !== undefined && isAbsent(error)) {
    return c.json({ ok: false, message: wording.absent } satisfies CloudWriteRefusal);
  }
  const problem = problemOf(error);
  if (problem !== null) {
    return c.json({ ok: false, problem } satisfies CloudWriteRefusal);
  }
  logger.warn(`[Cloud] Could not ${wording.what}`, logError(error));
  return c.json({
    ok: false,
    message: wording.unconfirmed ?? 'Couldn’t reach your DorkOS account. Try again shortly.',
  } satisfies CloudWriteRefusal);
}

/** Said, with HTTP 200, by every cloud write while this instance is not linked. */
export const NOT_LINKED: CloudWriteRefusal = {
  ok: false,
  message: 'This instance is not linked to a DorkOS account.',
};
