// @vitest-environment jsdom
/**
 * `runCommandIntent` — the one transport call that reaches the network through a
 * raw `fetch` rather than `fetchJSON`, because it reads the 409 body itself.
 *
 * That exemption cost it `fetchJSON`'s timeout, so it was the only call that
 * could hang forever. It matters more than the usual "requests should time out"
 * argument: the composer latches its submit paths on this promise (DOR-479) so
 * one `/compact` cannot fire twice, and a promise that never settles turns that
 * latch into a composer nobody can send from — in every session, since the latch
 * is not session-scoped.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createSessionMethods } from '../session-methods';

function setup() {
  return createSessionMethods('http://localhost:4242/api', () => 'client-1', new Map(), new Map());
}

/** The `RequestInit` the last `fetch` call was made with. */
function lastInit(): RequestInit {
  return vi.mocked(globalThis.fetch).mock.calls.at(-1)![1] as RequestInit;
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      status: 202,
      json: () => Promise.resolve({ sessionId: 's1' }),
    })
  );
});

describe('runCommandIntent', () => {
  it('bounds the request with an abort signal', async () => {
    await setup().runCommandIntent('s1', 'compact');
    expect(lastInit().signal).toBeInstanceOf(AbortSignal);
  });

  // Pinned as the value, not by waiting 30 seconds: `AbortSignal.timeout` runs on
  // a platform timer that fake timers do not control.
  it('bounds it at the same 30s every other transport call gets', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    await setup().runCommandIntent('s1', 'compact');
    expect(timeout).toHaveBeenCalledWith(30_000);
  });

  it('surfaces the abort as a rejection instead of hanging', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.reject(
          Object.assign(new Error('The operation was aborted'), { name: 'TimeoutError' })
        )
      )
    );
    // The caller (`dispatchCompactIntent`) turns this into a toast and a `false`,
    // which is what releases the composer's in-flight latch.
    await expect(setup().runCommandIntent('s1', 'compact')).rejects.toThrow(/aborted/);
  });

  it('still carries the client id and the trailing instructions', async () => {
    await setup().runCommandIntent('s1', 'compact', 'focus on the API changes');
    const init = lastInit();
    expect((init.headers as Record<string, string>)['X-Client-Id']).toBe('client-1');
    expect(JSON.parse(init.body as string)).toEqual({ instructions: 'focus on the API changes' });
  });

  it('sends no body when there are no instructions (Express 5 empty-POST contract)', async () => {
    await setup().runCommandIntent('s1', 'compact');
    expect(lastInit().body).toBeUndefined();
  });
});
