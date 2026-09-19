/**
 * A scripted stand-in for {@link CdpPipe}, so the agent-browser flows can be
 * tested without launching Chrome. Each CDP method answers from a handler;
 * every call is recorded.
 */
import type { CdpPipe, ChromeExit } from '../cdp-pipe.js';

/** One recorded CDP command. */
export interface FakeCdpCall {
  method: string;
  params: Record<string, unknown>;
  sessionId?: string;
}

/** A fake pipe plus the calls it saw and a way to make "Chrome" quit. */
export interface FakeCdp extends CdpPipe {
  calls: FakeCdpCall[];
  exit(): void;
}

/**
 * Build a fake pipe.
 *
 * @param handlers - Result per method; a missing method answers `{}`.
 */
export function createFakeCdp(
  handlers: Record<string, (params: Record<string, unknown>, sessionId?: string) => unknown> = {}
): FakeCdp {
  const calls: FakeCdpCall[] = [];
  let resolveExit!: (exit: ChromeExit) => void;
  let exited = false;
  const exitedPromise = new Promise<ChromeExit>((resolve) => {
    resolveExit = resolve;
  });
  const exit = () => {
    if (exited) return;
    exited = true;
    resolveExit({ code: 0, signal: null });
  };
  return {
    pid: 4242,
    calls,
    exited: exitedPromise,
    hasExited: () => exited,
    exit,
    async send<T>(method: string, params: Record<string, unknown> = {}, sessionId?: string) {
      calls.push({ method, params, ...(sessionId ? { sessionId } : {}) });
      const handler = handlers[method];
      return (handler ? await handler(params, sessionId) : {}) as T;
    },
    onEvent: () => () => {},
    async close() {
      calls.push({ method: 'Browser.close', params: {} });
      exit();
      return exitedPromise;
    },
  };
}
