/**
 * Contract for the host's account-spaces route (DOR-2954): the scope it needs, the refusals off
 * this host's single sign-on, the empty answer for an identity nobody signs in with, and the
 * answer's schema. The host's account service depends on it, so a deliberate change updates this
 * file in the same PR, says so in the PR description, and is agreed with Cloud first.
 */
import { randomUUID } from 'node:crypto';
import { CommunityAdminAccountSpacesResponseSchema } from '@dorkos/shared/community-admin-wire';
import { expect } from 'vitest';
import { contractSuite } from './contract.js';
import { startSpace, withKey, type SpaceFixture } from './space-fixture.js';

const ISSUER = 'https://issuer.contract.test';
const SUBJECT = 'contract-subject';
const PATH = '/api/v1/host/accounts/spaces';

// Status and code only: a caller acts on those, never on the English message.
const FORBIDDEN = { code: 'FORBIDDEN' };
const INVALID = { code: 'STATE_CONFLICT' };

/** A space whose single sign-on knows the bootstrap host, who owns the bootstrap space. */
async function start() {
  const server = await startSpace(
    'promises_accounts',
    { none: ['communities:read'], close: ['accounts:close'], read: ['accounts:read'] },
    {
      env: {
        COMMUNITY_OIDC_ISSUER_URL: ISSUER,
        COMMUNITY_OIDC_CLIENT_ID: 'contract-client',
        COMMUNITY_OIDC_CLIENT_SECRET: 'contract-client-secret',
      },
    }
  );
  const { h } = server.fixture;
  await h.pool.query(
    `INSERT INTO account(id,"accountId","providerId","userId")
     SELECT $1,$2,'oidc',user_id FROM host_operators LIMIT 1`,
    [randomUUID(), SUBJECT]
  );
  return server;
}

contractSuite<SpaceFixture>('host account spaces', start, [
  {
    name: 'POST /host/accounts/spaces with no credential is refused',
    method: 'POST',
    path: PATH,
    body: { issuer: ISSUER, subject: SUBJECT },
    expect: { status: 401, match: { code: 'UNAUTHENTICATED' } },
  },
  {
    name: 'POST /host/accounts/spaces needs accounts:read',
    method: 'POST',
    path: PATH,
    headers: withKey('none'),
    body: { issuer: ISSUER, subject: SUBJECT },
    expect: { status: 403, match: FORBIDDEN },
  },
  {
    name: 'POST /host/accounts/spaces is not granted by accounts:close',
    method: 'POST',
    path: PATH,
    headers: withKey('close'),
    body: { issuer: ISSUER, subject: SUBJECT },
    expect: { status: 403, match: FORBIDDEN },
  },
  {
    name: 'POST /host/accounts/spaces refuses a body it cannot read',
    method: 'POST',
    path: PATH,
    headers: withKey('read'),
    body: { issuer: ISSUER },
    expect: { status: 400, match: INVALID },
  },
  {
    name: 'POST /host/accounts/spaces refuses another sign-in service',
    method: 'POST',
    path: PATH,
    headers: withKey('read'),
    body: { issuer: 'https://other.contract.test', subject: SUBJECT },
    expect: { status: 409, match: INVALID },
  },
  {
    name: 'POST /host/accounts/spaces answers an empty list for an identity nobody signs in with',
    method: 'POST',
    path: PATH,
    headers: withKey('read'),
    body: { issuer: ISSUER, subject: 'nobody-signs-in-with-this' },
    expect: { status: 200, body: { spaces: [], truncated: false } },
  },
  {
    name: 'POST /host/accounts/spaces lists the account’s spaces',
    method: 'POST',
    path: PATH,
    headers: withKey('read'),
    body: { issuer: `${ISSUER}/`, subject: SUBJECT },
    expect: { status: 200, schema: CommunityAdminAccountSpacesResponseSchema },
    keep: (f, body) => {
      expect(body).toEqual({
        spaces: [
          {
            communityId: f.communityId,
            name: expect.any(String),
            url: `${f.h.config.publicUrl}/c/${f.communityId}`,
            role: 'owner',
            state: 'active',
          },
        ],
        truncated: false,
      });
    },
  },
]);
