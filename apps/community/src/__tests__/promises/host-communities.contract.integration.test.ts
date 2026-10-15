/**
 * Contract for the host API routes an outside caller depends on (specs/server-merge step 1,
 * DOR-2875): creating, reading, limiting, naming, claiming, holding and deleting communities,
 * usage, short-name lookups, imports, and the public host links. Each route is pinned with the
 * scope it needs, the refusal without it, and the answer's schema. The host API's callers depend
 * on these, so a deliberate change updates this file in the same PR, says so in the PR
 * description, and is agreed with Cloud first.
 */
import {
  CommunityAdminClaimResponseSchema,
  CommunityAdminCreateResponseSchema,
  CommunityAdminHostProjectionSchema,
  CommunityAdminImportCreateResponseSchema,
  CommunityAdminImportSchema,
  CommunityAdminLimitsSchema,
  CommunityAdminMemberLimitsSchema,
  CommunityAdminShortNameAvailabilitySchema,
  CommunityAdminUsagePageSchema,
  CommunityAdminUsageSchema,
} from '@dorkos/shared/community-admin-wire';
import { CommunityWireHostLinksSchema } from '@dorkos/shared/community-wire';
import { expect } from 'vitest';
import { z } from 'zod';
import { contractSuite, type ContractCase } from './contract.js';
import { startSpace, withKey, type SpaceFixture } from './space-fixture.js';

// Status and code only: a caller acts on those, never on the English message.
const FORBIDDEN = { code: 'FORBIDDEN' };
const INVALID = { code: 'STATE_CONFLICT' };
const NOT_FOUND = { code: 'NOT_FOUND' };
const NOBODY = '00000000-0000-4000-8000-000000000000';

type Case = ContractCase<SpaceFixture>;

/** The pending community the cases create, and the active one the bootstrap made. */
const pending = (f: SpaceFixture) => `/api/v1/host/communities/${f.kept.communityId}`;
const active = (f: SpaceFixture) => `/api/v1/host/communities/${f.communityId}`;

/** The refusal for a key without the scope a route needs. */
function needsScope(name: string, method: string, path: Case['path'], body?: unknown): Case {
  return {
    name,
    method,
    path,
    headers: withKey('none'),
    body,
    expect: { status: 403, match: FORBIDDEN },
  };
}

const communities: Case[] = [
  {
    name: 'GET /host/communities with no credential is refused',
    path: '/api/v1/host/communities',
    expect: { status: 401, match: { code: 'UNAUTHENTICATED' } },
  },
  needsScope('GET /host/communities needs communities:read', 'GET', '/api/v1/host/communities'),
  {
    name: 'GET /host/communities lists every community and the notice days',
    path: '/api/v1/host/communities',
    headers: withKey('read'),
    expect: {
      status: 200,
      schema: z.strictObject({
        communities: z.array(CommunityAdminHostProjectionSchema),
        deletionNoticeDays: z.literal(14),
      }),
    },
  },
  needsScope('POST /host/communities needs communities:write', 'POST', '/api/v1/host/communities', {
    idempotencyKey: 'contract-create',
    name: 'Contract',
  }),
  {
    name: 'POST /host/communities refuses a body it cannot read',
    method: 'POST',
    path: '/api/v1/host/communities',
    headers: withKey('write'),
    body: { name: 'No idempotency key' },
    expect: { status: 400, match: INVALID },
  },
  {
    name: 'POST /host/communities makes an unclaimed community and its one-time owner claim',
    method: 'POST',
    path: '/api/v1/host/communities',
    headers: withKey('write'),
    body: { idempotencyKey: 'contract-create', name: 'Contract', admissionPolicy: 'invite_only' },
    expect: {
      status: 201,
      headers: { 'cache-control': 'no-store' },
      schema: CommunityAdminCreateResponseSchema,
      match: {
        community: { name: 'Contract', lifecycle: 'pending_owner', ownerPresent: false },
        ownerClaimToken: expect.any(String),
        replayed: false,
      },
    },
    keep: (f, body) => {
      const created = body as { community: { id: string }; ownerClaimGrantId: string };
      f.kept.communityId = created.community.id;
      f.kept.grantId = created.ownerClaimGrantId;
    },
  },
  {
    name: 'POST /host/communities replayed answers the same community without the secret',
    method: 'POST',
    path: '/api/v1/host/communities',
    headers: withKey('write'),
    body: { idempotencyKey: 'contract-create', name: 'Contract', admissionPolicy: 'invite_only' },
    expect: {
      status: 200,
      schema: CommunityAdminCreateResponseSchema,
      match: { ownerClaimToken: null, replayed: true },
    },
  },
  needsScope('GET /host/communities/:id needs communities:read', 'GET', pending),
  {
    name: 'GET /host/communities/:id answers its projection',
    path: pending,
    headers: withKey('read'),
    expect: {
      status: 200,
      schema: CommunityAdminHostProjectionSchema,
      match: { lifecycle: 'pending_owner', lifecycleVersion: 1, ownerPresent: false },
    },
  },
  {
    name: 'GET /host/communities/:id of nobody is not found',
    path: `/api/v1/host/communities/${NOBODY}`,
    headers: withKey('read'),
    expect: { status: 404, match: NOT_FOUND },
  },
];

const limits: Case[] = [
  needsScope(
    'GET /host/communities/:id/usage needs communities:read',
    'GET',
    (f) => `${active(f)}/usage`
  ),
  {
    name: 'GET /host/communities/:id/usage answers counts and sizes only',
    path: (f) => `${active(f)}/usage`,
    headers: withKey('read'),
    expect: { status: 200, schema: CommunityAdminUsageSchema, match: { activeMembers: 1 } },
  },
  {
    name: 'GET /host/usage answers a page of usage',
    path: '/api/v1/host/usage',
    headers: withKey('read'),
    expect: { status: 200, schema: CommunityAdminUsagePageSchema, match: { next: null } },
  },
  needsScope(
    'PUT /host/communities/:id/limits needs communities:write',
    'PUT',
    (f) => `${active(f)}/limits`,
    {
      limitsVersion: 1,
      maxActiveMembers: 50,
      maxStorageBytes: null,
    }
  ),
  {
    name: 'PUT /host/communities/:id/limits sets limits against their version',
    method: 'PUT',
    path: (f) => `${active(f)}/limits`,
    headers: withKey('write'),
    body: { limitsVersion: 1, maxActiveMembers: 50, maxStorageBytes: null },
    expect: {
      status: 200,
      schema: CommunityAdminLimitsSchema,
      body: { maxActiveMembers: 50, maxStorageBytes: null, limitsVersion: 2 },
    },
  },
  {
    name: 'PUT /host/communities/:id/limits with a stale version conflicts',
    method: 'PUT',
    path: (f) => `${active(f)}/limits`,
    headers: withKey('write'),
    body: { limitsVersion: 1, maxActiveMembers: 10, maxStorageBytes: null },
    expect: { status: 409, match: { code: 'STATE_CONFLICT' } },
  },
  needsScope(
    'PUT /host/communities/:id/members/:memberId/limits needs communities:write',
    'PUT',
    (f) => `${active(f)}/members/${f.ownerMemberId}/limits`,
    { agentsPerMember: 5 }
  ),
  {
    name: "PUT /host/communities/:id/members/:memberId/limits sets one member's agent limit",
    method: 'PUT',
    path: (f) => `${active(f)}/members/${f.ownerMemberId}/limits`,
    headers: withKey('write'),
    body: { agentsPerMember: 5 },
    expect: {
      status: 200,
      schema: CommunityAdminMemberLimitsSchema,
      match: { agentsPerMember: 5, effectiveAgentsPerMember: 5 },
    },
  },
];

const names: Case[] = [
  needsScope(
    'GET /host/short-names/:name needs communities:read',
    'GET',
    '/api/v1/host/short-names/contract-space'
  ),
  {
    name: 'GET /host/short-names/:name says a free name is available',
    path: '/api/v1/host/short-names/contract-space',
    headers: withKey('read'),
    expect: {
      status: 200,
      schema: CommunityAdminShortNameAvailabilitySchema,
      match: { shortName: 'contract-space', availability: 'available' },
    },
  },
  {
    name: 'GET /host/short-names/:name says a path name is reserved',
    path: '/api/v1/host/short-names/api',
    headers: withKey('read'),
    expect: { status: 200, match: { availability: 'reserved' } },
  },
  needsScope(
    'PUT /host/communities/:id/short-name needs communities:write',
    'PUT',
    (f) => `${active(f)}/short-name`,
    {
      shortName: 'contract-space',
    }
  ),
  {
    name: 'PUT /host/communities/:id/short-name gives the community a web address',
    method: 'PUT',
    path: (f) => `${active(f)}/short-name`,
    headers: withKey('write'),
    body: { shortName: 'contract-space' },
    expect: {
      status: 200,
      schema: CommunityAdminHostProjectionSchema,
      match: { shortName: 'contract-space' },
    },
  },
  {
    name: 'GET /host/short-names/:name then says the name is taken',
    path: '/api/v1/host/short-names/contract-space',
    headers: withKey('read'),
    expect: { status: 200, match: { availability: 'taken' } },
  },
];

const claims: Case[] = [
  needsScope(
    'POST owner-claims/reissue needs communities:write',
    'POST',
    (f) => `${pending(f)}/owner-claims/reissue`,
    {}
  ),
  {
    name: 'POST /host/communities/:id/owner-claims/reissue hands out a new one-time claim',
    method: 'POST',
    path: (f) => `${pending(f)}/owner-claims/reissue`,
    headers: withKey('write'),
    body: {},
    expect: {
      status: 200,
      headers: { 'cache-control': 'no-store' },
      schema: CommunityAdminClaimResponseSchema,
    },
    keep: (f, body) => {
      f.kept.grantId = (body as { grantId: string }).grantId;
    },
  },
  {
    name: 'POST owner-claims/reissue on a community with an owner conflicts',
    method: 'POST',
    path: (f) => `${active(f)}/owner-claims/reissue`,
    headers: withKey('write'),
    body: {},
    expect: { status: 409, match: { code: 'STATE_CONFLICT' } },
  },
  needsScope(
    'POST owner-claims/:grantId/revoke needs communities:write',
    'POST',
    (f) => `${pending(f)}/owner-claims/${f.kept.grantId}/revoke`,
    {}
  ),
  {
    name: 'POST /host/communities/:id/owner-claims/:grantId/revoke ends the claim, answering nothing',
    method: 'POST',
    path: (f) => `${pending(f)}/owner-claims/${f.kept.grantId}/revoke`,
    headers: withKey('write'),
    body: {},
    expect: { status: 204, text: /^$/u },
  },
];

const lifecycle: Case[] = [
  needsScope(
    'PATCH /host/communities/:id/lifecycle needs communities:lifecycle',
    'PATCH',
    (f) => `${active(f)}/lifecycle`,
    {
      action: 'suspend',
      lifecycleVersion: 1,
    }
  ),
  {
    name: 'PATCH /host/communities/:id/lifecycle refuses a key with only communities:write',
    method: 'PATCH',
    path: (f) => `${active(f)}/lifecycle`,
    headers: withKey('write'),
    body: { action: 'suspend', lifecycleVersion: 1 },
    expect: { status: 403, match: FORBIDDEN },
  },
  {
    name: 'PATCH /host/communities/:id/lifecycle with a stale version conflicts',
    method: 'PATCH',
    path: (f) => `${active(f)}/lifecycle`,
    headers: withKey('lifecycle'),
    body: { action: 'suspend', lifecycleVersion: 99 },
    expect: { status: 409, match: { code: 'STATE_CONFLICT' } },
  },
  {
    name: 'PATCH /host/communities/:id/lifecycle suspends',
    method: 'PATCH',
    path: (f) => `${active(f)}/lifecycle`,
    headers: withKey('lifecycle'),
    body: { action: 'suspend', lifecycleVersion: 2 },
    expect: {
      status: 200,
      schema: CommunityAdminHostProjectionSchema,
      match: { lifecycle: 'suspended', lifecycleVersion: 3 },
    },
  },
  {
    name: 'PATCH /host/communities/:id/lifecycle resumes',
    method: 'PATCH',
    path: (f) => `${active(f)}/lifecycle`,
    headers: withKey('lifecycle'),
    body: { action: 'resume', lifecycleVersion: 3 },
    expect: { status: 200, match: { lifecycle: 'active', lifecycleVersion: 4 } },
  },
  needsScope(
    'POST /host/communities/:id/deletion needs communities:lifecycle',
    'POST',
    (f) => `${active(f)}/deletion`,
    {
      lifecycleVersion: 4,
      confirmIdSuffix: '00000000',
    }
  ),
  {
    name: 'POST /host/communities/:id/deletion of a community not on hold conflicts',
    method: 'POST',
    path: (f) => `${active(f)}/deletion`,
    headers: withKey('lifecycle'),
    body: (f: SpaceFixture) => ({ lifecycleVersion: 4, confirmIdSuffix: f.communityId.slice(-8) }),
    expect: { status: 409, match: { code: 'STATE_CONFLICT' } },
  },
  needsScope(
    'DELETE /host/communities/:id/deletion needs communities:lifecycle',
    'DELETE',
    (f) => `${active(f)}/deletion`
  ),
  {
    name: 'DELETE /host/communities/:id/deletion with no deletion pending conflicts',
    method: 'DELETE',
    path: (f) => `${active(f)}/deletion`,
    headers: withKey('lifecycle'),
    expect: { status: 409, match: { code: 'STATE_CONFLICT' } },
  },
];

const imports: Case[] = [
  needsScope('POST /host/imports needs communities:import', 'POST', '/api/v1/host/imports', {
    idempotencyKey: 'contract-import',
    name: 'Imported',
  }),
  {
    name: 'POST /host/imports starts an import and hands out its upload token once',
    method: 'POST',
    path: '/api/v1/host/imports',
    headers: withKey('import'),
    body: { idempotencyKey: 'contract-import', name: 'Imported' },
    expect: {
      status: 201,
      headers: { 'cache-control': 'no-store' },
      schema: CommunityAdminImportCreateResponseSchema,
      match: {
        import: { state: 'awaiting_upload' },
        uploadToken: expect.any(String),
        replayed: false,
      },
    },
    keep: (f, body) => {
      f.kept.importId = (body as { import: { importId: string } }).import.importId;
    },
  },
  needsScope(
    'GET /host/imports/:id needs communities:read',
    'GET',
    (f) => `/api/v1/host/imports/${f.kept.importId}`
  ),
  {
    name: 'GET /host/imports/:id answers the import, never its token',
    path: (f) => `/api/v1/host/imports/${f.kept.importId}`,
    headers: withKey('read'),
    expect: {
      status: 200,
      schema: CommunityAdminImportSchema,
      match: { state: 'awaiting_upload' },
    },
  },
  needsScope(
    'POST /host/imports/:id/commit needs communities:import',
    'POST',
    (f) => `/api/v1/host/imports/${f.kept.importId}/commit`,
    {}
  ),
  {
    name: 'POST /host/imports/:id/commit before the export is checked conflicts',
    method: 'POST',
    path: (f) => `/api/v1/host/imports/${f.kept.importId}/commit`,
    headers: withKey('import'),
    body: {},
    expect: { status: 409, match: { code: 'STATE_CONFLICT' } },
  },
  needsScope(
    'POST /host/imports/:id/cancel needs communities:import',
    'POST',
    (f) => `/api/v1/host/imports/${f.kept.importId}/cancel`,
    {}
  ),
  {
    name: 'POST /host/imports/:id/cancel cancels it',
    method: 'POST',
    path: (f) => `/api/v1/host/imports/${f.kept.importId}/cancel`,
    headers: withKey('import'),
    body: {},
    expect: { status: 200, schema: CommunityAdminImportSchema, match: { state: 'cancelled' } },
  },
];

const links: Case[] = [
  {
    name: 'GET /host-links answers the host links to anyone',
    path: '/api/v1/host-links',
    expect: {
      status: 200,
      schema: CommunityWireHostLinksSchema,
      body: { termsUrl: null, privacyUrl: null, reportAbuseUrl: null },
    },
  },
];

contractSuite(
  'host API communities',
  () =>
    startSpace('promises_host', {
      read: ['communities:read'],
      write: ['communities:write'],
      lifecycle: ['communities:lifecycle'],
      import: ['communities:import'],
      none: ['communities:takedown'],
    }),
  [...communities, ...limits, ...names, ...claims, ...lifecycle, ...imports, ...links]
);
