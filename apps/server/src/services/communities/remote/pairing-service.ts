/**
 * Browser-approved connection flow. The browser sees a URL and status; the
 * verifier, one-time code and personal bearer remain inside the local server.
 *
 * @module services/communities/remote/pairing-service
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { CommunityRefSchema, type CommunityRef } from '@dorkos/shared/community-adapter';
import {
  COMMUNITY_API_V1_ROUTES,
  CommunityWireCommunitySchema,
  CommunityWirePairingStartResponseSchema,
} from '@dorkos/shared/community-wire';
import {
  CommunityPairingPollPrivateResponseSchema,
  CommunityPairingExchangeSecretResponseSchema,
} from '@dorkos/shared/community-private-wire';
import { RemoteConnectionStore, type RemoteConnectionDescriptor } from './connection-store.js';
import { parseCommunityOrigin, pinnedJson, PinnedOriginError } from './pinned-origin.js';

/** A pending pairing with an approval page on the accepted community origin. */
export interface RemotePairingStart {
  /** Non-secret connection descriptor. */
  connection: RemoteConnectionDescriptor;
  /** Page opened in the community's own browser origin for a human decision. */
  approvalUrl: string;
}

/** Status returned to the browser without a one-time code or token. */
export interface RemotePairingPoll {
  /** The current non-secret descriptor when connected or pending. */
  connection: RemoteConnectionDescriptor | null;
  /** Exact stage of the local pairing. */
  status: 'pending' | 'connected' | 'expired' | 'cancelled';
}

/** A pairing state change already in progress for this local ref. */
export class RemotePairingBusyError extends Error {
  constructor() {
    super('Pairing state is changing');
    this.name = 'RemotePairingBusyError';
  }
}

/** Pairing orchestration scoped to the local owner's verified author ID. */
export class RemoteCommunityPairingService {
  private readonly busy = new Set<CommunityRef>();

  private enter(ref: CommunityRef): void {
    if (this.busy.has(ref)) throw new RemotePairingBusyError();
    this.busy.add(ref);
  }

  /**
   * Bind pairing to the local encrypted connection store.
   *
   * @param store - Private encrypted local connection store.
   */
  constructor(private readonly store: RemoteConnectionStore) {}

  /** Read only the caller's non-secret connection status. */
  async list(ownerKey: string): Promise<RemoteConnectionDescriptor[]> {
    await this.store.sweepExpired(ownerKey, this.busy);
    return this.store.list(ownerKey);
  }

  /** Read one descriptor without exposing another local owner's connection. */
  async status(ref: CommunityRef, ownerKey: string): Promise<RemoteConnectionDescriptor> {
    await this.store.sweepExpired(ownerKey, this.busy);
    return this.store.project(await this.store.get(ref, ownerKey));
  }

  /** Begin a ten-minute verifier-bound request at the checked deployment origin. */
  async start(ownerKey: string, url: string, installName: string): Promise<RemotePairingStart> {
    const origin = parseCommunityOrigin(url);
    const community = CommunityWireCommunitySchema.parse(
      await pinnedJson(origin, COMMUNITY_API_V1_ROUTES.community)
    );
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const start = CommunityWirePairingStartResponseSchema.parse(
      await pinnedJson(origin, COMMUNITY_API_V1_ROUTES.pairingStart, {
        installName,
        challenge,
        scopes: ['read', 'post', 'enroll-agent'],
      })
    );
    const approval = new URL(start.approvalUrl);
    if (
      approval.origin !== origin.origin ||
      approval.pathname !== '/pairing' ||
      approval.searchParams.get('pairingId') !== start.pairingId ||
      approval.hash
    )
      throw new PinnedOriginError('REMOTE_RESPONSE');
    const expiry = Date.parse(start.expiresAt);
    if (expiry <= Date.now() || expiry > Date.now() + 10 * 60_000 + 5_000)
      throw new PinnedOriginError('REMOTE_RESPONSE');
    const ref = CommunityRefSchema.parse(`remote_${randomUUID().replaceAll('-', '')}`);
    const connection = await this.store.addPending(
      {
        ref,
        ownerKey,
        remoteCommunityId: community.id,
        label: community.name,
        pinnedOrigin: origin.origin,
        pairingId: start.pairingId,
        expiresAt: start.expiresAt,
      },
      verifier
    );
    return { connection, approvalUrl: approval.toString() };
  }

  /** Poll once, exchanging an approved code only into the encrypted store. */
  async poll(ref: CommunityRef, ownerKey: string): Promise<RemotePairingPoll> {
    this.enter(ref);
    try {
      const connection = await this.store.get(ref, ownerKey);
      if (connection.status === 'connected')
        return { status: 'connected', connection: this.store.project(connection) };
      if (!connection.pairingId || !connection.expiresAt)
        throw new PinnedOriginError('REMOTE_RESPONSE');
      if (Date.parse(connection.expiresAt) <= Date.now()) {
        await this.store.disconnect(ref, ownerKey);
        return { status: 'expired', connection: null };
      }
      const verifier = await this.store.verifier(ref, ownerKey);
      const origin = parseCommunityOrigin(connection.pinnedOrigin);
      const result = CommunityPairingPollPrivateResponseSchema.parse(
        await pinnedJson(origin, COMMUNITY_API_V1_ROUTES.pairingPoll, {
          pairingId: connection.pairingId,
          verifier,
        })
      );
      if (result.status === 'pending')
        return { status: 'pending', connection: this.store.project(connection) };
      if (result.status !== 'approved') {
        await this.store.disconnect(ref, ownerKey);
        return {
          status: result.status === 'cancelled' ? 'cancelled' : 'expired',
          connection: null,
        };
      }
      if (!result.code) {
        await this.store.disconnect(ref, ownerKey);
        throw new PinnedOriginError('REMOTE_RESPONSE');
      }
      const exchangePayload = await pinnedJson(origin, COMMUNITY_API_V1_ROUTES.pairingExchange, {
        pairingId: connection.pairingId,
        code: result.code,
        verifier,
      });
      const parsedExchange =
        CommunityPairingExchangeSecretResponseSchema.safeParse(exchangePayload);
      if (!parsedExchange.success) throw new PinnedOriginError('REMOTE_RESPONSE');
      const exchanged = parsedExchange.data;
      if (
        !(['read', 'post', 'enroll-agent'] as const).every((scope) =>
          exchanged.grant.scopes.includes(scope)
        )
      )
        throw new PinnedOriginError('REMOTE_RESPONSE');
      const completed = await this.store.complete(
        ref,
        ownerKey,
        exchanged.grant.memberId,
        exchanged.token
      );
      return { status: 'connected', connection: completed };
    } finally {
      this.busy.delete(ref);
    }
  }

  /** Cancel a verifier-bound pending request and clear local protected state. */
  async cancel(ref: CommunityRef, ownerKey: string): Promise<void> {
    this.enter(ref);
    try {
      const connection = await this.store.get(ref, ownerKey);
      if (connection.status !== 'pending') throw new PinnedOriginError('REMOTE_RESPONSE');
      const verifier = await this.store.verifier(ref, ownerKey);
      try {
        await pinnedJson(
          parseCommunityOrigin(connection.pinnedOrigin),
          COMMUNITY_API_V1_ROUTES.pairingCancel,
          { pairingId: connection.pairingId, verifier }
        );
      } finally {
        await this.store.disconnect(ref, ownerKey);
      }
    } finally {
      this.busy.delete(ref);
    }
  }

  /** Remove this owner's connected or pending local credentials and cache. */
  async disconnect(ref: CommunityRef, ownerKey: string): Promise<void> {
    this.enter(ref);
    try {
      await this.store.disconnect(ref, ownerKey);
    } finally {
      this.busy.delete(ref);
    }
  }
}
