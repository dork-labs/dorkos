/**
 * Hosted-community routes — the local API behind "Start a community" and "Move
 * a community here" in the app's community switcher
 * (community-host-operator-api P5). Mounted at `/api/cloud/communities` by the
 * cloud router.
 *
 * The browser talks only to these routes; this server makes every call to the
 * hosting service with the installation credential it already holds. What goes
 * back is always built from the contract client's PARSED values, field by
 * field, never from a service body, so no key the contract does not declare can
 * reach the browser through here.
 *
 * Two one-time credentials exist in this family:
 *
 * - a move's **upload token** never leaves this process. The browser sends the
 *   export here (`POST /moves`), and this server measures it, starts the move,
 *   and streams the file to the Community server itself;
 * - an **owner-claim link** reaches the browser only from `POST
 *   /:communityId/claim-link`, the one action whose job is to open it in the
 *   person's own browser. It is sent `no-store` and appears in no list, poll or
 *   start answer.
 *
 * Reads answer `{ available: false }` and writes a plain refusal when this
 * instance is not linked, with no request leaving the machine. A refusal the
 * service described answers 200 with its problem envelope, for the reason the
 * seat routes give (`routes/cloud.ts`, `seatWriteFailed`).
 *
 * @module routes/cloud-communities
 */
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { CommunityShortNameSchema, type CommunityMove } from '@dork-labs/cloud-api';
import type {
  CloudCommunityClaimLinkResponse,
  CloudCommunityKeepResponse,
  CloudCommunityMove,
  CloudCommunityMovePollResponse,
  CloudCommunityMoveResponse,
  CloudCommunityNameCheckResponse,
  CloudCommunityRefusal,
  CloudCommunityRestoreResponse,
  CloudCommunityStartResponse,
  CloudHostedCommunitiesResponse,
} from '@dorkos/shared/cloud-schemas';
import {
  cancelMove,
  checkCommunityName,
  keepCommunity,
  readHostedCommunities,
  readMove,
  restoreCommunity,
  startCommunity,
  startMove,
  takeClaimLink,
} from '../services/core/cloud/hosted-communities.js';
import {
  communityMoveUploads,
  discardStagedArchive,
  hostLimitBytes,
  stageArchive,
  StagingError,
  type CommunityMoveUploads,
} from '../services/core/cloud/community-move-upload.js';
import { isCloudLinked, problemOf } from '../services/core/cloud/v1-client.js';
import { logger, logError } from '../lib/logger.js';

/** What a person reads when the hosting service could not be reached. */
const UNREACHABLE = 'Couldn’t reach your DorkOS account. Try again.';

/** What a person reads when this DorkOS is not linked to an account. */
const NOT_LINKED = 'This DorkOS is not linked to a DorkOS account.';

/** Move states in which the export can no longer be of use to anyone. */
const FINISHED_MOVE_STATES: ReadonlySet<string> = new Set([
  'ready',
  'failed',
  'cancelled',
  'claimed',
]);

/** A community's display name, as the contract takes it. */
const NameSchema = z.string().trim().min(1).max(80);

/** A caller-chosen idempotency key, as the contract takes it. */
const IdempotencyKeySchema = z.string().min(1).max(200);

/** The body `POST /` takes. */
const StartBodySchema = z.object({
  idempotencyKey: IdempotencyKeySchema,
  name: NameSchema,
  shortName: CommunityShortNameSchema.optional(),
});

/** The body `POST /:communityId/keep` takes. */
const KeepBodySchema = z.object({
  expectedHeldCommunityIds: z.array(z.string().min(1)).max(1000),
});

/** The query `POST /moves` takes; the body is the export itself. */
const MoveQuerySchema = z.object({
  idempotencyKey: IdempotencyKeySchema,
  name: NameSchema,
  shortName: CommunityShortNameSchema.optional(),
});

/**
 * A size in the units a person's own computer shows (powers of 1000, as
 * macOS Finder and most file managers count): GB with one decimal from a
 * gigabyte up, then whole MB, KB or bytes.
 *
 * @param bytes - The size in bytes.
 * @param round - `up` for space needed, `down` for space on hand, so a
 *   shortfall never reads as two equal numbers.
 */
function describeBytes(bytes: number, round: 'up' | 'down'): string {
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
function declaredLength(req: Request): number | null {
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
function stagingRefusal(error: StagingError): { status: number; message: string } {
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
 * one plain sentence, never the error's own text.
 *
 * @param res - The response to answer on.
 * @param error - What the write rejected with.
 * @param what - What was being done, for the log line.
 */
function writeFailed(res: Response, error: unknown, what: string) {
  const problem = problemOf(error);
  if (problem !== null) return res.json({ ok: false, problem } satisfies CloudCommunityRefusal);
  logger.warn(`[Cloud] Could not ${what}`, logError(error));
  return res.json({ ok: false, message: UNREACHABLE } satisfies CloudCommunityRefusal);
}

/**
 * Answer a failed read with a 502 and no body from the service.
 *
 * @param res - The response to answer on.
 * @param error - What the read rejected with.
 * @param what - What was being read, for the log line.
 */
function readFailed(res: Response, error: unknown, what: string) {
  logger.warn(`[Cloud] Could not read ${what}`, logError(error));
  return res.status(502).json({ error: UNREACHABLE });
}

/**
 * Build the router over one upload registry.
 *
 * @param uploads - Where moves' uploads run. The process-wide one by default;
 *   a test passes its own.
 */
export function createCloudCommunitiesRouter(
  uploads: CommunityMoveUploads = communityMoveUploads
): Router {
  const router = Router();

  // Nothing any of these routes answers may be cached by the browser or a
  // proxy: one answer carries a claim link, and the rest describe state that a
  // reload must read fresh.
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  /**
   * One move as the browser sees it: the service's parsed move, field by
   * field, plus this process's upload progress.
   *
   * @param move - The parsed move.
   */
  function withUpload(move: CommunityMove): CloudCommunityMove {
    return {
      moveId: move.moveId,
      communityId: move.communityId,
      communityUrl: move.communityUrl,
      name: move.name,
      state: move.state,
      failureCode: move.failureCode,
      report: move.report,
      pollAfterMs: move.pollAfterMs,
      updatedAt: move.updatedAt,
      upload: uploads.progress(move.moveId),
    };
  }

  /**
   * Let go of a move's local upload once the service says it can no longer use one.
   *
   * @param move - The move as the service now reports it.
   */
  function settleUpload(move: CommunityMove) {
    // Known end states only: a state this release does not know might still be
    // waiting for the file, and dropping it then would strand the move.
    if (FINISHED_MOVE_STATES.has(move.state)) uploads.discard(move.moveId);
  }

  /** GET / — this account's hosted communities, its moves, and its allowance. */
  router.get('/', async (_req, res) => {
    if (!isCloudLinked())
      return res.json({ available: false } satisfies CloudHostedCommunitiesResponse);
    try {
      const overview = await readHostedCommunities();
      if (overview === null)
        return res.json({ available: false } satisfies CloudHostedCommunitiesResponse);
      overview.moves.forEach(settleUpload);
      return res.json({
        available: true,
        communities: overview.communities,
        moves: overview.moves.map(withUpload),
        allowance: overview.allowance,
      } satisfies CloudHostedCommunitiesResponse);
    } catch (error) {
      return readFailed(res, error, 'hosted communities');
    }
  });

  /** GET /name-check?name= — whether a web address is free right now. */
  router.get('/name-check', async (req, res) => {
    const name = CommunityShortNameSchema.safeParse(req.query.name);
    if (!name.success) return res.status(400).json({ error: 'That isn’t a web address.' });
    if (!isCloudLinked())
      return res.json({ available: false } satisfies CloudCommunityNameCheckResponse);
    try {
      const check = await checkCommunityName(name.data);
      return res.json(
        (check === null
          ? { available: false }
          : { available: true, check }) satisfies CloudCommunityNameCheckResponse
      );
    } catch (error) {
      return readFailed(res, error, 'a web address');
    }
  });

  /** POST / — start a hosted community. The claim link stays on this server. */
  router.post('/', async (req, res) => {
    if (!isCloudLinked())
      return res.json({ ok: false, message: NOT_LINKED } satisfies CloudCommunityRefusal);
    const body = StartBodySchema.safeParse(req.body);
    if (!body.success) {
      return res.status(400).json({ ok: false, message: 'Give the community a name.' });
    }
    try {
      const started = await startCommunity(body.data);
      return res.json({
        ok: true,
        community: started.community,
        claimReady: started.claimReady,
      } satisfies CloudCommunityStartResponse);
    } catch (error) {
      return writeFailed(res, error, 'start a community');
    }
  });

  /**
   * POST /moves?idempotencyKey=&name=&shortName= — start a move with the
   * export as the body. Answers once the file is here and the move exists; the
   * upload to the Community server then runs on its own.
   */
  router.post('/moves', async (req: Request, res: Response) => {
    if (!isCloudLinked()) {
      req.resume();
      return res.json({ ok: false, message: NOT_LINKED } satisfies CloudCommunityRefusal);
    }
    const query = MoveQuerySchema.safeParse(req.query);
    if (!query.success) {
      req.resume();
      return res.status(400).json({ ok: false, message: 'Give the community a name.' });
    }
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
      if (error instanceof StagingError) {
        // Every refusal but `size_mismatch` comes before a byte is read. Let
        // the rest of the body go by unread so the browser gets this answer
        // (it reads it once it has sent the file). A mismatch has already
        // closed the connection, so nobody is left to answer.
        req.resume();
        const refusal = stagingRefusal(error);
        return res
          .status(refusal.status)
          .json({ ok: false, message: refusal.message } satisfies CloudCommunityRefusal);
      }
      // The browser stopped sending (a cancel, a closed tab). Nobody is left to answer.
      logger.warn('[Cloud] A community export did not arrive', logError(error));
      if (!res.headersSent && !req.destroyed) {
        return res.status(400).json({ ok: false, message: 'The file didn’t arrive. Try again.' });
      }
      return;
    }
    if (browserLeft) {
      await discardStagedArchive(staged);
      return;
    }
    let started;
    try {
      started = await startMove({
        ...query.data,
        archiveBytes: staged.bytes,
        archiveSha256: staged.sha256,
      });
    } catch (error) {
      await discardStagedArchive(staged);
      return writeFailed(res, error, 'start a move');
    }
    if (browserLeft) {
      await discardStagedArchive(staged);
      uploads.discard(started.move.moveId);
      await cancelMove(started.move.moveId).catch((error: unknown) =>
        logger.warn('[Cloud] Could not cancel a move nobody was waiting for', logError(error))
      );
      return;
    }
    if (started.upload !== null && staged.bytes > hostLimitBytes(started.upload)) {
      // The service checks the declared size against the host's limit when the
      // move starts, so this should not happen; if it does, sending would only
      // be refused by the Community server. Stop before a byte leaves.
      const limit = hostLimitBytes(started.upload);
      await discardStagedArchive(staged);
      await cancelMove(started.move.moveId).catch((error: unknown) =>
        logger.warn('[Cloud] Could not cancel a move too large for its host', logError(error))
      );
      return res.status(413).json({
        ok: false,
        message: `This export is too large for the new host. It is ${describeBytes(staged.bytes, 'up')}, and the most the host takes is ${describeBytes(limit, 'down')}.`,
      } satisfies CloudCommunityRefusal);
    }
    if (started.upload !== null) {
      void uploads.begin(started.move.moveId, staged, started.upload);
    } else {
      // A replay: the service issued this move's token to an earlier request
      // and keeps no copy. Whatever this process is already doing for the
      // move stands; this second copy is not needed.
      await discardStagedArchive(staged);
    }
    return res.json({
      ok: true,
      move: withUpload(started.move),
    } satisfies CloudCommunityMoveResponse);
  });

  /** GET /moves/:moveId — one move, read from the service every time. */
  router.get('/moves/:moveId', async (req, res) => {
    if (!isCloudLinked())
      return res.json({ available: false } satisfies CloudCommunityMovePollResponse);
    try {
      const move = await readMove(req.params.moveId);
      if (move === null)
        return res.json({ available: false } satisfies CloudCommunityMovePollResponse);
      settleUpload(move);
      return res.json({
        available: true,
        move: withUpload(move),
      } satisfies CloudCommunityMovePollResponse);
    } catch (error) {
      return readFailed(res, error, 'a move');
    }
  });

  /** POST /moves/:moveId/cancel — cancel a move that is not ready yet. */
  router.post('/moves/:moveId/cancel', async (req, res) => {
    if (!isCloudLinked())
      return res.json({ ok: false, message: NOT_LINKED } satisfies CloudCommunityRefusal);
    // Stop sending first: whatever the service answers, this process has no
    // further use for the file or the token.
    uploads.discard(req.params.moveId);
    try {
      const move = await cancelMove(req.params.moveId);
      return res.json({ ok: true, move: withUpload(move) } satisfies CloudCommunityMoveResponse);
    } catch (error) {
      return writeFailed(res, error, 'cancel a move');
    }
  });

  /** POST /moves/:moveId/upload — send the export again from the copy held here. */
  router.post('/moves/:moveId/upload', async (req, res) => {
    if (!isCloudLinked())
      return res.json({ ok: false, message: NOT_LINKED } satisfies CloudCommunityRefusal);
    if (!uploads.retry(req.params.moveId)) {
      return res.json({
        ok: false,
        message: 'This DorkOS no longer has the file. Cancel the move and start again.',
      } satisfies CloudCommunityRefusal);
    }
    try {
      const move = await readMove(req.params.moveId);
      if (move === null)
        return res.json({ ok: false, message: UNREACHABLE } satisfies CloudCommunityRefusal);
      return res.json({ ok: true, move: withUpload(move) } satisfies CloudCommunityMoveResponse);
    } catch (error) {
      return writeFailed(res, error, 'read a move');
    }
  });

  /**
   * POST /:communityId/claim-link — the owner-claim link, to open at once in
   * the person's own browser. The only answer in this family that carries one.
   */
  router.post('/:communityId/claim-link', async (req, res) => {
    if (!isCloudLinked())
      return res.json({ ok: false, message: NOT_LINKED } satisfies CloudCommunityRefusal);
    try {
      const claim = await takeClaimLink(req.params.communityId);
      return res.json({
        ok: true,
        claimUrl: claim.claimUrl,
        expiresAt: claim.expiresAt,
      } satisfies CloudCommunityClaimLinkResponse);
    } catch (error) {
      return writeFailed(res, error, 'get an owner-claim link');
    }
  });

  /** POST /:communityId/keep — keep one community open, confirming what it holds. */
  router.post('/:communityId/keep', async (req, res) => {
    if (!isCloudLinked())
      return res.json({ ok: false, message: NOT_LINKED } satisfies CloudCommunityRefusal);
    const body = KeepBodySchema.safeParse(req.body);
    if (!body.success) return res.status(400).json({ ok: false, message: 'Nothing to confirm.' });
    try {
      const kept = await keepCommunity(req.params.communityId, body.data.expectedHeldCommunityIds);
      return res.json({
        ok: true,
        community: kept.community,
        heldCommunityIds: kept.heldCommunityIds,
      } satisfies CloudCommunityKeepResponse);
    } catch (error) {
      return writeFailed(res, error, 'keep a community');
    }
  });

  /** POST /:communityId/restore — reopen a held community. */
  router.post('/:communityId/restore', async (req, res) => {
    if (!isCloudLinked())
      return res.json({ ok: false, message: NOT_LINKED } satisfies CloudCommunityRefusal);
    try {
      const community = await restoreCommunity(req.params.communityId);
      return res.json({ ok: true, community } satisfies CloudCommunityRestoreResponse);
    } catch (error) {
      return writeFailed(res, error, 'reopen a community');
    }
  });

  return router;
}
