/**
 * A `DORKOS_TEST_RUNTIME`-only fake of the DorkOS cloud device-flow transport
 * (capture-cloud-link-stub, DOR-301).
 *
 * These exist ONLY to let the capture pipeline photograph the real
 * pending→linked flip offline: every event still flows through the exact same
 * {@link CloudLinkManager} state machine, token persistence, and
 * `/api/cloud/*` routes a production link uses — only the `FetchLike` network
 * dependency to `dorkos.ai` is faked, exactly like `demo-scenarios.ts` fakes
 * the agent backend. Nothing here is wired into production — it is reachable
 * only when `DORKOS_TEST_RUNTIME=true`, and only via the gated dynamic
 * `import()` in `index.ts`'s composition root.
 *
 * @module services/runtimes/test-mode/fake-cloud-link
 */
import type { FetchLike, DeviceCodeResponse } from '../../core/auth/cloud-link-client.js';
import { env } from '../../../env.js';

/** Pending code shown in the panel (8 chars, hyphen-grouped like RFC 8628 user codes). */
const FAKE_USER_CODE = 'DORK-2F7Q';
/** Account label shown in the linked view. */
const FAKE_ACCOUNT_LABEL = 'Dork Labs';
/** Opaque device code (never shown in the UI). */
const FAKE_DEVICE_CODE = 'fake-device-code';
/** Fake scoped instance key persisted at `cloud.instanceToken` (never shown or logged). */
const FAKE_ACCESS_TOKEN = 'fake-instance-key';
/** Fake instance id echoed by the heartbeat. */
const FAKE_INSTANCE_ID = 'capture-instance';
/** Server-side poll cadence (`DeviceCodeResponse.interval`, seconds). */
const DEVICE_CODE_INTERVAL_SECONDS = 1;
/** Long enough that the code never visibly expires mid-capture (seconds). */
const DEVICE_CODE_EXPIRES_IN_SECONDS = 900;
/** Token polls answered `authorization_pending` before the fake approves. */
const PENDING_POLLS_BEFORE_APPROVAL = 2;

/**
 * A `DORKOS_TEST_RUNTIME`-only fake of the DorkOS cloud device-flow transport.
 * Scripts the four device-flow endpoints in-process so the real
 * {@link CloudLinkManager} drives a genuine pending→linked flip offline, with
 * ZERO packets to dorkos.ai. Mirrors how `demo-scenarios.ts` fakes the agent
 * backend: it fakes the network dependency and nothing else.
 *
 * @throws If constructed outside `DORKOS_TEST_RUNTIME` — the fake must be
 *   unreachable in production (structural gate + this runtime guard + tests).
 */
export function createFakeCloudLinkFetch(): FetchLike {
  if (!env.DORKOS_TEST_RUNTIME) {
    throw new Error('createFakeCloudLinkFetch is test-mode only (DORKOS_TEST_RUNTIME)');
  }
  // Poll count per device_code, so each link cycle flips independently and a
  // future unlink→relink drive is deterministic (a fresh code resets the count).
  const pollCounts = new Map<string, number>();

  return async (input, init) => {
    const { pathname } = new URL(input);
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });

    if (pathname.endsWith('/api/auth/device/code')) {
      return json(200, {
        device_code: FAKE_DEVICE_CODE,
        user_code: FAKE_USER_CODE,
        verification_uri: 'https://dorkos.ai/activate',
        verification_uri_complete: `https://dorkos.ai/activate?code=${FAKE_USER_CODE}`,
        expires_in: DEVICE_CODE_EXPIRES_IN_SECONDS,
        interval: DEVICE_CODE_INTERVAL_SECONDS,
      } satisfies DeviceCodeResponse);
    }

    if (pathname.endsWith('/api/auth/device/token')) {
      const { device_code } = JSON.parse(String(init?.body ?? '{}')) as { device_code?: string };
      const key = device_code ?? FAKE_DEVICE_CODE;
      const seen = pollCounts.get(key) ?? 0;
      pollCounts.set(key, seen + 1);
      if (seen < PENDING_POLLS_BEFORE_APPROVAL) {
        return json(400, { error: 'authorization_pending' });
      }
      return json(200, { access_token: FAKE_ACCESS_TOKEN });
    }

    if (pathname.endsWith('/api/instances/heartbeat')) {
      return json(200, {
        instanceId: FAKE_INSTANCE_ID,
        lastSeenAt: new Date().toISOString(), // ≈ now → renders "just now" (stable string)
        accountLabel: FAKE_ACCOUNT_LABEL,
      });
    }

    if (pathname.endsWith('/api/instances/revoke')) {
      return json(200, {});
    }

    // Fail loud: an unknown path is a wiring bug, never a silent escape.
    throw new Error(`fake cloud-link: unexpected request ${pathname}`);
  };
}
