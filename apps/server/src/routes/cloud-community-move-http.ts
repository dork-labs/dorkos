/** Stage a space export locally, then confirm before starting its move. */
import type { CommunityMove } from '@dork-labs/cloud-api';
import { CommunityShortNameSchema } from '@dork-labs/cloud-api';
import type {
  CloudCommunityMove,
  CloudCommunityMoveResponse,
  CloudCommunityRefusal,
} from '@dorkos/shared/cloud-schemas';
import type { Context } from 'hono';
import { problem, sendProblem, validationProblem } from '@dorkos/http-kit';
import { z } from 'zod';
import type { ApiEnv } from '../http/api-chain.js';
import { honoRequestFacts } from '../http/request-facts.js';
import { readQuery } from '../http/request-query.js';
import { MAX_HELD_STEP_UPS } from '../services/core/auth/step-up/step-up-holds.js';
import { refuseFrontDoorChange } from '../lib/caller-authority.js';
import { logger, logError } from '../lib/logger.js';
import { isCloudLinked } from '../services/core/cloud/v1-client.js';
import { cancelMove, startMove } from '../services/core/cloud/hosted-communities.js';
import {
  stageArchive,
  StagingError,
  discardStagedArchive,
  hostLimitBytes,
  type CommunityMoveUploads,
} from '../services/core/cloud/community-move-upload.js';
import { problemRefusalUnlessOwner, runAccountWrite } from './cloud-owner-bar.js';
import {
  NOT_LINKED,
  OWNER_ONLY,
  MOVE_ALREADY_CANCELLED,
  declaredLength,
  stagingProblem,
  writeFailed,
  nobodyToAnswer,
} from './cloud-communities-common.js';

/** The query `POST /moves` takes; the body is the export itself. */
const MoveQuerySchema = z.object({
  idempotencyKey: z.string().min(1).max(200),
  name: z.string().trim().min(1).max(80),
  shortName: CommunityShortNameSchema.optional(),
});

/** Reserve before reading exports: one pending move per browser, globally bounded too. */
const pendingMoves = new Map<string, symbol>();

/** Hold an uploaded export before any account write or outgoing upload. */
export async function startHostedSpaceMove(
  c: Context<ApiEnv>,
  uploads: CommunityMoveUploads,
  withUpload: (move: CommunityMove) => CloudCommunityMove
): Promise<Response> {
  // The export itself: the chain's JSON parser leaves any other body unread.
  const { incoming: req, outgoing: res } = c.env;
  const ownerRefusal = problemRefusalUnlessOwner(honoRequestFacts(c), OWNER_ONLY.move);
  if (ownerRefusal) {
    // Let the export go by unread, so the browser gets this answer.
    req.resume();
    return sendProblem(c, ownerRefusal);
  }
  const frontDoor = refuseFrontDoorChange(honoRequestFacts(c), 'moving a space');
  if (frontDoor) {
    req.resume();
    return problem(c, 'operator_only', { detail: frontDoor.error });
  }
  if (!isCloudLinked()) {
    req.resume();
    return c.json({ ok: false, message: NOT_LINKED } satisfies CloudCommunityRefusal);
  }
  const query = MoveQuerySchema.safeParse(readQuery(c));
  if (!query.success) {
    req.resume();
    return validationProblem(c, query.error, { detail: 'Give the space a name.' });
  }
  const browser = c.get('user')?.sessionId ?? 'first-run';
  if (pendingMoves.has(browser) || pendingMoves.size >= MAX_HELD_STEP_UPS) {
    req.resume();
    return problem(c, 'move_pending', { detail: 'Confirm or cancel the pending move first.' });
  }
  const reservation = Symbol();
  pendingMoves.set(browser, reservation);
  const release = () => {
    if (pendingMoves.get(browser) === reservation) pendingMoves.delete(browser);
  };
  // The browser can leave after the last byte arrives but before this
  // answers (a cancel, a stall, a closed tab). A move started for nobody
  // would upload and import with no one watching, so it is cancelled.
  let browserLeft = false;
  res.on('close', () => {
    if (!res.writableEnded) browserLeft = true;
  });
  let staged;
  try {
    staged = await stageArchive(req, declaredLength(req));
  } catch (error) {
    release();
    if (error instanceof StagingError) {
      // Every refusal but `size_mismatch` comes before a byte is read. Let
      // the rest of the body go by unread so the browser gets this answer
      // (it reads it once it has sent the file). A mismatch has already
      // closed the connection, so nobody is left to answer.
      req.resume();
      return stagingProblem(c, error);
    }
    // The browser stopped sending (a cancel, a closed tab). Nobody is left to answer.
    logger.warn('[Cloud] A community export did not arrive', logError(error));
    if (!res.headersSent && !req.destroyed) {
      return problem(c, 'invalid_request', { detail: 'The file didn’t arrive. Try again.' });
    }
    return nobodyToAnswer();
  }
  if (browserLeft) {
    release();
    await discardStagedArchive(staged);
    return nobodyToAnswer();
  }
  // A cancelled or expired hold must not retain the staged export.
  let discarded = false;
  let cleanup: Promise<void> | undefined;
  const discard = () => {
    if (discarded) return;
    discarded = true;
    release();
    cleanup = discardStagedArchive(staged).catch((error: unknown) =>
      logger.warn('[Cloud] Could not remove a discarded space export', logError(error))
    );
  };
  const held = await runAccountWrite(c, {
    kind: 'cloud.space',
    target: 'space-move',
    input: { ...query.data, archiveBytes: staged.bytes, archiveSha256: staged.sha256 },
    reason: 'Move this space to your DorkOS account.',
    onDiscard: discard,
    run: async () => {
      try {
        let started;
        try {
          started = await startMove({
            ...query.data,
            archiveBytes: staged.bytes,
            archiveSha256: staged.sha256,
          });
        } catch (error) {
          // The refusal answers 200, so the hold's failure cleanup never sees it.
          discard();
          await cleanup;
          return writeFailed(c, error, 'start a move');
        }
        if (browserLeft) {
          discard();
          await cleanup;
          uploads.discard(started.move.moveId);
          await cancelMove(started.move.moveId).catch((error: unknown) =>
            logger.warn('[Cloud] Could not cancel a move nobody was waiting for', logError(error))
          );
          return nobodyToAnswer();
        }
        if (started.upload !== null && staged.bytes > hostLimitBytes(started.upload)) {
          // The service checks the declared size against the host's limit when the
          // move starts, so this should not happen; if it does, sending would only
          // be refused by the Community server. Stop before a byte leaves.
          const limit = hostLimitBytes(started.upload);
          discard();
          await cleanup;
          // When the cancel does not go through, the move still exists; say so,
          // so a retry with the same key picks it up rather than making another.
          const cancelled = await cancelMove(started.move.moveId).then(
            () => true,
            (error: unknown) => {
              logger.warn(
                '[Cloud] Could not cancel a move too large for its host',
                logError(error)
              );
              return false;
            }
          );
          // `mayExist`: the move could not be cancelled, so a retry with the same key finds it.
          return problem(c, 'request_too_large', {
            detail: 'This export is larger than DorkOS can move.',
            extensions: {
              archiveBytes: staged.bytes,
              limitBytes: limit,
              ...(cancelled ? {} : { mayExist: true }),
            },
          });
        }
        if (started.upload === null && started.move.state === 'cancelled') {
          // A replay of a move that was cancelled, most often by the refusal just
          // above on an earlier try. Answering `ok` would show the person a
          // cancelled move in place of a reason, so say what happened.
          discard();
          await cleanup;
          return problem(c, 'conflict', { detail: MOVE_ALREADY_CANCELLED });
        }
        if (started.upload !== null) {
          void uploads.begin(started.move.moveId, staged, started.upload);
        } else {
          // A replay: the service issued this move's token to an earlier request
          // and keeps no copy. Whatever this process is already doing for the
          // move stands; this second copy is not needed.
          discard();
          await cleanup;
        }
        return c.json({
          ok: true,
          move: withUpload(started.move),
        } satisfies CloudCommunityMoveResponse);
      } finally {
        release();
      }
    },
  });
  if (held.status >= 400 && held.status !== 428) {
    discard();
    await cleanup;
  }
  return held;
}
