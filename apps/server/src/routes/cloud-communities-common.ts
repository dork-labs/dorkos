/** Shared HTTP answers and owner wording for hosted-space routes. */
import type { IncomingMessage } from 'node:http';
import { RESPONSE_ALREADY_SENT } from '@hono/node-server/utils/response';
import type { Context } from 'hono';
import type { CloudCommunityRefusal } from '@dorkos/shared/cloud-schemas';
import type { ApiEnv } from '../http/api-chain.js';
import type { AccountOwnerWording } from './cloud-owner-bar.js';
import { problemOf } from '../services/core/cloud/v1-client.js';
import { StagingError } from '../services/core/cloud/community-move-upload.js';
import { logger, logError } from '../lib/logger.js';

/** What a person reads when the hosting service could not be reached. */
export const UNREACHABLE = 'Couldn’t reach your DorkOS account. Try again.';

/** What a person reads when this DorkOS is not linked to an account. */
export const NOT_LINKED = 'This DorkOS is not linked to a DorkOS account.';

/**
 * What each hosted-space write says when it refuses a caller that is not the
 * person who owns this install. Each one acts as the DorkOS account (it may
 * use the account's space allowance, or hand out the link that makes someone a
 * space's owner), so each runs the owner bar before anything else.
 */
export const OWNER_ONLY = {
  start: {
    personOnly: 'Only you can start a space on your DorkOS account, from the DorkOS app.',
    action: 'start a space on the DorkOS account',
  },
  move: {
    personOnly: 'Only you can move a space to your DorkOS account, from the DorkOS app.',
    action: 'move a space to the DorkOS account',
  },
  claimLink: {
    personOnly: 'Only you can open the link that makes you a space’s owner, from the DorkOS app.',
    action: 'open the link that makes someone a space’s owner',
  },
  keep: {
    personOnly: 'Only you can choose which spaces stay open, from the DorkOS app.',
    action: 'choose which spaces stay open',
  },
} as const satisfies Record<string, AccountOwnerWording>;

/**
 * What a person reads when they start again with the same file and name as a
 * move that was already cancelled (the start that cancelled it said why).
 */
export const MOVE_ALREADY_CANCELLED =
  'That move was already cancelled, so nothing was sent on to DorkOS. Press Start moving to begin a new one.';

/**
 * A size in the units a person's own computer shows (powers of 1000, as
 * macOS Finder and most file managers count): GB with one decimal from a
 * gigabyte up, then whole MB, KB or bytes.
 *
 * @param bytes - The size in bytes.
 * @param round - `up` for space needed, `down` for space on hand, so a
 *   shortfall never reads as two equal numbers.
 */
export function describeBytes(bytes: number, round: 'up' | 'down'): string {
  const fit = round === 'up' ? Math.ceil : Math.floor;
  if (bytes >= 1e9) return `${(fit(bytes / 1e8) / 10).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${fit(bytes / 1e6)} MB`;
  if (bytes >= 1e3) return `${fit(bytes / 1e3)} KB`;
  return `${bytes} bytes`;
}

/**
 * The size a request declared in its `Content-Length`, or `null` when it
 * declared none (a chunked body) or one that is not a size.
 *
 * @param req - The incoming request.
 */
export function declaredLength(req: IncomingMessage): number | null {
  const header = req.headers['content-length'];
  if (header === undefined || !/^\d+$/.test(header)) return null;
  const bytes = Number(header);
  return Number.isSafeInteger(bytes) ? bytes : null;
}

/**
 * Why an export could not be staged, in words a person can act on, with the
 * status that fits it.
 *
 * @param error - The refusal.
 */
export function stagingRefusal(error: StagingError): { status: number; message: string } {
  switch (error.reason) {
    case 'empty':
      return { status: 400, message: 'That file is empty. Choose the export you saved.' };
    case 'size_unknown':
      return {
        status: 411,
        message:
          'The file arrived without its size, so DorkOS couldn’t check that it fits. Try again from the computer running DorkOS.',
      };
    case 'no_room': {
      const { neededBytes, freeBytes } = error.space ?? { neededBytes: 0, freeBytes: 0 };
      return {
        status: 507,
        message: `This computer doesn’t have room to hold the export. It needs ${describeBytes(neededBytes, 'up')} free and has ${describeBytes(freeBytes, 'down')}. Free up some space, then try again.`,
      };
    }
    case 'space_unknown':
      return {
        status: 507,
        message:
          'This computer’s disk can’t report how much free space it has, so DorkOS didn’t start the move. DorkOS holds the file in its data folder while it goes up. If that folder is on a network drive or another special drive, start DorkOS with its data folder on a local disk (set DORK_HOME to a folder there), then start the move again.',
      };
    case 'size_mismatch':
      return { status: 400, message: 'The file didn’t arrive whole. Try again.' };
  }
}

/**
 * Answer a failed write in words a person can act on.
 *
 * The service's own problem envelope when it described the refusal; otherwise
 * one plain sentence, never the error's own text. Marked `mayExist` when the
 * write may still have gone through: the service could not be reached, or it
 * answered with a server error (5xx), which does not say nothing was made.
 * A refusal it described with a 4xx made nothing.
 *
 * @param c - The request's context.
 * @param error - What the write rejected with.
 * @param what - What was being done, for the log line.
 */
export function writeFailed(c: Context<ApiEnv>, error: unknown, what: string) {
  const problem = problemOf(error);
  if (problem !== null) {
    return c.json({
      ok: false,
      problem,
      ...(problem.status >= 500 ? { mayExist: true as const } : {}),
    } satisfies CloudCommunityRefusal);
  }
  // A Problem was answered above, so this is a failure with no code to name.
  logger.warn(`[Cloud] Could not ${what}`, logError(error));
  return c.json({
    ok: false,
    message: UNREACHABLE,
    mayExist: true,
  } satisfies CloudCommunityRefusal);
}

/**
 * Answer a failed read with a 502 and no body from the service.
 *
 * @param c - The request's context.
 * @param error - What the read rejected with.
 * @param what - What was being read, for the log line.
 */
export function readFailed(c: Context<ApiEnv>, error: unknown, what: string) {
  const problem = problemOf(error);
  logger.warn(`[Cloud] Could not read ${what}`, {
    ...logError(error),
    code: problem?.code,
    status: problem?.status,
  });
  return c.json({ error: UNREACHABLE }, 502);
}

/**
 * What a handler returns when nobody is left to answer (the browser went
 * away): the marker that tells the Node adapter the response is not Hono's to
 * send, as an Express handler that never answered.
 */
export function nobodyToAnswer(): Response {
  return new Response(null, { headers: RESPONSE_ALREADY_SENT.headers });
}
