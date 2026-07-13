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

import { sendFeedback } from '../feedback-reporter.js';

let dorkHome: string;

beforeEach(async () => {
  dorkHome = await mkdtemp(path.join(tmpdir(), 'dork-feedback-'));
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
});
