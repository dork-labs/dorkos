import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createTerminalMethods } from '../terminal-methods';

/**
 * openTerminal create-path tests (DOR-225). Both cases resolve before any
 * WebSocket is opened, so only `fetch` is stubbed:
 *
 * - the abort signal is forwarded to the create POST, so an unmount racing the
 *   create cancels the request and no orphan PTY is ever spawned;
 * - a failed create carries the server's machine-readable `code` (e.g.
 *   `TERMINAL_LIMIT`) on the thrown error for friendlier client copy.
 */

const originalFetch = globalThis.fetch;

beforeEach(() => vi.restoreAllMocks());
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('createTerminalMethods().openTerminal', () => {
  it('forwards the abort signal to the create POST (no orphan PTY on unmount race)', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      // Mirror real fetch: an aborted signal rejects instead of hitting the server.
      if (init?.signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
      throw new Error('should not reach the server');
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const methods = createTerminalMethods('/api');
    await expect(methods.openTerminal('/repo', controller.signal)).rejects.toThrow();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1]?.signal).toBe(controller.signal);
  });

  it('attaches the server error code to a failed create (TERMINAL_LIMIT → friendly copy upstream)', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: 'Terminal limit reached (24 live terminals)',
            code: 'TERMINAL_LIMIT',
          }),
          { status: 429, headers: { 'Content-Type': 'application/json' } }
        )
    ) as unknown as typeof fetch;

    const methods = createTerminalMethods('/api');
    const failure = await methods.openTerminal('/repo').catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe('Terminal limit reached (24 live terminals)');
    expect((failure as Error & { code?: string }).code).toBe('TERMINAL_LIMIT');
  });
});
