/** Restricted standalone bearer DATA reads; original actor routes remain separate. SOURCE draft. */
import { json, Router, type Request, type Response, type RequestHandler } from 'express';
import { createHash } from 'node:crypto';
import {
  admitServiceOriginalTokenIngress,
  submitServiceOriginalTokenIngress,
  closedServiceOriginalTokenStream,
  openServiceOriginalTokenStream,
  nextServiceOriginalTokenStream,
  closeServiceOriginalTokenStream,
  replayServiceOriginalTokenScope,
  restoreServiceOriginalTokenScope,
  readServiceOriginalTokenEvent,
  type DocChannelService,
} from '../services/canvas/doc-channel/service.js';
import type {
  OriginalNativeDocTokenScope,
  OriginalNativeDocTokenPage,
} from '../services/canvas/doc-channel/current/current-operation-types.js';
import type { OriginalDocTokenNativeRow } from '../services/canvas/doc-channel/tokens/token-native-facts.js';
const parse = JSON.parse,
  stringify = JSON.stringify;
const surface = /^\/api\/canvas\/token\/docs\/[^/]+\/(?:channel|stream|events\/[^/]+)\/?$/u;
/** Only these leaf read endpoints are exempt from ordinary cookie/browser CORS. */
export function isStandaloneDocTokenReadSurface(req: Pick<Request, 'path' | 'method'>): boolean {
  return (req.method === 'GET' || req.method === 'OPTIONS') && surface.test(req.path);
}
const ingressSurface = /^\/api\/canvas\/token\/docs\/[^/]+\/events\/?$/u;
/** Identify the standalone bearer read or ingress HTTP surface. */
export function isStandaloneDocTokenSurface(req: Pick<Request, 'path' | 'method'>): boolean {
  return (
    isStandaloneDocTokenReadSurface(req) ||
    ((req.method === 'POST' || req.method === 'OPTIONS') && ingressSurface.test(req.path))
  );
}
function refusal(res: Response, status = 401): void {
  res.status(status).json({
    code: status === 400 ? 'INVALID_DOC_TOKEN_QUERY' : 'DOC_TOKEN_UNAVAILABLE',
    error:
      status === 400
        ? 'The document token query is not valid.'
        : 'The document token is not available.',
  });
}
function readService(req: Request): DocChannelService {
  const service = (req.app.locals.docChannelHttp as { service?: DocChannelService } | undefined)
    ?.service;
  if (!service) throw new Error('Unavailable');
  return service;
}
function boundedId(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 200)
    throw new Error('Invalid identifier');
  return value;
}
function cursor(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^\d{1,16}$/u.test(value)) throw new Error('Invalid cursor');
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error('Invalid cursor');
  return n;
}
function bearerHash(req: Request): string {
  // No session/operator fallback, even when the installation normally permits anonymous local use.
  if (
    req.headers.cookie !== undefined ||
    req.headers['x-dorkos-agent'] !== undefined ||
    req.headers['x-api-key'] !== undefined
  )
    throw new Error('Mixed credential');
  const credential = req.headers.authorization;
  if (typeof credential !== 'string' || !/^Bearer dct_[A-Za-z0-9_-]{43}$/u.test(credential))
    throw new Error('Invalid bearer');
  return createHash('sha256').update(credential.slice(7)).digest('hex');
}
function query(req: Request, allowed: readonly string[]): void {
  for (const name of Object.keys(req.query))
    if (!allowed.includes(name)) throw new Error('Invalid query');
}
function cors(res: Response): void {
  res.removeHeader('Access-Control-Allow-Credentials');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
}
function projectEvent(row: OriginalDocTokenNativeRow) {
  if (
    typeof row.event_id !== 'string' ||
    typeof row.doc_seq !== 'number' ||
    typeof row.type !== 'string' ||
    typeof row.direction !== 'string' ||
    typeof row.received_at !== 'string'
  )
    throw new Error('Invalid native event DATA');
  // A bounded NULL payload without a real pruning marker must not masquerade as a pruned event.
  if (row.payload === null && row.payload_pruned_at === null)
    throw new Error('Unavailable payload DATA');
  const payload =
    typeof row.payload === 'string' ? Reflect.apply(parse, JSON, [row.payload]) : null;
  return {
    id: row.event_id,
    docSeq: row.doc_seq,
    type: row.type,
    direction: row.direction,
    receivedAt: row.received_at,
    payloadPrunedAt: row.payload_pruned_at,
    payload,
  };
}
function projectPage(page: OriginalNativeDocTokenPage) {
  return {
    documentId: page.documentId,
    generation: page.generation,
    highWatermark: page.highWatermark,
    retentionFloor: page.retentionFloor,
    receiptRetentionFloor: page.receiptRetentionFloor,
    resetRequired: page.resetRequired,
    events: page.rows.map(projectEvent),
  };
}
async function bind(req: Request, permission: 'replay' | 'stream') {
  const hash = bearerHash(req),
    service = readService(req),
    id = boundedId(req.params.id);
  const scope = await restoreServiceOriginalTokenScope(service, hash);
  const page = await replayServiceOriginalTokenScope(service, scope, 0, 1, permission);
  if (page.documentId !== id) throw new Error('Wrong document');
  return { service, scope, id };
}
async function currentPage(
  own: { service: DocChannelService; scope: OriginalNativeDocTokenScope; id: string },
  since: number,
  limit: number,
  permission: 'replay' | 'stream'
) {
  const page = await replayServiceOriginalTokenScope(
    own.service,
    own.scope,
    since,
    limit,
    permission
  );
  if (page.documentId !== own.id) throw new Error('Wrong document');
  return page;
}
/** Both reset and event frames wait on the exact owned response, including stop-triggered close. */
async function writeFrame(res: Response, wire: string): Promise<void> {
  if (res.destroyed || res.writableEnded) return;
  if (!res.write(wire))
    await new Promise<void>((resolve) => {
      const done = () => {
        res.off('drain', done);
        res.off('close', done);
        resolve();
      };
      res.once('drain', done);
      res.once('close', done);
      if (res.destroyed) done();
    });
}
const router = Router();
router.options(
  ['/:id/channel', '/:id/stream', '/:id/events/:eventId', '/:id/events'],
  (req, res) => {
    // Browsers omit the bearer on preflight. This negotiates only headers/method, never authenticates data.
    const method = req.headers['access-control-request-method'];
    const headers = req.headers['access-control-request-headers'];
    const expected = /^\/[^/]+\/events\/?$/u.test(req.path) ? 'POST' : 'GET';
    if (
      method !== expected ||
      req.headers.cookie !== undefined ||
      req.headers.authorization !== undefined ||
      (headers !== undefined &&
        (typeof headers !== 'string' ||
          headers
            .split(',')
            .some((h) => !['authorization', 'content-type'].includes(h.trim().toLowerCase()))))
    )
      return refusal(res, 400);
    cors(res);
    res.setHeader('Access-Control-Allow-Methods', expected);
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.status(204).end();
  }
);
router.get('/:id/channel', async (req, res) => {
  try {
    query(req, ['since', 'limit']);
    const own = await bind(req, 'replay');
    const since = cursor(req.query.since, 0),
      limit = cursor(req.query.limit, 200);
    if (limit < 1 || limit > 200) return refusal(res, 400);
    const page = projectPage(await currentPage(own, since, limit, 'replay'));
    cors(res);
    res.json(page);
  } catch {
    refusal(res);
  }
});
router.get('/:id/events/:eventId', async (req, res) => {
  try {
    query(req, []);
    const own = await bind(req, 'replay'),
      id = boundedId(req.params.eventId);
    const raw = await readServiceOriginalTokenEvent(own.service, own.scope, id, 'replay');
    // Filtered/missing/pruned receipt authority is deliberately unconfirmed, never generic document absence.
    if (!raw) {
      cors(res);
      res
        .status(409)
        .json({ code: 'DOC_TOKEN_EVENT_UNCONFIRMED', error: 'The document event is unconfirmed.' });
      return;
    }
    const data = projectEvent(raw);
    cors(res);
    res.json(data);
  } catch {
    refusal(res);
  }
});
router.get('/:id/stream', async (req, res) => {
  let owned: Awaited<ReturnType<typeof bind>> | undefined,
    stream: Awaited<ReturnType<typeof openServiceOriginalTokenStream>> | undefined;
  let closed = false;
  const close = () => {
    closed = true;
    if (owned && stream) closeServiceOriginalTokenStream(owned.service, stream);
  };
  res.once('close', close);
  req.once('aborted', close);
  try {
    query(req, ['since']);
    const since = cursor(req.query.since, 0);
    owned = await bind(req, 'stream');
    stream = await openServiceOriginalTokenStream(owned.service, owned.scope, since);
    if (closed || res.destroyed) {
      close();
      return;
    }
    void closedServiceOriginalTokenStream(owned.service, stream).then(() => {
      if (!res.destroyed) res.destroy();
    });
    cors(res);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    while (!closed && !res.destroyed) {
      const page = await nextServiceOriginalTokenStream(owned.service, stream);
      if (page === undefined) break;
      if (page.documentId !== owned.id) throw new Error('Wrong document');
      if (page.resetRequired) {
        await currentPage(owned, page.retentionFloor - 1, 1, 'stream');
        if (closed || res.destroyed) break;
        // Reset DATA has no unfiltered state, viewer or routing snapshot.
        await writeFrame(
          res,
          'event: reset\ndata: ' +
            Reflect.apply(stringify, JSON, [
              {
                documentId: page.documentId,
                retentionFloor: page.retentionFloor,
                highWatermark: page.highWatermark,
              },
            ]) +
            '\n\n'
        );
      }
      for (const raw of page.rows) {
        if (closed || res.destroyed) break;
        // Fresh native expiry/revoke/source/permission checks for EACH actual frame, after all waits.
        const current = await readServiceOriginalTokenEvent(
          owned.service,
          owned.scope,
          String(raw.event_id),
          'stream'
        );
        if (!current) throw new Error('Unconfirmed frame');
        const data = projectEvent(current);
        const wire =
          'id: ' +
          String(data.docSeq) +
          '\nevent: doc.event\ndata: ' +
          Reflect.apply(stringify, JSON, [data]) +
          '\n\n';
        await writeFrame(res, wire);
      }
    }
  } catch {
    // No credential or private native failure is echoed or logged.
    if (!res.headersSent) refusal(res);
    else res.end();
  } finally {
    close();
    res.off('close', close);
    req.off('aborted', close);
    if (!res.writableEnded && !res.destroyed) res.end();
  }
});
const originalIngressRequests = new WeakMap<
  Request,
  { service: DocChannelService; scope: OriginalNativeDocTokenScope; id: string }
>();
const parseIngress = json({ limit: '16kb' });
router.post(
  '/:id/events',
  async (req, res, next) => {
    try {
      query(req, []);
      const service = readService(req),
        id = boundedId(req.params.id),
        hash = bearerHash(req);
      const scope = await restoreServiceOriginalTokenScope(service, hash);
      const admitted = await admitServiceOriginalTokenIngress(service, scope);
      if (admitted.documentId !== id) throw new Error('Wrong document');
      originalIngressRequests.set(req, { service, scope, id });
      next();
    } catch {
      refusal(res);
    }
  },
  (req, res, next) => {
    parseIngress(req, res, (error?: unknown) => {
      if (error) {
        originalIngressRequests.delete(req);
        const status = (error as { type?: unknown })?.type === 'entity.too.large' ? 413 : 400;
        res
          .status(status)
          .json({ code: 'INVALID_DOC_TOKEN_EVENT', error: 'The document event is not valid.' });
        return;
      }
      next();
    });
  },
  async (req, res) => {
    try {
      const own = originalIngressRequests.get(req);
      if (!own) throw new Error('Unavailable');
      // The original engine repeats full native currentness and closed type/direction/payload/grant gates.
      const result = await submitServiceOriginalTokenIngress(own.service, own.scope, req.body);
      const current = await admitServiceOriginalTokenIngress(own.service, own.scope);
      if (current.documentId !== own.id) throw new Error('Wrong document');
      cors(res);
      res.status(result.receipt.status === 'duplicate' ? 200 : 201).json(result);
    } catch {
      refusal(res);
    } finally {
      originalIngressRequests.delete(req);
    }
  }
);

export const standaloneDocTokenRouter: RequestHandler = router;
export const standaloneDocTokenReadRouter: RequestHandler = router;
