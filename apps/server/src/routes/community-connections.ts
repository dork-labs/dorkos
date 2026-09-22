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
  type CommunityConnectionDescriptor,
} from '@dorkos/shared/community-connections';
import {
  CommunityNavigationMoveRequestSchema,
  CommunityNavigationRememberRequestSchema,
  CommunityNavigationResolveResponseSchema,
  CommunityNavigationRememberInstallationRequestSchema,
  CommunityNavigationStateSchema,
} from '@dorkos/shared/community-navigation';
import { readOwnerAccount } from '../services/core/auth/index.js';
import { configManager } from '../services/core/config-manager.js';
import { getRoomService } from '../services/rooms/index.js';
import { resolveCaller } from './room-caller.js';
import { isLocalCaller, requireOperatorCookieUnderLogin } from '../lib/caller-authority.js';
import {
  RemoteConnectionAuthorizationError,
  RemoteConnectionNotFoundError,
} from '../services/communities/remote/connection-store.js';
import {
  RemoteCommunityPairingService,
  RemotePairingBusyError,
  RemoteCommunitySelectionRequiredError,
  RemoteCommunityUpgradeRequiredError,
} from '../services/communities/remote/pairing-service.js';
import {
  PinnedHttpError,
  PinnedOriginError,
} from '../services/communities/remote/pinned-origin.js';
import {
  getRemoteCommunityAdapter,
  getRemotePairingService,
} from '../services/communities/remote/state.js';
import { CommunityNavigationPreferenceService } from '../services/communities/community-navigation-preferences.js';

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
  const expectedOwner = req.get('x-dorkos-community-owner');
  if (expectedOwner && expectedOwner !== caller.id) {
    res.status(409).json({
      error: 'The local owner changed. Reload Community data for the current account.',
      code: 'COMMUNITY_OWNER_CHANGED',
    });
    return null;
  }
  return caller.id;
}

function failure(res: Response, error: unknown): void {
  if (error instanceof RemotePairingBusyError) {
    res.status(409).json({ error: 'This pairing is still finishing. Try again in a moment.' });
  } else if (error instanceof RemoteCommunitySelectionRequiredError) {
    res.status(409).json({
      code: 'COMMUNITY_SELECTION_REQUIRED',
      error: 'Choose a specific community from this host and use its community link.',
    });
  } else if (error instanceof RemoteCommunityUpgradeRequiredError) {
    res.status(426).json({
      code: 'COMMUNITY_UPGRADE_REQUIRED',
      error: 'Upgrade this Community server before connecting it to DorkOS.',
    });
  } else if (error instanceof RemoteConnectionAuthorizationError) {
    res.status(409).json({
      error: 'Reconnect this community to continue.',
      code: 'COMMUNITY_RECONNECT_REQUIRED',
    });
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

/** Add current attention only after the local owner and remote read grant are verified. */
async function withAttention(
  connection: CommunityConnectionDescriptor,
  owner: string
): Promise<CommunityConnectionDescriptor> {
  if (connection.status !== 'connected' || connection.access?.state !== 'verified')
    return connection;
  if (!connection.access.effective.read) return connection;
  try {
    const attention = await getRemoteCommunityAdapter(connection.ref, owner).attention();
    return {
      ...connection,
      attention: { ...attention, state: 'verified', verifiedAt: new Date().toISOString() },
    };
  } catch {
    return connection;
  }
}

/** Build the production route or inject an isolated service in HTTP tests. */
export function createCommunityConnectionsRouter(
  connectionService: RemoteCommunityPairingService = getRemotePairingService(),
  navigationService: CommunityNavigationPreferenceService = new CommunityNavigationPreferenceService(
    configManager,
    connectionService,
    async (owner, ref, roomId) => {
      try {
        return (await getRemoteCommunityAdapter(ref, owner).getRoom(roomId)) !== null;
      } catch (error) {
        // A valid grant can still lack access to one private channel. Treat that
        // exactly like a removed remembered room, without revealing which case.
        if (error instanceof PinnedHttpError && error.status === 403) return false;
        throw error;
      }
    }
  )
): Router {
  const router = Router();
  router.get('/', async (req, res) => {
    const owner = resolveCommunityOwner(req, res);
    if (!owner) return;
    try {
      res.json(
        CommunityConnectionListResponseSchema.parse({
          connections: await Promise.all(
            (await connectionService.list(owner)).map((item) => withAttention(item, owner))
          ),
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
  router.get('/navigation', async (req, res) => {
    const owner = resolveCommunityOwner(req, res);
    if (!owner) return;
    try {
      res.json(CommunityNavigationStateSchema.parse(await navigationService.get(owner)));
    } catch (error) {
      failure(res, error);
    }
  });
  router.post('/navigation/move', async (req, res) => {
    const owner = resolveCommunityOwner(req, res);
    if (!owner) return;
    const parsed = CommunityNavigationMoveRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Choose a connected community and move direction.' });
      return;
    }
    try {
      res.json(
        CommunityNavigationStateSchema.parse(
          await navigationService.move(owner, parsed.data.ref, parsed.data.direction)
        )
      );
    } catch (error) {
      failure(res, error);
    }
  });

  router.put('/navigation/installation', async (req, res) => {
    const owner = resolveCommunityOwner(req, res);
    if (!owner) return;
    const parsed = CommunityNavigationRememberInstallationRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Choose a valid local installation destination.' });
      return;
    }
    try {
      res.json(
        CommunityNavigationStateSchema.parse(
          await navigationService.rememberInstallation(owner, parsed.data.destination)
        )
      );
    } catch (error) {
      failure(res, error);
    }
  });
  router.put('/navigation/destination', async (req, res) => {
    const owner = resolveCommunityOwner(req, res);
    if (!owner) return;
    const parsed = CommunityNavigationRememberRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Choose a valid Community destination.' });
      return;
    }
    try {
      res.json(
        CommunityNavigationStateSchema.parse(await navigationService.remember(owner, parsed.data))
      );
    } catch (error) {
      failure(res, error);
    }
  });
  router.get('/navigation/:ref/destination', async (req, res) => {
    const owner = resolveCommunityOwner(req, res);
    if (!owner) return;
    const ref = CommunityRefSchema.safeParse(req.params.ref);
    if (!ref.success) {
      res.status(404).json({ error: 'Community connection not found.' });
      return;
    }
    try {
      res.json(
        CommunityNavigationResolveResponseSchema.parse({
          destination: await navigationService.resolve(owner, ref.data),
        })
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
          connection: await withAttention(await connectionService.status(ref.data, owner), owner),
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
