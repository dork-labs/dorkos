/** Standalone bearer DATA on the native Hono listener, before ordinary cookie/session admission. */
import bodyParser from 'body-parser';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { Hono, type Context } from 'hono';
import type { ApiEnv } from '../http/api-chain.js';
import { parseRequestBody, readJsonBody } from '../http/request-body.js';
import { streamToNodeResponse } from '../http/raw-node-stream.js';
import { refuseStandaloneDocTokenHost } from '../middleware/host-guard.js';
import type { createDocChannelHttpComposition } from '../services/canvas/doc-channel/http-composition.js';
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
type Source = () => ReturnType<typeof createDocChannelHttpComposition> | undefined;
const parse = JSON.parse,
  stringify = JSON.stringify;
const surface = /^\/api\/canvas\/token\/docs\/[^/]+\/(?:channel|stream|events\/[^/]+)\/?$/u;
const ingressSurface = /^\/api\/canvas\/token\/docs\/[^/]+\/events\/?$/u;
/** Only fixed bearer leaf reads own credential-free CORS. */
export function isStandaloneDocTokenReadSurface(req: { path: string; method: string }): boolean {
  return (req.method === 'GET' || req.method === 'OPTIONS') && surface.test(req.path);
}
/** Fixed read/ingress methods terminate before the ordinary chain; other requests fall through. */
export function isStandaloneDocTokenSurface(req: { path: string; method: string }): boolean {
  return (
    isStandaloneDocTokenReadSurface(req) ||
    ((req.method === 'POST' || req.method === 'OPTIONS') && ingressSurface.test(req.path))
  );
}
function refusal(c: Context<ApiEnv>, status: 400 | 401 = 401): Response {
  return c.json(
    {
      code: status === 400 ? 'INVALID_DOC_TOKEN_QUERY' : 'DOC_TOKEN_UNAVAILABLE',
      error:
        status === 400
          ? 'The document token query is not valid.'
          : 'The document token is not available.',
    },
    status
  );
}
function sendRefusal(res: ServerResponse): void {
  res.statusCode = 401;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(
    JSON.stringify({ code: 'DOC_TOKEN_UNAVAILABLE', error: 'The document token is not available.' })
  );
}
function readService(source: Source): DocChannelService {
  const service = source()?.service;
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
function bearerHash(req: IncomingMessage): string {
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
function query(c: Context<ApiEnv>, allowed: readonly string[]): void {
  for (const name of Object.keys(c.req.queries()))
    if (!allowed.includes(name)) throw new Error('Invalid query');
}
/** Duplicate query values remain invalid, as the original parser's arrays were. */
function queryValue(c: Context<ApiEnv>, name: string): unknown {
  const values = c.req.queries(name);
  return values?.length === 1 ? values[0] : values?.length ? values : undefined;
}
function cors(c: Context<ApiEnv>): void {
  c.header('Access-Control-Allow-Credentials', undefined);
  c.header('Access-Control-Allow-Origin', '*');
  c.header('Cache-Control', 'no-store');
  c.header('X-Content-Type-Options', 'nosniff');
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
async function bind(c: Context<ApiEnv>, source: Source, permission: 'replay' | 'stream') {
  const hash = bearerHash(c.env.incoming),
    service = readService(source),
    id = boundedId(c.req.param('id'));
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
async function writeFrame(res: ServerResponse, wire: string): Promise<void> {
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
function corsRaw(res: ServerResponse): void {
  res.removeHeader('Access-Control-Allow-Credentials');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
}
const originalIngressRequests = new WeakMap<
  IncomingMessage,
  { service: DocChannelService; scope: OriginalNativeDocTokenScope; id: string }
>();
const ingressParser = parseRequestBody<ApiEnv>([
  {
    matches: () => true,
    parse: bodyParser.json({ limit: '16kb' }),
    answerFailure: (error) => ({
      status: (error as { type?: unknown })?.type === 'entity.too.large' ? 413 : 400,
      body: { code: 'INVALID_DOC_TOKEN_EVENT', error: 'The document event is not valid.' },
    }),
  },
]);
/** Mount at the construction-owned early frontier; service/token engines enforce original private scopes. */
export function createStandaloneDocTokenRoutes(source: Source): Hono<ApiEnv> {
  const router = new Hono<ApiEnv>({ strict: false });
  router.use('*', async (c, next) => {
    if (isStandaloneDocTokenSurface({ path: c.req.path, method: c.req.method })) {
      const refused = refuseStandaloneDocTokenHost(c.env.incoming.headers.host);
      if (refused) return c.json(refused, 403);
    }
    await next();
  });
  for (const path of ['/:id/channel', '/:id/stream', '/:id/events/:eventId', '/:id/events']) {
    router.options(path, (c) => {
      const headers = c.env.incoming.headers;
      const method = headers['access-control-request-method'];
      const requested = headers['access-control-request-headers'];
      const expected = ingressSurface.test(c.req.path) ? 'POST' : 'GET';
      if (
        method !== expected ||
        headers.cookie !== undefined ||
        headers.authorization !== undefined ||
        (requested !== undefined &&
          (typeof requested !== 'string' ||
            requested
              .split(',')
              .some((h) => !['authorization', 'content-type'].includes(h.trim().toLowerCase()))))
      )
        return refusal(c, 400);
      cors(c);
      c.header('Access-Control-Allow-Methods', expected);
      c.header('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      return c.body(null, 204);
    });
  }
  router.get('/:id/channel', async (c, next) => {
    if (c.req.method !== 'GET') return next();
    try {
      query(c, ['since', 'limit']);
      const own = await bind(c, source, 'replay');
      const since = cursor(queryValue(c, 'since'), 0),
        limit = cursor(queryValue(c, 'limit'), 200);
      if (limit < 1 || limit > 200) return refusal(c, 400);
      const page = projectPage(await currentPage(own, since, limit, 'replay'));
      cors(c);
      return c.json(page);
    } catch {
      return refusal(c);
    }
  });
  router.get('/:id/events/:eventId', async (c, next) => {
    if (c.req.method !== 'GET') return next();
    try {
      query(c, []);
      const own = await bind(c, source, 'replay'),
        id = boundedId(c.req.param('eventId'));
      const raw = await readServiceOriginalTokenEvent(own.service, own.scope, id, 'replay');
      if (!raw) {
        cors(c);
        return c.json(
          { code: 'DOC_TOKEN_EVENT_UNCONFIRMED', error: 'The document event is unconfirmed.' },
          409
        );
      }
      const data = projectEvent(raw);
      cors(c);
      return c.json(data);
    } catch {
      return refusal(c);
    }
  });
  router.get('/:id/stream', async (c, next) => {
    if (c.req.method !== 'GET') return next();
    const req = c.env.incoming;
    return streamToNodeResponse(c, async (res) => {
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
        query(c, ['since']);
        const since = cursor(queryValue(c, 'since'), 0);
        owned = await bind(c, source, 'stream');
        stream = await openServiceOriginalTokenStream(owned.service, owned.scope, since);
        if (closed || res.destroyed) {
          close();
          return;
        }
        void closedServiceOriginalTokenStream(owned.service, stream).then(() => {
          if (!res.destroyed) res.destroy();
        });
        corsRaw(res);
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
        if (!res.headersSent) sendRefusal(res);
        else res.end();
      } finally {
        close();
        res.off('close', close);
        req.off('aborted', close);
        if (!res.writableEnded && !res.destroyed) res.end();
      }
    });
  });
  router.post(
    '/:id/events',
    async (c, next) => {
      const req = c.env.incoming;
      try {
        query(c, []);
        const service = readService(source),
          id = boundedId(c.req.param('id')),
          hash = bearerHash(req);
        const scope = await restoreServiceOriginalTokenScope(service, hash);
        const admitted = await admitServiceOriginalTokenIngress(service, scope);
        if (admitted.documentId !== id) throw new Error('Wrong document');
        originalIngressRequests.set(req, { service, scope, id });
      } catch {
        return refusal(c);
      }
      try {
        await next();
      } finally {
        originalIngressRequests.delete(req);
      }
    },
    ingressParser,
    async (c) => {
      try {
        const own = originalIngressRequests.get(c.env.incoming);
        if (!own) throw new Error('Unavailable');
        const result = await submitServiceOriginalTokenIngress(
          own.service,
          own.scope,
          readJsonBody(c)
        );
        const current = await admitServiceOriginalTokenIngress(own.service, own.scope);
        if (current.documentId !== own.id) throw new Error('Wrong document');
        cors(c);
        return c.json(result, result.receipt.status === 'duplicate' ? 200 : 201);
      } catch {
        return refusal(c);
      }
    }
  );
  return router;
}
/** Original names retained as native constructor factories, with an explicit owning source. */
export const standaloneDocTokenRouter = createStandaloneDocTokenRoutes;
export const standaloneDocTokenReadRouter = createStandaloneDocTokenRoutes;
