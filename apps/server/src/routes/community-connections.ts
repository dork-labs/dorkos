/**
 * Local, owner-scoped connection endpoints. Browser responses contain only
 * descriptors and approval URLs; all pairing proof and bearer material stays
 * inside the local server's encrypted store.
 *
 * @module routes/community-connections
 */
import { Router, type Request, type Response } from 'express';
import { CommunityRefSchema } from '@dorkos/shared/community-adapter';
import {
  CommunityConnectionStartRequestSchema,
  CommunityConnectionStartResponseSchema,
  CommunityConnectionListResponseSchema,
  CommunityConnectionStatusResponseSchema,
  CommunityConnectionPollResponseSchema,
} from '@dorkos/shared/community-connections';
import { readOwnerAccount } from '../services/core/auth/index.js';
import { getRoomService } from '../services/rooms/index.js';
import { resolveCaller } from './room-caller.js';
import { isLocalCaller, requireOperatorCookieUnderLogin } from '../lib/caller-authority.js';
import { RemoteConnectionNotFoundError } from '../services/communities/remote/connection-store.js';
import {
  RemoteCommunityPairingService,
  RemotePairingBusyError,
} from '../services/communities/remote/pairing-service.js';
import { PinnedOriginError } from '../services/communities/remote/pinned-origin.js';
import { getRemotePairingService } from '../services/communities/remote/state.js';

/** Resolve the only local human allowed to use a stored community connection. */
export function resolveCommunityOwner(req: Request, res: Response): string | null {
  const cookieRefusal = requireOperatorCookieUnderLogin(res, 'community connections');
  if (cookieRefusal) {
    res.status(cookieRefusal.status).json({ error: cookieRefusal.error, code: cookieRefusal.code });
    return null;
  }
  if (!res.locals.user && !isLocalCaller(req)) {
    res.status(403).json({ error: 'Manage community connections from this machine.' });
    return null;
  }
  let caller;
  try {
    caller = resolveCaller(req, res);
  } catch {
    res.status(403).json({ error: 'An agent cannot manage community connections.' });
    return null;
  }
  if (!getRoomService().authorRegistry.isOwner(caller.id, readOwnerAccount()?.id ?? null)) {
    res.status(403).json({ error: 'Only this install’s owner can manage community connections.' });
    return null;
  }
  return caller.id;
}

function failure(res: Response, error: unknown): void {
  if (error instanceof RemotePairingBusyError) {
    res.status(409).json({ error: 'This pairing is still finishing. Try again in a moment.' });
  } else if (error instanceof RemoteConnectionNotFoundError) {
    res.status(404).json({ error: 'Community connection not found.' });
  } else if (error instanceof PinnedOriginError) {
    res
      .status(error.code === 'INVALID_ORIGIN' || error.code === 'UNSAFE_ADDRESS' ? 400 : 502)
      .json({
        error:
          error.code === 'INVALID_ORIGIN' || error.code === 'UNSAFE_ADDRESS'
            ? 'Enter an accessible HTTPS community address.'
            : 'The community could not complete this connection request.',
      });
  } else {
    res.status(502).json({ error: 'The community connection is unavailable.' });
  }
}

/** Build the production route or inject an isolated service in HTTP tests. */
export function createCommunityConnectionsRouter(
  connectionService: RemoteCommunityPairingService = getRemotePairingService()
): Router {
  const router = Router();
  router.get('/', async (req, res) => {
    const owner = resolveCommunityOwner(req, res);
    if (!owner) return;
    try {
      res.json(
        CommunityConnectionListResponseSchema.parse({
          connections: await connectionService.list(owner),
        })
      );
    } catch (error) {
      failure(res, error);
    }
  });
  router.post('/', async (req, res) => {
    const owner = resolveCommunityOwner(req, res);
    if (!owner) return;
    const parsed = CommunityConnectionStartRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Enter a valid community address and install name.' });
      return;
    }
    try {
      res
        .status(201)
        .json(
          CommunityConnectionStartResponseSchema.parse(
            await connectionService.start(owner, parsed.data.url, parsed.data.installName)
          )
        );
    } catch (error) {
      failure(res, error);
    }
  });
  router.get('/:ref', async (req, res) => {
    const owner = resolveCommunityOwner(req, res);
    if (!owner) return;
    const ref = CommunityRefSchema.safeParse(req.params.ref);
    if (!ref.success) {
      res.status(404).json({ error: 'Community connection not found.' });
      return;
    }
    try {
      res.json(
        CommunityConnectionStatusResponseSchema.parse({
          connection: await connectionService.status(ref.data, owner),
        })
      );
    } catch (error) {
      failure(res, error);
    }
  });
  router.post('/:ref/poll', async (req, res) => {
    const owner = resolveCommunityOwner(req, res);
    if (!owner) return;
    const ref = CommunityRefSchema.safeParse(req.params.ref);
    if (!ref.success) {
      res.status(404).json({ error: 'Community connection not found.' });
      return;
    }
    try {
      res.json(
        CommunityConnectionPollResponseSchema.parse(await connectionService.poll(ref.data, owner))
      );
    } catch (error) {
      failure(res, error);
    }
  });
  router.post('/:ref/cancel', async (req, res) => {
    const owner = resolveCommunityOwner(req, res);
    if (!owner) return;
    const ref = CommunityRefSchema.safeParse(req.params.ref);
    if (!ref.success) {
      res.status(404).json({ error: 'Community connection not found.' });
      return;
    }
    try {
      await connectionService.cancel(ref.data, owner);
      res.status(204).end();
    } catch (error) {
      failure(res, error);
    }
  });
  router.delete('/:ref', async (req, res) => {
    const owner = resolveCommunityOwner(req, res);
    if (!owner) return;
    const ref = CommunityRefSchema.safeParse(req.params.ref);
    if (!ref.success) {
      res.status(404).json({ error: 'Community connection not found.' });
      return;
    }
    try {
      await connectionService.disconnect(ref.data, owner);
      res.status(204).end();
    } catch (error) {
      failure(res, error);
    }
  });
  return router;
}
