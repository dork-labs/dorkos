import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  CommunityAdminHostApiKeyIssueRequestSchema,
  CommunityAdminHostApiKeyScopeSchema,
  CommunityAdminHostApiKeySchema,
  CommunityAdminHostProjectionSchema,
  CommunityAdminOwnerReplacementCancelRequestSchema,
  CommunityAdminOwnerReplacementClaimTokenRequestSchema,
  CommunityAdminOwnerReplacementClaimTokenSchema,
  CommunityAdminOwnerReplacementCreateResponseSchema,
  CommunityAdminOwnerReplacementListSchema,
  CommunityAdminOwnerReplacementRequestSchema,
  CommunityAdminOwnerReplacementSchema,
} from '../community-admin-wire.js';
import {
  COMMUNITY_API_V1_ROUTES,
  CommunityWireErrorCodeSchema,
  CommunityWireOwnerReplacementClaimRequestSchema,
  CommunityWireOwnerReplacementClaimResponseSchema,
  CommunityWireOwnerReplacementNoticeResponseSchema,
  CommunityWireOwnerReplacementObjectPreflightResponseSchema,
  CommunityWireOwnerReplacementObjectRequestSchema,
  CommunityWireOwnerReplacementObjectResponseSchema,
  CommunityWireOwnerReplacementObjectionRequestSchema,
  CommunityWireOwnerReplacementPreflightRequestSchema,
  CommunityWireOwnerReplacementPreflightResponseSchema,
} from '../community-wire.js';

const ID = '5f1c3c9e-9d7a-4b8e-9f00-1a2b3c4d5e6f';
const AT = '2026-10-01T12:00:00.000Z';

const request = {
  idempotencyKey: 'replace-1',
  lifecycleVersion: 3,
  reason: 'owner_unreachable',
  reference: 'CASE-123 #4.5_x',
  claimant: { oidcSubject: null },
} as const;

const replacement = {
  replacementId: ID,
  communityId: ID,
  state: 'waiting',
  reason: 'other',
  reference: null,
  claimantNamed: true,
  requestedAt: AT,
  requestedBy: { kind: 'api_key', label: 'dkh_abcdef' },
  notice: { state: 'accepted', resolvedAt: AT, verifiedAddress: false },
  wait: 'long',
  claimableAfter: AT,
  claimExpiresAt: null,
  claimReissuedAt: null,
  endedAt: null,
  withdrawnBecause: null,
  cooldownUntil: null,
  afterObjection: false,
  afterWithdrawal: false,
} as const;

const adminNotice = {
  role: 'admin',
  replacementId: ID,
  state: 'waiting',
  reason: 'owner_left_group',
  requestedAt: AT,
  claimableAfter: AT,
  noticeState: 'failed',
} as const;

const ownerNotice = {
  ...adminNotice,
  role: 'owner',
  reference: 'ABC-123',
  claimReissuedAt: null,
  options: { keep: true, transfer: false, delete: true, needsPassword: false },
  objectionCooldownDays: 90,
} as const;

const projection = {
  id: ID,
  name: 'Acme',
  description: null,
  lifecycle: 'active',
  lifecycleVersion: 2,
  settingsVersion: 1,
  ownerPresent: true,
  deletionState: null,
  deletionNoticeAt: null,
  deletionRequestedBy: null,
  shortName: null,
  legalHold: null,
  importId: null,
  importState: null,
  ownerReplacement: null,
  createdAt: AT,
} as const;

/** Every strict schema here, each with one valid value. */
const strictSchemas: [string, z.ZodType, Record<string, unknown>][] = [
  ['request', CommunityAdminOwnerReplacementRequestSchema, request],
  ['replacement', CommunityAdminOwnerReplacementSchema, replacement],
  [
    'create response',
    CommunityAdminOwnerReplacementCreateResponseSchema,
    {
      replacement,
      claimToken: 'token',
      claimUrl: 'https://community.example/owner-replacement#token',
      replayed: false,
    },
  ],
  ['list', CommunityAdminOwnerReplacementListSchema, { replacements: [replacement] }],
  ['cancel', CommunityAdminOwnerReplacementCancelRequestSchema, {}],
  ['reissue', CommunityAdminOwnerReplacementClaimTokenRequestSchema, {}],
  [
    'claim token',
    CommunityAdminOwnerReplacementClaimTokenSchema,
    {
      replacementId: ID,
      claimToken: 'token',
      claimUrl: 'https://community.example/owner-replacement#token',
    },
  ],
  ['projection', CommunityAdminHostProjectionSchema, projection],
  [
    'notice',
    CommunityWireOwnerReplacementNoticeResponseSchema,
    { open: ownerNotice, completed: null },
  ],
  ['objection', CommunityWireOwnerReplacementObjectionRequestSchema, { replacementId: ID }],
  ['object', CommunityWireOwnerReplacementObjectRequestSchema, { token: 'token' }],
  [
    'object preflight',
    CommunityWireOwnerReplacementObjectPreflightResponseSchema,
    { communityName: 'Acme', claimableAfter: null, objectionCooldownDays: 90 },
  ],
  ['object response', CommunityWireOwnerReplacementObjectResponseSchema, { outcome: 'kept' }],
  ['claim preflight', CommunityWireOwnerReplacementPreflightRequestSchema, { token: 'token' }],
  [
    'claim preflight response',
    CommunityWireOwnerReplacementPreflightResponseSchema,
    {
      communityId: ID,
      communityName: 'Acme',
      state: 'claimable',
      claimableAfter: AT,
      claimExpiresAt: AT,
      requiresSingleSignOn: true,
    },
  ],
  ['claim', CommunityWireOwnerReplacementClaimRequestSchema, {}],
  [
    'claim response',
    CommunityWireOwnerReplacementClaimResponseSchema,
    { community: { id: ID, name: 'Acme' }, memberId: 'member-1' },
  ],
];

describe('owner replacement wire schemas', () => {
  // Purpose: fails if any schema is loose, so a database column (a member id, the OIDC subject)
  // could ride out on a response without a schema change.
  it.each(strictSchemas)('%s accepts its shape and refuses an extra field', (_, schema, value) => {
    expect(schema.safeParse(value).success).toBe(true);
    expect(schema.safeParse({ ...value, ownerEmail: 'leak@example.test' }).success).toBe(false);
  });

  // Purpose: fails if the nested objects are loose, since they sit inside strict parents.
  it('refuses extra fields in nested objects', () => {
    expect(
      CommunityAdminOwnerReplacementRequestSchema.safeParse({
        ...request,
        claimant: { oidcSubject: null, issuer: 'https://idp.example' },
      }).success
    ).toBe(false);
    expect(
      CommunityAdminOwnerReplacementSchema.safeParse({
        ...replacement,
        requestedBy: { ...replacement.requestedBy, userId: 'u' },
      }).success
    ).toBe(false);
    expect(
      CommunityAdminOwnerReplacementSchema.safeParse({
        ...replacement,
        notice: { ...replacement.notice, email: 'owner@example.test' },
      }).success
    ).toBe(false);
    expect(
      CommunityAdminHostProjectionSchema.safeParse({
        ...projection,
        ownerReplacement: {
          replacementId: ID,
          state: 'waiting',
          claimableAfter: AT,
          reference: 'x',
        },
      }).success
    ).toBe(false);
  });

  // Purpose: fails if the reference can form a link, markup, or a second line, or grows past 80.
  it.each([
    ['a colon', 'https:x'],
    ['a slash', 'a/b'],
    ['markup', '<b>'],
    ['a newline', 'ABC\n123'],
    ['81 characters', 'a'.repeat(81)],
    ['nothing', ''],
  ])('refuses a reference with %s', (_, reference) => {
    expect(
      CommunityAdminOwnerReplacementRequestSchema.safeParse({ ...request, reference }).success
    ).toBe(false);
    expect(
      CommunityAdminOwnerReplacementSchema.safeParse({ ...replacement, reference }).success
    ).toBe(false);
    expect(
      CommunityWireOwnerReplacementNoticeResponseSchema.safeParse({
        open: { ...ownerNotice, reference },
        completed: null,
      }).success
    ).toBe(false);
  });

  it('accepts an 80-character reference and no reference', () => {
    expect(
      CommunityAdminOwnerReplacementRequestSchema.safeParse({
        ...request,
        reference: 'a'.repeat(80),
      }).success
    ).toBe(true);
    expect(
      CommunityAdminOwnerReplacementRequestSchema.safeParse({ ...request, reference: null }).success
    ).toBe(true);
  });

  // Purpose: fails if the request loses a field the route relies on, or takes an unknown reason.
  it('bounds the request', () => {
    const parse = (value: unknown) => CommunityAdminOwnerReplacementRequestSchema.safeParse(value);
    expect(parse({ ...request, password: 'secret' }).success).toBe(true);
    expect(parse({ ...request, password: '' }).success).toBe(false);
    expect(parse({ ...request, reason: 'dispute' }).success).toBe(false);
    expect(parse({ ...request, idempotencyKey: 'k'.repeat(201) }).success).toBe(false);
    expect(parse({ ...request, lifecycleVersion: 0 }).success).toBe(false);
    expect(parse({ ...request, claimant: { oidcSubject: 's'.repeat(255) } }).success).toBe(true);
    expect(parse({ ...request, claimant: { oidcSubject: 's'.repeat(256) } }).success).toBe(false);
    expect(parse({ ...request, claimant: { oidcSubject: '' } }).success).toBe(false);
    const { claimant: _claimant, ...withoutClaimant } = request;
    expect(parse(withoutClaimant).success).toBe(false);
  });

  // Purpose: fails if the host list can carry more than the route's page.
  it('caps the host list at 50', () => {
    const many = (count: number) => ({ replacements: Array(count).fill(replacement) });
    expect(CommunityAdminOwnerReplacementListSchema.safeParse(many(50)).success).toBe(true);
    expect(CommunityAdminOwnerReplacementListSchema.safeParse(many(51)).success).toBe(false);
  });

  // Purpose: fails if the projection or a tenant read could show a closed replacement as open.
  it('shows only open states where only an open replacement belongs', () => {
    for (const state of ['completed', 'objected', 'withdrawn', 'superseded', 'expired']) {
      expect(
        CommunityAdminHostProjectionSchema.safeParse({
          ...projection,
          ownerReplacement: { replacementId: ID, state, claimableAfter: null },
        }).success
      ).toBe(false);
      expect(
        CommunityWireOwnerReplacementNoticeResponseSchema.safeParse({
          open: { ...adminNotice, state },
          completed: null,
        }).success
      ).toBe(false);
    }
  });

  // Purpose: fails if an admin's read could carry the owner's reference or options, or if the
  // owner's read could drop its options.
  it('keeps the owner and admin notices apart', () => {
    const parse = (open: unknown) =>
      CommunityWireOwnerReplacementNoticeResponseSchema.safeParse({ open, completed: null });
    expect(parse(adminNotice).success).toBe(true);
    expect(parse(ownerNotice).success).toBe(true);
    expect(parse({ ...adminNotice, reference: 'ABC-123' }).success).toBe(false);
    // The role decides the view: an admin view labelled as the owner's is refused, and back.
    const { role: _role, ...unlabelled } = adminNotice;
    expect(parse({ ...unlabelled, role: 'owner' }).success).toBe(false);
    expect(parse({ ...ownerNotice, role: 'admin' }).success).toBe(false);
    expect(parse(unlabelled).success).toBe(false);
    const { options: _options, ...ownerWithoutOptions } = ownerNotice;
    expect(parse(ownerWithoutOptions).success).toBe(false);
    expect(
      parse({ ...ownerNotice, options: { ...ownerNotice.options, keep: false } }).success
    ).toBe(false);
    const completed = {
      replacementId: 'replacement-1',
      newOwnerDisplayName: 'Riley',
      completedAt: AT,
      wasYours: true,
    };
    const parseCompleted = (value: unknown) =>
      CommunityWireOwnerReplacementNoticeResponseSchema.safeParse({ open: null, completed: value })
        .success;
    expect(parseCompleted(completed)).toBe(true);
    // The completion names its request and says whether it was the reader's (DOR-2543).
    const { wasYours: _wasYours, ...unmarked } = completed;
    expect(parseCompleted(unmarked)).toBe(false);
    const { replacementId: _id, ...unnamed } = completed;
    expect(parseCompleted(unnamed)).toBe(false);
  });

  // Purpose: fails if the session objection takes anything but a replacement id.
  it('takes an id for the session objection', () => {
    expect(
      CommunityWireOwnerReplacementObjectionRequestSchema.safeParse({ replacementId: '' }).success
    ).toBe(false);
    expect(CommunityWireOwnerReplacementObjectionRequestSchema.safeParse({}).success).toBe(false);
  });

  // Purpose: fails if the host cannot tell why a request was withdrawn, or if a cause outside
  // the three the storage allows could be sent.
  it('says why a withdrawn request was withdrawn', () => {
    for (const cause of ['cancelled', 'suspended', 'deletion']) {
      expect(
        CommunityAdminOwnerReplacementSchema.safeParse({
          ...replacement,
          state: 'withdrawn',
          endedAt: AT,
          withdrawnBecause: cause,
        }).success
      ).toBe(true);
    }
    expect(
      CommunityAdminOwnerReplacementSchema.safeParse({
        ...replacement,
        withdrawnBecause: 'expired',
      }).success
    ).toBe(false);
    const { withdrawnBecause: _cause, ...withoutCause } = replacement;
    expect(CommunityAdminOwnerReplacementSchema.safeParse(withoutCause).success).toBe(false);
  });

  // Purpose: fails if a malformed token is refused by the schema (a 400) instead of reaching the
  // route's one identical refusal for every unusable token.
  it('passes any non-empty token to the route', () => {
    for (const schema of [
      CommunityWireOwnerReplacementObjectRequestSchema,
      CommunityWireOwnerReplacementPreflightRequestSchema,
    ]) {
      expect(schema.safeParse({ token: 'not/a real token' }).success).toBe(true);
      expect(schema.safeParse({ token: '' }).success).toBe(false);
    }
  });

  it('names the three new refusals and the routes', () => {
    for (const code of [
      'NOTICE_DELIVERY_UNAVAILABLE',
      'OWNER_REPLACEMENT_OPEN',
      'OWNER_REPLACEMENT_COOLDOWN',
    ]) {
      expect(CommunityWireErrorCodeSchema.safeParse(code).success).toBe(true);
    }
    expect(COMMUNITY_API_V1_ROUTES).toMatchObject({
      ownerReplacement: '/api/v1/owner-replacement',
      ownerReplacementObjection: '/api/v1/owner-replacement/objection',
      ownerReplacementObjectPreflight: '/api/v1/owner-replacements/object-preflight',
      ownerReplacementObject: '/api/v1/owner-replacements/object',
      ownerReplacementPreflight: '/api/v1/owner-replacements/preflight',
      ownerReplacementClaim: '/api/v1/owner-replacements/claim',
    });
  });
});

describe('the communities:ownership scope', () => {
  const scopes = CommunityAdminHostApiKeyScopeSchema.options;
  const key = {
    id: ID,
    label: 'Ownership',
    prefix: 'dkh_abcdef',
    scopes: ['communities:ownership'],
    issuedVia: 'command',
    issuedByOperator: null,
    createdAt: AT,
    expiresAt: null,
    lastUsedAt: null,
    revokedAt: null,
  };

  // Purpose: fails if the scope is missing, or if a key cannot hold it alone.
  it('is a scope a key can hold on its own', () => {
    expect(scopes).toContain('communities:ownership');
    expect(CommunityAdminHostApiKeySchema.safeParse(key).success).toBe(true);
    expect(
      CommunityAdminHostApiKeyIssueRequestSchema.safeParse({
        label: 'Ownership',
        scopes: ['communities:ownership'],
        expiresInDays: 30,
        password: 'secret',
      }).success
    ).toBe(true);
  });

  // Purpose: fails if the ceiling stays at the old count (a key with every scope refused) or
  // does not grow with the list (one more than every scope accepted).
  it('lets a key hold every scope, and no more', () => {
    expect(CommunityAdminHostApiKeySchema.safeParse({ ...key, scopes }).success).toBe(true);
    expect(
      CommunityAdminHostApiKeySchema.safeParse({ ...key, scopes: [...scopes, scopes[0]] }).success
    ).toBe(false);
    expect(
      CommunityAdminHostApiKeyIssueRequestSchema.safeParse({
        label: 'Everything',
        scopes: [...scopes, scopes[0]],
        expiresInDays: null,
        password: 'secret',
      }).success
    ).toBe(false);
    expect(
      CommunityAdminHostApiKeySchema.safeParse({ ...key, scopes: ['communities:owner'] }).success
    ).toBe(false);
  });
});
