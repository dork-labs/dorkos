import { RESPONSE_ALREADY_SENT } from '@hono/node-server/utils/response';
import type { Context } from 'hono';
import type { ApiEnv } from '../http/api-chain.js';

/**
 * Run a connector probe for as long as its caller waits, and answer with what
 * it returned. A caller that leaves aborts the probe, and gets no answer.
 *
 * @param c - The request.
 * @param failure - The message for a probe that failed without a message.
 * @param run - The probe, handed the signal that says the caller left.
 */
export async function holdWhileTheCallerWaits(
  c: Context<ApiEnv>,
  failure: string,
  run: (signal: AbortSignal) => Promise<unknown>
): Promise<Response> {
  const { incoming, outgoing } = c.env;
  const controller = new AbortController();
  const abort = () => controller.abort();
  // Nothing is written to the response until the probe answers, so a close
  // before then is the caller leaving.
  const abortClosedResponse = () => {
    if (!outgoing.writableEnded) controller.abort();
  };
  incoming.once('aborted', abort);
  outgoing.once('close', abortClosedResponse);
  try {
    return c.json(await run(controller.signal));
  } catch (error) {
    if (controller.signal.aborted)
      return new Response(null, { headers: RESPONSE_ALREADY_SENT.headers });
    return c.json({ error: error instanceof Error ? error.message : failure }, 500);
  } finally {
    incoming.off('aborted', abort);
    outgoing.off('close', abortClosedResponse);
  }
}
