/**
 * The hosted-communities family: `/v1/communities`, its moves, and the
 * entitlement and `Problem` additions that go with it.
 *
 * Each case pins a property the app relies on to render the states of the
 * start and move flows, or a property that keeps a secret or a catalog value
 * off this wire. The fixtures test proves every example parses; this file
 * proves the schemas refuse what they must.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import * as contract from '../index.js';
import { V1_ROUTES, v1Path } from '../routes.js';

const fixturesRoot = path.resolve(import.meta.dirname, '..', '..', 'fixtures', 'v1');

/**
 * Reads one conformance fixture.
 *
 * @param rel - The fixture path relative to `fixtures/v1`.
 */
function fixture(rel: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(fixturesRoot, rel), 'utf8')) as Record<string, unknown>;
}

describe('the entitlement additions', () => {
  const withCommunities = fixture('billing/entitlements-communities.json');
  const withoutCommunities = fixture('billing/entitlements-free.json');

  it('parses an entitlement with no community group, so a service one release behind still works', () => {
    expect(contract.EntitlementsSchema.safeParse(withoutCommunities).success).toBe(true);
  });

  it('carries the community limits and the count used when the service sends them', () => {
    const parsed = contract.EntitlementsSchema.parse(withCommunities);
    expect(parsed.limits.communities?.maxCommunities).toBe(3);
    expect(parsed.used.communities).toBe(1);
  });

  it('keeps the group and the count independent: either may be absent alone', () => {
    const limits = withCommunities.limits as Record<string, unknown>;
    const used = withCommunities.used as Record<string, unknown>;
    const { communities: _limits, ...limitsWithout } = limits;
    const { communities: _used, ...usedWithout } = used;
    expect(
      contract.EntitlementsSchema.safeParse({ ...withCommunities, limits: limitsWithout }).success
    ).toBe(true);
    expect(
      contract.EntitlementsSchema.safeParse({ ...withCommunities, used: usedWithout }).success
    ).toBe(true);
  });

  it('reads null as no fixed number, and refuses a negative or fractional one', () => {
    const group = contract.EntitlementCommunityLimitsSchema;
    const unlimited = {
      maxCommunities: null,
      maxMembersPerCommunity: null,
      maxStorageBytesPerCommunity: null,
    };
    expect(group.safeParse(unlimited).success).toBe(true);
    expect(group.safeParse({ ...unlimited, maxCommunities: -1 }).success).toBe(false);
    expect(group.safeParse({ ...unlimited, maxCommunities: 1.5 }).success).toBe(false);
    expect(group.safeParse({ ...unlimited, maxMembersPerCommunity: 0 }).success).toBe(false);
    // Null is a decision the service states, not something a client assumes.
    expect(group.safeParse({ maxMembersPerCommunity: null }).success).toBe(false);
  });
});

describe('the short-name grammar', () => {
  const name = contract.CommunityShortNameSchema;

  it('accepts what a Community server accepts', () => {
    for (const ok of ['acme', 'night-shift', 'a1b', 'a-b-c', 'a'.repeat(32)]) {
      expect(name.safeParse(ok).success, ok).toBe(true);
    }
  });

  it('refuses what a Community server refuses, before a request goes out', () => {
    for (const bad of [
      'ab', // too short
      'a'.repeat(33), // too long
      'Acme', // mixed case is refused, never folded
      '1acme', // starts with a digit
      '-acme',
      'acme-',
      'ac--me', // double hyphen
      'ac_me',
      'ac.me',
      'acmé', // no look-alike letters
      'ac me',
    ]) {
      expect(name.safeParse(bad).success, bad).toBe(false);
    }
  });

  it('binds the start and move requests, and the name check', () => {
    const start = { idempotencyKey: 'k', name: 'Acme' };
    expect(contract.CommunityStartRequestSchema.safeParse(start).success).toBe(true);
    expect(
      contract.CommunityStartRequestSchema.safeParse({ ...start, shortName: 'Acme' }).success
    ).toBe(false);
    expect(contract.CommunityNameCheckQuerySchema.safeParse({ name: 'api-' }).success).toBe(false);
    const move = fixture('communities/move-start-request.json');
    expect(
      contract.CommunityMoveStartRequestSchema.safeParse({ ...move, shortName: 'x' }).success
    ).toBe(false);
  });
});

describe('starting a community', () => {
  const request = contract.CommunityStartRequestSchema;

  it('trims the display name and refuses an empty or overlong one', () => {
    expect(request.parse({ idempotencyKey: 'k', name: '  Acme  ' }).name).toBe('Acme');
    expect(request.safeParse({ idempotencyKey: 'k', name: '   ' }).success).toBe(false);
    expect(request.safeParse({ idempotencyKey: 'k', name: 'a'.repeat(81) }).success).toBe(false);
    expect(request.safeParse({ idempotencyKey: 'k', name: 'a'.repeat(80) }).success).toBe(true);
  });

  it('needs an idempotency key, so a retried start never makes a second community', () => {
    expect(request.safeParse({ name: 'Acme' }).success).toBe(false);
    expect(request.safeParse({ idempotencyKey: '', name: 'Acme' }).success).toBe(false);
  });

  it('answers a repeated key with the community and no claim link', () => {
    const replay = contract.CommunityStartResponseSchema.parse(
      fixture('communities/start-replay.json')
    );
    expect(replay.claim).toBeNull();
    expect(replay.community.actions.claimLink).toBe(true);
  });

  it('refuses a claim link that is not a URL', () => {
    const claim = fixture('communities/claim-link.json');
    expect(
      contract.CommunityClaimLinkSchema.safeParse({ ...claim, claimUrl: 'ct_opaque_0001' }).success
    ).toBe(false);
  });
});

describe('what a hosted community carries', () => {
  const list = contract.HostedCommunityListResponseSchema.parse(fixture('communities/list.json'));

  it('gives the app every state the switcher has to render', () => {
    const states = list.items.map((community) => community.state);
    expect(states).toEqual(expect.arrayContaining(['active', 'pending_owner', 'held']));
    const held = list.items.find((community) => community.state === 'held');
    expect(held?.hold?.reason).toBe('inactive');
    const moving = list.items.find((community) => community.moveId !== null);
    expect(moving?.state).toBe('pending_owner');
  });

  it('refuses a hold reason or a state it does not publish', () => {
    const [first] = fixture('communities/list.json').items as Array<Record<string, unknown>>;
    expect(contract.HostedCommunitySchema.safeParse({ ...first, state: 'deleted' }).success).toBe(
      false
    );
    expect(
      contract.HostedCommunitySchema.safeParse({
        ...first,
        state: 'held',
        hold: { reason: 'unpaid', since: '2026-09-01T00:00:00.000Z', deletionNoticeAt: null },
      }).success
    ).toBe(false);
  });

  it('carries no credential: the claim link and upload token travel on their own routes', () => {
    const fields = Object.keys(contract.HostedCommunitySchema.shape);
    expect(fields.filter((field) => /claim(Url|Token)|token|secret/i.test(field))).toEqual([]);
  });

  it('carries numbers and no amount, plan or account identifier', () => {
    const fields = [
      ...Object.keys(contract.HostedCommunitySchema.shape),
      ...Object.keys(contract.HostedCommunitySchema.shape.limits.shape),
      ...Object.keys(contract.CommunityStartRequestSchema.shape),
      ...Object.keys(contract.CommunityMoveStartRequestSchema.shape),
    ];
    expect(
      fields.filter((field) => /micro|amount|price|cost|plan|billing|tier/i.test(field))
    ).toEqual([]);
  });
});

describe('moving a community in', () => {
  it('names the export by size and lower-case digest before a byte is sent', () => {
    const request = fixture('communities/move-start-request.json');
    const schema = contract.CommunityMoveStartRequestSchema;
    expect(schema.safeParse(request).success).toBe(true);
    const digest = request.archiveSha256 as string;
    expect(schema.safeParse({ ...request, archiveSha256: digest.toUpperCase() }).success).toBe(
      false
    );
    expect(schema.safeParse({ ...request, archiveSha256: digest.slice(1) }).success).toBe(false);
    expect(schema.safeParse({ ...request, archiveBytes: 0 }).success).toBe(false);
    expect(schema.safeParse({ ...request, archiveBytes: 1.5 }).success).toBe(false);
  });

  it('returns the upload token once, and never on a poll', () => {
    const started = contract.CommunityMoveStartResponseSchema.parse(
      fixture('communities/move-start.json')
    );
    expect(started.upload?.token).toBeTruthy();
    // The polled shape has nowhere to put a token or a claim link.
    const pollFields = Object.keys(contract.CommunityMoveSchema.shape);
    expect(pollFields.filter((field) => /token|upload|claim/i.test(field))).toEqual([]);
  });

  it('publishes the digest header the upload needs', () => {
    expect(contract.COMMUNITY_ARCHIVE_DIGEST_HEADER).toBe('X-Archive-SHA256');
  });

  it('gives the app a distinct failure for every sentence the move dialog says', () => {
    // Not an owner export, damaged, too large, out of file space, not supported.
    for (const code of [
      'not_owner_export',
      'archive_invalid',
      'too_large',
      'storage_limit_reached',
      'version_unsupported',
    ]) {
      expect(contract.CommunityMoveFailureCodeSchema.safeParse(code).success, code).toBe(true);
    }
    const failed = contract.CommunityMoveSchema.parse(fixture('communities/move-failed.json'));
    expect(failed.failureCode).toBe('not_owner_export');
    expect(
      contract.CommunityMoveSchema.safeParse({
        ...fixture('communities/move-failed.json'),
        failureCode: 'IMPORT_ARCHIVE_INVALID',
      }).success
    ).toBe(false);
  });

  it('reports counts and sizes, never a name', () => {
    const fields = Object.keys(contract.CommunityMoveReportSchema.shape);
    expect(fields.filter((field) => /name|title|text|email|handle/i.test(field))).toEqual([]);
  });
});

describe('the refusals the flows show', () => {
  it('names a short name that is taken, or reserved, as its own code', () => {
    for (const code of ['community_name_taken', 'community_name_reserved', 'import_too_large']) {
      expect(contract.ProblemCodeSchema.safeParse(code).success, code).toBe(true);
    }
  });

  it('lets a refusal carry the page where a person can act on it', () => {
    const refusal = contract.ProblemSchema.parse(
      fixture('problem/entitlement-required-action.json')
    );
    expect(refusal.code).toBe('entitlement_required');
    expect(refusal.actionUrl).toMatch(/^https:\/\//);
    expect(refusal.actionLabel).toBeTruthy();
    expect(contract.ProblemSchema.safeParse({ ...refusal, actionUrl: '/account' }).success).toBe(
      false
    );
  });

  it('leaves the action optional, so every refusal published before still parses', () => {
    expect(contract.ProblemSchema.safeParse(fixture('problem/unauthenticated.json')).success).toBe(
      true
    );
  });
});

describe('the routes', () => {
  it('serves the family under /v1/communities', () => {
    expect(V1_ROUTES.communities).toBe('/v1/communities');
    expect(V1_ROUTES.communitiesNameCheck).toBe('/v1/communities/name-check');
    expect(V1_ROUTES.communitiesMoves).toBe('/v1/communities/moves');
    expect(v1Path.communityClaimLink('c1')).toBe('/v1/communities/c1/claim-link');
    expect(v1Path.communityKeep('c1')).toBe('/v1/communities/c1/keep');
    expect(v1Path.communityRestore('c1')).toBe('/v1/communities/c1/restore');
    expect(v1Path.communityMove('m1')).toBe('/v1/communities/moves/m1');
    expect(v1Path.communityMoveCancel('m1')).toBe('/v1/communities/moves/m1/cancel');
  });

  it('refuses an identifier that would land on another route in the family', () => {
    expect(() => v1Path.communityKeep('..')).toThrow(TypeError);
    expect(v1Path.communityClaimLink('moves/m1')).toBe('/v1/communities/moves%2Fm1/claim-link');
  });
});
