/**
 * A `DORKOS_TEST_RUNTIME`-only fake of the DorkOS Cloud `/v1` contract
 * (DOR-2783): the reads and the inference token a linked computer needs to
 * run a chat on DorkOS credits, answered in-process.
 *
 * Like `fake-cloud-link.ts`, it fakes the network dependency and nothing
 * else: every answer is parsed against the real `@dork-labs/cloud-api`
 * schemas before it is sent, so the app's own `/v1` client, mint, catalog and
 * readiness code run unchanged. The minted token's endpoints point at the
 * fake inference stream this server mounts in test mode
 * (`fake-inference.ts`), so a credits turn never leaves the machine and never
 * spends anything. Reachable only through the gated dynamic `import()` in the
 * test-mode composition root.
 *
 * @module services/runtimes/test-mode/fake-cloud-v1
 */
import {
  BalanceSchema,
  EntitlementsSchema,
  InferenceModelsResponseSchema,
  InferenceTokenRevokeResponseSchema,
  InferenceTokenSchema,
  SessionSchema,
  V1_ROUTES,
} from '@dork-labs/cloud-api';
import type { FetchLike } from '@dork-labs/cloud-api/client';
import { env } from '../../../env.js';

/** The one model the fake catalog lists. */
export const FAKE_CLOUD_MODEL = {
  id: 'dorkos-test-model',
  displayName: 'Test model',
  contextWindow: 128_000,
  maxOutputTokens: 4096,
} as const;

/** The request format the fake token serves and the fake inference speaks. */
const SERVED_FORMAT = 'openaiChat';
/** The instance id the fake session names; matches the fake link's heartbeat. */
const FAKE_INSTANCE_ID = 'capture-instance';
/** Fake minted credential (never shown or logged). */
const FAKE_INFERENCE_TOKEN = 'fake-inference-token';
/** How long a fake token lives; well past the refresh margin. */
const TOKEN_LIFETIME_MS = 60 * 60_000;
/** How far ahead billing periods and snapshot staleness are dated. */
const PERIOD_MS = 30 * 24 * 60 * 60_000;

/** Where the fake reaches the rest of this test server. */
export interface FakeCloudV1Options {
  /** The base the minted token's endpoints point at, e.g. `http://localhost:7242/api/test/fake-inference/v1`. */
  inferenceBaseUrl: string;
}

/**
 * Build the fake `/v1` transport.
 *
 * @param options - Where the fake inference stream lives.
 * @throws If called outside `DORKOS_TEST_RUNTIME` — the fake must be
 *   unreachable in production (structural gate + this runtime guard + tests).
 */
export function createFakeCloudV1Fetch(options: FakeCloudV1Options): FetchLike {
  if (!env.DORKOS_TEST_RUNTIME) {
    throw new Error('createFakeCloudV1Fetch is test-mode only (DORKOS_TEST_RUNTIME)');
  }
  let minted = 0;

  return async (input, init) => {
    const { pathname } = new URL(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    const at = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

    if (method === 'GET' && pathname === V1_ROUTES.session) {
      return json(
        SessionSchema.parse({
          authenticated: true,
          instanceId: FAKE_INSTANCE_ID,
          account: {
            id: 'fake-account',
            email: 'test@example.invalid',
            displayName: 'Dork Labs',
            createdAt: at(-PERIOD_MS),
          },
          scopes: ['account:read', 'billing:read', 'inference:mint'],
        })
      );
    }

    if (method === 'GET' && pathname === V1_ROUTES.entitlements) {
      return json(
        EntitlementsSchema.parse({
          planId: 'free',
          planDisplayName: 'Free',
          periodStart: at(-PERIOD_MS),
          periodEnd: at(PERIOD_MS),
          limits: {
            personSeatsIncluded: 1,
            agentSeatsIncluded: 0,
            includedCreditsMicro: '0',
            cloudHours: 0,
            storageGb: 1,
            remoteAccess: 'byo',
            alwaysAvailableInstances: 0,
            customAddress: 'none',
            managedConnectionActions: null,
            support: 'community',
            emailAddressPerSeat: false,
          },
          used: { personSeats: 1, agentSeats: 0 },
          seats: { total: 1, assigned: 1, byKind: { person: 1, agent: 0 } },
          canCreateSeat: false,
          canInviteMember: false,
          staleAt: at(PERIOD_MS),
        })
      );
    }

    if (method === 'GET' && pathname === V1_ROUTES.balance) {
      // `paymentMethodOnFile` is the field the one-minute first run reads
      // (spec §5.3). It is sent beside the parsed body rather than through
      // it, so it reaches the app whether or not this contract release has
      // the field yet (an object schema strips a key it does not know).
      return json({
        ...BalanceSchema.parse({
          allowance: { grantedMicro: '0', remainingMicro: '0', resetsAt: at(PERIOD_MS) },
          purchased: { remainingMicro: '0' },
          heldMicro: '0',
          owedMicro: '0',
          autoReload: { enabled: false, ceilingMicro: null },
        }),
        paymentMethodOnFile: true,
      });
    }

    if (method === 'POST' && pathname === V1_ROUTES.inferenceTokens) {
      minted += 1;
      return json(
        InferenceTokenSchema.parse({
          tokenId: `fake-token-${minted}`,
          token: FAKE_INFERENCE_TOKEN,
          expiresAt: at(TOKEN_LIFETIME_MS),
          endpoints: {
            // Present because the contract requires it; not served, so the
            // app never sends this format here.
            anthropicMessages: options.inferenceBaseUrl,
            openaiChat: options.inferenceBaseUrl,
          },
          served: [SERVED_FORMAT],
          limits: { concurrentStreams: 4, requestsPerMinute: 120 },
          catalogVersion: 'fake-catalog-1',
        })
      );
    }

    if (
      method === 'POST' &&
      pathname.startsWith(`${V1_ROUTES.inferenceTokens}/`) &&
      pathname.endsWith('/revoke')
    ) {
      return json(InferenceTokenRevokeResponseSchema.parse({ revoked: true }));
    }

    if (method === 'GET' && pathname === V1_ROUTES.inferenceModels) {
      return json(
        InferenceModelsResponseSchema.parse({
          catalogVersion: 'fake-catalog-1',
          models: [
            {
              ...FAKE_CLOUD_MODEL,
              supports: { tools: true, promptCaching: false, streaming: true, thinking: false },
              protocols: [SERVED_FORMAT],
              recommendedOn: [SERVED_FORMAT],
            },
          ],
        })
      );
    }

    // Fail loud: an unknown path is a wiring bug, never a silent escape.
    throw new Error(`fake cloud /v1: unexpected request ${method} ${pathname}`);
  };
}
