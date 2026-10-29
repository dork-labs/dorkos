/**
 * The credential a space gives this app to manage it for its person (DOR-3005), kept apart from
 * the connection's own grant.
 *
 * An owner or admin who ticks the consent line when they pair gets a second token beside the
 * connection's `read`/`post`/`enroll-agent` grant. It is stored under its own name
 * (`community:<ref>:administer`), never beside the grant in `connection-store.ts`, so nothing
 * that loads a connection's grant or an agent's token can reach it. Only {@link
 * RemoteAdministerCredentials.forPerson} returns it, and only person-only routes may call that:
 * routes behind `resolveCommunityOwner`, which refuses an agent's identity and anyone but this
 * install's owner. No agent path, MCP tool or agent credential loads it, and a test keeps the
 * importers of this module to the ones allowed.
 *
 * It ends with its connection: removing the connection, or the space refusing the grant, deletes
 * it here, as the space refuses it once the grant is revoked there.
 *
 * @module services/communities/remote/administer/administer-credentials
 */
import type { CommunityRef } from '@dorkos/shared/community-adapter';
import { COMMUNITY_API_V1_ROUTES } from '@dorkos/shared/community-wire';
import type { CommunityConnectionAdminister } from '@dorkos/shared/community-administer';
import type { CredentialStore } from '../../../core/credential-provider.js';
import { logger } from '../../../../lib/logger.js';
import { SpaceFeatures } from '../availability/space-features.js';
import { RemoteConnectionNotFoundError, type RemoteConnectionStore } from '../connection-store.js';
import { communityApiPath, parseCommunityOrigin, pinnedJson } from '../pinned-origin.js';

/** The credential store name of one connection's manage credential. */
function credentialName(ref: CommunityRef): string {
  return `community:${ref}:administer`;
}

/** Holds each connection's manage credential, apart from its grant. */
export class RemoteAdministerCredentials {
  /** What each connection's space says it offers, kept for a while. */
  private readonly offers = new Map<CommunityRef, SpaceFeatures>();

  /**
   * Keep manage credentials beside, never inside, the connection store.
   *
   * @param connections - The connections, to check a ref is this owner's and connected, and to
   *   hear when one is removed or must reconnect.
   * @param credentials - The encrypted store the credential is kept in.
   * @param read - How a space's features are read; `pinnedJson` in production.
   */
  constructor(
    private readonly connections: Pick<RemoteConnectionStore, 'get' | 'onChange'>,
    private readonly credentials: CredentialStore,
    private readonly read: typeof pinnedJson = pinnedJson
  ) {
    connections.onChange((changes) => {
      for (const change of changes)
        if (change.status === 'removed' || change.status === 'reconnect-required')
          void this.forget(change.ref);
    });
  }

  /**
   * Keep the manage credential a pairing returned. Never throws: a credential that cannot be kept
   * leaves the connection as it is, read-only here, and the person can pair again.
   *
   * @param ref - The connection, just completed.
   * @param owner - Its local owner.
   * @param token - The credential, once.
   */
  async save(ref: CommunityRef, owner: string, token: string): Promise<void> {
    try {
      await this.connected(ref, owner);
      await this.credentials.put(credentialName(ref), token);
    } catch (error) {
      logger.warn('[communities] could not keep the credential to manage a space', {
        error: error instanceof Error ? error.name : 'unknown',
      });
    }
  }

  /**
   * Whether this connection can manage its space, and whether pairing again would let it.
   *
   * @param ref - The connection.
   * @param owner - Its local owner; another owner's connection is not found.
   */
  async state(ref: CommunityRef, owner: string): Promise<CommunityConnectionAdminister> {
    const record = await this.connections.get(ref, owner);
    const held =
      record.status === 'connected' && (await this.credentials.get(credentialName(ref))) !== null;
    return {
      canAdminister: held,
      administerAvailable: held || (await this.offered(ref, record)),
    };
  }

  /**
   * The manage credential, for a person-only route acting for this install's owner. Never call it
   * from an agent's path.
   *
   * @param ref - The connection.
   * @param owner - The local owner `resolveCommunityOwner` returned for this request.
   * @throws {RemoteConnectionNotFoundError} When the connection is not this owner's, is not
   *   connected, or holds no manage credential.
   */
  async forPerson(ref: CommunityRef, owner: string): Promise<string> {
    await this.connected(ref, owner);
    const token = await this.credentials.get(credentialName(ref));
    if (!token) throw new RemoteConnectionNotFoundError();
    return token;
  }

  /** Drop one connection's manage credential and what its space said it offers. */
  async forget(ref: CommunityRef): Promise<void> {
    this.offers.delete(ref);
    try {
      await this.credentials.delete(credentialName(ref));
    } catch (error) {
      logger.warn('[communities] could not remove the credential to manage a space', {
        error: error instanceof Error ? error.name : 'unknown',
      });
    }
  }

  private async connected(ref: CommunityRef, owner: string): Promise<void> {
    if ((await this.connections.get(ref, owner)).status !== 'connected')
      throw new RemoteConnectionNotFoundError();
  }

  /** Whether the space offers the manage credential: false when it cannot say. */
  private offered(
    ref: CommunityRef,
    place: { pinnedOrigin: string; remoteCommunityId: string }
  ): Promise<boolean> {
    let features = this.offers.get(ref);
    if (!features) {
      features = new SpaceFeatures(() =>
        this.read(
          parseCommunityOrigin(place.pinnedOrigin),
          communityApiPath(place.remoteCommunityId, COMMUNITY_API_V1_ROUTES.features),
          undefined,
          undefined,
          { method: 'GET' }
        )
      );
      this.offers.set(ref, features);
    }
    return features.has('administer');
  }
}
