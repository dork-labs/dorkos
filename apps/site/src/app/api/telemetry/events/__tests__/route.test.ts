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

// Feedback events use the lighter feedback envelope (no envelope dorkosVersion,
// lenient distinctId) and carry user-volunteered free-text (DOR-317).
const VALID_FEEDBACK_SUBMITTED = {
  event: 'feedback_submitted' as const,
  properties: {
    kind: 'bug' as const,
    message: 'The sidebar flickers when I switch sessions.',
    contact: 'kai@example.com',
    surface: 'site' as const,
    route: '/feedback',
  },
  distinctId: 'ph_visitor_abc123',
  timestamp: '2026-07-13T12:00:02.000Z',
};

const VALID_FEATURE_REQUESTED = {
  event: 'feature_requested' as const,
  properties: {
    message: 'Please add a keyboard shortcut for the command palette.',
    surface: 'site' as const,
  },
  distinctId: 'ph_visitor_abc123',
  timestamp: '2026-07-13T12:00:03.000Z',
};

const VALID_EXCEPTION = {
  event: '$exception' as const,
  properties: {
    $exception_list: [
      {
        type: 'TypeError',
        value: '',
        mechanism: { handled: false, synthetic: false },
        stacktrace: {
          type: 'raw' as const,
          frames: [
            {
              platform: 'node:javascript',
              filename: 'apps/server/src/x.ts',
              function: 'fn',
              lineno: 3,
              colno: 1,
              in_app: true,
            },
          ],
        },
      },
    ],
    $exception_level: 'error' as const,
    $process_person_profile: false as const,
    surface: 'server',
    release: 'dorkos@0.47.0',
    environment: 'production',
    os: 'darwin-arm64',
  },
  distinctId: '7c6d2b9a-9f44-4f3a-bf67-3f3aa6bbf7c4',
  timestamp: '2026-07-13T12:00:02.000Z',
  dorkosVersion: '0.47.0',
};

const VALID_AI_GENERATION = {
  event: '$ai_generation' as const,
  properties: {
    $ai_trace_id: '3f3aa6bb-9f44-4f3a-bf67-7c6d2b9a1234',
    $ai_provider: 'claude-code',
    $ai_model: 'claude-opus-4-6',
    $ai_input_tokens: 1200,
    $ai_output_tokens: 340,
    $ai_latency: 4.2,
    $ai_total_cost_usd: 0.51,
    $process_person_profile: false as const,
  },
  distinctId: '7c6d2b9a-9f44-4f3a-bf67-3f3aa6bbf7c4',
  timestamp: '2026-07-13T12:00:04.000Z',
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

  describe('$exception crash events (DOR-318)', () => {
    beforeEach(() => {
      env.POSTHOG_PROJECT_KEY = 'phc_test_key';
    });

    it('accepts a valid $exception event alongside usage events (mixed batch)', async () => {
      const res = await POST(makeRequest({ events: [VALID_APP_STARTED, VALID_EXCEPTION] }));
      expect((await readJson(res)).accepted).toBe(2);
    });

    it('forwards $exception to PostHog with its error-tracking properties intact', async () => {
      await POST(makeRequest({ events: [VALID_EXCEPTION] }));
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      const sent = JSON.parse(init.body as string) as {
        batch: Array<{ event: string; properties: Record<string, unknown> }>;
      };
      expect(sent.batch[0].event).toBe('$exception');
      expect(sent.batch[0].properties.$exception_list).toBeDefined();
      expect(sent.batch[0].properties.$process_person_profile).toBe(false);
    });

    it('drops a $exception event with an unknown property (strict allowlist)', async () => {
      const poisoned = {
        ...VALID_EXCEPTION,
        properties: { ...VALID_EXCEPTION.properties, cwd: '/Users/kai/secret' },
      };
      const res = await POST(makeRequest({ events: [poisoned] }));
      expect((await readJson(res)).accepted).toBe(0);
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe('$ai_generation metadata events (DOR-319)', () => {
    beforeEach(() => {
      env.POSTHOG_PROJECT_KEY = 'phc_test_key';
    });

    it('accepts a valid $ai_generation event in a mixed batch', async () => {
      const res = await POST(
        makeRequest({ events: [VALID_APP_STARTED, VALID_AI_GENERATION, VALID_EXCEPTION] })
      );
      expect((await readJson(res)).accepted).toBe(3);
    });

    it('forwards $ai_generation to PostHog with its LLM-analytics properties intact', async () => {
      await POST(makeRequest({ events: [VALID_AI_GENERATION] }));
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      const sent = JSON.parse(init.body as string) as {
        batch: Array<{ event: string; properties: Record<string, unknown> }>;
      };
      expect(sent.batch[0].event).toBe('$ai_generation');
      expect(sent.batch[0].properties.$ai_model).toBe('claude-opus-4-6');
      expect(sent.batch[0].properties.$ai_input_tokens).toBe(1200);
      expect(sent.batch[0].properties.$process_person_profile).toBe(false);
      expect(sent.batch[0].properties.dorkos_version).toBe('0.47.0');
    });

    it('drops an $ai_generation event carrying a content-shaped property (strict allowlist)', async () => {
      const poisoned = {
        ...VALID_AI_GENERATION,
        properties: { ...VALID_AI_GENERATION.properties, $ai_input: 'the raw prompt text' },
      };
      const res = await POST(makeRequest({ events: [poisoned] }));
      expect((await readJson(res)).accepted).toBe(0);
      expect(fetchSpy).not.toHaveBeenCalled();
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

  describe('feedback events (user-volunteered; DOR-317)', () => {
    it('accepts a valid feedback_submitted event', async () => {
      const res = await POST(makeRequest({ events: [VALID_FEEDBACK_SUBMITTED] }));
      expect((await readJson(res)).accepted).toBe(1);
    });

    it('accepts a valid feature_requested event', async () => {
      const res = await POST(makeRequest({ events: [VALID_FEATURE_REQUESTED] }));
      expect((await readJson(res)).accepted).toBe(1);
    });

    it('accepts a mixed usage + feedback batch (both branches)', async () => {
      const res = await POST(
        makeRequest({ events: [VALID_APP_STARTED, VALID_FEEDBACK_SUBMITTED] })
      );
      expect((await readJson(res)).accepted).toBe(2);
    });

    it('drops a feedback event with an unknown property', async () => {
      const res = await POST(
        makeRequest({
          events: [
            {
              ...VALID_FEEDBACK_SUBMITTED,
              properties: { ...VALID_FEEDBACK_SUBMITTED.properties, cwd: '/Users/kai' },
            },
          ],
        })
      );
      expect((await readJson(res)).accepted).toBe(0);
    });

    it('forwards feedback (including the volunteered message/contact) to PostHog', async () => {
      env.POSTHOG_PROJECT_KEY = 'phc_test_key';
      await POST(makeRequest({ events: [VALID_FEEDBACK_SUBMITTED] }));
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://us.i.posthog.com/batch/');
      const sent = JSON.parse(init.body as string) as {
        batch: Array<{ event: string; distinct_id: string; properties: Record<string, unknown> }>;
      };
      expect(sent.batch[0].event).toBe('feedback_submitted');
      expect(sent.batch[0].distinct_id).toBe('ph_visitor_abc123');
      expect(sent.batch[0].properties.message).toBe(VALID_FEEDBACK_SUBMITTED.properties.message);
      expect(sent.batch[0].properties.contact).toBe('kai@example.com');
    });

    it('does not forward feedback when POSTHOG_PROJECT_KEY is unset (accept-and-drop)', async () => {
      env.POSTHOG_PROJECT_KEY = undefined;
      const res = await POST(makeRequest({ events: [VALID_FEEDBACK_SUBMITTED] }));
      expect((await readJson(res)).accepted).toBe(1);
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe('honeypot (bot trap; DOR-317)', () => {
    beforeEach(() => {
      env.POSTHOG_PROJECT_KEY = 'phc_test_key';
    });

    it('drops the whole batch when the website field is non-empty', async () => {
      const res = await POST(
        makeRequest({ events: [VALID_FEEDBACK_SUBMITTED], website: 'http://spam.example' })
      );
      expect(res.status).toBe(200);
      expect((await readJson(res)).accepted).toBe(0);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('ignores an empty/whitespace website field (real submissions pass)', async () => {
      const res = await POST(makeRequest({ events: [VALID_FEEDBACK_SUBMITTED], website: '   ' }));
      expect((await readJson(res)).accepted).toBe(1);
    });
  });
});
