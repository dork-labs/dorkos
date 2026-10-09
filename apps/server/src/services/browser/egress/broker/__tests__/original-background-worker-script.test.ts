import { runInNewContext } from 'node:vm';
import { expect, it, vi } from 'vitest';
import { originalBackgroundWorkerScript } from './original-background-worker-script.fixture.js';

it('runs the actual generated event body only after its original held response completes', async () => {
  const nonce = '11111111-1111-1111-1111-111111111111';
  const script = originalBackgroundWorkerScript({
    nonce,
    allowedOrigin: 'https://owned-allowed.test',
    deniedOrigin: 'https://owned-denied.test',
  });
  let release!: (body: string) => void;
  const body = new Promise<string>((yes) => {
    release = yes;
  });
  const fetch = vi.fn(async (url: string) => {
    if (url === script.urls.gate) return { ok: true, text: () => body };
    if (url === script.urls.denied) throw new Error('ORIGINAL_OWNED_DENIAL');
    return { ok: true, text: async () => 'Owned response' };
  });
  const update = vi.fn(async () => {});
  const listeners = new Map<
    string,
    (event: { data: string; waitUntil(job: Promise<void>): void }) => void
  >();
  const jobs: Promise<void>[] = [];
  runInNewContext(script.source, {
    fetch,
    self: {
      addEventListener(
        name: string,
        callback: (event: { data: string; waitUntil(job: Promise<void>): void }) => void
      ) {
        listeners.set(name, callback);
      },
      registration: { update },
    },
  });
  listeners.get('message')!({
    data: nonce,
    waitUntil(job) {
      jobs.push(job);
      void job.catch(() => {});
    },
  });
  try {
    await vi.waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(script.urls.gate, {
        cache: 'no-store',
      })
    );
    expect(fetch).toHaveBeenCalledOnce();
    expect(update).not.toHaveBeenCalled();
    release('Original gate body');
    await jobs[0];
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      script.urls.gate,
      script.urls.allowed,
      script.urls.denied,
      script.urls.report + '/denied',
    ]);
    expect(update).toHaveBeenCalledOnce();
  } finally {
    release('Original gate body');
    await Promise.allSettled(jobs);
  }
});
it('refuses nonowned origins before emitting worker code', () => {
  expect(() =>
    originalBackgroundWorkerScript({
      nonce: '11111111-1111-1111-1111-111111111111',
      allowedOrigin: 'http://owned-allowed.test',
      deniedOrigin: 'https://owned-denied.test',
    })
  ).toThrow('BACKGROUND_OWNED_ORIGIN_REQUIRED');
});
