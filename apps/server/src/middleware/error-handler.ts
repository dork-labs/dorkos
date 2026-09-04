import type { Request, Response, NextFunction } from 'express';
import { runtimeDisplayName } from '@dorkos/shared/agent-runtime';
import { logger } from '../lib/logger.js';
import { RuntimeNotRegisteredError } from '../services/core/runtime-registry.js';

/** Global Express error handler that logs the error and returns a JSON response. */
export function errorHandler(err: Error, _req: Request, res: Response, next: NextFunction): void {
  // If the response is already streaming/flushed (e.g. the durable session SSE
  // stream), the headers are sent and we can't write a JSON error body. Express 5
  // auto-forwards async rejections here, so a post-flush rejection would otherwise
  // throw ERR_HTTP_HEADERS_SENT — delegate to Express's default handler, which
  // closes the socket. (Matches the inline guards in routes/uploads.ts, routes/mcp.ts.)
  if (res.headersSent) {
    next(err);
    return;
  }

  logger.error('[DorkOS Error]', err.message, err.stack);

  // A runtime registration mismatch is a configuration error, not a 500. A
  // session persisted as runtime X on a server that no longer has X registered
  // is deployment drift; surface it with a stable error code so the client can
  // render a targeted message instead of a generic failure toast.
  //
  // The relay's own version of this no longer arrives here. It is answered where
  // it happens — the built-in adapter refuses the delivery by name and reports
  // it on the adapter status (DOR-1614) — because it belongs to a bus message,
  // not to an HTTP request there is a response to write.
  //
  // **The words say what a room's `runtime_gone` notice says** (DOR-1720). This
  // is the same state reached from the other surface — a conversation pinned to
  // a program that is not running — and the two used to describe it in different
  // languages: one named a runtime slug and stopped there, the other apologised
  // for a broken agent. Naming the program the way a person sees it elsewhere
  // (`runtimeDisplayName`) and stating the recovery is what makes them one
  // answer. `runtime` still rides the body as the raw type, for a client that
  // wants to route on it rather than print it.
  if (err instanceof RuntimeNotRegisteredError) {
    const program = runtimeDisplayName(err.runtime);
    res.status(503).json({
      error: `This session runs on ${program}, which isn't running on this machine. Turn ${program} back on to pick it up, or start a new session to use what's running now.`,
      code: 'RUNTIME_NOT_AVAILABLE',
      runtime: err.runtime,
    });
    return;
  }

  // A body that never fit is not a server fault, and answering 500 to it is a
  // small lie with a real cost: a person saving a large file in a room was told
  // "Internal server error" by `express.json`'s own 1 MB limit, so the message
  // said nothing about the one thing they could act on (DOR-1600's review).
  //
  // Deliberately narrow. `body-parser` raises several kinds of failure and this
  // honours exactly one of them — the size limit, which it marks
  // `entity.too.large` and which is unambiguous. Everything else it raises keeps
  // the 500 it has always had, because widening this to "any 4xx with expose"
  // would quietly restate every route's answer to a malformed body, which is a
  // change nobody has argued for here.
  if ((err as { type?: unknown }).type === 'entity.too.large') {
    res.status(413).json({
      error: 'That is too large to send in one request.',
      code: 'REQUEST_TOO_LARGE',
    });
    return;
  }

  // eslint-disable-next-line no-restricted-syntax -- must read dynamically; env.ts parses once at import and tests mutate NODE_ENV at runtime
  const isDev = process.env.NODE_ENV !== 'production';
  res.status(500).json({
    error: isDev ? err.message || 'Internal Server Error' : 'Internal Server Error',
    code: 'INTERNAL_ERROR',
  });
}
