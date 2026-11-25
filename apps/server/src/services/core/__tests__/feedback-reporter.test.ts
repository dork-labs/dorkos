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

import type { FeedbackDiagnostics } from '@dorkos/shared/telemetry-events';

import { sendFeedback, resolveFeedbackIdentity, listMyFeedback } from '../feedback-reporter.js';
import { getUserById } from '../auth/index.js';

/** The `clientReport` half of a diagnostics bundle, typed from the schema. */
type ClientReport = FeedbackDiagnostics['clientReport'];

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

/** Every durable-endpoint body, in call order. */
function durableBodies(fetchImpl: FetchMock): Array<Record<string, unknown>> {
  const calls = fetchImpl.mock.calls as unknown as Array<[string | URL | Request, RequestInit]>;
  return calls
    .filter(([url]) => String(url) === DURABLE_ENDPOINT)
    .map(([, init]) => JSON.parse(init.body as string) as Record<string, unknown>);
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

  // `ok` reflects ONLY the durable post; the metrics post is best-effort, and
  // nothing ever throws.
  it.each([
    { durable: 'ok', metrics: 'reject', ok: true },
    { durable: 'not-ok', metrics: 'ok', ok: false },
    { durable: 'reject', metrics: 'ok', ok: false },
  ] as const)(
    'returns ok:$ok when the durable post is $durable and metrics is $metrics',
    async ({ durable, metrics, ok }) => {
      const fetchImpl = makeSplitFetch({ durable, metrics });
      await expect(sendFeedback(baseOptions({ fetchImpl }))).resolves.toEqual({ ok });
    }
  );

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
    const metrics = bodyForUrl(fetchImpl, METRICS_ENDPOINT) as {
      events: Array<{ properties: Record<string, unknown> }>;
    };
    expect(metrics.events[0].properties).toMatchObject({
      reporterEmail: 'dorian@example.com',
      reporterName: 'Dorian',
    });
    expect(JSON.stringify(metrics)).not.toContain('user_1');
  });

  it('truncates an over-cap name and drops an over-cap email so identity never 400s the durable write', async () => {
    // The durable route is .strict() with a 128-char name cap and a 254-char
    // email cap; an over-cap value would reject the WHOLE write and silently
    // lose the feedback. Names truncate safely; an over-cap email is dropped
    // (a sliced address is worse than none) rather than sent.
    const fetchImpl = makeFetch('ok');
    await sendFeedback(
      baseOptions({
        submission: { kind: 'bug', message: 'crash on save' },
        identity: {
          userId: 'user_1',
          email: `${'a'.repeat(260)}@example.com`,
          name: 'x'.repeat(200),
        },
        fetchImpl,
      })
    );

    const body = durableBody(fetchImpl);
    expect(body.reporterName).toBe('x'.repeat(128));
    expect(body).not.toHaveProperty('reporterEmail');
  });

  it("names the desktop shell's own log apart from the server's (DOR-2045)", async () => {
    // Without a section of its own the field is inert: it would reach the route,
    // validate, and then never appear in the report anyone reads. The two logs
    // are labelled separately because they come from different processes and a
    // reader has to know which one said what.
    const fetchImpl = makeFetch('ok');
    await sendFeedback(
      baseOptions({
        submission: {
          kind: 'bug',
          message: 'the window keeps reloading itself',
          diagnostics: {
            clientReport: {
              version: '0.75.0',
              platform: 'darwin-arm64',
              runtimes: [],
              flags: {},
              shell: 'desktop-app' as const,
            },
            serverLogExcerpt: '2026-09-14T22:25:25.000Z warn [http] slow request',
            shellLogExcerpt: '2026-09-14 15:25:25.123 info [renderer] Reloading the window.',
          },
        },
        fetchImpl,
      })
    );

    const diagnostics = durableBody(fetchImpl).diagnostics as string;
    expect(diagnostics).toContain('Server log excerpt:\n2026-09-14T22:25:25.000Z warn');
    expect(diagnostics).toContain(
      'Desktop app log excerpt:\n2026-09-14 15:25:25.123 info [renderer] Reloading the window.'
    );
  });

  it('says so in the report when a section had no room, instead of vanishing', async () => {
    // `flags` is an uncapped record, so a report CAN arrive with almost the
    // whole block already spent. A section that silently disappears reads as
    // "there was no log", which sends triage looking in the wrong place.
    const fetchImpl = makeFetch('ok');
    // 166 flags is the middle of the band (measured 163-169) where the header
    // leaves room to NAME what was dropped but not to carry it: below it the
    // excerpts still fit front-cut, above it not even the markers do.
    const flags = Object.fromEntries(
      Array.from({ length: 166 }, (_, i) => [`f${i}`, 'v'.repeat(40)])
    );

    await sendFeedback(
      baseOptions({
        submission: {
          kind: 'bug',
          message: 'the window keeps reloading itself',
          diagnostics: {
            clientReport: {
              version: '0.75.0',
              platform: 'darwin-arm64',
              runtimes: [],
              flags,
              shell: 'desktop-app' as const,
            },
            serverLogExcerpt: `2026-09-14T22:25:00.000Z warn [http] slow ${'y'.repeat(4000)}`,
            shellLogExcerpt: `2026-09-14 15:25:25.123 info [renderer] reload ${'z'.repeat(4000)}`,
          },
        },
        fetchImpl,
      })
    );

    const diagnostics = durableBody(fetchImpl).diagnostics as string;
    expect(diagnostics.length).toBeLessThanOrEqual(8000);
    expect(diagnostics).toContain('Server log excerpt: (omitted, no room)');
    expect(diagnostics).toContain('Desktop app log excerpt: (omitted, no room)');
  });

  it('folds a run of identical breadcrumbs into one line with a count (DOR-2234)', async () => {
    // A retry loop logs the same crumb many times in a row; printed one per
    // line it buried the crumbs around it and spent the shared budget.
    const fetchImpl = makeFetch('ok');
    type Crumb = NonNullable<FeedbackDiagnostics['breadcrumbs']>[number];
    const crumb = (at: string, kind: Crumb['kind'], message: string): Crumb => ({
      at,
      kind,
      message,
    });
    await sendFeedback(
      baseOptions({
        submission: {
          kind: 'bug',
          message: 'it keeps retrying',
          diagnostics: {
            clientReport: { version: '0.47.0', platform: 'darwin-arm64', runtimes: [], flags: {} },
            breadcrumbs: [
              crumb('2026-08-03T00:00:00.000Z', 'sse_disconnect', 'stream closed'),
              crumb('2026-08-03T00:00:01.000Z', 'console_error', 'fetch failed'),
              crumb('2026-08-03T00:00:02.000Z', 'console_error', 'fetch failed'),
              crumb('2026-08-03T00:00:03.000Z', 'console_error', 'fetch failed'),
              crumb('2026-08-03T00:00:04.000Z', 'query_error', 'rooms failed'),
              // Same words, different kind: not a repeat.
              crumb('2026-08-03T00:00:05.000Z', 'console_warn', 'rooms failed'),
              // A repeat that is not adjacent keeps its own place in time.
              crumb('2026-08-03T00:00:06.000Z', 'console_error', 'fetch failed'),
            ],
          },
        },
        fetchImpl,
      })
    );

    const diagnostics = durableBody(fetchImpl).diagnostics as string;
    const crumbs = diagnostics.split('Breadcrumbs:\n')[1]!.split('\n');
    expect(crumbs).toEqual([
      '[2026-08-03T00:00:00.000Z] sse_disconnect: stream closed',
      '[2026-08-03T00:00:01.000Z] console_error: fetch failed (x3, last 2026-08-03T00:00:03.000Z)',
      '[2026-08-03T00:00:04.000Z] query_error: rooms failed',
      '[2026-08-03T00:00:05.000Z] console_warn: rooms failed',
      '[2026-08-03T00:00:06.000Z] console_error: fetch failed',
    ]);
  });

  describe('diagnostics context lines (DOR-1960)', () => {
    /** A `clientReport` carrying every environment field the client can capture. */
    function reportWithEnvironment(overrides: Partial<ClientReport> = {}): ClientReport {
      return {
        version: '0.47.0',
        platform: 'darwin-arm64',
        runtimes: ['claude-code'],
        flags: {},
        viewport: { width: 1280, height: 720, devicePixelRatio: 2 },
        browser: 'Mozilla/5.0 (Macintosh) TestBrowser/1.0',
        shell: 'desktop-app' as const,
        theme: 'dark' as const,
        locale: 'en-GB',
        timezone: 'Europe/London',
        ...overrides,
      };
    }

    /** Send one submission with the given clientReport and return the rendered text. */
    async function renderedFor(
      clientReport: ClientReport,
      options: Partial<Parameters<typeof sendFeedback>[0]> = {}
    ): Promise<string> {
      const fetchImpl = makeFetch('ok');
      await sendFeedback(
        baseOptions({
          submission: { kind: 'bug', message: 'layout broke', diagnostics: { clientReport } },
          fetchImpl,
          ...options,
        })
      );
      return durableBody(fetchImpl).diagnostics as string;
    }

    it('renders every captured environment field as a Key: value line', async () => {
      const diagnostics = await renderedFor(reportWithEnvironment());

      // Asserted as whole lines, not substrings: the site fences this text
      // verbatim into the Linear issue, so the LINE is the contract a human
      // reads. A bare `toContain('dark')` would also pass on `darwin-arm64`.
      const lines = diagnostics.split('\n');
      expect(lines).toContain('Viewport: 1280x720 @2x');
      expect(lines).toContain('Shell: desktop-app');
      expect(lines).toContain('Theme: dark');
      expect(lines).toContain('Locale: en-GB');
      expect(lines).toContain('Timezone: Europe/London');
      expect(lines).toContain('Browser: Mozilla/5.0 (Macintosh) TestBrowser/1.0');
    });

    it.each([
      { client: '0.47.0', server: '0.47.0', line: 'Version: 0.47.0' },
      // Upgrade skew: a long-lived tab holding a cached config.
      { client: '0.47.0', server: '0.48.1', line: 'Version: 0.47.0 (server 0.48.1)' },
      // `unknown` is a loading state, not a version, so it is not skew.
      { client: 'unknown', server: '0.48.1', line: 'Version: 0.48.1' },
    ])('renders client $client / server $server as "$line"', async ({ client, server, line }) => {
      const diagnostics = await renderedFor(reportWithEnvironment({ version: client }), {
        dorkosVersion: server,
      });
      expect(diagnostics.split('\n')).toContain(line);
    });

    it('keeps the context lines when a full breadcrumb trail overruns the 8000-char cap', async () => {
      // Breadcrumbs alone reach ~17,000 characters at their own caps (50 x 300),
      // so the final slice is a live possibility on a real report. The context
      // header must be on the surviving side of it — which is only true while
      // the header is rendered BEFORE the breadcrumb section.
      const fetchImpl = makeFetch('ok');
      await sendFeedback(
        baseOptions({
          submission: {
            kind: 'bug',
            message: 'layout broke',
            diagnostics: {
              clientReport: reportWithEnvironment(),
              breadcrumbs: Array.from({ length: 50 }, (_, i) => ({
                at: '2026-08-03T00:00:00.000Z',
                kind: 'console_error' as const,
                message: `${i}-${'x'.repeat(295)}`,
              })),
            },
          },
          fetchImpl,
        })
      );

      const diagnostics = durableBody(fetchImpl).diagnostics as string;
      expect(diagnostics).toHaveLength(8000);
      const lines = diagnostics.split('\n');
      expect(lines).toContain('Viewport: 1280x720 @2x');
      expect(lines).toContain('Theme: dark');
      expect(lines).toContain('Browser: Mozilla/5.0 (Macintosh) TestBrowser/1.0');
    });
  });

  it('carries transcriptExcerpt, truncated to the durable route cap, with hasTranscript:true', async () => {
    const fetchImpl = makeFetch('ok');
    await sendFeedback(
      baseOptions({
        submission: {
          kind: 'bug',
          message: 'crash on save',
          transcriptExcerpt: 'x'.repeat(15_000),
        },
        fetchImpl,
      })
    );

    const body = durableBody(fetchImpl);
    expect(body.transcriptExcerpt).toBe('x'.repeat(8000));
    expect(body.hasTranscript).toBe(true);
  });

  it('forwards the screenshot data URL verbatim and sets hasScreenshot:true', async () => {
    const fetchImpl = makeFetch('ok');
    const dataUrl = `data:image/webp;base64,${'QUJD'.repeat(40)}`;
    await sendFeedback(
      baseOptions({
        submission: { kind: 'bug', message: 'crash on save', screenshot: { dataUrl } },
        fetchImpl,
      })
    );

    const body = durableBody(fetchImpl);
    expect(body.hasScreenshot).toBe(true);
    // The bytes themselves ride along — the site is what hands them to Linear.
    // Verbatim matters: a truncated base64 payload is a corrupt image.
    expect(body.screenshot).toEqual({ dataUrl });
  });

  describe('413 retry (a screenshot must never sink the report)', () => {
    /**
     * Durable endpoint answers 413 once, then 200. Every per-field cap counts
     * characters while the site's body cap counts bytes, so a multibyte report
     * plus a maximum screenshot can be schema-legal and still too large.
     */
    function make413ThenOk(): FetchMock {
      let durableCalls = 0;
      return vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
        if (String(url) !== DURABLE_ENDPOINT) return new Response(null, { status: 200 });
        durableCalls += 1;
        return new Response(null, { status: durableCalls === 1 ? 413 : 200 });
      }) as unknown as FetchMock;
    }

    const withScreenshot = {
      kind: 'bug' as const,
      message: 'crash on save',
      screenshot: { dataUrl: `data:image/webp;base64,${'QUJD'.repeat(40)}` },
    };

    it('retries once without the screenshot and reports ok', async () => {
      const fetchImpl = make413ThenOk();
      const result = await sendFeedback(baseOptions({ submission: withScreenshot, fetchImpl }));

      const bodies = durableBodies(fetchImpl);
      expect(bodies).toHaveLength(2);
      expect(bodies[0]).toHaveProperty('screenshot');
      // The picture is dropped; the report — message and all — is not.
      expect(bodies[1]).not.toHaveProperty('screenshot');
      expect(bodies[1]).not.toHaveProperty('hasScreenshot');
      expect(bodies[1]).toMatchObject({ kind: 'bug', message: 'crash on save' });
      expect(result).toEqual({ ok: true });
    });

    it('does not retry a 413 when there was no screenshot to drop', async () => {
      const fetchImpl = make413ThenOk();
      const result = await sendFeedback(baseOptions({ fetchImpl }));

      // Nothing to shed, so a second attempt would just repeat the failure.
      expect(durableBodies(fetchImpl)).toHaveLength(1);
      expect(result).toEqual({ ok: false });
    });
  });

  describe('the pointed-at element (DOR-2232)', () => {
    const element = {
      selector: '[data-testid="message-list"]',
      slot: 'scroll-area',
      testId: 'message-list',
      label: 'Messages',
    };
    const withElement = { kind: 'bug' as const, message: 'messages vanish', element };

    /** What an older site's strict schema says about a key it has never heard of. */
    const ELEMENT_UNKNOWN = {
      ok: false,
      error: 'Invalid submission',
      issues: [{ code: 'unrecognized_keys', keys: ['element'], path: [], message: 'x' }],
    };
    /** A refusal that has nothing to do with the element. */
    const MESSAGE_TOO_LONG = {
      ok: false,
      error: 'Invalid submission',
      issues: [{ code: 'too_big', path: ['message'], message: 'x' }],
    };

    /** Durable endpoint answers each scripted response in turn, then 200. */
    function makeDurableScript(script: Array<{ status: number; body?: unknown }>): FetchMock {
      let durableCalls = 0;
      return vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
        if (String(url) !== DURABLE_ENDPOINT) return new Response(null, { status: 200 });
        const step = script[durableCalls];
        durableCalls += 1;
        if (!step) return new Response(null, { status: 200 });
        return new Response(step.body ? JSON.stringify(step.body) : null, {
          status: step.status,
          headers: { 'content-type': 'application/json' },
        });
      }) as unknown as FetchMock;
    }

    it('retries once without the element when the site refuses the body', async () => {
      // A site that predates the field refuses it (its schema is strict). The
      // report is worth more than the element's name, so it goes again without.
      const fetchImpl = makeDurableScript([{ status: 400, body: ELEMENT_UNKNOWN }]);
      const result = await sendFeedback(baseOptions({ submission: withElement, fetchImpl }));

      const bodies = durableBodies(fetchImpl);
      expect(bodies).toHaveLength(2);
      expect(bodies[0]).toHaveProperty('element');
      expect(bodies[1]).not.toHaveProperty('element');
      expect(bodies[1]).toMatchObject({ kind: 'bug', message: 'messages vanish' });
      expect(result).toEqual({ ok: true });
    });

    it('does not retry a 400 that names something other than the element', async () => {
      const fetchImpl = makeDurableScript([{ status: 400, body: MESSAGE_TOO_LONG }]);
      const result = await sendFeedback(baseOptions({ submission: withElement, fetchImpl }));

      // Dropping the element would not fix a refusal about something else, and
      // the log would blame the wrong field.
      expect(durableBodies(fetchImpl)).toHaveLength(1);
      expect(result).toEqual({ ok: false });
    });
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

  it('throws (never swallows) on a non-OK response — this is a read the UI must show an error for', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(null, { status: 500 })
    ) as unknown as typeof fetch;

    await expect(
      listMyFeedback({ dorkHome, cloudUrl: 'https://example.test', fetchImpl })
    ).rejects.toThrow(/500/);
  });
});
