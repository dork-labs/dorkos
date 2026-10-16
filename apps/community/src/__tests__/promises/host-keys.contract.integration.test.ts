/**
 * Contract for host API keys (specs/server-merge step 1, DOR-2875): the key format, the eleven
 * scopes, who may issue, rotate and revoke a key (only a host operator's session, never a key),
 * and the refusals a caller sees. The host API's callers hold these keys, so a deliberate change
 * updates this file in the same PR, says so in the PR description, and is agreed with Cloud first.
 */
import { describe, expect, it } from 'vitest';
import {
  CommunityAdminHostApiKeyListSchema,
  CommunityAdminHostApiKeyScopeSchema,
  CommunityAdminHostApiKeySchema,
  CommunityAdminHostApiKeySecretResponseSchema,
} from '@dorkos/shared/community-admin-wire';
import { HOST_API_KEY_PATTERN } from '../../security.js';
import { TENANCY_PASSWORD } from '../tenancy-test-harness.js';
import { contractSuite } from './contract.js';
import { asOperator, startSpace, withKey, type SpaceFixture } from './space-fixture.js';

/** The eleven scopes a key can hold, as the host API's callers name them. */
const SCOPES = [
  'communities:read',
  'communities:write',
  'communities:lifecycle',
  'communities:import',
  'communities:legal_hold',
  'communities:takedown',
  'communities:ownership',
  'communities:erasure_journal',
  'accounts:close',
  'communities:reserved_names',
  'accounts:read',
] as const;

// Status and code only: a caller acts on those, never on the English message.
const INVALID = { code: 'STATE_CONFLICT' };
const KEY_CANNOT_MANAGE = { code: 'FORBIDDEN' };
const NO_CONTENT_FOR_KEYS = { code: 'UNAUTHENTICATED' };
const KEY_INVALID = { code: 'UNAUTHENTICATED' };

const issue = (scopes: readonly string[], password = TENANCY_PASSWORD) => ({
  label: 'Contract',
  scopes,
  expiresInDays: null,
  password,
});

describe('host API key format', () => {
  it('is dkh_ and 43 base64url characters, with the eleven scopes', () => {
    // Purpose: fails if the key format or the scope list changes under the host API's callers.
    expect(HOST_API_KEY_PATTERN.source).toBe('^dkh_[A-Za-z0-9_-]{43}$');
    expect(CommunityAdminHostApiKeyScopeSchema.options).toEqual(SCOPES);
  });
});

contractSuite<SpaceFixture>(
  'host API keys',
  () => startSpace('promises_keys', { read: ['communities:read'] }),
  [
    {
      name: 'issuing a key needs a signed-in host operator',
      method: 'POST',
      path: '/api/v1/host/api-keys',
      body: issue(['communities:read']),
      expect: { status: 401, match: { code: 'UNAUTHENTICATED' } },
    },
    {
      name: 'a key cannot issue keys',
      method: 'POST',
      path: '/api/v1/host/api-keys',
      headers: withKey('read'),
      body: issue(['communities:read']),
      expect: { status: 403, match: KEY_CANNOT_MANAGE },
    },
    {
      name: 'a scope that does not exist is refused',
      method: 'POST',
      path: '/api/v1/host/api-keys',
      headers: asOperator,
      body: issue(['communities:everything']),
      expect: { status: 400, match: INVALID },
    },
    {
      name: 'a wrong password is refused',
      method: 'POST',
      path: '/api/v1/host/api-keys',
      headers: asOperator,
      body: issue(['communities:read'], 'not-the-password'),
      expect: { status: 403, match: { code: 'REAUTH_FAILED' } },
    },
    {
      name: 'an operator issues a key with every scope, its secret shown once',
      method: 'POST',
      path: '/api/v1/host/api-keys',
      headers: asOperator,
      body: issue(SCOPES),
      expect: {
        status: 201,
        headers: { 'cache-control': 'no-store' },
        schema: CommunityAdminHostApiKeySecretResponseSchema,
        match: {
          key: { scopes: [...SCOPES], issuedVia: 'browser', revokedAt: null },
          previousKeyExpiresAt: null,
        },
      },
      keep: (f, body) => {
        const { key, secret } = body as { key: { id: string; prefix: string }; secret: string };
        expect(key.prefix).toBe(secret.slice(0, 10));
        f.kept.keyId = key.id;
        f.kept.secret = secret;
      },
    },
    {
      name: 'the operator lists keys, never their secrets',
      path: '/api/v1/host/api-keys',
      headers: asOperator,
      expect: { status: 200, schema: CommunityAdminHostApiKeyListSchema },
      keep: (f, body) => {
        const text = JSON.stringify(body);
        expect(text).toContain(f.kept.keyId);
        expect(text).not.toContain(f.kept.secret);
      },
    },
    {
      name: 'a key cannot list keys',
      path: '/api/v1/host/api-keys',
      headers: (f) => ({ authorization: `Bearer ${f.kept.secret}` }),
      expect: { status: 403, match: KEY_CANNOT_MANAGE },
    },
    {
      name: 'a key works on a host route its scope allows',
      path: '/api/v1/host/capabilities',
      headers: (f) => ({ authorization: `Bearer ${f.kept.secret}` }),
      expect: { status: 200 },
    },
    {
      name: 'a host key never reaches space content, unscoped',
      path: '/api/v1/channels',
      headers: (f) => ({ authorization: `Bearer ${f.kept.secret}` }),
      expect: { status: 401, match: NO_CONTENT_FOR_KEYS },
    },
    {
      name: 'a host key never reaches space content, under a community',
      path: (f) => `/api/v1/communities/${f.communityId}/channels`,
      headers: (f) => ({ authorization: `Bearer ${f.kept.secret}` }),
      expect: { status: 401, match: NO_CONTENT_FOR_KEYS },
    },
    {
      name: 'a key cannot rotate keys',
      method: 'POST',
      path: (f) => `/api/v1/host/api-keys/${f.kept.keyId}/rotate`,
      headers: withKey('read'),
      body: { overlapMinutes: 0, password: TENANCY_PASSWORD },
      expect: { status: 403, match: KEY_CANNOT_MANAGE },
    },
    {
      name: 'an operator rotates a key: a new secret, shown once',
      method: 'POST',
      path: (f) => `/api/v1/host/api-keys/${f.kept.keyId}/rotate`,
      headers: asOperator,
      body: { overlapMinutes: 0, password: TENANCY_PASSWORD },
      expect: {
        status: 201,
        headers: { 'cache-control': 'no-store' },
        schema: CommunityAdminHostApiKeySecretResponseSchema,
      },
      keep: (f, body) => {
        const { key, secret } = body as { key: { id: string }; secret: string };
        expect(secret).not.toBe(f.kept.secret);
        f.kept.rotatedId = key.id;
        f.kept.rotated = secret;
      },
    },
    {
      name: 'the rotated-out key stops working with no overlap',
      path: '/api/v1/host/capabilities',
      headers: (f) => ({ authorization: `Bearer ${f.kept.secret}` }),
      expect: { status: 401, match: KEY_INVALID },
    },
    {
      name: 'an operator revokes a key',
      method: 'POST',
      path: (f) => `/api/v1/host/api-keys/${f.kept.rotatedId}/revoke`,
      headers: asOperator,
      body: {},
      expect: { status: 200, schema: CommunityAdminHostApiKeySchema },
      keep: (_f, body) => expect((body as { revokedAt: string | null }).revokedAt).not.toBeNull(),
    },
    {
      name: 'a revoked key is refused',
      path: '/api/v1/host/capabilities',
      headers: (f) => ({ authorization: `Bearer ${f.kept.rotated}` }),
      expect: { status: 401, match: KEY_INVALID },
    },
  ]
);
