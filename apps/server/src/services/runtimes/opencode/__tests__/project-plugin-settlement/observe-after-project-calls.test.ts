/** @vitest-environment node */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { observeAfterProjectCalls } from './observe-after-project-calls.js';

/** A request whose settlement is controlled independently of the observer. */
function deferred() {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const endpoints = ['createSession', 'mcpStatus', 'getConfig', 'listProviders'] as const;

/** Cross a task boundary so all runnable promise continuations have run. */
const checkpoint = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('the live plugin row settlement seam', () => {
  let root: string | undefined;
  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
    root = undefined;
    vi.useRealTimers();
  });

  function fixture(delayed: number, writesMarker = false) {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-plugin-settlement-'));
    const marker = path.join(root, 'owned-marker');
    const gate = deferred();
    const started: string[] = [];
    const finished: string[] = [];
    const request = (index: number) => async () => {
      started.push(endpoints[index]!);
      if (index === delayed) {
        await gate.promise;
        if (writesMarker) fs.writeFileSync(marker, 'imported');
      }
      finished.push(endpoints[index]!);
    };
    const observe = vi.fn(() => expect(fs.existsSync(marker)).toBe(false));
    const run = observeAfterProjectCalls(
      {
        createSession: request(0),
        mcpStatus: request(1),
        getConfig: request(2),
        listProviders: request(3),
      },
      observe
    );
    // Attach a handler immediately, including when a deliberately broken seam
    // observes early. The tests still assert the actual fulfillment/rejection.
    const outcome = run.then(
      () => ({ status: 'fulfilled' as const }),
      (reason: unknown) => ({ status: 'rejected' as const, reason })
    );
    return { marker, gate, started, finished, observe, outcome };
  }

  it.each([0, 3])('does not observe while request %i is pending', async (delayed) => {
    const f = fixture(delayed);
    try {
      await checkpoint();
      await vi.advanceTimersByTimeAsync(66_000);
      expect(f.observe).not.toHaveBeenCalled();
      expect(f.started).toEqual(endpoints.slice(0, delayed + 1));
      expect(f.finished).toEqual(endpoints.slice(0, delayed));
    } finally {
      f.gate.resolve();
      await f.outcome;
      await checkpoint();
    }
    expect(await f.outcome).toEqual({ status: 'fulfilled' });
    expect(f.started).toEqual(endpoints);
    expect(f.finished).toEqual(endpoints);
    expect(f.observe).toHaveBeenCalledTimes(1);
  });

  it.each([0, 3])(
    'a marker written by delayed request %i fails the absence assertion',
    async (delayed) => {
      const f = fixture(delayed, true);
      await checkpoint();
      await vi.advanceTimersByTimeAsync(66_000);
      f.gate.resolve();
      const outcome = await f.outcome;
      await checkpoint();
      expect(outcome.status).toBe('rejected');
      if (outcome.status === 'rejected') expect(outcome.reason).toBeInstanceOf(Error);
      expect(fs.readFileSync(f.marker, 'utf8')).toBe('imported');
      expect(f.started).toEqual(endpoints);
      expect(f.finished).toEqual(endpoints);
      expect(f.observe).toHaveBeenCalledTimes(1);
    }
  );

  it.each([0, 1, 2, 3])('a rejected request %i cannot become an absence pass', async (delayed) => {
    const f = fixture(delayed);
    await checkpoint();
    // Even rejection with undefined must fail, rather than acting as a sentinel
    // meaning that no error occurred.
    f.gate.reject(undefined);
    expect(await f.outcome).toEqual({ status: 'rejected', reason: undefined });
    expect(f.started).toEqual(endpoints.slice(0, delayed + 1));
    expect(f.finished).toEqual(endpoints.slice(0, delayed));
    expect(f.observe).not.toHaveBeenCalled();
  });

  it('a synchronous setup failure cannot reach the observer', async () => {
    const observe = vi.fn();
    const later = vi.fn(async () => undefined);
    const error = new Error('setup failed');
    await expect(
      observeAfterProjectCalls(
        {
          createSession: () => {
            throw error;
          },
          mcpStatus: later,
          getConfig: later,
          listProviders: later,
        },
        observe
      )
    ).rejects.toBe(error);
    expect(later).not.toHaveBeenCalled();
    expect(observe).not.toHaveBeenCalled();
  });
});
