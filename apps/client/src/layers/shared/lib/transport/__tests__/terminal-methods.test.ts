import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createTerminalMethods } from '../terminal-methods';

/**
 * Terminal-methods REST-path tests (DOR-225, DOR-226). Every case resolves
 * before any WebSocket is opened, so only `fetch` is stubbed:
 *
 * - `closeTerminal` DELETEs the PTY by id — the explicit-teardown surface a
 *   tab's × button drives (idempotent server-side);
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

describe('createTerminalMethods().closeTerminal', () => {
  it('DELETEs the terminal by id (explicit teardown, DOR-226)', async () => {
    const fetchMock = vi.fn(
      async (_url: unknown, _init?: RequestInit) => new Response(null, { status: 204 })
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const methods = createTerminalMethods('/api');
    await methods.closeTerminal('pty-9');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/terminal/pty-9');
    expect(fetchMock.mock.calls[0][1]?.method).toBe('DELETE');
  });

  it('resolves cleanly on an already-gone id (the route is idempotent)', async () => {
    globalThis.fetch = vi.fn(
      async () => new Response(null, { status: 204 })
    ) as unknown as typeof fetch;

    const methods = createTerminalMethods('/api');
    await expect(methods.closeTerminal('unknown')).resolves.toBeUndefined();
  });
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
