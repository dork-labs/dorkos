/**
 * Local, owner-scoped connection endpoints. Browser responses contain only
 * descriptors and approval URLs; all pairing proof and bearer material stays
 * inside the local server's encrypted store.
 *
 * @module routes/community-connections
 */
import { Hono, type Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { CommunityRefSchema, type CommunityRef } from '@dorkos/shared/community-adapter';
import {
  CommunityConnectionStartRequestSchema,
  CommunityConnectionStartResponseSchema,
  CommunityConnectionListResponseSchema,
  CommunityConnectionStatusResponseSchema,
  CommunityConnectionPollResponseSchema,
  CommunityConnectionDescriptorSchema,
  CommunityDisconnectImpactSchema,
  CommunityDisconnectResponseSchema,
  CommunityWakeAgentsFromSchema,
  type CommunityConnectionDescriptor,
  describeCommunityRetryWait,
} from '@dorkos/shared/community-connections';
import {
  CommunityNavigationMoveRequestSchema,
  CommunityNavigationRememberRequestSchema,
  CommunityNavigationResolveResponseSchema,
  CommunityNavigationRememberInstallationRequestSchema,
  CommunityNavigationStateSchema,
} from '@dorkos/shared/community-navigation';
import type { ApiEnv } from '../http/api-chain.js';
import { readJsonBody } from '../http/request-body.js';
import { honoRequestFacts } from '../http/request-facts.js';
import { readOwnerAccount } from '../services/core/auth/index.js';
import { configManager } from '../services/core/config-manager.js';
import { getRoomService } from '../services/rooms/index.js';
import { resolveCaller } from './room-caller.js';
import { requireOperatorCookieUnderLogin } from '../lib/caller-authority.js';
import {
  RemoteConnectionAuthorizationError,
  RemoteConnectionNotFoundError,
} from '../services/communities/remote/connection-store.js';
import {
  RemoteCommunityPairingService,
  RemotePairingBusyError,
  RemoteCommunityRateLimitedError,
  RemoteCommunityNameNotFoundError,
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
  getRemoteWakePolicy,
} from '../services/communities/remote/state.js';
import type { RemoteWakePolicy } from '../services/communities/remote/wake/wake-policy.js';
import { CommunityNavigationPreferenceService } from '../services/communities/community-navigation-preferences.js';
import { CommunityAttentionCache } from '../services/communities/remote/community-attention-cache.js';
import { CommunityOwnerNoticeCache } from '../services/communities/remote/community-owner-notice-cache.js';
import {
  CommunityOwnerNoticeAnnouncer,
  getOwnerNoticeAnnouncer,
} from '../services/notifications/emitters/community-owner-replacement.js';
import { resolveDorkHome } from '../lib/dork-home.js';
import { officialOnlyOrigin, spaceReachable } from '../middleware/spaces-enabled.js';
import { addAnswerInRoutes } from './community-answer-in.js';
import { isAtThisComputer } from '../services/core/auth/gate-policy.js';

/**
 * Resolve the only local human allowed to use a stored community connection.
 *
 * @param c - The request's context.
 * @returns The owner's author id, or the refusal to answer with.
 */
export function resolveCommunityOwner(c: Context<ApiEnv>): string | Response {
  const facts = honoRequestFacts(c);
  const cookieRefusal = requireOperatorCookieUnderLogin(facts, 'community connections');
  if (cookieRefusal) {
    return c.json(
      { error: cookieRefusal.error, code: cookieRefusal.code },
      cookieRefusal.status as ContentfulStatusCode
    );
  }
  if (!facts.user && !isAtThisComputer(facts)) {
    return c.json({ error: 'Manage space connections from this machine.' }, 403);
  }
  let caller;
  try {
    caller = resolveCaller(facts);
  } catch {
    return c.json({ error: 'An agent cannot manage space connections.' }, 403);
  }
  if (!getRoomService().authorRegistry.isOwner(caller.id, readOwnerAccount()?.id ?? null)) {
    return c.json({ error: 'Only this install’s owner can manage space connections.' }, 403);
  }
  const expectedOwner = c.req.header('x-dorkos-community-owner');
  if (expectedOwner && expectedOwner !== caller.id) {
    return c.json(
      {
        error: 'The local owner changed. Reload to see spaces for the current account.',
        code: 'COMMUNITY_OWNER_CHANGED',
      },
      409
    );
  }
  return caller.id;
}

/** A connection route's answer when its ref is not path-safe or names no connection. */
function notFound(c: Context): Response {
  return c.json({ error: 'Space connection not found.' }, 404);
}

function failure(c: Context, error: unknown): Response {
  if (error instanceof RemotePairingBusyError) {
    // Coded so a client can tell "another check of this connection is in
    // flight" (keep waiting) from a real refusal: every open window polls.
    return c.json(
      { code: 'PAIRING_BUSY', error: 'This pairing is still finishing. Try again in a moment.' },
      409
    );
  }
  if (error instanceof RemoteCommunitySelectionRequiredError) {
    return c.json(
      {
        code: 'COMMUNITY_SELECTION_REQUIRED',
        error: 'That address has more than one space on it. Use the link for the one you want.',
      },
      409
    );
  }
  if (error instanceof RemoteCommunityNameNotFoundError) {
    return c.json(
      {
        code: 'COMMUNITY_NAME_NOT_FOUND',
        error: 'No space uses that short address there. Check the spelling.',
      },
      404
    );
  }
  if (error instanceof RemoteCommunityRateLimitedError) {
    // The host's own wait, passed on so the person is told how long, not left to guess.
    const { retryAfterSeconds } = error;
    if (retryAfterSeconds !== undefined) c.header('Retry-After', String(retryAfterSeconds));
    return c.json(
      {
        code: 'COMMUNITY_RATE_LIMITED',
        error: `This DorkOS has tried that space too many times in a short while. Wait ${describeCommunityRetryWait(retryAfterSeconds)}, then try again.`,
        ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
      },
      429
    );
  }
  if (error instanceof RemoteCommunityUpgradeRequiredError) {
    return c.json(
      {
        code: 'COMMUNITY_UPGRADE_REQUIRED',
        error: 'This space’s server is too old to connect. Ask whoever runs it to update it.',
      },
      426
    );
  }
  if (error instanceof RemoteConnectionAuthorizationError) {
    return c.json(
      { error: 'Reconnect this space to continue.', code: 'COMMUNITY_RECONNECT_REQUIRED' },
      409
    );
  }
  if (error instanceof RemoteConnectionNotFoundError) return notFound(c);
  if (error instanceof PinnedOriginError) {
    const address = error.code === 'INVALID_ORIGIN' || error.code === 'UNSAFE_ADDRESS';
    return address
      ? c.json({ error: 'Enter an accessible HTTPS space address.' }, 400)
      : c.json({ error: 'The space could not complete this connection request.' }, 502);
  }
  return c.json({ error: 'The space connection is unavailable.' }, 502);
}

/**
 * What this connection's access allows for counts: `read` fetches them now,
 * `offline` keeps showing the last confirmed ones (the Community did not
 * answer this read, but could read before), and `none` means counts must go.
 */
function attentionAccess(connection: CommunityConnectionDescriptor): 'read' | 'offline' | 'none' {
  if (connection.status !== 'connected' || !connection.access) return 'none';
  const { state, effective, lastKnown } = connection.access;
  if (state === 'verified') return effective.read ? 'read' : 'none';
  if (state === 'unverified') return lastKnown?.capabilities.read ? 'offline' : 'none';
  return 'none';
}

/**
 * The per-connection reads a connection listing adds, each held within the same budget, and the
 * announcer that tells the owner once about each notice those reads find.
 */
interface ActivityCaches {
  attention: CommunityAttentionCache;
  ownerNotice: CommunityOwnerNoticeCache;
  announcer: CommunityOwnerNoticeAnnouncer;
}

/**
 * Add attention, and the owner's notice about a request to replace them, only after the local
 * owner and remote read grant are verified.
 *
 * Remote answers are untrusted. Any failure — transport, a slow answer, or
 * counts that break a descriptor rule — leaves this one connection on the last
 * counts its Community confirmed (`stale`) or on `unavailable`, so a single
 * broken or slow Community can never fail or stall the whole list and hide the
 * Remove control the owner needs to drop it. A Community that is offline this
 * read is not asked at all and keeps its last confirmed counts, also `stale`.
 *
 * The owner notice is asked at the same moment as the counts, so it adds nothing to how long the
 * list takes. Unlike the counts it is never kept past about a minute: an offline Community, or
 * one that stays slow or fails, shows none rather than an old one (DOR-2543). Each notice shown
 * is handed to the announcer, which raises its notification once, ever; the list never waits
 * for that.
 */
async function withAttention(
  connection: CommunityConnectionDescriptor,
  owner: string,
  caches: ActivityCaches
): Promise<CommunityConnectionDescriptor> {
  const access = attentionAccess(connection);
  if (access === 'none') {
    caches.attention.forget(owner, connection.ref);
    caches.ownerNotice.forget(owner, connection.ref);
    return connection;
  }
  const [attention, ownerNotice] =
    access === 'offline'
      ? [caches.attention.lastConfirmed(owner, connection.ref), undefined]
      : await Promise.all([
          caches.attention.read(owner, connection.ref, () =>
            getRemoteCommunityAdapter(connection.ref, owner).attention()
          ),
          caches.ownerNotice.read(owner, connection.ref, () =>
            getRemoteCommunityAdapter(connection.ref, owner).ownerReplacementNotice()
          ),
        ]);
  const enriched = CommunityConnectionDescriptorSchema.safeParse({
    ...connection,
    attention,
    ...(ownerNotice ? { ownerNotice } : {}),
  });
  // Counts that break a descriptor rule must not take a valid notice down with them.
  const result = enriched.success
    ? enriched.data
    : (CommunityConnectionDescriptorSchema.safeParse({
        ...connection,
        ...(ownerNotice ? { ownerNotice } : {}),
      }).data ?? connection);
  if (result.ownerNotice)
    void caches.announcer.announce(result.ref, result.label, result.ownerNotice);
  return result;
}

/** Build the production routes, or inject an isolated service in HTTP tests. */
export function createCommunityConnectionsRoutes(
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
  ),
  attentionCache: CommunityAttentionCache = new CommunityAttentionCache(),
  ownerNoticeCache: CommunityOwnerNoticeCache = new CommunityOwnerNoticeCache(),
  announcer: CommunityOwnerNoticeAnnouncer = getOwnerNoticeAnnouncer(resolveDorkHome()),
  // Looked up per request when not injected, so building the routes reads nothing from disk.
  wakePolicy?: Pick<RemoteWakePolicy, 'get' | 'set' | 'getAnswerIn' | 'setAnswerIn'>
): Hono<ApiEnv> {
  const router = new Hono<ApiEnv>();
  const caches: ActivityCaches = {
    attention: attentionCache,
    ownerNotice: ownerNoticeCache,
    announcer,
  };
  router.get('/', async (c) => {
    const owner = resolveCommunityOwner(c);
    if (typeof owner !== 'string') return owner;
    try {
      // With spaces off the gate let this list through for the official space alone, so the
      // official row is the only one it carries (spec `official-community-space` D5).
      const listed = await connectionService.list(owner);
      const connections =
        officialOnlyOrigin(c) !== null
          ? listed.filter((connection) => connection.official === true)
          : listed;
      const readable = connections
        .filter((connection) => attentionAccess(connection) !== 'none')
        .map((connection) => connection.ref);
      attentionCache.retainOnly(owner, readable);
      ownerNoticeCache.retainOnly(owner, readable);
      return c.json(
        CommunityConnectionListResponseSchema.parse({
          connections: await Promise.all(
            connections.map((item) => withAttention(item, owner, caches))
          ),
        })
      );
    } catch (error) {
      return failure(c, error);
    }
  });
  router.post('/', async (c) => {
    const owner = resolveCommunityOwner(c);
    if (typeof owner !== 'string') return owner;
    const parsed = CommunityConnectionStartRequestSchema.safeParse(readJsonBody(c));
    if (!parsed.success) {
      return c.json({ error: 'Enter a valid space address and install name.' }, 400);
    }
    try {
      return c.json(
        CommunityConnectionStartResponseSchema.parse(
          await connectionService.start(owner, parsed.data.url, parsed.data.installName)
        ),
        201
      );
    } catch (error) {
      return failure(c, error);
    }
  });
  router.get('/navigation', async (c) => {
    const owner = resolveCommunityOwner(c);
    if (typeof owner !== 'string') return owner;
    try {
      const state = await navigationService.get(owner);
      // With spaces off this answers for the official space alone, so the saved order and
      // destinations name no other space (spec `official-community-space` D5).
      const reachable = (ref: string) => spaceReachable(ref as CommunityRef);
      return c.json(
        CommunityNavigationStateSchema.parse(
          officialOnlyOrigin(c) !== null
            ? {
                ...state,
                order: state.order.filter(reachable),
                destinations: state.destinations.filter((item) => reachable(item.ref)),
              }
            : state
        )
      );
    } catch (error) {
      return failure(c, error);
    }
  });
  router.post('/navigation/move', async (c) => {
    const owner = resolveCommunityOwner(c);
    if (typeof owner !== 'string') return owner;
    const parsed = CommunityNavigationMoveRequestSchema.safeParse(readJsonBody(c));
    if (!parsed.success) {
      return c.json({ error: 'Choose a connected space and move direction.' }, 400);
    }
    try {
      return c.json(
        CommunityNavigationStateSchema.parse(
          await navigationService.move(owner, parsed.data.ref, parsed.data.direction)
        )
      );
    } catch (error) {
      return failure(c, error);
    }
  });
  router.put('/navigation/installation', async (c) => {
    const owner = resolveCommunityOwner(c);
    if (typeof owner !== 'string') return owner;
    const parsed = CommunityNavigationRememberInstallationRequestSchema.safeParse(readJsonBody(c));
    if (!parsed.success) {
      return c.json({ error: 'Choose a valid local installation destination.' }, 400);
    }
    try {
      return c.json(
        CommunityNavigationStateSchema.parse(
          await navigationService.rememberInstallation(owner, parsed.data.destination)
        )
      );
    } catch (error) {
      return failure(c, error);
    }
  });
  router.put('/navigation/destination', async (c) => {
    const owner = resolveCommunityOwner(c);
    if (typeof owner !== 'string') return owner;
    const parsed = CommunityNavigationRememberRequestSchema.safeParse(readJsonBody(c));
    if (!parsed.success) return c.json({ error: 'Choose a valid space to open.' }, 400);
    try {
      return c.json(
        CommunityNavigationStateSchema.parse(await navigationService.remember(owner, parsed.data))
      );
    } catch (error) {
      return failure(c, error);
    }
  });
  router.get('/navigation/:ref/destination', async (c) => {
    const owner = resolveCommunityOwner(c);
    if (typeof owner !== 'string') return owner;
    const ref = CommunityRefSchema.safeParse(c.req.param('ref'));
    if (!ref.success) return notFound(c);
    try {
      return c.json(
        CommunityNavigationResolveResponseSchema.parse({
          destination: await navigationService.resolve(owner, ref.data),
        })
      );
    } catch (error) {
      return failure(c, error);
    }
  });
  /**
   * The routes about one connection, `/:ref…`: the owner first, then a ref that is not path-safe
   * answers as one that names no connection, then the route.
   */
  const forConnection =
    (run: (c: Context<ApiEnv>, owner: string, ref: CommunityRef) => Promise<Response>) =>
    async (c: Context<ApiEnv>): Promise<Response> => {
      const owner = resolveCommunityOwner(c);
      if (typeof owner !== 'string') return owner;
      const ref = CommunityRefSchema.safeParse(c.req.param('ref'));
      if (!ref.success) return notFound(c);
      return run(c, owner, ref.data);
    };
  router.get(
    '/:ref',
    forConnection(async (c, owner, ref) => {
      attentionCache.retainOwner(owner);
      ownerNoticeCache.retainOwner(owner);
      try {
        return c.json(
          CommunityConnectionStatusResponseSchema.parse({
            connection: await withAttention(
              await connectionService.status(ref, owner),
              owner,
              caches
            ),
          })
        );
      } catch (error) {
        return failure(c, error);
      }
    })
  );
  router.post(
    '/:ref/poll',
    forConnection(async (c, owner, ref) => {
      try {
        return c.json(
          CommunityConnectionPollResponseSchema.parse(await connectionService.poll(ref, owner))
        );
      } catch (error) {
        return failure(c, error);
      }
    })
  );
  router.post(
    '/:ref/cancel',
    forConnection(async (c, owner, ref) => {
      try {
        await connectionService.cancel(ref, owner);
        return c.body(null, 204);
      } catch (error) {
        return failure(c, error);
      }
    })
  );
  // What Disconnect would remove, read from this install's own records so the confirmation can
  // name the agents even while the Community cannot be reached.
  router.get(
    '/:ref/disconnect-impact',
    forConnection(async (c, owner, ref) => {
      try {
        return c.json(
          CommunityDisconnectImpactSchema.parse(
            await connectionService.disconnectImpact(ref, owner)
          )
        );
      } catch (error) {
        return failure(c, error);
      }
    })
  );
  // Who in this space may wake the owner's agents (spec `official-community-space` D9).
  // Owner-only, like every route here: `resolveCommunityOwner` refuses an agent's identity, a
  // remote caller and anyone but this install's owner, and no DorkOS tool or config key
  // reaches it. (With login off, an agent's own shell on this machine is the local-trust
  // residual, and a stranger's turn asks before it runs one.)
  router.get(
    '/:ref/wake-agents-from',
    forConnection(async (c, owner, ref) => {
      try {
        return c.json(
          CommunityWakeAgentsFromSchema.parse({
            wakeAgentsFrom: await (wakePolicy ?? getRemoteWakePolicy()).get(ref, owner),
          })
        );
      } catch (error) {
        return failure(c, error);
      }
    })
  );
  router.put(
    '/:ref/wake-agents-from',
    forConnection(async (c, owner, ref) => {
      const body = CommunityWakeAgentsFromSchema.safeParse(readJsonBody(c));
      if (!body.success) {
        return c.json({ error: 'Choose who can wake your agents: me or members.' }, 400);
      }
      try {
        await (wakePolicy ?? getRemoteWakePolicy()).set(ref, owner, body.data.wakeAgentsFrom);
        return c.json(body.data);
      } catch (error) {
        return failure(c, error);
      }
    })
  );
  // Where any person's post wakes the owner's agents without a mention (D11), owner-only too.
  addAnswerInRoutes(router, resolveCommunityOwner, () => wakePolicy ?? getRemoteWakePolicy());
  router.delete(
    '/:ref',
    forConnection(async (c, owner, ref) => {
      try {
        return c.json(
          CommunityDisconnectResponseSchema.parse(await connectionService.disconnect(ref, owner))
        );
      } catch (error) {
        return failure(c, error);
      } finally {
        // Even a failed disconnect may have removed the local copy; counts and notices
        // for a Community the owner asked to leave must not outlive the request.
        attentionCache.forget(owner, ref);
        ownerNoticeCache.forget(owner, ref);
      }
    })
  );
  return router;
}
