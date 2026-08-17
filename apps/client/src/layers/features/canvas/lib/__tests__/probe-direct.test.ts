import { describe, it, expect, vi } from 'vitest';
import { probeDirect } from '../probe-direct';

/**
 * The question this answers is "can the BROWSER reach it", which is a different
 * question from the one the server's port probe answers — and on a port-forwarded
 * cockpit (Docker `-p`, `ssh -L`) the two have different answers.
 */
describe('probeDirect', () => {
  it('says reachable when something answers, even opaquely', async () => {
    // A cross-origin no-cors request resolves with an OPAQUE response: status 0,
    // no headers, no body. Nothing here reads it, which is the point — resolving
    // at all is the answer. (A real opaque response cannot be constructed in a
    // test; `Response` rejects status 0. Nothing in the code path notices.)
    const fetchImpl = vi.fn(async () => new Response());
    await expect(probeDirect('http://localhost:5173/', fetchImpl)).resolves.toBe(true);

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://localhost:5173/');
    expect(init.mode).toBe('no-cors');
    // Never let a cached answer stand in for a server that has since stopped.
    expect(init.cache).toBe('no-store');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('says unreachable when the connection is refused', async () => {
    // A refused connection is what `fetch` rejects with, opaque request or not.
    // This is the forwarded-port case (`docker -p`, `ssh -L`), and it is fast —
    // measured at ~62 ms, nowhere near the deadline below.
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    await expect(probeDirect('http://localhost:5173/', fetchImpl)).resolves.toBe(false);
  });

  it('says REACHABLE when the target is slow — thinking is not the same as missing', async () => {
    // A Next.js first request, a Vite mid-pre-bundle, a dev server that just
    // restarted: alive, and capable of taking longer than the deadline to send a
    // header. Calling those unreachable demotes a working dev server to the
    // proxy path, whose shell fires `load` — so the user gets a blank frame and
    // no banner, which is the failure this whole change exists to remove.
    //
    // A blackholed port (forwarded, nothing behind it, so it hangs rather than
    // refusing) also lands here and gets framed. That is the deliberate trade:
    // rarer than a slow compile, and the frame's own 10-second load deadline
    // tells the truth about it moments later.
    const fetchImpl = vi.fn(
      (_url: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        })
    );
    await expect(probeDirect('http://localhost:5173/', fetchImpl, 20)).resolves.toBe(true);
  });

  it('never throws, and a failure that is not our deadline is unreachable', async () => {
    const fetchImpl = vi.fn(() => {
      throw new Error('synchronous explosion');
    });
    await expect(probeDirect('http://localhost:5173/', fetchImpl)).resolves.toBe(false);
  });
});
