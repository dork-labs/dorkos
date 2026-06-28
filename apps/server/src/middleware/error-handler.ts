import type { Request, Response, NextFunction } from 'express';
import { logger } from '../lib/logger.js';
import { RuntimeNotRegisteredError } from '../services/core/runtime-registry.js';
import { AdapterNotRegisteredError } from '../services/relay/adapter-manager.js';

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

  // Runtime / adapter registration mismatches are configuration errors, not
  // 500s. A session persisted as runtime X on a server that no longer has X
  // registered (or an adapter-manager without the adapter for X) is a
  // deployment drift, surface it with a stable error code so the client can
  // render a targeted message instead of a generic failure toast.
  if (err instanceof RuntimeNotRegisteredError || err instanceof AdapterNotRegisteredError) {
    const runtime = err instanceof RuntimeNotRegisteredError ? err.runtime : err.runtimeType;
    res.status(503).json({
      error: `Session's runtime is not available on this server (runtime: ${runtime})`,
      code: 'RUNTIME_NOT_AVAILABLE',
      runtime,
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
