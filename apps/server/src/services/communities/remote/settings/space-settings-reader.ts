/**
 * Read a connected space's settings for its Settings tab (DOR-3005): the settings, the person's
 * own membership, who is in it and its rules, each through the connection's own `read` grant.
 *
 * Four fixed paths and nothing else. The caller names a read, never a path, so no URL, segment or
 * query from a request reaches the space. The grant is read from the encrypted store here, used
 * as the request's bearer, and never returned, logged or put in an error. What the space sends
 * is checked against its wire schema, and a refusal becomes one plain sentence of our own: a
 * space's own error text is untrusted and is never passed on.
 *
 * Each answer is kept ({@link SpaceSettingsCache}). When the space cannot be reached, the last
 * one is returned with when it came and `offline: true`.
 *
 * @module services/communities/remote/settings/space-settings-reader
 */
import type { ZodType } from 'zod';
import type { CommunityRef } from '@dorkos/shared/community-adapter';
import { CommunityAdminSettingsSchema } from '@dorkos/shared/community-admin-wire';
import {
  CommunityWireMemberDirectoryPageSchema,
  CommunityWireMemberResponseSchema,
  CommunityWireRulesSchema,
} from '@dorkos/shared/community-wire';
import type {
  CommunitySpaceRead,
  CommunitySpaceReadResult,
} from '@dorkos/shared/community-space-settings';
import { logger } from '../../../../lib/logger.js';
import {
  communityApiPath,
  parseCommunityOrigin,
  PinnedHttpError,
  PinnedOriginError,
  pinnedJson,
} from '../pinned-origin.js';
import type { SpaceSettingsCache } from './space-settings-cache.js';

/** The fixed path each read asks the space for. The only paths these reads ever reach. */
export const SPACE_READ_PATHS: Readonly<Record<CommunitySpaceRead, string>> = {
  settings: '/api/v1/settings',
  me: '/api/v1/me',
  members: '/api/v1/members?limit=100&include=agents,availability',
  rules: '/api/v1/rules',
};

/** A space from before the combined directory refuses `include`; this is its plain page. */
const MEMBERS_WITHOUT_EXTRAS = '/api/v1/members?limit=100';

const WIRE: Readonly<Record<CommunitySpaceRead, ZodType>> = {
  settings: CommunityAdminSettingsSchema,
  me: CommunityWireMemberResponseSchema,
  members: CommunityWireMemberDirectoryPageSchema,
  rules: CommunityWireRulesSchema,
};

/** A read the space refused, or answered with something this app cannot read. */
export class SpaceReadRefusedError extends Error {
  /**
   * A refusal the route answers with as it is.
   *
   * @param status - The local status to answer with.
   * @param code - A stable code the client can branch on.
   * @param sentence - One plain sentence for the person; never the space's own text.
   */
  constructor(
    readonly status: 403 | 404 | 409 | 423 | 502 | 503,
    readonly code: string,
    readonly sentence: string
  ) {
    super(code);
    this.name = 'SpaceReadRefusedError';
  }
}

/** Where a connection points and the credential that reads it, resolved per read. */
export interface SpaceConnectionSource {
  /** The connection's pinned origin and the space's id. Throws when it is not connected. */
  place(
    ref: CommunityRef,
    owner: string
  ): Promise<{ pinnedOrigin: string; remoteCommunityId: string }>;
  /** The connection's personal grant. Throws when it needs reconnecting. */
  credential(ref: CommunityRef, owner: string): Promise<string>;
}

/** How a request reaches a space; `pinnedJson` in production, a fake in tests. */
export type SpaceRequest = typeof pinnedJson;

/** Reads a space's settings through its connection, keeping the last answer of each. */
export class SpaceSettingsReader {
  constructor(
    private readonly source: SpaceConnectionSource,
    private readonly cache: SpaceSettingsCache,
    private readonly request: SpaceRequest = pinnedJson,
    private readonly now: () => Date = () => new Date()
  ) {}

  /**
   * One read: the space's answer now, or its last answer when it cannot be reached.
   *
   * @throws {SpaceReadRefusedError} When the space refuses, answers with something unreadable,
   *   or cannot be reached and never answered this read before.
   */
  async read<Read extends CommunitySpaceRead>(
    ref: CommunityRef,
    owner: string,
    read: Read
  ): Promise<CommunitySpaceReadResult<Read>> {
    const place = await this.source.place(ref, owner);
    const authorization = await this.source.credential(ref, owner);
    let value: unknown;
    try {
      value =
        read === 'members'
          ? await this.members(place, authorization)
          : await this.fetch(place, SPACE_READ_PATHS[read], authorization, WIRE[read]);
    } catch (error) {
      if (!unreachable(error)) throw refusal(read, error);
      const kept = await this.cache.get(owner, ref, read);
      // Only the kind of failure, never the error itself: nothing about the request is logged.
      logger.warn('[space-settings] space unreachable; showing its last answer', {
        ref,
        read,
        kept: kept !== undefined,
      });
      if (!kept)
        throw new SpaceReadRefusedError(
          503,
          'SPACE_UNREACHABLE',
          'Can’t reach this space right now.'
        );
      return {
        value: kept.value,
        fetchedAt: kept.fetchedAt,
        offline: true,
      } as CommunitySpaceReadResult<Read>;
    }
    const fetchedAt = this.now().toISOString();
    await this.cache.set(owner, ref, read, { value, fetchedAt }).catch(() => undefined);
    return { value, fetchedAt, offline: false } as CommunitySpaceReadResult<Read>;
  }

  private async fetch(
    place: { pinnedOrigin: string; remoteCommunityId: string },
    path: string,
    authorization: string,
    schema: ZodType
  ): Promise<unknown> {
    const answer = await this.request(
      parseCommunityOrigin(place.pinnedOrigin),
      communityApiPath(place.remoteCommunityId, path),
      undefined,
      undefined,
      { method: 'GET', authorization, maxBytes: 1024 * 1024 }
    );
    const parsed = schema.safeParse(answer);
    if (!parsed.success) throw new PinnedOriginError('REMOTE_RESPONSE');
    return parsed.data;
  }

  /**
   * The first 100 people, with their agents when the space sends them. A space from before the
   * combined directory refuses `include`, and is asked again for its plain page.
   */
  private async members(
    place: { pinnedOrigin: string; remoteCommunityId: string },
    authorization: string
  ): Promise<unknown> {
    try {
      return await this.fetch(place, SPACE_READ_PATHS.members, authorization, WIRE.members);
    } catch (error) {
      if (!(error instanceof PinnedHttpError && error.status === 400)) throw error;
      return this.fetch(place, MEMBERS_WITHOUT_EXTRAS, authorization, WIRE.members);
    }
  }
}

/** Whether the space could not be reached at all, as opposed to answering with a refusal. */
function unreachable(error: unknown): boolean {
  if (error instanceof PinnedOriginError) return error.code === 'REMOTE_UNAVAILABLE';
  if (error instanceof PinnedHttpError)
    return error.status >= 500 && error.remoteCode !== 'COMMUNITY_SUSPENDED';
  return false;
}

/** What each read is, in the sentence that says the space would not show it. */
const SUBJECT: Readonly<Record<CommunitySpaceRead, string>> = {
  settings: 'its settings',
  me: 'your membership',
  members: 'who is in it',
  rules: 'its rules',
};

/** The space's refusal, as one plain sentence of our own and a local status. */
function refusal(read: CommunitySpaceRead, error: unknown): SpaceReadRefusedError {
  if (error instanceof PinnedHttpError) {
    switch (error.remoteCode) {
      case 'COMMUNITY_ARCHIVED':
        return new SpaceReadRefusedError(423, 'SPACE_ARCHIVED', 'This space is archived.');
      case 'COMMUNITY_HELD':
        return new SpaceReadRefusedError(
          423,
          'SPACE_HELD',
          'This space is on hold by its server admin.'
        );
      case 'COMMUNITY_SUSPENDED':
        return new SpaceReadRefusedError(423, 'SPACE_SUSPENDED', 'This space is suspended.');
      case 'COMMUNITY_DELETION_PENDING':
        return new SpaceReadRefusedError(423, 'SPACE_DELETING', 'This space is being deleted.');
      default:
        break;
    }
    if (error.status === 403)
      return new SpaceReadRefusedError(
        403,
        'SPACE_READ_FORBIDDEN',
        `This space doesn’t show ${SUBJECT[read]} to your role.`
      );
    if (error.status === 401)
      return new SpaceReadRefusedError(
        403,
        'SPACE_READ_UNAVAILABLE',
        `This space doesn’t show ${SUBJECT[read]} to the app yet.`
      );
    if (error.status === 404)
      return new SpaceReadRefusedError(404, 'SPACE_NOT_FOUND', 'This space wasn’t found.');
  }
  return new SpaceReadRefusedError(
    502,
    'SPACE_READ_FAILED',
    'This space sent an answer the app can’t read.'
  );
}
