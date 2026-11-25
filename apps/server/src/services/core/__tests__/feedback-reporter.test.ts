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
import { describe, expect, it, vi } from 'vitest';

import { sendFeedback, listMyFeedback } from '../feedback-reporter.js';
import {
  DURABLE_ENDPOINT,
  METRICS_ENDPOINT,
  type FetchMock,
  bodyForUrl,
  durableBodies,
  feedbackOptions,
  makeFetch,
  useTempDorkHome,
} from './feedback-reporter/feedback-reporter.fixtures.js';

const dorkHome = useTempDorkHome();

/** Default options shared by most `sendFeedback` calls below. */
function baseOptions(
  overrides: Partial<Parameters<typeof sendFeedback>[0]> = {}
): Parameters<typeof sendFeedback>[0] {
  return feedbackOptions(dorkHome(), overrides);
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

describe('sendFeedback — dual-write', () => {
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
      dorkHome: dorkHome(),
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
      listMyFeedback({ dorkHome: dorkHome(), cloudUrl: 'https://example.test', fetchImpl })
    ).rejects.toThrow(/500/);
  });
});
