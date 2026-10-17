/**
 * @vitest-environment node
 *
 * Who this computer is at its DorkOS account, read from `GET /v1/session`.
 */
import { describe, expect, it } from 'vitest';

import { resolveCloudIdentity, type CloudV1Context } from '../v1-client.js';

function contextAnswering(session: unknown): CloudV1Context {
  const client = { get: async () => session } as unknown as CloudV1Context['client'];
  return { client, isCurrent: () => true };
}

const signedIn = {
  authenticated: true,
  account: {
    id: 'acct_1',
    email: 'person@example.invalid',
    displayName: 'A Person',
    createdAt: '2026-09-15T12:00:00.000Z',
  },
  instanceId: 'inst_1',
  scopes: [],
};

describe('resolveCloudIdentity', () => {
  it("carries the account's issuer when the service names one", async () => {
    const identity = await resolveCloudIdentity(
      contextAnswering({
        ...signedIn,
        account: { ...signedIn.account, issuer: 'https://accounts.example.invalid' },
      })
    );
    expect(identity).toEqual({
      instanceId: 'inst_1',
      accountKey: 'acct_1',
      issuer: 'https://accounts.example.invalid',
    });
  });

  it('reads a malformed issuer as absent, and still knows the account', async () => {
    const { SessionSchema } = await import('@dork-labs/cloud-api');
    const parsed = SessionSchema.parse({
      ...signedIn,
      account: { ...signedIn.account, issuer: 'not a url' },
    });
    expect(parsed.account?.issuer).toBeUndefined();
    expect(parsed.account?.id).toBe('acct_1');
  });

  it('leaves the issuer out when the service does not say', async () => {
    const identity = await resolveCloudIdentity(contextAnswering(signedIn));
    expect(identity).toEqual({ instanceId: 'inst_1', accountKey: 'acct_1' });
  });
});
