import { vi } from 'vitest';

/** One request a page made: where, how, and with what. */
export type Call = { url: string; method: string; body: unknown };
/** A canned answer for one route. */
export type Reply = { status: number; body?: unknown };
type Handler = Reply | ((call: Call) => Reply);

/**
 * Replace `fetch` with a router keyed by `METHOD path`. Every request is recorded, and one no
 * route expects fails the test's assertions with a `599` rather than reaching the network.
 */
export function mockFetch(routes: Record<string, Handler>): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init: RequestInit = {}) => {
      const url = String(input);
      const method = init.method ?? 'GET';
      const body = typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
      const call = { url, method, body };
      calls.push(call);
      const path = new URL(url, 'http://localhost').pathname;
      const handler = routes[`${method} ${path}`];
      const reply = typeof handler === 'function' ? handler(call) : (handler ?? { status: 599 });
      return {
        ok: reply.status >= 200 && reply.status < 300,
        status: reply.status,
        json: async () => reply.body ?? null,
      } as Response;
    })
  );
  return calls;
}

/** A refusal body as the server sends it. */
export function refusal(status: number, code: string, message: string): Reply {
  return { status, body: { code, message } };
}

/**
 * Put a token where the page's inline bootstrap leaves it: in page memory, behind a reader and
 * a clearer, and nowhere in the address.
 */
export function captureFragment(token: string): void {
  let secret: string | null = token;
  window.__readDorkosOwnerReplacementFragment = () => secret;
  window.__clearDorkosOwnerReplacementFragment = () => {
    secret = null;
    delete window.__readDorkosOwnerReplacementFragment;
    delete window.__clearDorkosOwnerReplacementFragment;
  };
}

/** Every console line written during a test, to prove a secret never reached one. */
export function spyConsole(): () => string {
  const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) =>
    vi.spyOn(console, level).mockImplementation(() => {})
  );
  return () =>
    spies
      .flatMap((spy) => spy.mock.calls)
      .map((args) => args.map(String).join(' '))
      .join('\n');
}
