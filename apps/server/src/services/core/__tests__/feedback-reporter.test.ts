/**
 * Tests for the feedback forwarder (DOR-317, ADR 260713-143958 Phase 5).
 *
 * Proves the two things that make this NOT the usage path: it reports send
 * success/failure honestly (so the UI can toast truthfully), and it does NO
 * consent gating — it forwards even with every telemetry kill switch set,
 * because pressing Send is the consent.
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

let dorkHome: string;

beforeEach(async () => {
  dorkHome = await mkdtemp(path.join(tmpdir(), 'dork-feedback-'));
  mockGetUserById.mockReset();
});

afterEach(async () => {
  await rm(dorkHome, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

/** A fetch stub that records its args and resolves an OK/!OK/rejecting response. */
function makeFetch(behavior: 'ok' | 'not-ok' | 'reject') {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
    if (behavior === 'reject') throw new Error('network down');
    return new Response(null, { status: behavior === 'ok' ? 200 : 500 });
  }) as unknown as typeof fetch;
}

describe('sendFeedback', () => {
  it('returns ok:true when the ingest accepts the POST', async () => {
    const fetchImpl = makeFetch('ok');
    const result = await sendFeedback({
      submission: { kind: 'bug', message: 'broken thing' },
      dorkHome,
      dorkosVersion: '0.47.0',
      endpoint: 'https://example.test/ingest',
      fetchImpl,
    });
    expect(result).toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('returns ok:false on a non-OK response', async () => {
    const result = await sendFeedback({
      submission: { kind: 'feedback', message: 'hi' },
      dorkHome,
      dorkosVersion: '0.47.0',
      fetchImpl: makeFetch('not-ok'),
    });
    expect(result).toEqual({ ok: false });
  });

  it('returns ok:false (never throws) on a network error', async () => {
    const result = await sendFeedback({
      submission: { kind: 'feedback', message: 'hi' },
      dorkHome,
      dorkosVersion: '0.47.0',
      fetchImpl: makeFetch('reject'),
    });
    expect(result).toEqual({ ok: false });
  });

  it('builds the correct wire event: bug → feedback_submitted, cockpit surface, version', async () => {
    const fetchImpl = makeFetch('ok');
    await sendFeedback({
      submission: { kind: 'bug', message: 'crash on save', contact: 'a@b.com', route: '/tasks' },
      dorkHome,
      dorkosVersion: '0.47.0',
      endpoint: 'https://example.test/ingest',
      fetchImpl,
    });
    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse((init as RequestInit).body as string) as {
      events: Array<{ event: string; properties: Record<string, unknown>; distinctId: string }>;
    };
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
    // distinctId is the anonymous install id (a UUID), not a user id.
    expect(event.distinctId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('maps the idea kind to feature_requested with no kind property', async () => {
    const fetchImpl = makeFetch('ok');
    await sendFeedback({
      submission: { kind: 'idea', message: 'add dark mode' },
      dorkHome,
      dorkosVersion: '0.47.0',
      endpoint: 'https://example.test/ingest',
      fetchImpl,
    });
    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse((init as RequestInit).body as string) as {
      events: Array<{ event: string; properties: Record<string, unknown> }>;
    };
    expect(body.events[0].event).toBe('feature_requested');
    expect(body.events[0].properties).not.toHaveProperty('kind');
  });

  it('does NO consent gating: forwards even with every telemetry kill switch set', async () => {
    // The whole point of the feedback path — DO_NOT_TRACK / DORKOS_TELEMETRY_*
    // govern tracking, not a user pressing Send. The reporter reads none of them.
    vi.stubEnv('DO_NOT_TRACK', '1');
    vi.stubEnv('DORKOS_TELEMETRY_DISABLED', '1');
    const fetchImpl = makeFetch('ok');
    const result = await sendFeedback({
      submission: { kind: 'feedback', message: 'still sends' },
      dorkHome,
      dorkosVersion: '0.47.0',
      endpoint: 'https://example.test/ingest',
      fetchImpl,
    });
    expect(result).toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('attaches reporterEmail/reporterName when the caller passes a resolved identity', async () => {
    const fetchImpl = makeFetch('ok');
    await sendFeedback({
      submission: { kind: 'bug', message: 'crash on save' },
      dorkHome,
      dorkosVersion: '0.47.0',
      endpoint: 'https://example.test/ingest',
      fetchImpl,
      identity: { userId: 'user_1', email: 'dorian@example.com', name: 'Dorian' },
    });
    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse((init as RequestInit).body as string) as {
      events: Array<{ properties: Record<string, unknown> }>;
    };
    expect(body.events[0].properties.reporterEmail).toBe('dorian@example.com');
    expect(body.events[0].properties.reporterName).toBe('Dorian');
    // The Better Auth user id itself never rides the wire event.
    expect(JSON.stringify(body.events[0].properties)).not.toContain('user_1');
  });

  it('sends no reporterEmail/reporterName when no identity was resolved (auth off / no session)', async () => {
    const fetchImpl = makeFetch('ok');
    await sendFeedback({
      submission: { kind: 'bug', message: 'crash on save' },
      dorkHome,
      dorkosVersion: '0.47.0',
      endpoint: 'https://example.test/ingest',
      fetchImpl,
    });
    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse((init as RequestInit).body as string) as {
      events: Array<{ properties: Record<string, unknown> }>;
    };
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
