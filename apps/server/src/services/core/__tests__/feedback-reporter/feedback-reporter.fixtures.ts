/**
 * Shared harness for the feedback forwarder tests: a temp data directory, fetch
 * stubs and readers for the bodies each post sent.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, vi } from 'vitest';
import type { Mock } from 'vitest';

import type { SendFeedbackOptions } from '../../feedback-reporter.js';

/** The site route the durable post goes to. */
export const DURABLE_ENDPOINT = 'https://example.test/api/feedback';
/** The metrics ingest the best-effort post goes to. */
export const METRICS_ENDPOINT = 'https://example.test/ingest';

/** A mocked `fetch`: a vitest mock usable both as `typeof fetch` and for call inspection. */
export type FetchMock = Mock & typeof fetch;

/** Give every test a fresh data directory; returns a reader for the current one. */
export function useTempDorkHome(): () => string {
  let dorkHome = '';
  beforeEach(async () => {
    dorkHome = await mkdtemp(path.join(tmpdir(), 'dork-feedback-'));
  });
  afterEach(async () => {
    await rm(dorkHome, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });
  return () => dorkHome;
}

/** Default options shared by most `sendFeedback` calls. */
export function feedbackOptions(
  dorkHome: string,
  overrides: Partial<SendFeedbackOptions> = {}
): SendFeedbackOptions {
  return {
    submission: { kind: 'bug', message: 'broken thing' },
    dorkHome,
    dorkosVersion: '0.47.0',
    endpoint: METRICS_ENDPOINT,
    cloudUrl: 'https://example.test',
    ...overrides,
  };
}

/** A same-behavior-for-both-posts fetch stub. */
export function makeFetch(behavior: 'ok' | 'not-ok' | 'reject'): FetchMock {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
    if (behavior === 'reject') throw new Error('network down');
    return new Response(null, { status: behavior === 'ok' ? 200 : 500 });
  }) as unknown as FetchMock;
}

/** Find the call made to `url`, returning its parsed JSON body. */
export function bodyForUrl(fetchImpl: FetchMock, url: string): Record<string, unknown> {
  const calls = fetchImpl.mock.calls as unknown as Array<[string | URL | Request, RequestInit]>;
  const call = calls.find(([callUrl]) => String(callUrl) === url);
  if (!call) throw new Error(`${url} was never called`);
  const [, init] = call;
  return JSON.parse(init.body as string) as Record<string, unknown>;
}

/** Every durable-endpoint body, in call order. */
export function durableBodies(fetchImpl: FetchMock): Array<Record<string, unknown>> {
  const calls = fetchImpl.mock.calls as unknown as Array<[string | URL | Request, RequestInit]>;
  return calls
    .filter(([url]) => String(url) === DURABLE_ENDPOINT)
    .map(([, init]) => JSON.parse(init.body as string) as Record<string, unknown>);
}
