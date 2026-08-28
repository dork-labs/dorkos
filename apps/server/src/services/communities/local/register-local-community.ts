/**
 * Registering `LOCAL_COMMUNITY` — the line that makes the registry's own
 * guarantee true.
 *
 * The spec says twice that "the `LOCAL_COMMUNITY` adapter is always registered"
 * (§8, and again in the registry's unit-test list). Until there was a local
 * adapter to register there was nothing that could hold it up: a fresh registry
 * was empty, and every consumer that asked for `LOCAL_COMMUNITY` would have got
 * a `CommunityNotRegisteredError` for the one community that certainly exists.
 * This is where it becomes real.
 *
 * @module server/services/communities/local/register-local-community
 */
import type { CommunityAdapter } from '@dorkos/shared/community-adapter';
import { logger } from '../../../lib/logger.js';
import type { AuthorRegistry } from '../../rooms/author-registry.js';
import { resolveOperatorAuthor } from '../../rooms/operator-author.js';
import type { RoomService } from '../../rooms/room-service.js';
import type { RoomStore } from '../../rooms/room-store.js';
import { communityRegistry, type CommunityRegistry } from '../registry.js';
import { LocalCommunityAdapter } from './local-community-adapter.js';

/**
 * What a person calls this community.
 *
 * The registry holds the label so a ref never has to be rendered. For the one
 * community that is not a place you joined, the honest name is the machine you
 * are sitting at.
 */
export const LOCAL_COMMUNITY_LABEL = 'This machine';

/**
 * Resolve who the local community is connected as: the person who owns this
 * install.
 *
 * The same three-branch answer `resolveCaller` gives a request, minus the two
 * branches a background registration cannot have — there is no agent identity
 * header and no session here, so what is left is the owner, and the unbound
 * `'local'` author while nobody owns the install yet.
 *
 * Re-resolved on every call rather than captured: an install becomes owned
 * partway through its life, and `bindOwner` keeps the author id it rebinds, so
 * a room, a membership or a read cursor written before login was turned on still
 * belongs to the same person afterwards.
 *
 * @param authors - The author registry to resolve through.
 */
export function localCommunityIdentity(authors: AuthorRegistry): () => string {
  return () => resolveOperatorAuthor(authors).id;
}

/**
 * Build the local adapter and register it, so `LOCAL_COMMUNITY` is present from
 * the moment the rooms subsystem is up.
 *
 * `connect()` is driven here rather than left to the first caller because the
 * registry remembers the result, and a listing needs it: a community that did
 * not connect contributes a warning instead of rooms. Locally that can only
 * report a store that will not answer, which is exactly the case a person needs
 * told rather than discovered by an empty sidebar.
 *
 * Connecting resolves the operator's author, which **mints that row on an
 * install that has never had one** — the same row the first room request would
 * have minted, one moment earlier and by the same call. It runs after
 * `initAuth`, so an owned install resolves the owner rather than the unbound
 * sentinel.
 *
 * @param deps.service - The wired room service.
 * @param deps.store - The room store behind it.
 * @param deps.authors - The author registry, for resolving the operator.
 * @param deps.registry - The registry to register into; defaults to the singleton.
 * @returns The registered adapter.
 */
export async function registerLocalCommunity(deps: {
  service: RoomService;
  store: RoomStore;
  authors: AuthorRegistry;
  registry?: CommunityRegistry;
}): Promise<CommunityAdapter> {
  const registry = deps.registry ?? communityRegistry;
  const adapter = new LocalCommunityAdapter({
    service: deps.service,
    store: deps.store,
    resolveIdentity: localCommunityIdentity(deps.authors),
  });
  registry.register(adapter, LOCAL_COMMUNITY_LABEL);
  const connection = await registry.connect(adapter.community);
  if (connection.status !== 'connected') {
    logger.warn('[Communities] the local community did not connect', {
      status: connection.status,
      error: connection.error,
    });
  }
  return adapter;
}
