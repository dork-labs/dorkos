import { describe, expect, it } from 'vitest';
import {
  COMMUNITY_CREDENTIAL_ENV_NAMES,
  flyCredentialEnvInUse,
  formatCommunityCredentialNotice,
  pickCommunityCredentialEnv,
  withoutCommunityCredentialEnv,
} from '../runtime/credential-env.js';
import { FlyTigrisGraphqlClient, flyGraphqlAuthorization } from '../fly-graphql-client.js';

const SENTINELS = {
  FLY_ACCESS_TOKEN: 'FlyV1 fm2_dor2602_sentinel_access',
  FLY_API_TOKEN: 'fo1_dor2602_sentinel_api',
  NEON_API_KEY: 'napi_dor2602_sentinel_neon',
};
// Every sentinel shares this, so one search covers each value and each re-encoding of it.
const SENTINEL_MARK = 'dor2602_sentinel';

describe('credential variables', () => {
  it('passes the three variables fly and neonctl read', () => {
    expect([...COMMUNITY_CREDENTIAL_ENV_NAMES].sort()).toEqual([
      'FLY_ACCESS_TOKEN',
      'FLY_API_TOKEN',
      'NEON_API_KEY',
    ]);
  });

  it('picks the Fly variable the way flyctl does', () => {
    expect(flyCredentialEnvInUse({})).toBeNull();
    expect(flyCredentialEnvInUse({ FLY_API_TOKEN: 'x' })).toBe('FLY_API_TOKEN');
    expect(flyCredentialEnvInUse({ FLY_ACCESS_TOKEN: 'x', FLY_API_TOKEN: 'y' })).toBe(
      'FLY_ACCESS_TOKEN'
    );
    // flyctl takes the first variable that is SET, so an empty FLY_ACCESS_TOKEN hides
    // FLY_API_TOKEN and leaves the saved session in charge (env.First, internal/env).
    expect(flyCredentialEnvInUse({ FLY_ACCESS_TOKEN: '', FLY_API_TOKEN: 'y' })).toBeNull();
  });

  it('hands fly and neonctl only non-empty credentials, so the notice names what fly uses', () => {
    const shell = { PATH: '/bin', FLY_ACCESS_TOKEN: '', FLY_API_TOKEN: 'y', NEON_API_KEY: '' };
    const handed = pickCommunityCredentialEnv(shell);
    expect(handed).toEqual({ FLY_API_TOKEN: 'y' });
    expect(flyCredentialEnvInUse(handed)).toBe('FLY_API_TOKEN');
    expect(formatCommunityCredentialNotice(handed)).toContain('FLY_API_TOKEN');
  });

  it('strips every credential for the tools that are not fly or neonctl', () => {
    expect(withoutCommunityCredentialEnv({ PATH: '/bin', ...SENTINELS })).toEqual({ PATH: '/bin' });
  });

  it('says nothing when no credential variable is set', () => {
    expect(formatCommunityCredentialNotice({ PATH: '/bin', NEON_API_KEY: '' })).toBe('');
  });

  it('names each variable in use in one line, and never a value', () => {
    expect(formatCommunityCredentialNotice({ FLY_API_TOKEN: SENTINELS.FLY_API_TOKEN })).toBe(
      'Using the Fly token in FLY_API_TOKEN from your environment, not your saved sign-in.\n'
    );
    expect(formatCommunityCredentialNotice({ NEON_API_KEY: SENTINELS.NEON_API_KEY })).toBe(
      'Using the Neon key in NEON_API_KEY from your environment, not your saved sign-in.\n'
    );
    const all = formatCommunityCredentialNotice(SENTINELS);
    expect(all).toBe(
      'Using the Fly token in FLY_ACCESS_TOKEN and the Neon key in NEON_API_KEY from your environment, not your saved sign-ins. FLY_API_TOKEN is set too, but Fly reads FLY_ACCESS_TOKEN first.\n'
    );
    expect(all.trimEnd()).not.toContain('\n');
    expect(all).not.toContain(SENTINEL_MARK);
    expect(all.toLowerCase()).not.toContain('provider');
  });
});

describe('Fly GraphQL authorization', () => {
  it('sends a scoped macaroon token under FlyV1 and a session token under Bearer, as flyctl does', () => {
    expect(flyGraphqlAuthorization('fo1_session')).toBe('Bearer fo1_session');
    expect(flyGraphqlAuthorization('fm2_scoped')).toBe('FlyV1 fm2_scoped');
    expect(flyGraphqlAuthorization('fm1r_a,fm2_b')).toBe('FlyV1 fm1r_a,fm2_b');
    expect(flyGraphqlAuthorization('fm1a_a')).toBe('FlyV1 fm1a_a');
    // `fly auth token` lists macaroons first, then any session token, as one value.
    expect(flyGraphqlAuthorization('fm2_a,fo1_b')).toBe('FlyV1 fm2_a,fo1_b');
  });

  it('puts that header on the request the client sends', async () => {
    const seen: string[] = [];
    const client = new FlyTigrisGraphqlClient({
      accessToken: 'fm2_scoped',
      fetch: async (_input, init) => {
        seen.push(new Headers(init?.headers).get('authorization') ?? '');
        return new Response(JSON.stringify({ data: { viewer: { agreedToProviderTos: true } } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    await client.hasAcceptedTerms();
    expect(seen).toEqual(['FlyV1 fm2_scoped']);
  });
});
