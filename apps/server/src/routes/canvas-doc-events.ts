import { createFileSaveRecoveryRoutes } from './file-saves/recovery.js';
import { createCanvasDocRouteControlRoutes } from './canvas-doc-route-controls.js';
import type { DocRouteControls } from '../services/canvas/doc-channel/route-controls/controls.js';
import type { InstallationFileWrites } from '../services/canvas/doc-channel/writes/installation-file-writes.js';
/** Private document event endpoints, behind the app's host, origin and session gates. */
import type { ServerResponse } from 'node:http';
import bodyParser from 'body-parser';
import { Hono, type Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import {
  CanvasChannelEventIdSchema,
  CanvasChannelReplayQuerySchema,
} from '@dorkos/shared/canvas-channel-schemas';
import type { ApiEnv } from '../http/api-chain.js';
import { readJsonBody, underMount, type BodyRule } from '../http/request-body.js';
import { readQuery } from '../http/request-query.js';
import { honoRequestFacts, type RequestFacts } from '../http/request-facts.js';
import type { DocChannelActor } from '../services/canvas/doc-channel/authorization.js';
import type { DocChannelService } from '../services/canvas/doc-channel/service.js';
import { logger } from '../lib/logger.js';
import type {
  DocChannelMetrics,
  DocChannelHttpOutcome,
  DocChannelRejectionClass,
} from '../services/observability/doc-channel-metrics.js';

/** Where the routes read the document channel from, at request time. */
export type DocChannelHttpSource = () => DocChannelHttp | undefined;

/** Record one answer's outcome once it has gone out. */
function observeResult(
  res: ServerResponse,
  metrics: DocChannelMetrics | undefined,
  operation: 'ingest' | 'replay' | 'receipt',
  outcome: DocChannelHttpOutcome
): void {
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
  fileWrites?: InstallationFileWrites;
  service: DocChannelService;
  metrics?: DocChannelMetrics;
  /** A person's route controls (`routes/canvas-doc-route-controls.ts`). */
  routeControls?: DocRouteControls;
  actor(caller: Pick<RequestFacts, 'headers' | 'agentIdentity' | 'user'>): DocChannelActor;
}

/** The ingest path, `/api/canvas/docs/:id/events`. */
const INGEST_PATH = /^\/api\/canvas\/docs\/[^/]+\/events\/?$/i;

/**
 * The body rule for every path under `/api/canvas/docs`: page envelopes have a
 * smaller wire ceiling than ordinary API requests, and a malformed one gets
 * this group's own 400 rather than the chain's.
 *
 * @param metrics - The document metrics, read when a body is refused.
 */
export function canvasDocBodyRule(metrics: () => DocChannelMetrics | undefined): BodyRule {
  return {
    matches: (_method, path) => underMount(path, '/api/canvas/docs'),
    parse: bodyParser.json({ limit: '16kb' }),
    answerFailure: (error, { method, path, outgoing }) => {
      const tooLarge = (error as { type?: unknown }).type === 'entity.too.large';
      if (method === 'POST' && INGEST_PATH.test(path)) {
        observeResult(outgoing, metrics(), 'ingest', {
          kind: 'refused',
          reason: tooLarge ? 'too_large' : 'invalid',
        });
      }
      return {
        status: tooLarge ? 413 : 400,
        body: {
          error: tooLarge ? 'The document event is too large.' : 'The document event is not valid.',
          code: tooLarge ? 'DOC_EVENT_TOO_LARGE' : 'INVALID_DOC_EVENT',
        },
      };
    },
  };
}

function documentId(c: Context<ApiEnv>): string {
  const id = c.req.param('id');
  if (typeof id !== 'string' || id.length === 0 || id.length > 200)
    throw Object.assign(new Error(), { code: 'INVALID_DOC_QUERY', status: 400 });
  return id;
}

/**
 * Build the document event routes.
 *
 * @param source - The document channel, read per request; `undefined` answers 503.
 */
export function createCanvasDocEventRoutes(source: DocChannelHttpSource): Hono<ApiEnv> {
  const router = new Hono<ApiEnv>();

  function dependencies(): DocChannelHttp {
    const deps = source();
    if (!deps) throw Object.assign(new Error(), { code: 'DOC_CHANNEL_UNAVAILABLE', status: 503 });
    return deps;
  }

  /** Translate typed refusals without echoing private paths, payloads or authority evidence. */
  function failure(
    c: Context<ApiEnv>,
    error: unknown,
    operation: 'ingest' | 'replay' | 'receipt'
  ): Response {
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
      c.header('Retry-After', String(refusal.retryAfterSeconds));
    observeResult(c.env.outgoing, source()?.metrics, operation, {
      kind: 'refused',
      reason: refusalClass(status),
    });
    if (status === 500) logger.error('[canvas-doc-events] request failed', error);
    return c.json(
      { error: messages[status] ?? 'The document request could not be completed.', code },
      status as ContentfulStatusCode
    );
  }

  router.post('/:id/events', async (c) => {
    try {
      const deps = dependencies();
      const receipt = await deps.service.ingestEvent(
        documentId(c),
        readJsonBody(c),
        deps.actor(honoRequestFacts(c))
      );
      observeResult(c.env.outgoing, deps.metrics, 'ingest', { kind: 'success' });
      return c.json(receipt, receipt.receipt.status === 'duplicate' ? 200 : 201);
    } catch (error) {
      return failure(c, error, 'ingest');
    }
  });
  router.get('/:id/channel', async (c) => {
    try {
      const deps = dependencies();
      const raw = readQuery(c);
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
        documentId(c),
        deps.actor(honoRequestFacts(c)),
        query.data.since,
        query.data.limit
      );
      observeResult(c.env.outgoing, deps.metrics, 'replay', {
        kind: snapshot.resetRequired ? 'retention_reset' : 'success',
      });
      return c.json(snapshot);
    } catch (error) {
      return failure(c, error, 'replay');
    }
  });
  router.get('/:id/events/:eventId', async (c) => {
    try {
      const deps = dependencies();
      const id = CanvasChannelEventIdSchema.safeParse(c.req.param('eventId'));
      if (!id.success)
        throw Object.assign(new Error(), { code: 'INVALID_DOC_EVENT_ID', status: 400 });
      const receipt = await deps.service.receipt(
        documentId(c),
        id.data,
        deps.actor(honoRequestFacts(c))
      );
      observeResult(c.env.outgoing, deps.metrics, 'receipt', { kind: 'success' });
      return c.json(receipt);
    } catch (error) {
      return failure(c, error, 'receipt');
    }
  });
  // Claim every path under `/api/canvas/docs`, served or not, so a request to
  // one no route serves still gets this group's body limit before its `/api`
  // 404, as it always had.
  router.route(
    '/',
    createFileSaveRecoveryRoutes(() => source()?.fileWrites)
  );
  router.route('/', createCanvasDocRouteControlRoutes(source));
  router.all('*', (c) => c.notFound());
  return router;
}
