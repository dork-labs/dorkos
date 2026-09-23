/**
 * The hosted-communities family: `/v1/communities`, its moves, and the
 * entitlement and `Problem` additions that go with it.
 *
 * Each case pins a property the app relies on to render the states of the
 * start and move flows, or a property that keeps a secret, an unsafe link or a
 * catalog value off this wire. The fixtures test proves every example parses;
 * this file proves the schemas refuse what they must.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import * as contract from '../index.js';
import { V1_ROUTES, v1Path } from '../routes.js';
import { exportedSchemas, walk } from './schema-walk.js';

const fixturesRoot = path.resolve(import.meta.dirname, '..', '..', 'fixtures', 'v1');

/**
 * Reads one conformance fixture.
 *
 * @param rel - The fixture path relative to `fixtures/v1`.
 */
function fixture(rel: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(fixturesRoot, rel), 'utf8')) as Record<string, unknown>;
}

/** The first community in the list fixture, an active one. */
function activeCommunity(): Record<string, unknown> {
  return (fixture('communities/list.json').items as Array<Record<string, unknown>>)[0];
}

const UNSAFE_LINKS = [
  'javascript:alert(1)',
  'file:///etc/passwd',
  'data:text/html,<script>alert(1)</script>',
  'vscode://open',
  'http://community.example.invalid/c/x',
  'https:community.example.invalid',
];

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

  it('ties the name check`s reason to its answer', () => {
    const check = contract.CommunityNameCheckResponseSchema;
    expect(check.safeParse({ name: 'acme', available: true, reason: 'taken' }).success).toBe(false);
    expect(check.safeParse({ name: 'acme', available: false, reason: null }).success).toBe(false);
  });
});

describe('links a person may be sent to', () => {
  it('accepts only https: for a claim link, and refuses every unsafe scheme', () => {
    const claim = fixture('communities/claim-link.json');
    for (const link of UNSAFE_LINKS) {
      expect(
        contract.CommunityClaimLinkSchema.safeParse({ ...claim, claimUrl: link }).success,
        link
      ).toBe(false);
    }
  });

  it('accepts https:, or http: to loopback only, for a server link', () => {
    const server = contract.ServerUrlSchema;
    expect(server.safeParse('https://community.example.invalid/c/x').success).toBe(true);
    expect(server.safeParse('http://localhost:4242/c/x').success).toBe(true);
    expect(server.safeParse('http://127.0.0.1/c/x').success).toBe(true);
    expect(server.safeParse('http://[::1]:8080/c/x').success).toBe(true);
    expect(server.safeParse('http://localhost.example.invalid/c/x').success).toBe(false);
    for (const link of UNSAFE_LINKS) {
      expect(server.safeParse(link).success, link).toBe(false);
    }
    const community = activeCommunity();
    expect(
      contract.HostedCommunitySchema.safeParse({ ...community, communityUrl: 'javascript:x' })
        .success
    ).toBe(false);
    const upload = fixture('communities/move-upload.json');
    expect(
      contract.CommunityMoveUploadSchema.safeParse({ ...upload, url: 'file:///tmp/x' }).success
    ).toBe(false);
  });

  it('publishes the scheme rule in the JSON Schema too, for a consumer that validates from it', () => {
    const json = JSON.stringify(z.toJSONSchema(contract.CommunityClaimLinkSchema));
    expect(json).toContain('^https:');
    const server = JSON.stringify(z.toJSONSchema(contract.CommunityMoveUploadSchema));
    expect(server).toContain('localhost');
  });

  it('drops a malformed action link on a refusal instead of losing the refusal', () => {
    for (const link of UNSAFE_LINKS) {
      const parsed = contract.ProblemSchema.safeParse({
        code: 'entitlement_required',
        status: 403,
        title: 'No room.',
        actionUrl: link,
        actionLabel: '',
      });
      expect(parsed.success, link).toBe(true);
      expect(parsed.success && parsed.data.actionUrl).toBeUndefined();
      expect(parsed.success && parsed.data.actionLabel).toBeUndefined();
      expect(parsed.success && parsed.data.title).toBe('No room.');
    }
    expect(
      contract.ProblemSchema.parse({
        code: 'entitlement_required',
        status: 403,
        title: 'No room.',
        actionLabel: 'x'.repeat(61),
      }).actionLabel
    ).toBeUndefined();
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

  it('says when an answer is a replay, and a replay never carries the claim link', () => {
    const replay = contract.CommunityStartResponseSchema.parse(
      fixture('communities/start-replay.json')
    );
    expect(replay.replayed).toBe(true);
    expect(replay.claim).toBeNull();
    const first = fixture('communities/start.json');
    expect(
      contract.CommunityStartResponseSchema.safeParse({ ...first, replayed: true }).success
    ).toBe(false);
  });

  it('carries no claim link for a community that is still provisioning', () => {
    const first = fixture('communities/start.json');
    const community = { ...(first.community as Record<string, unknown>), state: 'provisioning' };
    expect(contract.CommunityStartResponseSchema.safeParse({ ...first, community }).success).toBe(
      false
    );
    expect(
      contract.CommunityStartResponseSchema.safeParse({ ...first, community, claim: null }).success
    ).toBe(true);
  });
});

describe('what a hosted community carries', () => {
  const list = contract.HostedCommunityListResponseSchema.parse(fixture('communities/list.json'));

  it('gives the app every state the switcher has to render', () => {
    const states = list.items.map((community) => community.state);
    expect(states).toEqual(
      expect.arrayContaining(['active', 'pending_owner', 'held', 'deletion_pending'])
    );
    const held = list.items.find((community) => community.state === 'held');
    expect(held?.hold?.reason).toBe('inactive');
    const moving = list.items.find((community) => community.moveId !== null);
    expect(moving?.state).toBe('pending_owner');
    const deleting = list.items.find((community) => community.state === 'deletion_pending');
    expect(deleting?.deletionAt).toBeTruthy();
    expect(deleting?.notice?.title).toBeTruthy();
  });

  it('ties hold to the held state and deletionAt to deletion_pending', () => {
    const active = activeCommunity();
    const hold = { reason: 'host', since: '2026-09-01T00:00:00.000Z', deletionNoticeAt: null };
    const parse = (value: Record<string, unknown>) =>
      contract.HostedCommunitySchema.safeParse(value).success;
    expect(parse({ ...active, state: 'held' })).toBe(false);
    expect(parse({ ...active, hold })).toBe(false);
    expect(parse({ ...active, state: 'held', hold })).toBe(true);
    expect(parse({ ...active, state: 'deletion_pending' })).toBe(false);
    expect(parse({ ...active, deletionAt: '2026-09-30T00:00:00.000Z' })).toBe(false);
  });

  it('refuses a hold reason or a state it does not publish', () => {
    const active = activeCommunity();
    expect(contract.HostedCommunitySchema.safeParse({ ...active, state: 'deleted' }).success).toBe(
      false
    );
    expect(
      contract.HostedCommunitySchema.safeParse({
        ...active,
        state: 'held',
        hold: { reason: 'unpaid', since: '2026-09-01T00:00:00.000Z', deletionNoticeAt: null },
      }).success
    ).toBe(false);
  });

  it('refuses a display name longer than a start would accept', () => {
    expect(
      contract.HostedCommunitySchema.safeParse({ ...activeCommunity(), name: 'a'.repeat(81) })
        .success
    ).toBe(false);
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

describe('keeping a community open', () => {
  it('previews which communities keeping this one would hold', () => {
    const list = contract.HostedCommunityListResponseSchema.parse(fixture('communities/list.json'));
    const held = list.items.find((community) => community.state === 'held');
    expect(held?.actions.keep.allowed).toBe(true);
    expect(held?.actions.keep.wouldHold.length).toBeGreaterThan(0);
  });

  it('makes the owner confirm the preview they saw', () => {
    expect(contract.CommunityKeepRequestSchema.safeParse({}).success).toBe(false);
    const request = contract.CommunityKeepRequestSchema.parse(
      fixture('communities/keep-request.json')
    );
    const kept = contract.CommunityKeepResponseSchema.parse(fixture('communities/keep.json'));
    expect(kept.heldCommunityIds).toEqual(request.expectedHeldCommunityIds);
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

  it('returns the upload target on the first answer only, and says when it is a replay', () => {
    const started = fixture('communities/move-start.json');
    expect(contract.CommunityMoveStartResponseSchema.safeParse(started).success).toBe(true);
    expect(
      contract.CommunityMoveStartResponseSchema.safeParse({ ...started, replayed: true }).success
    ).toBe(false);
    expect(
      contract.CommunityMoveStartResponseSchema.safeParse({ ...started, upload: null }).success
    ).toBe(false);
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

  it('ties failureCode to the failed state', () => {
    const ready = fixture('communities/move-ready.json');
    expect(
      contract.CommunityMoveSchema.safeParse({ ...ready, failureCode: 'too_large' }).success
    ).toBe(false);
    expect(
      contract.CommunityMoveSchema.safeParse({
        ...fixture('communities/move-failed.json'),
        failureCode: null,
      }).success
    ).toBe(false);
  });

  it('lists finished moves beside unfinished ones, so a failure survives a restart', () => {
    const moves = contract.CommunityMoveListResponseSchema.parse(fixture('communities/moves.json'));
    expect(moves.items.map((move) => move.state)).toEqual(
      expect.arrayContaining(['importing', 'failed'])
    );
  });

  it('reports counts and sizes, never a name', () => {
    const fields = Object.keys(contract.CommunityMoveReportSchema.shape);
    expect(fields.filter((field) => /name|title|text|email|handle/i.test(field))).toEqual([]);
  });
});

/**
 * Where a one-time credential may appear: the answer that creates it, and the
 * shape that carries it. Nowhere else, and in particular never a list or a
 * poll, which the app reads over and over and the DorkOS server relays.
 */
const CREDENTIAL_PATHS = new Set([
  'CommunityClaimLinkSchema.claimUrl',
  'CommunityStartResponseSchema.claim.claimUrl',
  'CommunityMoveUploadSchema.token',
  'CommunityMoveStartResponseSchema.upload.token',
]);

/** The exported schemas of the hosted-communities family. */
function communitySchemas(): Array<[string, z.ZodTypeAny]> {
  return exportedSchemas().filter(([name]) => /^(Hosted)?Community/.test(name));
}

describe('one-time credentials', () => {
  it('are marked, so a relay can refuse to pass them on', () => {
    const marked: string[] = [];
    for (const [name, schema] of communitySchemas()) {
      for (const { path: at, node } of walk(schema, name)) {
        const meta = z.globalRegistry.get(node) as Record<string, unknown> | undefined;
        if (meta?.[contract.ONE_TIME_CREDENTIAL_META]) marked.push(at);
      }
    }
    expect(marked.sort()).toEqual([...CREDENTIAL_PATHS].sort());
  });

  it('appear under no other name anywhere in the family, however deep', () => {
    // Name-based, so a credential added without the marker is caught too.
    const offenders: string[] = [];
    for (const [name, schema] of communitySchemas()) {
      for (const { path: at } of walk(schema, name)) {
        const field = at.split('.').pop() ?? at;
        if (/token|secret|password|claim_?url|credential/i.test(field) && !CREDENTIAL_PATHS.has(at))
          offenders.push(at);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('are stripped from a list or a poll that carries one by mistake, when re-serialized', () => {
    // The DorkOS server relays the PARSED value, never the raw body, so a
    // service that leaks a credential into a list cannot leak it further.
    const list = fixture('communities/list.json');
    const items = (list.items as Array<Record<string, unknown>>).map((item) => ({
      ...item,
      claimUrl: 'https://community.example.invalid/claim/leaked',
    }));
    const relayed = JSON.stringify(
      contract.HostedCommunityListResponseSchema.parse({ ...list, items })
    );
    expect(relayed).not.toContain('leaked');
    const poll = { ...fixture('communities/move-importing.json'), token: 'upl_leaked' };
    expect(JSON.stringify(contract.CommunityMoveSchema.parse(poll))).not.toContain('leaked');
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
    expect(v1Path.communityMoveUpload('m1')).toBe('/v1/communities/moves/m1/upload');
    expect(v1Path.communityMoveCancel('m1')).toBe('/v1/communities/moves/m1/cancel');
  });

  it('refuses a community identifier that would build another route`s path', () => {
    // `communityClaimLink('moves')` would build `/v1/communities/moves/claim-link`,
    // which reads as the move `claim-link`.
    for (const fixed of ['moves', 'name-check']) {
      expect(() => v1Path.communityClaimLink(fixed)).toThrow(TypeError);
      expect(() => v1Path.communityKeep(fixed)).toThrow(TypeError);
      expect(() => v1Path.communityRestore(fixed)).toThrow(TypeError);
    }
    expect(() => v1Path.communityKeep('..')).toThrow(TypeError);
    expect(v1Path.communityClaimLink('moves/m1')).toBe('/v1/communities/moves%2Fm1/claim-link');
  });
});
