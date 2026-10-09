import { runInNewContext } from 'node:vm';
import { expect, it, vi } from 'vitest';
import {
  originalBackgroundRevocationScript,
  readOriginalBackgroundRevocation,
} from './original-background-revocation.fixture.js';
const nonce = '11111111-1111-4111-8111-111111111111';
it.each([false, undefined])(
  'keeps the original worker alive across body rejection %s until genuine port release',
  async (cause) => {
    const script = originalBackgroundRevocationScript(nonce, 'https://owned.test');
    let rejectBody!: (value: unknown) => void;
    const body = new Promise<ArrayBuffer>((_yes, no) => {
      rejectBody = no;
    });
    void body.catch(() => {});
    const fetch = vi.fn(async (url: string) => {
      if (url === script.urls.gate) return { status: 200, arrayBuffer: () => body };
      throw cause;
    });
    type Port = {
      onmessage?: (event: { data: { nonce: string; kind: string } }) => void;
      postMessage(value: unknown): void;
      start(): void;
      close(): void;
    };
    const messages: unknown[] = [];
    const port: Port = {
      postMessage: (value) => {
        messages.push(value);
      },
      start: vi.fn(),
      close: vi.fn(),
    };
    type Event = {
      data: { nonce: string; kind: string };
      ports: Port[];
      waitUntil(job: Promise<void>): void;
    };
    const listeners = new Map<string, (event: Event) => void>();
    const jobs: Promise<void>[] = [];
    runInNewContext(script.source, {
      fetch,
      self: {
        addEventListener(name: string, callback: (event: Event) => void) {
          listeners.set(name, callback);
        },
      },
    });
    listeners.get('message')!({
      data: { nonce, kind: 'begin' },
      ports: [port],
      waitUntil(job) {
        jobs.push(job);
        void job.catch(() => {});
      },
    });
    try {
      await vi.waitFor(() =>
        expect(messages).toContainEqual({ nonce, phase: 'held', status: 200 })
      );
      expect(fetch).toHaveBeenCalledOnce();
      rejectBody(cause);
      await vi.waitFor(() =>
        expect(messages).toContainEqual({ nonce, phase: 'gate-returned', outcome: 'rejected' })
      );
      expect(fetch).toHaveBeenCalledOnce();
      port.onmessage!({ data: { nonce: 'foreign', kind: 'release' } });
      expect(fetch).toHaveBeenCalledOnce();
      port.onmessage!({ data: { nonce, kind: 'release' } });
      await jobs[0];
      expect(fetch.mock.calls.map(([url]) => url)).toEqual([script.urls.gate, script.urls.after]);
      expect(messages).toContainEqual({
        nonce,
        phase: 'result',
        gate: 'rejected',
        afterRelease: 'rejected',
      });
      expect(port.close).toHaveBeenCalledOnce();
    } finally {
      rejectBody(cause);
      port.onmessage?.({ data: { nonce, kind: 'release' } });
      await Promise.allSettled(jobs);
    }
  }
);
it('requires actual rejected body and post-release request without converting unrelated outcomes', () => {
  expect(
    readOriginalBackgroundRevocation({ nonce, gate: 'rejected', afterRelease: 'rejected' }, nonce)
  ).toEqual({ nonce, gate: 'rejected', afterRelease: 'rejected' });
  for (const gate of ['fulfilled', 'rejected'])
    for (const afterRelease of ['fulfilled', 'rejected']) {
      if (gate === 'rejected' && afterRelease === 'rejected') continue;
      expect(() => readOriginalBackgroundRevocation({ nonce, gate, afterRelease }, nonce)).toThrow(
        'BACKGROUND_REVOCATION_NOT_OBSERVED'
      );
    }
  expect(() =>
    readOriginalBackgroundRevocation(
      { nonce, gate: 'rejected', afterRelease: 'rejected', fabricated: true },
      nonce
    )
  ).toThrow();
  expect(() => originalBackgroundRevocationScript(nonce, 'http://owned.test')).toThrow(
    'BACKGROUND_REVOCATION_OWNED_ORIGIN_REQUIRED'
  );
});
