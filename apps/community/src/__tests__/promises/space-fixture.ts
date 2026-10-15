/**
 * The space the contract files run against (DOR-2875): a real server on its own Postgres
 * database, built by the tenancy harness the way `main.ts` builds it, with its first host
 * operator signed in and one host API key per scope set the cases need.
 */
import type { CommunityAdminHostApiKeyScopeSchema } from '@dorkos/shared/community-admin-wire';
import type { z } from 'zod';
import {
  TENANCY_PASSWORD,
  bootstrapHost,
  expectStatus,
  startTenancyHarness,
  type TenancyHarness,
} from '../tenancy-test-harness.js';
import type { ContractServer } from './contract.js';

type Scope = z.infer<typeof CommunityAdminHostApiKeyScopeSchema>;

/** What a contract case can read once the space is up. */
export interface SpaceFixture {
  readonly h: TenancyHarness;
  /** The first host operator's browser session, who is also the first space's owner. */
  readonly operatorCookie: string;
  /** The space the bootstrap made, and its owner membership and first channel. */
  readonly communityId: string;
  readonly ownerMemberId: string;
  readonly channelId: string;
  /** One key secret per name the caller asked for. */
  readonly keys: Record<string, string>;
  /** Values earlier cases kept for later ones. */
  readonly kept: Record<string, string>;
}

/** Headers for a host operator's browser call: its cookie and the space's own origin. */
export function asOperator(f: SpaceFixture): Record<string, string> {
  return { cookie: f.operatorCookie, origin: f.h.config.publicUrl };
}

/** Headers for a call with a host API key. */
export function withKey(name: string): (f: SpaceFixture) => Record<string, string> {
  return (f) => ({ authorization: `Bearer ${f.keys[name]}` });
}

/**
 * Start a space, bootstrap its first host, and issue the named keys.
 *
 * @param label - Names the database.
 * @param keys - The scopes for each key, by the name cases use.
 * @param options - Passed to the tenancy harness: settings to override, mail composers.
 */
export async function startSpace(
  label: string,
  keys: Record<string, Scope[]> = {},
  options: Parameters<typeof startTenancyHarness>[1] = {}
): Promise<ContractServer<SpaceFixture>> {
  const h = await startTenancyHarness(label, options);
  try {
    const host = await bootstrapHost(h, 'Host', 'host@example.com');
    const secrets: Record<string, string> = {};
    for (const [name, scopes] of Object.entries(keys)) {
      const issued = await expectStatus(
        await h.call('/api/v1/host/api-keys', {
          cookie: host.cookie,
          body: { label: name, scopes, expiresInDays: null, password: TENANCY_PASSWORD },
        }),
        201,
        `issue key ${name}`
      );
      secrets[name] = ((await issued.json()) as { secret: string }).secret;
    }
    return {
      baseUrl: h.baseUrl,
      fixture: {
        h,
        operatorCookie: host.cookie,
        communityId: host.communityId,
        ownerMemberId: host.memberId,
        channelId: host.channelId,
        keys: secrets,
        kept: {},
      },
      close: () => h.close(),
    };
  } catch (error) {
    await h.close();
    throw error;
  }
}
