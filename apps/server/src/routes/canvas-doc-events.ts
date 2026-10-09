import { CanvasChannelPresenceRequestSchema } from '@dorkos/shared/canvas-channel-schemas';
import { updateServiceOriginalDocPresence } from '../services/canvas/doc-channel/service.js';
/** Private document event endpoints, behind the app's host, origin and session gates. */
import { z } from 'zod';
import { json, Router, type Request, type Response, type RequestHandler } from 'express';
import {
  CanvasChannelSelectionRequestSchema,
  CanvasChannelTokenRequestSchema,
  CanvasChannelCheckboxRequestSchema,
  CanvasChannelEventIdSchema,
  CanvasChannelReplayQuerySchema,
} from '@dorkos/shared/canvas-channel-schemas';
import type { DocChannelActor } from '../services/canvas/doc-channel/authorization.js';
import {
  askServiceOriginalDocSelection,
  readServiceOriginalDocManagement,
  issueServiceOriginalDocToken,
  revokeServiceOriginalDocToken,
  submitCurrentDocEvent,
  inspectServiceCurrentDocReceipt,
  replayServiceCurrentDoc,
  type DocChannelService,
} from '../services/canvas/doc-channel/service.js';
import { logger } from '../lib/logger.js';
import {
  toggleOriginalCheckboxWriter,
  type DocCheckboxWriteService,
} from '../services/canvas/doc-channel/writes/checkbox-service.js';
import { isCheckboxAuthorityRefusal } from '../services/canvas/doc-channel/writes/authority-policy.js';
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
  /** The genuine installation child; absence keeps the native write endpoint unavailable. */
  checkboxWriter?: DocCheckboxWriteService;
  metrics?: DocChannelMetrics;
  actor(req: Pick<Request, 'headers'>, res: Pick<Response, 'locals'>): DocChannelActor;
}
const router: Router = Router();
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
function originalGeneration(req: Request): { readonly expectedGeneration: string } {
  const value = req.headers['x-dorkos-doc-generation'];
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value))
    throw Object.assign(new Error(), { code: 'INVALID_DOC_GENERATION', status: 409 });
  return Object.freeze({ expectedGeneration: value });
}
/** Native FILE writes share the ordinary Host/origin/session gates and bounded parser above. */
/** Verified original editor selection stays behind the SAME ordinary Host/origin/session/body gates. */
router.post('/:id/editor/selection', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const deps = dependencies(req),
      id = documentId(req);
    const request = CanvasChannelSelectionRequestSchema.parse(req.body);
    if (
      request.documentId !== id ||
      Object.keys(req.query).length ||
      (typeof req.headers.authorization === 'string' &&
        /^Bearer dct_/iu.test(req.headers.authorization))
    )
      throw Object.assign(new Error(), { status: 403, code: 'EDITOR_SELECTION_UNAVAILABLE' });
    const actor = deps.actor(req, res);
    if (actor.principal.claims.kind !== 'operator')
      throw Object.assign(new Error(), { status: 403, code: 'EDITOR_SELECTION_UNAVAILABLE' });
    res.json(await askServiceOriginalDocSelection(deps.service, request, actor));
  } catch (error) {
    failure(req, res, error, 'ingest');
  }
});
router.post('/:id/checkbox', async (req, res) => {
  try {
    const deps = dependencies(req),
      id = documentId(req);
    const parsed = CanvasChannelCheckboxRequestSchema.safeParse(req.body);
    if (!parsed.success || parsed.data.documentId !== id) {
      res
        .status(400)
        .json({ error: 'The checkbox request is not valid.', code: 'INVALID_CHECKBOX_REQUEST' });
      return;
    }
    if (!deps.checkboxWriter) {
      res
        .status(503)
        .json({ error: 'Checkbox writes are not available.', code: 'CHECKBOX_UNAVAILABLE' });
      return;
    }
    const actor = deps.actor(req, res);
    const receipt = await toggleOriginalCheckboxWriter(deps.checkboxWriter, parsed.data, actor);
    // Conflict/review are verified write outcomes, not successful channel ingestion.
    // Return their strict receipt so the client offers the appropriate explicit action.
    res.json(receipt);
  } catch (error) {
    if (isCheckboxAuthorityRefusal(error)) {
      res
        .status(403)
        .json({ error: 'You cannot change this document.', code: 'CHECKBOX_ACCESS_LOST' });
      return;
    }
    failure(req, res, error, 'ingest');
  }
});
router.post('/:id/events', async (req, res) => {
  try {
    const deps = dependencies(req);
    const condition = originalGeneration(req);
    const receipt = await submitCurrentDocEvent(
      deps.service,
      documentId(req),
      req.body,
      deps.actor(req, res),
      condition
    );
    observeResult(req, res, 'ingest', { kind: 'success' });
    res.status(receipt.receipt.status === 'duplicate' ? 200 : 201).json(receipt);
  } catch (error) {
    failure(req, res, error, 'ingest');
  }
});
router.post('/:id/presence', async (req, res) => {
  try {
    const deps = dependencies(req);
    const actor = deps.actor(req, res);
    const request = CanvasChannelPresenceRequestSchema.safeParse(req.body);
    if (!request.success)
      throw Object.assign(new Error(), { code: 'INVALID_DOC_PRESENCE', status: 400 });
    res.json(
      await updateServiceOriginalDocPresence(deps.service, documentId(req), actor, request.data)
    );
  } catch (error) {
    failure(req, res, error, 'replay');
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
    const snapshot = await replayServiceCurrentDoc(
      deps.service,
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
    const inspected = await inspectServiceCurrentDocReceipt(
      deps.service,
      documentId(req),
      id.data,
      deps.actor(req, res),
      originalGeneration(req)
    );
    // The actual fixed inspector owns original birth/access/floor classification.
    // Never use a legacy public getter as proof of original absence.
    if (inspected.kind !== 'receipt') {
      observeResult(req, res, 'receipt', { kind: 'refused', reason: 'conflict' });
      res.status(409).json({
        code: 'DOC_RECEIPT_UNCONFIRMED',
        error: 'The original document receipt is unconfirmed.',
      });
      return;
    }
    const receipt = inspected.event;
    observeResult(req, res, 'receipt', { kind: 'success' });
    res.json(receipt);
  } catch (error) {
    failure(req, res, error, 'receipt');
  }
});
/** Operator revocation stays behind ordinary Host/origin/session gates, never bearer CORS. */
/** Operator management shares the same original document Host/session/actor gates. */
router.get('/:id/management', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (
      Object.keys(req.query).length ||
      (typeof req.headers.authorization === 'string' &&
        /^Bearer dct_/iu.test(req.headers.authorization))
    )
      throw new Error('Invalid management credential or query.');
    const deps = dependencies(req);
    res.json(
      await readServiceOriginalDocManagement(deps.service, documentId(req), deps.actor(req, res))
    );
  } catch {
    res
      .status(403)
      .json({ code: 'DOC_MANAGEMENT_UNAVAILABLE', error: 'Document controls are not available.' });
  }
});
const tokenIssueInput = z
  .object({
    request: CanvasChannelTokenRequestSchema,
    approvedGrantIds: z
      .array(z.string().min(1).max(200))
      .max(1024)
      .refine((ids) => new Set(ids).size === ids.length),
  })
  .strict();
/** Issue once through the original authenticated operator and native issuance transaction. */
router.post('/:id/tokens', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const credential = req.headers.authorization;
    if (typeof credential === 'string' && /^Bearer dct_/iu.test(credential))
      throw new Error('Document bearer cannot authorize operator issuance.');
    const parsed = tokenIssueInput.safeParse(req.body);
    const id = documentId(req);
    if (
      Object.keys(req.query).length !== 0 ||
      !parsed.success ||
      parsed.data.request.documentId !== id
    ) {
      res.status(400).json({
        code: 'INVALID_DOC_TOKEN_ISSUANCE',
        error: 'The document token scope is not valid.',
      });
      return;
    }
    const deps = dependencies(req);
    const response = await issueServiceOriginalDocToken(
      deps.service,
      deps.actor(req, res),
      parsed.data.request,
      parsed.data.approvedGrantIds
    );
    res.status(201).json(response);
  } catch {
    // Never expose credentials, native rows, paths or the private failure to the response/log.
    res.status(403).json({
      code: 'DOC_TOKEN_ISSUANCE_UNAVAILABLE',
      error: 'The document token cannot be issued.',
    });
  }
});
router.post('/:id/tokens/:tokenId/revoke', async (req, res) => {
  try {
    const credential = req.headers.authorization;
    // An installation permitting anonymous operators must still never promote a document bearer.
    if (typeof credential === 'string' && /^Bearer dct_/iu.test(credential))
      throw new Error('Document bearer cannot authorize operator revocation.');
    if (
      Object.keys(req.query).length !== 0 ||
      (req.body !== undefined &&
        (!req.body ||
          typeof req.body !== 'object' ||
          Array.isArray(req.body) ||
          Object.keys(req.body).length !== 0))
    ) {
      res.status(400).json({
        code: 'INVALID_DOC_TOKEN_REVOCATION',
        error: 'The document token revocation is not valid.',
      });
      return;
    }
    const tokenId = req.params.tokenId;
    if (typeof tokenId !== 'string' || !tokenId || tokenId.length > 200)
      throw new Error('Invalid token identifier.');
    const deps = dependencies(req);
    const result = await revokeServiceOriginalDocToken(
      deps.service,
      deps.actor(req, res),
      documentId(req),
      tokenId
    );
    res.setHeader('Cache-Control', 'no-store');
    res.json(result);
  } catch {
    // No token existence, native row, credential, path or private raw failure is disclosed.
    res.status(403).json({
      code: 'DOC_TOKEN_REVOCATION_UNAVAILABLE',
      error: 'The document token cannot be revoked.',
    });
  }
});
export default router;
