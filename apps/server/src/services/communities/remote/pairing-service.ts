/**
 * Browser-approved connection flow. The browser sees a URL and status; the
 * verifier, one-time code and personal bearer remain inside the local server.
 *
 * @module services/communities/remote/pairing-service
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { COMMUNITY_SEEMS_GONE_AFTER_MS } from '@dorkos/shared/community-connections';
import { logger } from '../../../lib/logger.js';
import { isCommunityDeleted } from './remote-community-adapter.js';
import { CommunityRefSchema, type CommunityRef } from '@dorkos/shared/community-adapter';
import {
  COMMUNITY_API_V1_ROUTES,
  CommunityWireConnectionAccessResponseSchema,
  CommunityWireCommunitySchema,
  CommunityWireHostAccessResponseSchema,
  CommunityWirePairingStartResponseSchema,
  CommunityWireShortNameLookupSchema,
  type CommunityConnectionAccess,
} from '@dorkos/shared/community-wire';
import {
  CommunityPairingPollPrivateResponseSchema,
  CommunityPairingExchangeSecretResponseSchema,
} from '@dorkos/shared/community-private-wire';
import {
  RemoteConnectionAuthorizationError,
  RemoteConnectionStore,
  type RemoteConnectionDescriptor,
} from './connection-store.js';
import {
  communityApiPath,
  isCommunityId,
  parseCommunityLink,
  parseCommunityOrigin,
  pinnedJson,
  PinnedHttpError,
  PinnedOriginError,
} from './pinned-origin.js';

/** What disconnecting told the Community. */
export interface RemoteDisconnectResult {
  /**
   * True when the Community confirmed this installation's grant is gone, or
   * when there was no grant to end. False when it could not be told.
   */
  remoteRevoked: boolean;
}

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

/** An origin-only link cannot choose among multiple private communities. */
export class RemoteCommunitySelectionRequiredError extends Error {
  constructor() {
    super('A canonical community link is required');
    this.name = 'RemoteCommunitySelectionRequiredError';
  }
}

/** A singleton host answered discovery but does not implement qualified tenant routes. */
export class RemoteCommunityUpgradeRequiredError extends Error {
  constructor() {
    super('The Community server does not support tenant-qualified connections');
    this.name = 'RemoteCommunityUpgradeRequiredError';
  }
}

/**
 * Ask a Community whether the account behind this installation's grant runs
 * its host, which decides only whether the app offers "Create a community".
 *
 * Every failure reads as "no": a host built before this read answers 404, and
 * an offer the app cannot confirm is an offer it does not make. The answer
 * grants nothing either way: the host's creation page signs the person in and
 * checks host authority again.
 */
async function readHostOperator(
  origin: URL,
  remoteCommunityId: string,
  authorization: string
): Promise<boolean> {
  try {
    return CommunityWireHostAccessResponseSchema.parse(
      await pinnedJson(
        origin,
        communityApiPath(remoteCommunityId, COMMUNITY_API_V1_ROUTES.hostAccess),
        undefined,
        undefined,
        { authorization }
      )
    ).hostOperator;
  } catch {
    return false;
  }
}

/**
 * How long one list read waits for a Community to re-check its access. Every
 * Community is asked in parallel, so this bounds the access step of the whole
 * list, not each row.
 */
export const COMMUNITY_ACCESS_BUDGET_MS = 750;

/**
 * Decides only what a list read reports for a Community that missed
 * {@link COMMUNITY_ACCESS_BUDGET_MS}: its stored state when some re-check
 * finished within this window, offline otherwise. It is not a revocation
 * window. Stored access is at most one re-check old, and a re-check is always
 * running or recently finished (bounded by its request timeouts, about 15 s),
 * so a refusal is stored within that time whatever this value is. The 90 s only
 * matters while no re-check has finished: longer than the client's 30-second
 * poll, so a Community that is merely slow keeps the answer it gave last poll
 * instead of flickering offline on every read.
 */
export const COMMUNITY_ACCESS_FRESH_MS = 90_000;

/** Timing for the list read's access re-check. Overridden only by tests. */
export interface RemoteAccessTiming {
  /** How long the list waits for one Community's access re-check. */
  budgetMs: number;
  /** How long a completed re-check stands in for one that did not answer in time. */
  freshMs: number;
  /** The clock, in milliseconds. */
  now: () => number;
}

const NO_CAPABILITIES = { read: false, post: false, enrollAgent: false, stream: false };

/** A `/<name>` link whose host knows no community by that name. */
export class RemoteCommunityNameNotFoundError extends Error {
  constructor() {
    super('No community answers to this short name');
    this.name = 'RemoteCommunityNameNotFoundError';
  }
}

/** The host refused a short-name lookup because this server asked too often. */
export class RemoteCommunityLookupRateLimitedError extends Error {
  constructor() {
    super('The community host is limiting short-name lookups');
    this.name = 'RemoteCommunityLookupRateLimitedError';
  }
}

/**
 * Whether a Community answered that it is being deleted: `423 COMMUNITY_DELETION_PENDING`.
 *
 * The one "gone" answer the Community gives today that cannot mean anything else on its own. A
 * finished deletion answers `404 NOT_FOUND`, which a missing channel also answers, so a 404 counts
 * only after this was seen (`communityGone`). A hold
 * (`423 COMMUNITY_HELD`, reported by the access check as a read-only `archived`), an outage (5xx,
 * unreachable) and a bare `404` (which a missing channel also answers) are deliberately NOT gone:
 * treating them as gone would delete this installation's copy of a community that still exists.
 */
function isDeletionPending(error: unknown): boolean {
  return (
    error instanceof PinnedHttpError &&
    error.status === 423 &&
    error.remoteCode === 'COMMUNITY_DELETION_PENDING'
  );
}

/** Whether a Community answered `404 NOT_FOUND`: what a finished deletion answers. */
function isNotFound(error: unknown): boolean {
  return (
    error instanceof PinnedHttpError && error.status === 404 && error.remoteCode === 'NOT_FOUND'
  );
}

/** Pairing orchestration scoped to the local owner's verified author ID. */
export class RemoteCommunityPairingService {
  private readonly busy = new Set<CommunityRef>();
  /** The one access re-check in flight per owner and connection. */
  private readonly checking = new Map<string, Promise<RemoteConnectionDescriptor>>();
  /** When each owner's connection last finished an access re-check, whatever it found. */
  private readonly checkedAt = new Map<string, number>();
  /** Connections whose deleted community's copies were purged, so a later check does not purge again. */
  private readonly purgedGone = new Set<string>();
  private readonly timing: RemoteAccessTiming;

  private enter(ref: CommunityRef): void {
    if (this.busy.has(ref)) throw new RemotePairingBusyError();
    this.busy.add(ref);
  }

  /**
   * Bind pairing to the local encrypted connection store.
   *
   * @param store - Private encrypted local connection store.
   * @param onReconnectRequired - Revokes and purges everything derived from one owner's
   *   connection: called when the grant is rejected, when the Community is being deleted, and
   *   when the owner disconnects.
   */
  constructor(
    private readonly store: RemoteConnectionStore,
    private readonly onReconnectRequired?: (
      communityRef: CommunityRef,
      ownerKey: string
    ) => Promise<void>,
    private readonly onAccessAuthorityChanged?: (
      communityRef: CommunityRef,
      ownerKey: string
    ) => void,
    timing: Partial<RemoteAccessTiming> = {}
  ) {
    this.timing = {
      budgetMs: COMMUNITY_ACCESS_BUDGET_MS,
      freshMs: COMMUNITY_ACCESS_FRESH_MS,
      now: Date.now,
      ...timing,
    };
  }

  private notifyAccessAuthorityChanged(
    ref: CommunityRef,
    ownerKey: string,
    before: CommunityConnectionAccess | null | undefined,
    after: CommunityConnectionAccess
  ): void {
    if (
      before?.state === after.state &&
      before.effective.read === after.effective.read &&
      before.effective.post === after.effective.post &&
      before.effective.enrollAgent === after.effective.enrollAgent &&
      before.effective.stream === after.effective.stream
    )
      return;
    this.onAccessAuthorityChanged?.(ref, ownerKey);
  }

  private async requireReconnect(ref: CommunityRef, ownerKey: string): Promise<void> {
    const results = await Promise.allSettled([
      this.onReconnectRequired?.(ref, ownerKey) ?? Promise.resolve(),
      this.store.requireReconnect(ref, ownerKey),
    ]);
    const failures = results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : []
    );
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1)
      throw new AggregateError(failures, 'Failed to revoke the rejected community connection');
  }

  /**
   * Read only the caller's non-secret connection status, without letting one
   * slow Community hold up the rest.
   *
   * Each connected Community re-checks its access in parallel, within
   * {@link COMMUNITY_ACCESS_BUDGET_MS}. One that does not answer in time is
   * reported from what this server already knows: its stored state when a
   * re-check finished within {@link COMMUNITY_ACCESS_FRESH_MS}, otherwise as
   * offline (`unverified`, its last known access kept, nothing live allowed).
   * A slow answer is never read as a refusal, so it can never turn into
   * reconnect-required. The re-check keeps running, stores its outcome exactly
   * as before (a real refusal still requires reconnecting) and the next read
   * uses it. Nothing is announced on the live stream: the announcement would
   * make every window read again, and that read would start the next re-check.
   */
  async list(ownerKey: string): Promise<RemoteConnectionDescriptor[]> {
    await this.store.sweepExpired(ownerKey, this.busy);
    const connections = await this.store.list(ownerKey);
    return Promise.all(
      connections.map(async (connection) =>
        this.withGoneHint(await this.verifyWithinBudget(connection.ref, ownerKey), ownerKey)
      )
    );
  }

  /**
   * A request answered `410 COMMUNITY_DELETED`: check this connection's access now, which records
   * the deletion and purges the copies (DOR-2334). Nothing to do once the deletion is recorded:
   * every later request of a deleted community answers the same, and each would otherwise ask.
   */
  async communityDeletedSeen(ref: CommunityRef, ownerKey: string): Promise<void> {
    const record = await this.store.get(ref, ownerKey).catch(() => null);
    if (!record || record.access?.lastKnown?.lifecycle === 'deleted') return;
    await this.status(ref, ownerKey);
  }

  /**
   * Say a connection "seems to be gone" once the Community has answered `404 NOT_FOUND` for it,
   * with no pending deletion seen first, for {@link COMMUNITY_SEEMS_GONE_AFTER_MS} (DOR-2334).
   * Only a hint the app shows beside an offer to remove the local copy: nothing is deleted on it,
   * since a deleted community and a misconfigured host answer alike.
   */
  private async withGoneHint(
    descriptor: RemoteConnectionDescriptor,
    ownerKey: string
  ): Promise<RemoteConnectionDescriptor> {
    const lifecycle = descriptor.access?.lastKnown?.lifecycle;
    if (lifecycle === 'deleted' || lifecycle === 'deletion_pending') return descriptor;
    const since = await this.store.notFoundSince(descriptor.ref, ownerKey);
    if (!since || this.timing.now() - Date.parse(since) < COMMUNITY_SEEMS_GONE_AFTER_MS)
      return descriptor;
    return { ...descriptor, seemsGoneSince: since };
  }

  /**
   * Read one descriptor without exposing another local owner's connection.
   * This waits for the Community's full answer, joining a re-check the list
   * already started, because lifecycle callers act on the result.
   */
  async status(ref: CommunityRef, ownerKey: string): Promise<RemoteConnectionDescriptor> {
    await this.store.sweepExpired(ownerKey, this.busy);
    return this.withGoneHint(await this.sharedVerify(ref, ownerKey), ownerKey);
  }

  /** Start, or join, the one access re-check for this owner's connection. */
  private sharedVerify(ref: CommunityRef, ownerKey: string): Promise<RemoteConnectionDescriptor> {
    const key = `${ownerKey}\0${ref}`;
    const inFlight = this.checking.get(key);
    if (inFlight) return inFlight;
    const pending = this.verify(ref, ownerKey)
      .then((descriptor) => {
        this.checkedAt.set(key, this.timing.now());
        return descriptor;
      })
      .finally(() => {
        if (this.checking.get(key) === pending) this.checking.delete(key);
      });
    // The re-check may outlive every reader that waited on it.
    pending.catch(() => undefined);
    this.checking.set(key, pending);
    return pending;
  }

  private async verifyWithinBudget(
    ref: CommunityRef,
    ownerKey: string
  ): Promise<RemoteConnectionDescriptor> {
    const pending = this.sharedVerify(ref, ownerKey);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settled = await Promise.race([
      pending.then(
        (descriptor) => ({ descriptor }),
        (error: unknown) => ({ error })
      ),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), this.timing.budgetMs);
      }),
    ]);
    clearTimeout(timer);
    if (settled) {
      if ('error' in settled) throw settled.error;
      return settled.descriptor;
    }
    const record = await this.store.get(ref, ownerKey);
    const checkedAt = this.checkedAt.get(`${ownerKey}\0${ref}`);
    if (
      record.status !== 'connected' ||
      (checkedAt !== undefined && this.timing.now() - checkedAt <= this.timing.freshMs)
    )
      return this.store.project(record);
    // Only reported, never stored: the re-check still running records the truth.
    return {
      ...this.store.project(record),
      access: {
        state: 'unverified',
        effective: NO_CAPABILITIES,
        lastKnown: record.access?.lastKnown ?? null,
      },
    };
  }

  /** Forget re-check timing for a connection this owner no longer has. */
  private forgetChecks(ref: CommunityRef, ownerKey: string): void {
    const key = `${ownerKey}\0${ref}`;
    this.checking.delete(key);
    this.checkedAt.delete(key);
  }

  private async verify(ref: CommunityRef, ownerKey: string): Promise<RemoteConnectionDescriptor> {
    const record = await this.store.get(ref, ownerKey);
    if (record.status !== 'connected') return this.store.project(record);
    const authorization = await this.store.personalToken(ref, ownerKey);
    const origin = parseCommunityOrigin(record.pinnedOrigin);
    // Asked beside the access check, not after it, so a list costs no extra
    // round trip; it never throws, so it cannot fail the access check.
    const hostOperator = readHostOperator(origin, record.remoteCommunityId, authorization);
    let access: CommunityConnectionAccess;
    try {
      access = CommunityWireConnectionAccessResponseSchema.parse(
        await pinnedJson(
          origin,
          communityApiPath(record.remoteCommunityId, COMMUNITY_API_V1_ROUTES.connectionAccess),
          undefined,
          undefined,
          { authorization }
        )
      ).access;
    } catch (error) {
      // Any definite answer other than `404 NOT_FOUND` comes from a community that exists — a
      // rejected grant (401) included, after which this check never runs again for a connection
      // that only needs reconnecting — so the "not found" count starts over.
      if (error instanceof PinnedHttpError && error.status < 500 && !isNotFound(error))
        await this.store.clearNotFound(ref, ownerKey);
      if (error instanceof PinnedHttpError && error.status === 401) {
        await this.requireReconnect(ref, ownerKey);
        return this.store.project(await this.store.get(ref, ownerKey));
      }
      if (isDeletionPending(error))
        return this.communityGone(ref, ownerKey, record.access, 'deletion_pending');
      // The Community keeps a record of a finished deletion for a while and answers this from it:
      // definite, whatever this installation saw before (DOR-2334).
      if (isCommunityDeleted(error))
        return this.communityGone(ref, ownerKey, record.access, 'deleted');
      // A finished deletion removes the community's row, and the Community then answers
      // `404 NOT_FOUND`, which on its own could also be a missing channel. Having seen the
      // deletion pending, it is final (DOR-2334).
      if (
        isNotFound(error) &&
        (record.access?.lastKnown?.lifecycle === 'deletion_pending' ||
          record.access?.lastKnown?.lifecycle === 'deleted')
      )
        return this.communityGone(ref, ownerKey, record.access, 'deleted');
      // Never a deletion on its own: remembered, so a community that keeps answering this for
      // two weeks is offered for removal (`withGoneHint`), never removed.
      if (isNotFound(error))
        await this.store.markNotFound(ref, ownerKey, new Date(this.timing.now()).toISOString());
      const unavailable = await this.store.updateAccess(ref, ownerKey, {
        state: 'unverified',
        effective: { read: false, post: false, enrollAgent: false, stream: false },
        lastKnown: record.access?.lastKnown ?? null,
      });
      this.notifyAccessAuthorityChanged(ref, ownerKey, record.access, unavailable.access!);
      return unavailable;
    }
    await this.store.clearNotFound(ref, ownerKey);
    const verified = await this.store.updateAccess(ref, ownerKey, access, await hostOperator);
    this.notifyAccessAuthorityChanged(ref, ownerKey, record.access, verified.access!);
    return verified;
  }

  /**
   * The Community is being deleted, or its deletion finished (DOR-2334). Everything this
   * installation copied from it goes, through the same path a rejected grant takes: streams and
   * queued posts stop, local agents' turns in its rooms halt, their enrollments end, and the
   * mirrored rooms, their entries, files and search rows are purged.
   *
   * The no-access state is recorded FIRST, so whatever happens to the purge, nothing here goes on
   * treating the community as live; the purge runs after, and a failed one is logged and tried
   * again on the next check, never thrown into the connection list. A purge that succeeded is
   * not repeated while the state lasts: every check of a pending deletion would otherwise purge
   * again.
   *
   * A pending deletion can be cancelled on the Community, but every grant was revoked when it
   * was requested, so a cancelled deletion answers the next check with a 401 and the person
   * reconnects; the mirrors then fill again from the Community, and their agents are added again.
   * A finished deletion answers `410 COMMUNITY_DELETED` while the Community keeps its record of
   * it, and `404 NOT_FOUND` after; either is recorded here as `deleted` (the 404 only after the
   * deletion was seen pending). The bearer is kept
   * either way, since it is what hears those answers.
   */
  private async communityGone(
    ref: CommunityRef,
    ownerKey: string,
    before: CommunityConnectionAccess | null | undefined,
    lifecycle: 'deletion_pending' | 'deleted'
  ): Promise<RemoteConnectionDescriptor> {
    const gone = await this.store.updateAccess(ref, ownerKey, {
      state: 'verified',
      effective: NO_CAPABILITIES,
      lastKnown: {
        lifecycle,
        capabilities: NO_CAPABILITIES,
        verifiedAt: new Date(this.timing.now()).toISOString(),
      },
    });
    this.notifyAccessAuthorityChanged(ref, ownerKey, before, gone.access!);
    const key = `${ownerKey}\0${ref}`;
    const wasGone =
      before?.lastKnown?.lifecycle === 'deletion_pending' ||
      before?.lastKnown?.lifecycle === 'deleted';
    if (!(wasGone && this.purgedGone.has(key))) {
      const [purge] = await Promise.allSettled([
        this.onReconnectRequired?.(ref, ownerKey) ?? Promise.resolve(),
      ]);
      if (purge.status === 'fulfilled') this.purgedGone.add(key);
      else {
        this.purgedGone.delete(key);
        logger.warn('[communities] could not remove every copy of a deleted community; retrying', {
          error: purge.reason instanceof Error ? purge.reason.message : String(purge.reason),
        });
      }
    }
    return gone;
  }

  /** Begin a ten-minute verifier-bound request at the checked deployment origin. */
  async start(ownerKey: string, url: string, installName: string): Promise<RemotePairingStart> {
    const link = parseCommunityLink(url);
    const target = link.shortName
      ? {
          origin: link.origin,
          communityId: await this.resolveShortName(link.origin, link.shortName),
        }
      : link;
    const discoveryPath = target.communityId
      ? communityApiPath(target.communityId, COMMUNITY_API_V1_ROUTES.community)
      : COMMUNITY_API_V1_ROUTES.community;
    let discovered: unknown;
    try {
      discovered = await pinnedJson(target.origin, discoveryPath);
    } catch (error) {
      if (!target.communityId && error instanceof PinnedHttpError && error.status === 409)
        throw new RemoteCommunitySelectionRequiredError();
      throw error;
    }
    const community = CommunityWireCommunitySchema.parse(discovered);
    if (target.communityId && community.id !== target.communityId)
      throw new PinnedOriginError('REMOTE_RESPONSE');
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    let pairingStart: unknown;
    try {
      pairingStart = await pinnedJson(
        target.origin,
        communityApiPath(community.id, COMMUNITY_API_V1_ROUTES.pairingStart),
        {
          installName,
          challenge,
          scopes: ['read', 'post', 'enroll-agent'],
        }
      );
    } catch (error) {
      if (!target.communityId && error instanceof PinnedHttpError && error.status === 404)
        throw new RemoteCommunityUpgradeRequiredError();
      throw error;
    }
    const start = CommunityWirePairingStartResponseSchema.parse(pairingStart);
    const approval = new URL(start.approvalUrl);
    if (
      approval.origin !== target.origin.origin ||
      approval.pathname !== `/c/${community.id}/pairing` ||
      approval.searchParams.get('pairingId') !== start.pairingId ||
      approval.searchParams.size !== 1 ||
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
        pinnedOrigin: target.origin.origin,
        pairingId: start.pairingId,
        expiresAt: start.expiresAt,
      },
      verifier
    );
    return { connection, approvalUrl: approval.toString() };
  }

  /**
   * Resolve a short name to its community's UUID through the host's public lookup, over the
   * same pinned, redirect-free socket as every other call. From here on the connection only
   * knows the UUID, so a later rename or release of the name never changes which community it
   * talks to.
   */
  private async resolveShortName(origin: URL, shortName: string): Promise<string> {
    let answer: unknown;
    try {
      answer = await pinnedJson(
        origin,
        COMMUNITY_API_V1_ROUTES.communityName.replace(':name', shortName)
      );
    } catch (error) {
      if (error instanceof PinnedHttpError && error.status === 404)
        throw new RemoteCommunityNameNotFoundError();
      if (error instanceof PinnedHttpError && error.status === 429)
        throw new RemoteCommunityLookupRateLimitedError();
      throw error;
    }
    const parsed = CommunityWireShortNameLookupSchema.safeParse(answer);
    if (!parsed.success || !isCommunityId(parsed.data.communityId))
      throw new PinnedOriginError('REMOTE_RESPONSE');
    return parsed.data.communityId;
  }

  /** Poll once, exchanging an approved code only into the encrypted store. */
  async poll(ref: CommunityRef, ownerKey: string): Promise<RemotePairingPoll> {
    this.enter(ref);
    try {
      const connection = await this.store.get(ref, ownerKey);
      if (connection.status === 'connected')
        return { status: 'connected', connection: this.store.project(connection) };
      if (connection.status === 'reconnect-required')
        throw new RemoteConnectionAuthorizationError();
      if (!connection.pairingId || !connection.expiresAt)
        throw new PinnedOriginError('REMOTE_RESPONSE');
      if (Date.parse(connection.expiresAt) <= Date.now()) {
        await this.store.disconnect(ref, ownerKey);
        return { status: 'expired', connection: null };
      }
      const verifier = await this.store.verifier(ref, ownerKey);
      const origin = parseCommunityOrigin(connection.pinnedOrigin);
      const result = CommunityPairingPollPrivateResponseSchema.parse(
        await pinnedJson(
          origin,
          communityApiPath(connection.remoteCommunityId, COMMUNITY_API_V1_ROUTES.pairingPoll),
          {
            pairingId: connection.pairingId,
            verifier,
          }
        )
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
      const exchangePayload = await pinnedJson(
        origin,
        communityApiPath(connection.remoteCommunityId, COMMUNITY_API_V1_ROUTES.pairingExchange),
        { pairingId: connection.pairingId, code: result.code, verifier }
      );
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
        exchanged.token,
        {
          state: 'verified',
          effective: exchanged.grant.capabilities,
          lastKnown: {
            lifecycle: exchanged.grant.lifecycle,
            capabilities: exchanged.grant.capabilities,
            verifiedAt: new Date().toISOString(),
          },
        }
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
          communityApiPath(connection.remoteCommunityId, COMMUNITY_API_V1_ROUTES.pairingCancel),
          { pairingId: connection.pairingId, verifier }
        );
      } finally {
        await this.store.disconnect(ref, ownerKey);
      }
    } finally {
      this.busy.delete(ref);
    }
  }

  /**
   * Disconnect this installation: revoke its grant on the Community, then
   * remove this owner's local credentials and cache.
   *
   * The Community is told first, with the installation's own bearer, because
   * after the local copy is gone nothing could prove which grant to end. The
   * local copy is removed whatever the Community answers: the person asked to
   * disconnect, and an unreachable Community must not keep a credential here.
   * The result says whether the Community confirmed the grant is gone, so the
   * person can be told when it could not be reached.
   *
   * @param ref - Local connection ref.
   * @param ownerKey - The local owner the connection belongs to.
   */
  async disconnect(ref: CommunityRef, ownerKey: string): Promise<RemoteDisconnectResult> {
    this.enter(ref);
    try {
      const record = await this.store.get(ref, ownerKey);
      // Revoke whenever a bearer is still stored, reconnect-required included:
      // a grant the Community refused for a missing scope can still be live
      // there, and the revoke is idempotent. A pending request never received
      // a grant, so it has no bearer and makes no call. Revocation never
      // throws, so the local copy is always removed below.
      const bearer = await this.store.storedPersonalToken(ref, ownerKey);
      // A connected record that lost its bearer cannot confirm anything, so it
      // reports unconfirmed rather than claiming the grant is gone.
      //
      // A reconnect-required record with no bearer reports true without a
      // call. That is "assumed ended, not confirmed": requireReconnect dropped
      // the bearer because the Community rejected it, so a grant refused only
      // for a missing scope could in theory still be live there. It is rare,
      // because grants are approved with fixed scopes, and reporting false
      // here would warn on every ordinary revocation.
      const remoteRevoked = bearer
        ? await this.revokeRemoteGrant(bearer, record)
        : record.status !== 'connected';
      // Everything copied through this connection goes with it (DOR-2334): the same path a
      // rejected grant takes stops its streams and agents' turns and purges its mirrored rooms,
      // their files and search rows. Before the credential is removed, and never allowed to keep
      // the credential here: a failure is logged and the disconnect still completes.
      try {
        await this.onReconnectRequired?.(ref, ownerKey);
      } catch (error) {
        logger.warn('[communities] could not remove every copy of a disconnected community', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      await this.store.disconnect(ref, ownerKey);
      await this.store.clearNotFound(ref, ownerKey).catch(() => undefined);
      return { remoteRevoked };
    } finally {
      this.forgetChecks(ref, ownerKey);
      this.busy.delete(ref);
    }
  }

  private async revokeRemoteGrant(
    bearer: string,
    record: { pinnedOrigin: string; remoteCommunityId: string }
  ): Promise<boolean> {
    try {
      await pinnedJson(
        parseCommunityOrigin(record.pinnedOrigin),
        communityApiPath(record.remoteCommunityId, COMMUNITY_API_V1_ROUTES.meConnection),
        undefined,
        undefined,
        {
          method: 'DELETE',
          authorization: bearer,
          accept: [204],
        }
      );
      return true;
    } catch (error) {
      // 401: the Community no longer accepts this bearer, so its grant is
      // already gone. Anything else (unreachable, refused, an older Community
      // without this route) leaves the grant unconfirmed.
      return error instanceof PinnedHttpError && error.status === 401;
    }
  }
}
