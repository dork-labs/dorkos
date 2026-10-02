/** Private document event endpoints, behind the app's host, origin and session gates. */
import { json, Router, type Request, type Response, type RequestHandler } from 'express';
import {
  CanvasChannelEventIdSchema,
  CanvasChannelReplayQuerySchema,
} from '@dorkos/shared/canvas-channel-schemas';
import type { DocChannelActor } from '../services/canvas/doc-channel/authorization.js';
import type { DocChannelService } from '../services/canvas/doc-channel/service.js';
import { logger } from '../lib/logger.js';
import type {
  DocChannelMetrics,
  DocChannelHttpOutcome,
  DocChannelRejectionClass,
} from '../services/observability/doc-channel-metrics.js';
function observeResult(
  req: Request,
  res: Response,
  operation: 'ingest' | 'replay' | 'receipt',
  outcome: DocChannelHttpOutcome
): void {
  const metrics = (req.app.locals.docChannelHttp as DocChannelHttp | undefined)?.metrics;
  res.once('finish', () => {
    try {
      metrics?.recordHttpResult(operation, outcome);
    } catch {
      /* A completed response cannot be changed or retried by observability. */
    }
  });
}
function refusalClass(status: number): DocChannelRejectionClass {
  if (status === 400) return 'invalid';
  if (status === 413) return 'too_large';
  if ([401, 403, 404].includes(status)) return 'authority';
  if (status === 409) return 'conflict';
  if (status === 422) return 'manifest';
  if (status === 429) return 'rate_backlog';
  if (status === 507) return 'storage';
  if (status === 503) return 'unavailable';
  return 'other';
}

/** The composition root resolves authenticated callers; page envelopes carry no authority. */
export interface DocChannelHttp {
  service: DocChannelService;
  metrics?: DocChannelMetrics;
  actor(req: Pick<Request, 'headers'>, res: Pick<Response, 'locals'>): DocChannelActor;
}
const router = Router();
const parseEnvelope = json({ limit: '16kb' });
/** Bound raw wire data before the app-wide parser and give malformed envelopes a safe 400. */
export const canvasDocJsonParser: RequestHandler = (req, res, next) => {
  parseEnvelope(req, res, (error?: unknown) => {
    if (!error) {
      next();
      return;
    }
    const tooLarge = (error as { type?: unknown }).type === 'entity.too.large';
    if (req.method === 'POST' && /^\/[^/]+\/events\/?$/i.test(req.path))
      observeResult(req, res, 'ingest', {
        kind: 'refused',
        reason: tooLarge ? 'too_large' : 'invalid',
      });
    res.status(tooLarge ? 413 : 400).json({
      error: tooLarge ? 'The document event is too large.' : 'The document event is not valid.',
      code: tooLarge ? 'DOC_EVENT_TOO_LARGE' : 'INVALID_DOC_EVENT',
    });
  });
};
function dependencies(req: Request): DocChannelHttp {
  const deps = req.app.locals.docChannelHttp as DocChannelHttp | undefined;
  if (!deps) throw Object.assign(new Error(), { code: 'DOC_CHANNEL_UNAVAILABLE', status: 503 });
  return deps;
}
function documentId(req: Request): string {
  const id = req.params.id;
  if (typeof id !== 'string' || id.length === 0 || id.length > 200)
    throw Object.assign(new Error(), { code: 'INVALID_DOC_QUERY', status: 400 });
  return id;
}
/** Translate typed refusals without echoing private paths, payloads or authority evidence. */
function failure(
  req: Request,
  res: Response,
  error: unknown,
  operation: 'ingest' | 'replay' | 'receipt'
): void {
  const refusal = error as { code?: unknown; status?: unknown; retryAfterSeconds?: unknown };
  const knownStatus =
    refusal?.code === 'AGENT_IDENTITY_UNVERIFIED'
      ? 401
      : refusal?.code === 'INVALID_APP_MANIFEST'
        ? 422
        : 500;
  const status =
    typeof refusal?.status === 'number' && refusal.status >= 400 && refusal.status <= 599
      ? refusal.status
      : knownStatus;
  const code = typeof refusal?.code === 'string' ? refusal.code : 'DOC_CHANNEL_FAILED';
  const messages: Record<number, string> = {
    400: 'The document event or query is not valid.',
    401: 'Sign in or use a valid agent token.',
    403: 'You cannot use this document.',
    404: 'The document is not available.',
    409: 'The document changed. Refresh it before trying again.',
    413: 'The document event is too large.',
    422: 'The app does not accept this event.',
    429: 'The document has too many pending events. Try again later.',
    503: 'Document events are not available yet.',
    507: 'The document event could not be saved.',
  };
  if (status === 429 && typeof refusal.retryAfterSeconds === 'number')
    res.set('Retry-After', String(refusal.retryAfterSeconds));
  observeResult(req, res, operation, { kind: 'refused', reason: refusalClass(status) });
  if (status === 500) logger.error('[canvas-doc-events] request failed', error);
  res
    .status(status)
    .json({ error: messages[status] ?? 'The document request could not be completed.', code });
}
router.post('/:id/events', async (req, res) => {
  try {
    const deps = dependencies(req);
    const receipt = await deps.service.ingestEvent(documentId(req), req.body, deps.actor(req, res));
    observeResult(req, res, 'ingest', { kind: 'success' });
    res.status(receipt.receipt.status === 'duplicate' ? 200 : 201).json(receipt);
  } catch (error) {
    failure(req, res, error, 'ingest');
  }
});
router.get('/:id/channel', async (req, res) => {
  try {
    const deps = dependencies(req);
    const raw = req.query;
    const numeric: Record<string, unknown> = { ...raw };
    for (const key of ['since', 'limit'])
      if (key in raw) {
        const value = raw[key];
        numeric[key] = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
      }
    const query = CanvasChannelReplayQuerySchema.safeParse(numeric);
    if (!query.success)
      throw Object.assign(new Error(), { code: 'INVALID_DOC_QUERY', status: 400 });
    const snapshot = await deps.service.replay(
      documentId(req),
      deps.actor(req, res),
      query.data.since,
      query.data.limit
    );
    observeResult(req, res, 'replay', {
      kind: snapshot.resetRequired ? 'retention_reset' : 'success',
    });
    res.json(snapshot);
  } catch (error) {
    failure(req, res, error, 'replay');
  }
});
router.get('/:id/events/:eventId', async (req, res) => {
  try {
    const deps = dependencies(req);
    const id = CanvasChannelEventIdSchema.safeParse(req.params.eventId);
    if (!id.success)
      throw Object.assign(new Error(), { code: 'INVALID_DOC_EVENT_ID', status: 400 });
    const receipt = await deps.service.receipt(documentId(req), id.data, deps.actor(req, res));
    observeResult(req, res, 'receipt', { kind: 'success' });
    res.json(receipt);
  } catch (error) {
    failure(req, res, error, 'receipt');
  }
});
export default router;
