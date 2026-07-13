import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The route reads POSTHOG_PROJECT_KEY / NEXT_PUBLIC_POSTHOG_HOST via `@/env`.
// Mock it so each test can flip the key on/off deterministically.
vi.mock('@/env', () => ({
  env: {
    POSTHOG_PROJECT_KEY: undefined as string | undefined,
    NEXT_PUBLIC_POSTHOG_HOST: 'https://us.i.posthog.com',
  },
}));

import { env } from '@/env';

import { POST } from '../route';

const VALID_APP_STARTED = {
  event: 'app_started' as const,
  properties: { os: 'darwin-arm64', runtimesConfigured: 3 },
  distinctId: '7c6d2b9a-9f44-4f3a-bf67-3f3aa6bbf7c4',
  timestamp: '2026-07-13T12:00:00.000Z',
  dorkosVersion: '0.47.0',
};

const VALID_SESSION_CREATED = {
  event: 'session_created' as const,
  properties: { runtime: 'claude-code' },
  distinctId: '7c6d2b9a-9f44-4f3a-bf67-3f3aa6bbf7c4',
  timestamp: '2026-07-13T12:00:01.000Z',
  dorkosVersion: '0.47.0',
};

let fetchSpy: ReturnType<typeof vi.spyOn>;
let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 200 }));
  consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  env.POSTHOG_PROJECT_KEY = undefined;
  env.NEXT_PUBLIC_POSTHOG_HOST = 'https://us.i.posthog.com';
});

afterEach(() => {
  fetchSpy.mockRestore();
  consoleErrorSpy.mockRestore();
  vi.clearAllMocks();
});

function makeRequest(body: unknown, rawBody?: string): Request {
  return new Request('https://dorkos.ai/api/telemetry/events', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: rawBody ?? JSON.stringify(body),
  });
}

async function readJson(res: Response): Promise<{ ok: boolean; accepted: number }> {
  return (await res.json()) as { ok: boolean; accepted: number };
}

describe('POST /api/telemetry/events', () => {
  describe('always-200 graceful degrade', () => {
    it('returns 200 accepted:0 on malformed JSON (never a retryable error)', async () => {
      const res = await POST(makeRequest(undefined, '{ not json'));
      expect(res.status).toBe(200);
      expect(await readJson(res)).toEqual({ ok: true, accepted: 0 });
    });

    it('returns 200 accepted:0 on a non-batch body', async () => {
      const res = await POST(makeRequest({ nope: true }));
      expect(res.status).toBe(200);
      expect((await readJson(res)).accepted).toBe(0);
    });

    it('returns 200 accepted:0 on an empty events array', async () => {
      const res = await POST(makeRequest({ events: [] }));
      expect(res.status).toBe(200);
      expect((await readJson(res)).accepted).toBe(0);
    });
  });

  describe('per-event validation (drop invalid, accept valid)', () => {
    beforeEach(() => {
      env.POSTHOG_PROJECT_KEY = 'phc_test_key';
    });

    it('accepts every valid event in the batch', async () => {
      const res = await POST(makeRequest({ events: [VALID_APP_STARTED, VALID_SESSION_CREATED] }));
      expect((await readJson(res)).accepted).toBe(2);
    });

    it('drops invalid events but accepts the valid ones (partial batch)', async () => {
      const res = await POST(
        makeRequest({
          events: [
            VALID_APP_STARTED,
            { event: 'not_a_real_event', properties: {} },
            { event: 'session_created', properties: { runtime: 'codex', cwd: '/Users/kai' } }, // unknown prop
          ],
        })
      );
      expect((await readJson(res)).accepted).toBe(1);
    });

    it('drops an event whose distinctId is not a UUID', async () => {
      const res = await POST(
        makeRequest({ events: [{ ...VALID_APP_STARTED, distinctId: 'not-a-uuid' }] })
      );
      expect((await readJson(res)).accepted).toBe(0);
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe('PostHog fan-out', () => {
    it('does NOT call PostHog when POSTHOG_PROJECT_KEY is unset (accept-and-drop)', async () => {
      env.POSTHOG_PROJECT_KEY = undefined;
      const res = await POST(makeRequest({ events: [VALID_APP_STARTED] }));
      expect((await readJson(res)).accepted).toBe(1);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('forwards valid events to PostHog /batch/ when the key is set', async () => {
      env.POSTHOG_PROJECT_KEY = 'phc_test_key';
      await POST(makeRequest({ events: [VALID_APP_STARTED] }));

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://us.i.posthog.com/batch/');

      const sent = JSON.parse(init.body as string) as {
        api_key: string;
        batch: Array<{ event: string; distinct_id: string; properties: Record<string, unknown> }>;
      };
      expect(sent.api_key).toBe('phc_test_key');
      expect(sent.batch).toHaveLength(1);
      expect(sent.batch[0].event).toBe('app_started');
      expect(sent.batch[0].distinct_id).toBe(VALID_APP_STARTED.distinctId);
      expect(sent.batch[0].properties.dorkos_version).toBe('0.47.0');
    });

    it('still returns 200 when the PostHog fetch rejects (graceful degrade)', async () => {
      env.POSTHOG_PROJECT_KEY = 'phc_test_key';
      fetchSpy.mockRejectedValueOnce(new Error('posthog timeout'));
      const res = await POST(makeRequest({ events: [VALID_APP_STARTED] }));
      expect(res.status).toBe(200);
      expect((await readJson(res)).accepted).toBe(1);
      expect(consoleErrorSpy).toHaveBeenCalled();
    });
  });

  describe('privacy — no PII in the forwarded payload', () => {
    it('forwards only allowlisted properties; a path/prompt/email can never ride along', async () => {
      env.POSTHOG_PROJECT_KEY = 'phc_test_key';
      // Event carrying an extra PII-shaped prop — the strict allowlist drops the
      // whole event, so nothing leaks.
      await POST(
        makeRequest({
          events: [
            {
              ...VALID_SESSION_CREATED,
              properties: {
                runtime: 'claude-code',
                cwd: '/Users/kai/secret-project',
                email: 'kai@example.com',
              },
            },
          ],
        })
      );
      // The event was invalid (unknown props) so nothing was forwarded at all.
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('a valid event forwards no path/prompt/email keys', async () => {
      env.POSTHOG_PROJECT_KEY = 'phc_test_key';
      await POST(makeRequest({ events: [VALID_SESSION_CREATED] }));
      const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      const bodyStr = init.body as string;
      for (const forbidden of ['cwd', 'email', 'prompt', 'path', 'hostname', 'username']) {
        expect(bodyStr).not.toContain(`"${forbidden}"`);
      }
    });
  });
});
