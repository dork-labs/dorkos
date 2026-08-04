/**
 * Tests for the feedback forwarder (DOR-317, ADR 260713-143958 Phase 5;
 * dual-write per feedback-pipeline spec Part 3, decision 260803-205035).
 *
 * Proves the dual-write contract: `sendFeedback` posts to BOTH the durable
 * site route (`POST /api/feedback`) and the metrics ingest
 * (`/api/telemetry/events`), the returned `{ ok }` reflects ONLY the durable
 * post's outcome, the metrics post is best-effort and never throws, and the
 * whole function never throws regardless of which post fails. Also proves
 * the two things that make this NOT the usage path: it does NO consent
 * gating, and it does no consent-channel reads — pressing Send is the
 * consent.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../auth/index.js', () => ({
  getUserById: vi.fn(),
}));

import { sendFeedback, resolveFeedbackIdentity, listMyFeedback } from '../feedback-reporter.js';
import { getUserById } from '../auth/index.js';

const mockGetUserById = vi.mocked(getUserById);

const DURABLE_ENDPOINT = 'https://example.test/api/feedback';
const METRICS_ENDPOINT = 'https://example.test/ingest';

let dorkHome: string;

beforeEach(async () => {
  dorkHome = await mkdtemp(path.join(tmpdir(), 'dork-feedback-'));
  mockGetUserById.mockReset();
});

afterEach(async () => {
  await rm(dorkHome, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

/** A mocked `fetch`: a vitest mock usable both as `typeof fetch` and for call inspection. */
type FetchMock = ReturnType<typeof vi.fn> & typeof fetch;

/** A same-behavior-for-both-posts fetch stub. */
function makeFetch(behavior: 'ok' | 'not-ok' | 'reject'): FetchMock {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
    if (behavior === 'reject') throw new Error('network down');
    return new Response(null, { status: behavior === 'ok' ? 200 : 500 });
  }) as unknown as FetchMock;
}

/**
 * A fetch stub that behaves differently for the durable post vs the metrics
 * post, distinguished by URL, so ok-semantics tests can prove the durable
 * response (not the metrics one) decides the returned `ok`.
 */
function makeSplitFetch(behaviors: {
  durable: 'ok' | 'not-ok' | 'reject';
  metrics: 'ok' | 'not-ok' | 'reject';
}): FetchMock {
  return vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
    const isDurable = String(url) === DURABLE_ENDPOINT;
    const behavior = isDurable ? behaviors.durable : behaviors.metrics;
    if (behavior === 'reject') throw new Error(isDurable ? 'durable down' : 'metrics down');
    return new Response(null, { status: behavior === 'ok' ? 200 : 500 });
  }) as unknown as FetchMock;
}

/** Default options shared by most `sendFeedback` calls below. */
function baseOptions(overrides: Partial<Parameters<typeof sendFeedback>[0]> = {}) {
  return {
    submission: { kind: 'bug' as const, message: 'broken thing' },
    dorkHome,
    dorkosVersion: '0.47.0',
    endpoint: METRICS_ENDPOINT,
    cloudUrl: 'https://example.test',
    ...overrides,
  };
}

/** Find the call made to `url`, returning its parsed JSON body. */
function bodyForUrl(fetchImpl: FetchMock, url: string): Record<string, unknown> {
  const calls = fetchImpl.mock.calls as unknown as Array<[string | URL | Request, RequestInit]>;
  const call = calls.find(([callUrl]) => String(callUrl) === url);
  if (!call) throw new Error(`${url} was never called`);
  const [, init] = call;
  return JSON.parse(init.body as string) as Record<string, unknown>;
}

describe('sendFeedback — dual-write', () => {
  it('posts to BOTH the durable site route and the metrics ingest', async () => {
    const fetchImpl = makeFetch('ok');
    await sendFeedback(baseOptions({ fetchImpl }));

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const calls = fetchImpl.mock.calls as unknown as Array<[string | URL | Request, RequestInit]>;
    const urls = calls.map(([url]) => String(url));
    expect(urls).toContain(DURABLE_ENDPOINT);
    expect(urls).toContain(METRICS_ENDPOINT);
  });

  it('returns ok:true when the durable post succeeds', async () => {
    const fetchImpl = makeSplitFetch({ durable: 'ok', metrics: 'ok' });
    const result = await sendFeedback(baseOptions({ fetchImpl }));
    expect(result).toEqual({ ok: true });
  });

  it('returns ok:false when the durable post gets a non-OK response, EVEN THOUGH the metrics post succeeds', async () => {
    const fetchImpl = makeSplitFetch({ durable: 'not-ok', metrics: 'ok' });
    const result = await sendFeedback(baseOptions({ fetchImpl }));
    expect(result).toEqual({ ok: false });
  });

  it('returns ok:true when the durable post succeeds EVEN THOUGH the metrics post fails', async () => {
    const fetchImpl = makeSplitFetch({ durable: 'ok', metrics: 'not-ok' });
    const result = await sendFeedback(baseOptions({ fetchImpl }));
    expect(result).toEqual({ ok: true });
  });

  it('returns ok:false when the durable post throws, never throwing itself', async () => {
    const fetchImpl = makeSplitFetch({ durable: 'reject', metrics: 'ok' });
    const result = await sendFeedback(baseOptions({ fetchImpl }));
    expect(result).toEqual({ ok: false });
  });

  it('returns ok:true when the durable post succeeds even though the metrics post throws', async () => {
    const fetchImpl = makeSplitFetch({ durable: 'ok', metrics: 'reject' });
    const result = await sendFeedback(baseOptions({ fetchImpl }));
    expect(result).toEqual({ ok: true });
  });

  it('never throws when BOTH posts fail (network error)', async () => {
    const fetchImpl = makeFetch('reject');
    const result = await sendFeedback(baseOptions({ fetchImpl }));
    expect(result).toEqual({ ok: false });
  });

  it('does NO consent gating: dual-writes even with every telemetry kill switch set', async () => {
    vi.stubEnv('DO_NOT_TRACK', '1');
    vi.stubEnv('DORKOS_TELEMETRY_DISABLED', '1');
    const fetchImpl = makeFetch('ok');
    const result = await sendFeedback(baseOptions({ fetchImpl }));
    expect(result).toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe('sendFeedback — durable payload shape', () => {
  /** Parse the JSON body of the call made to the durable endpoint. */
  function durableBody(fetchImpl: FetchMock): Record<string, unknown> {
    return bodyForUrl(fetchImpl, DURABLE_ENDPOINT);
  }

  it('sends instanceId, kind, message, surface:"cockpit" as the minimum shape', async () => {
    const fetchImpl = makeFetch('ok');
    await sendFeedback(
      baseOptions({ submission: { kind: 'bug', message: 'crash on save' }, fetchImpl })
    );

    const body = durableBody(fetchImpl);
    expect(body).toMatchObject({
      kind: 'bug',
      message: 'crash on save',
      surface: 'cockpit',
    });
    expect(body.instanceId).toMatch(/^[0-9a-f-]{36}$/);
    // No metrics-only or PostHog-envelope fields leak into the durable body.
    expect(body).not.toHaveProperty('distinctId');
    expect(body).not.toHaveProperty('properties');
    expect(body).not.toHaveProperty('event');
  });

  it('carries contact and route through untouched', async () => {
    const fetchImpl = makeFetch('ok');
    await sendFeedback(
      baseOptions({
        submission: {
          kind: 'feedback',
          message: 'hi',
          contact: 'a@b.com',
          route: '/tasks',
        },
        fetchImpl,
      })
    );

    const body = durableBody(fetchImpl);
    expect(body.contact).toBe('a@b.com');
    expect(body.route).toBe('/tasks');
  });

  it('attaches reporterEmail/reporterName from a resolved identity', async () => {
    const fetchImpl = makeFetch('ok');
    await sendFeedback(
      baseOptions({
        submission: { kind: 'bug', message: 'crash on save' },
        identity: { userId: 'user_1', email: 'dorian@example.com', name: 'Dorian' },
        fetchImpl,
      })
    );

    const body = durableBody(fetchImpl);
    expect(body.reporterEmail).toBe('dorian@example.com');
    expect(body.reporterName).toBe('Dorian');
    // The Better Auth user id itself never rides the wire payload.
    expect(JSON.stringify(body)).not.toContain('user_1');
  });

  it('omits reporterEmail/reporterName when no identity was resolved', async () => {
    const fetchImpl = makeFetch('ok');
    await sendFeedback(baseOptions({ fetchImpl }));

    const body = durableBody(fetchImpl);
    expect(body).not.toHaveProperty('reporterEmail');
    expect(body).not.toHaveProperty('reporterName');
  });

  it('renders diagnostics to text and includes it when present', async () => {
    const fetchImpl = makeFetch('ok');
    await sendFeedback(
      baseOptions({
        submission: {
          kind: 'bug',
          message: 'crash on save',
          diagnostics: {
            clientReport: {
              version: '0.47.0',
              platform: 'darwin-arm64',
              runtimes: ['claude-code'],
              flags: { darkMode: true },
            },
            breadcrumbs: [
              { at: '2026-08-03T00:00:00.000Z', kind: 'console_error', message: 'boom' },
            ],
          },
        },
        fetchImpl,
      })
    );

    const body = durableBody(fetchImpl);
    expect(typeof body.diagnostics).toBe('string');
    const diagnostics = body.diagnostics as string;
    expect(diagnostics).toContain('0.47.0');
    expect(diagnostics).toContain('darwin-arm64');
    expect(diagnostics).toContain('claude-code');
    expect(diagnostics).toContain('boom');
    expect(diagnostics.length).toBeLessThanOrEqual(8000);
  });

  it('omits diagnostics when the submission has none', async () => {
    const fetchImpl = makeFetch('ok');
    await sendFeedback(baseOptions({ fetchImpl }));

    const body = durableBody(fetchImpl);
    expect(body).not.toHaveProperty('diagnostics');
  });

  it('carries transcriptExcerpt and sets hasTranscript:true when present', async () => {
    const fetchImpl = makeFetch('ok');
    await sendFeedback(
      baseOptions({
        submission: {
          kind: 'bug',
          message: 'crash on save',
          transcriptExcerpt: 'user: it broke\nassistant: sorry',
        },
        fetchImpl,
      })
    );

    const body = durableBody(fetchImpl);
    expect(body.transcriptExcerpt).toBe('user: it broke\nassistant: sorry');
    expect(body.hasTranscript).toBe(true);
  });

  it('truncates an oversized transcriptExcerpt to the durable route cap (8000 chars)', async () => {
    const fetchImpl = makeFetch('ok');
    const longExcerpt = 'x'.repeat(15_000);
    await sendFeedback(
      baseOptions({
        submission: { kind: 'bug', message: 'crash on save', transcriptExcerpt: longExcerpt },
        fetchImpl,
      })
    );

    const body = durableBody(fetchImpl);
    expect((body.transcriptExcerpt as string).length).toBe(8000);
  });

  it('omits transcriptExcerpt/hasTranscript when the submission has none', async () => {
    const fetchImpl = makeFetch('ok');
    await sendFeedback(baseOptions({ fetchImpl }));

    const body = durableBody(fetchImpl);
    expect(body).not.toHaveProperty('transcriptExcerpt');
    expect(body).not.toHaveProperty('hasTranscript');
  });

  it('sets hasScreenshot:true when a screenshotUploadId is present', async () => {
    const fetchImpl = makeFetch('ok');
    await sendFeedback(
      baseOptions({
        submission: { kind: 'bug', message: 'crash on save', screenshotUploadId: 'upload_1' },
        fetchImpl,
      })
    );

    const body = durableBody(fetchImpl);
    expect(body.hasScreenshot).toBe(true);
    // The raw upload id itself is never forwarded — only the boolean hint.
    expect(body).not.toHaveProperty('screenshotUploadId');
  });

  it('omits hasScreenshot when no screenshot was attached', async () => {
    const fetchImpl = makeFetch('ok');
    await sendFeedback(baseOptions({ fetchImpl }));

    const body = durableBody(fetchImpl);
    expect(body).not.toHaveProperty('hasScreenshot');
  });

  it('maps kind:"idea" straight through (the durable route has no PostHog-style event remapping)', async () => {
    const fetchImpl = makeFetch('ok');
    await sendFeedback(
      baseOptions({ submission: { kind: 'idea', message: 'add dark mode' }, fetchImpl })
    );

    const body = durableBody(fetchImpl);
    expect(body.kind).toBe('idea');
  });
});

describe('sendFeedback — metrics post (best-effort)', () => {
  /** Parse the JSON body of the call whose URL matches the metrics endpoint. */
  function metricsBody(fetchImpl: FetchMock): {
    events: Array<{ event: string; properties: Record<string, unknown>; distinctId: string }>;
  } {
    return bodyForUrl(fetchImpl, METRICS_ENDPOINT) as unknown as {
      events: Array<{ event: string; properties: Record<string, unknown>; distinctId: string }>;
    };
  }

  it('still fires the existing PostHog-shaped event: bug → feedback_submitted, cockpit surface, version', async () => {
    const fetchImpl = makeFetch('ok');
    await sendFeedback(
      baseOptions({
        submission: { kind: 'bug', message: 'crash on save', contact: 'a@b.com', route: '/tasks' },
        fetchImpl,
      })
    );

    const body = metricsBody(fetchImpl);
    const event = body.events[0];
    expect(event.event).toBe('feedback_submitted');
    expect(event.properties).toMatchObject({
      kind: 'bug',
      message: 'crash on save',
      contact: 'a@b.com',
      route: '/tasks',
      surface: 'cockpit',
      dorkosVersion: '0.47.0',
    });
    expect(event.distinctId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('maps the idea kind to feature_requested with no kind property', async () => {
    const fetchImpl = makeFetch('ok');
    await sendFeedback(
      baseOptions({ submission: { kind: 'idea', message: 'add dark mode' }, fetchImpl })
    );

    const body = metricsBody(fetchImpl);
    expect(body.events[0].event).toBe('feature_requested');
    expect(body.events[0].properties).not.toHaveProperty('kind');
  });

  it('attaches reporterEmail/reporterName when the caller passes a resolved identity', async () => {
    const fetchImpl = makeFetch('ok');
    await sendFeedback(
      baseOptions({
        submission: { kind: 'bug', message: 'crash on save' },
        identity: { userId: 'user_1', email: 'dorian@example.com', name: 'Dorian' },
        fetchImpl,
      })
    );

    const body = metricsBody(fetchImpl);
    expect(body.events[0].properties.reporterEmail).toBe('dorian@example.com');
    expect(body.events[0].properties.reporterName).toBe('Dorian');
    expect(JSON.stringify(body.events[0].properties)).not.toContain('user_1');
  });

  it('sends no reporterEmail/reporterName when no identity was resolved', async () => {
    const fetchImpl = makeFetch('ok');
    await sendFeedback(baseOptions({ fetchImpl }));

    const body = metricsBody(fetchImpl);
    expect(body.events[0].properties).not.toHaveProperty('reporterEmail');
    expect(body.events[0].properties).not.toHaveProperty('reporterName');
  });
});

describe('resolveFeedbackIdentity', () => {
  it('resolves { userId, email, name } from a verified session userId', async () => {
    mockGetUserById.mockReturnValue({
      id: 'user_1',
      email: 'dorian@example.com',
      name: 'Dorian',
    });

    const identity = await resolveFeedbackIdentity('user_1');

    expect(identity).toEqual({ userId: 'user_1', email: 'dorian@example.com', name: 'Dorian' });
    expect(mockGetUserById).toHaveBeenCalledWith('user_1');
  });

  it('resolves undefined when the id does not resolve to a user', async () => {
    mockGetUserById.mockReturnValue(null);

    const identity = await resolveFeedbackIdentity('unknown_id');

    expect(identity).toBeUndefined();
  });

  it('never reads identity from anything other than the passed userId', async () => {
    // The function's only input is the verified session's userId — there is no
    // parameter through which a caller could pass a client-supplied email/name
    // and have it override the database lookup.
    mockGetUserById.mockReturnValue({
      id: 'user_1',
      email: 'real@example.com',
      name: 'Real Name',
    });

    const identity = await resolveFeedbackIdentity('user_1');

    expect(identity?.email).toBe('real@example.com');
    expect(identity?.name).toBe('Real Name');
  });
});

describe('listMyFeedback', () => {
  const ITEMS = [
    {
      id: 'row-1',
      kind: 'bug' as const,
      message: 'it broke',
      status: 'in_progress' as const,
      createdAt: '2026-08-01T00:00:00.000Z',
    },
  ];

  it('reads this install own instanceId and forwards it as a query param', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      expect(String(url)).toMatch(/\/api\/feedback\/mine\?instanceId=[0-9a-f-]{36}$/);
      return new Response(JSON.stringify(ITEMS), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await listMyFeedback({
      dorkHome,
      cloudUrl: 'https://example.test',
      fetchImpl,
    });

    expect(result).toEqual(ITEMS);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('strips trailing slashes from the cloud URL before building the request', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      expect(String(url)).toMatch(/^https:\/\/example\.test\/api\/feedback\/mine\?/);
      return new Response('[]', { status: 200 });
    }) as unknown as typeof fetch;

    await listMyFeedback({ dorkHome, cloudUrl: 'https://example.test///', fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('throws (never swallows) on a non-OK response — this is a read the UI must show an error for', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(null, { status: 500 })
    ) as unknown as typeof fetch;

    await expect(
      listMyFeedback({ dorkHome, cloudUrl: 'https://example.test', fetchImpl })
    ).rejects.toThrow(/500/);
  });

  it('throws (never swallows) on a network error', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;

    await expect(
      listMyFeedback({ dorkHome, cloudUrl: 'https://example.test', fetchImpl })
    ).rejects.toThrow('network down');
  });
});
