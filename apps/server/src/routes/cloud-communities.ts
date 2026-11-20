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
 * Every write is for the owner of this DorkOS and nobody else
 * (`routes/cloud-owner-bar.ts`, DOR-2652): it acts as the DorkOS account. The
 * reads stay open.
 *
 * Reads answer `{ available: false }` and writes a plain refusal when this
 * instance is not linked, with no request leaving the machine. A refusal the
 * service described answers 200 with its problem envelope, for the reason the
 * seat routes give (`routes/cloud.ts`, `seatWriteFailed`).
 *
 * @module routes/cloud-communities
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { CommunityShortNameSchema, type CommunityMove } from '@dork-labs/cloud-api';
import type {
  CloudCommunityClaimLinkResponse,
  CloudCommunityKeepResponse,
  CloudCommunityMove,
  CloudCommunityMovePollResponse,
  CloudCommunityMoveResponse,
  CloudCommunityMoveRoomResponse,
  CloudCommunityNameCheckResponse,
  CloudCommunityRefusal,
  CloudCommunityRestoreResponse,
  CloudCommunitySignInResponse,
  CloudCommunityStartResponse,
  CloudHostedCommunitiesResponse,
} from '@dorkos/shared/cloud-schemas';
import {
  cancelMove,
  checkCommunityName,
  keepCommunity,
  readAccountSignInOrigins,
  readHostedCommunities,
  readMove,
  restoreCommunity,
  startCommunity,
  takeClaimLink,
} from '../services/core/cloud/hosted-communities.js';
import {
  checkRoom,
  communityMoveUploads,
  StagingError,
  type CommunityMoveUploads,
} from '../services/core/cloud/community-move-upload.js';
import { isCloudLinked } from '../services/core/cloud/v1-client.js';
import { envelopeRefusalUnlessOwner, runAccountWrite } from './cloud-owner-bar.js';
import { officialOnlyOrigin } from '../middleware/spaces-enabled.js';
import type { ApiEnv } from '../http/api-chain.js';
import { readJsonBody } from '../http/request-body.js';
import { honoRequestFacts } from '../http/request-facts.js';
import { readQuery } from '../http/request-query.js';
import { startHostedSpaceMove } from './cloud-community-move-http.js';
import {
  UNREACHABLE,
  NOT_LINKED,
  OWNER_ONLY,
  stagingRefusal,
  writeFailed,
  readFailed,
} from './cloud-communities-common.js';

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

/** The query `GET /moves/room` takes: the export's size in bytes. */
const RoomQuerySchema = z.object({
  bytes: z
    .string()
    .regex(/^\d+$/)
    .transform(Number)
    .refine((bytes) => Number.isSafeInteger(bytes)),
});

/** Whether two origins name the same server, however each is spelled. */
function sameOrigin(left: string, right: string): boolean {
  try {
    return new URL(left).origin === new URL(right).origin;
  } catch {
    return false;
  }
}

/**
 * Build the routes over one upload registry. Mount them behind
 * `gateCloudCommunities` (`middleware/spaces-enabled.ts`), as `routes/cloud.ts`
 * does.
 *
 * @param uploads - Where moves' uploads run. The process-wide one by default;
 *   a test passes its own.
 */
export function createCloudCommunitiesRoutes(
  uploads: CommunityMoveUploads = communityMoveUploads
): Hono<ApiEnv> {
  const router = new Hono<ApiEnv>();

  // Nothing any of these routes answers may be cached by the browser or a
  // proxy: one answer carries a claim link, and the rest describe state that a
  // reload must read fresh. Every path below this mount, the `/api` 404 too.
  router.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    await next();
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
  router.get('/', async (c) => {
    if (!isCloudLinked())
      return c.json({ available: false } satisfies CloudHostedCommunitiesResponse);
    try {
      const overview = await readHostedCommunities();
      if (overview === null)
        return c.json({ available: false } satisfies CloudHostedCommunitiesResponse);
      overview.moves.forEach(settleUpload);
      return c.json({
        available: true,
        communities: overview.communities,
        moves: overview.moves.map(withUpload),
        allowance: overview.allowance,
      } satisfies CloudHostedCommunitiesResponse);
    } catch (error) {
      return readFailed(c, error, 'hosted communities');
    }
  });

  /** GET /name-check?name= — whether a web address is free right now. */
  router.get('/name-check', async (c) => {
    const name = CommunityShortNameSchema.safeParse(readQuery(c).name);
    if (!name.success) return c.json({ error: 'That isn’t a web address.' }, 400);
    if (!isCloudLinked())
      return c.json({ available: false } satisfies CloudCommunityNameCheckResponse);
    try {
      const check = await checkCommunityName(name.data);
      return c.json(
        (check === null
          ? { available: false }
          : { available: true, check }) satisfies CloudCommunityNameCheckResponse
      );
    } catch (error) {
      return readFailed(c, error, 'a web address');
    }
  });

  /**
   * GET /sign-in — the space servers where the linked account signs a person
   * in. Unlinked, or a service that does not serve the route yet, answers
   * `{ available: false }`, and the app keeps today's flow.
   */
  router.get('/sign-in', async (c) => {
    if (!isCloudLinked())
      return c.json({ available: false } satisfies CloudCommunitySignInResponse);
    try {
      const all = await readAccountSignInOrigins();
      // With spaces off the gate let this through for the official space alone, so the answer
      // names its server or nothing (spec `official-community-space` D5).
      const official = officialOnlyOrigin(c);
      const origins =
        all === null || official === null
          ? all
          : all.filter((origin) => sameOrigin(origin, official));
      return c.json(
        (origins === null || (official !== null && origins.length === 0)
          ? { available: false }
          : { available: true, origins }) satisfies CloudCommunitySignInResponse
      );
    } catch (error) {
      return readFailed(c, error, 'where the account signs in');
    }
  });

  /** POST / — start a hosted community. The claim link stays on this server. */
  router.post('/', async (c) => {
    const refusal = envelopeRefusalUnlessOwner(honoRequestFacts(c), OWNER_ONLY.start);
    if (refusal) return c.json(refusal, 403);
    if (!isCloudLinked())
      return c.json({ ok: false, message: NOT_LINKED } satisfies CloudCommunityRefusal);
    const body = StartBodySchema.safeParse(readJsonBody(c));
    if (!body.success) {
      return c.json({ ok: false, message: 'Give the space a name.' }, 400);
    }
    return runAccountWrite(c, {
      kind: 'cloud.space',
      target: 'hosted-space',
      input: body.data,
      reason: 'Create a space on your DorkOS account.',
      run: async () => {
        try {
          const started = await startCommunity(body.data);
          return c.json({
            ok: true,
            community: started.community,
            claimReady: started.claimReady,
          } satisfies CloudCommunityStartResponse);
        } catch (error) {
          return writeFailed(c, error, 'start a community');
        }
      },
    });
  });

  /**
   * GET /moves/room?bytes= — whether an export of this size fits on this
   * computer, asked before the browser sends it. The same check `POST /moves`
   * makes as the file arrives, and like it, nothing is held back: that check
   * runs again. Answers 200 either way, with the same plain refusal.
   */
  router.get('/moves/room', async (c) => {
    if (!isCloudLinked())
      return c.json({ ok: false, message: NOT_LINKED } satisfies CloudCommunityRefusal);
    const query = RoomQuerySchema.safeParse(readQuery(c));
    if (!query.success) return c.json({ error: 'That isn’t a file size.' }, 400);
    try {
      await checkRoom(query.data.bytes);
    } catch (error) {
      if (!(error instanceof StagingError)) throw error;
      return c.json({
        ok: false,
        message: stagingRefusal(error).message,
      } satisfies CloudCommunityRefusal);
    }
    return c.json({ ok: true } satisfies CloudCommunityMoveRoomResponse);
  });

  /**
   * POST /moves?idempotencyKey=&name=&shortName= — start a move with the
   * export as the body. Answers once the file is here and the move exists; the
   * upload to the Community server then runs on its own.
   */
  router.post('/moves', (c) => startHostedSpaceMove(c, uploads, withUpload));

  /** GET /moves/:moveId — one move, read from the service every time. */
  router.get('/moves/:moveId', async (c) => {
    if (!isCloudLinked())
      return c.json({ available: false } satisfies CloudCommunityMovePollResponse);
    try {
      const move = await readMove(c.req.param('moveId'));
      if (move === null)
        return c.json({ available: false } satisfies CloudCommunityMovePollResponse);
      settleUpload(move);
      return c.json({
        available: true,
        move: withUpload(move),
      } satisfies CloudCommunityMovePollResponse);
    } catch (error) {
      return readFailed(c, error, 'a move');
    }
  });

  /** POST /moves/:moveId/cancel — cancel a move that is not ready yet. */
  router.post('/moves/:moveId/cancel', async (c) => {
    const refusal = envelopeRefusalUnlessOwner(honoRequestFacts(c), OWNER_ONLY.move);
    if (refusal) return c.json(refusal, 403);
    if (!isCloudLinked())
      return c.json({ ok: false, message: NOT_LINKED } satisfies CloudCommunityRefusal);
    // Stop sending first: whatever the service answers, this process has no
    // further use for the file or the token.
    uploads.discard(c.req.param('moveId'));
    try {
      const move = await cancelMove(c.req.param('moveId'));
      return c.json({ ok: true, move: withUpload(move) } satisfies CloudCommunityMoveResponse);
    } catch (error) {
      return writeFailed(c, error, 'cancel a move');
    }
  });

  /** POST /moves/:moveId/upload — send the export again from the copy held here. */
  router.post('/moves/:moveId/upload', async (c) => {
    const refusal = envelopeRefusalUnlessOwner(honoRequestFacts(c), OWNER_ONLY.move);
    if (refusal) return c.json(refusal, 403);
    if (!isCloudLinked())
      return c.json({ ok: false, message: NOT_LINKED } satisfies CloudCommunityRefusal);
    return runAccountWrite(c, {
      kind: 'cloud.space',
      target: c.req.param('moveId'),
      input: { moveId: c.req.param('moveId') },
      reason: 'Send this space export to your DorkOS account.',
      run: async () => {
        if (!uploads.retry(c.req.param('moveId'))) {
          return c.json({
            ok: false,
            message: 'This DorkOS no longer has the file. Cancel the move and start again.',
          } satisfies CloudCommunityRefusal);
        }
        try {
          const move = await readMove(c.req.param('moveId'));
          if (move === null)
            return c.json({ ok: false, message: UNREACHABLE } satisfies CloudCommunityRefusal);
          return c.json({ ok: true, move: withUpload(move) } satisfies CloudCommunityMoveResponse);
        } catch (error) {
          return writeFailed(c, error, 'read a move');
        }
      },
    });
  });

  /**
   * POST /:communityId/claim-link — the owner-claim link, to open at once in
   * the person's own browser. The only answer in this family that carries one.
   */
  router.post('/:communityId/claim-link', async (c) => {
    const refusal = envelopeRefusalUnlessOwner(honoRequestFacts(c), OWNER_ONLY.claimLink);
    if (refusal) return c.json(refusal, 403);
    if (!isCloudLinked())
      return c.json({ ok: false, message: NOT_LINKED } satisfies CloudCommunityRefusal);
    return runAccountWrite(c, {
      kind: 'cloud.space',
      target: c.req.param('communityId'),
      input: { communityId: c.req.param('communityId') },
      reason: 'Open the link that chooses this space’s owner.',
      run: async () => {
        try {
          const claim = await takeClaimLink(c.req.param('communityId'));
          return c.json({
            ok: true,
            claimUrl: claim.claimUrl,
            expiresAt: claim.expiresAt,
          } satisfies CloudCommunityClaimLinkResponse);
        } catch (error) {
          return writeFailed(c, error, 'get an owner-claim link');
        }
      },
    });
  });

  /** POST /:communityId/keep — keep one community open, confirming what it holds. */
  router.post('/:communityId/keep', async (c) => {
    const refusal = envelopeRefusalUnlessOwner(honoRequestFacts(c), OWNER_ONLY.keep);
    if (refusal) return c.json(refusal, 403);
    if (!isCloudLinked())
      return c.json({ ok: false, message: NOT_LINKED } satisfies CloudCommunityRefusal);
    const body = KeepBodySchema.safeParse(readJsonBody(c));
    if (!body.success) return c.json({ ok: false, message: 'Nothing to confirm.' }, 400);
    return runAccountWrite(c, {
      kind: 'cloud.space',
      target: c.req.param('communityId'),
      input: body.data,
      reason: 'Choose which DorkOS spaces stay open.',
      run: async () => {
        try {
          const kept = await keepCommunity(
            c.req.param('communityId'),
            body.data.expectedHeldCommunityIds
          );
          return c.json({
            ok: true,
            community: kept.community,
            heldCommunityIds: kept.heldCommunityIds,
          } satisfies CloudCommunityKeepResponse);
        } catch (error) {
          return writeFailed(c, error, 'keep a community');
        }
      },
    });
  });

  /** POST /:communityId/restore — reopen a held community. */
  router.post('/:communityId/restore', async (c) => {
    const refusal = envelopeRefusalUnlessOwner(honoRequestFacts(c), OWNER_ONLY.keep);
    if (refusal) return c.json(refusal, 403);
    if (!isCloudLinked())
      return c.json({ ok: false, message: NOT_LINKED } satisfies CloudCommunityRefusal);
    return runAccountWrite(c, {
      kind: 'cloud.space',
      target: c.req.param('communityId'),
      input: { communityId: c.req.param('communityId') },
      reason: 'Reopen this space on your DorkOS account.',
      run: async () => {
        try {
          const community = await restoreCommunity(c.req.param('communityId'));
          return c.json({ ok: true, community } satisfies CloudCommunityRestoreResponse);
        } catch (error) {
          return writeFailed(c, error, 'reopen a community');
        }
      },
    });
  });

  return router;
}
