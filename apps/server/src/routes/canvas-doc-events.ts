/** Private document event endpoints, behind the app's host, origin and session gates. */
import type { ServerResponse } from 'node:http';
import bodyParser from 'body-parser';
import { Hono, type Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import {
  CanvasChannelSelectionRequestSchema,
  CanvasChannelTokenRequestSchema,
  CanvasChannelCheckboxRequestSchema,
  CanvasChannelPresenceRequestSchema,
  CanvasChannelEventIdSchema,
  CanvasChannelReplayQuerySchema,
} from '@dorkos/shared/canvas-channel-schemas';
import type { ApiEnv } from '../http/api-chain.js';
import { readJsonBody, underMount, type BodyRule } from '../http/request-body.js';
import { readQuery } from '../http/request-query.js';
import { honoRequestFacts, type RequestFacts } from '../http/request-facts.js';
import type { DocChannelActor } from '../services/canvas/doc-channel/authorization.js';
import {
  askServiceOriginalDocSelection,
  readServiceOriginalDocManagement,
  issueServiceOriginalDocToken,
  revokeServiceOriginalDocToken,
  submitCurrentDocEvent,
  inspectServiceCurrentDocReceipt,
  replayServiceCurrentDoc,
  updateServiceOriginalDocPresence,
  type DocChannelService,
} from '../services/canvas/doc-channel/service.js';
import { z } from 'zod';
import type { Request, Response as ExpressResponse } from 'express';
import {
  toggleOriginalCheckboxWriter,
  type DocCheckboxWriteService,
} from '../services/canvas/doc-channel/writes/checkbox-service.js';
import { isCheckboxAuthorityRefusal } from '../services/canvas/doc-channel/writes/authority/authority-policy.js';
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
  service: DocChannelService;
  /** Exact installation-owned native checkbox writer. */
  checkboxWriter?: DocCheckboxWriteService;
  metrics?: DocChannelMetrics;
  actor(
    caller: Pick<RequestFacts, 'headers' | 'agentIdentity' | 'user'> | Pick<Request, 'headers'>,
    res?: Pick<ExpressResponse, 'locals'>
  ): DocChannelActor;
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

  function reply<T>(c: Context<ApiEnv>, status: number, value: T): Response {
    return c.json(value, status as ContentfulStatusCode);
  }

  function originalGeneration(c: Context<ApiEnv>): { readonly expectedGeneration: string } {
    const value = c.env.incoming.headers['x-dorkos-doc-generation'];
    if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value))
      throw Object.assign(new Error(), { code: 'INVALID_DOC_GENERATION', status: 409 });
    return Object.freeze({ expectedGeneration: value });
  }
  /** Native FILE writes share the ordinary Host/origin/session gates and bounded parser above. */
  /** Verified original editor selection stays behind the SAME ordinary Host/origin/session/body gates. */
  router.post('/:id/editor/selection', async (c) => {
    c.header('Cache-Control', 'no-store');
    try {
      const deps = dependencies(),
        id = documentId(c);
      const request = CanvasChannelSelectionRequestSchema.parse(readJsonBody(c));
      if (
        request.documentId !== id ||
        Object.keys(readQuery(c)).length ||
        (typeof c.env.incoming.headers.authorization === 'string' &&
          /^Bearer dct_/iu.test(c.env.incoming.headers.authorization))
      )
        throw Object.assign(new Error(), { status: 403, code: 'EDITOR_SELECTION_UNAVAILABLE' });
      const actor = deps.actor(honoRequestFacts(c));
      if (actor.principal.claims.kind !== 'operator')
        throw Object.assign(new Error(), { status: 403, code: 'EDITOR_SELECTION_UNAVAILABLE' });
      return c.json(await askServiceOriginalDocSelection(deps.service, request, actor));
    } catch (error) {
      return failure(c, error, 'ingest');
    }
  });
  router.post('/:id/checkbox', async (c) => {
    try {
      const deps = dependencies(),
        id = documentId(c);
      const parsed = CanvasChannelCheckboxRequestSchema.safeParse(readJsonBody(c));
      if (!parsed.success || parsed.data.documentId !== id) {
        return reply(c, 400, {
          error: 'The checkbox request is not valid.',
          code: 'INVALID_CHECKBOX_REQUEST',
        });
      }
      if (!deps.checkboxWriter) {
        return reply(c, 503, {
          error: 'Checkbox writes are not available.',
          code: 'CHECKBOX_UNAVAILABLE',
        });
      }
      const actor = deps.actor(honoRequestFacts(c));
      const receipt = await toggleOriginalCheckboxWriter(deps.checkboxWriter, parsed.data, actor);
      // Conflict/review are verified write outcomes, not successful channel ingestion.
      // Return their strict receipt so the client offers the appropriate explicit action.
      return c.json(receipt);
    } catch (error) {
      if (isCheckboxAuthorityRefusal(error)) {
        return reply(c, 403, {
          error: 'You cannot change this document.',
          code: 'CHECKBOX_ACCESS_LOST',
        });
      }
      return failure(c, error, 'ingest');
    }
  });
  router.post('/:id/events', async (c) => {
    try {
      const deps = dependencies();
      const condition = originalGeneration(c);
      const receipt = await submitCurrentDocEvent(
        deps.service,
        documentId(c),
        readJsonBody(c),
        deps.actor(honoRequestFacts(c)),
        condition
      );
      observeResult(c.env.outgoing, source()?.metrics, 'ingest', { kind: 'success' });
      return reply(c, receipt.receipt.status === 'duplicate' ? 200 : 201, receipt);
    } catch (error) {
      return failure(c, error, 'ingest');
    }
  });
  router.post('/:id/presence', async (c) => {
    try {
      const deps = dependencies();
      const actor = deps.actor(honoRequestFacts(c));
      const request = CanvasChannelPresenceRequestSchema.safeParse(readJsonBody(c));
      if (!request.success)
        throw Object.assign(new Error(), { code: 'INVALID_DOC_PRESENCE', status: 400 });
      return c.json(
        await updateServiceOriginalDocPresence(deps.service, documentId(c), actor, request.data)
      );
    } catch (error) {
      return failure(c, error, 'replay');
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
      const snapshot = await replayServiceCurrentDoc(
        deps.service,
        documentId(c),
        deps.actor(honoRequestFacts(c)),
        query.data.since,
        query.data.limit
      );
      observeResult(c.env.outgoing, source()?.metrics, 'replay', {
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
      const inspected = await inspectServiceCurrentDocReceipt(
        deps.service,
        documentId(c),
        id.data,
        deps.actor(honoRequestFacts(c)),
        originalGeneration(c)
      );
      // The actual fixed inspector owns original birth/access/floor classification.
      // Never use a legacy public getter as proof of original absence.
      if (inspected.kind !== 'receipt') {
        observeResult(c.env.outgoing, source()?.metrics, 'receipt', {
          kind: 'refused',
          reason: 'conflict',
        });
        return reply(c, 409, {
          code: 'DOC_RECEIPT_UNCONFIRMED',
          error: 'The original document receipt is unconfirmed.',
        });
      }
      const receipt = inspected.event;
      observeResult(c.env.outgoing, source()?.metrics, 'receipt', { kind: 'success' });
      return c.json(receipt);
    } catch (error) {
      return failure(c, error, 'receipt');
    }
  });
  /** Operator revocation stays behind ordinary Host/origin/session gates, never bearer CORS. */
  /** Operator management shares the same original document Host/session/actor gates. */
  router.get('/:id/management', async (c) => {
    c.header('Cache-Control', 'no-store');
    try {
      if (
        Object.keys(readQuery(c)).length ||
        (typeof c.env.incoming.headers.authorization === 'string' &&
          /^Bearer dct_/iu.test(c.env.incoming.headers.authorization))
      )
        throw new Error('Invalid management credential or query.');
      const deps = dependencies();
      return c.json(
        await readServiceOriginalDocManagement(
          deps.service,
          documentId(c),
          deps.actor(honoRequestFacts(c))
        )
      );
    } catch {
      return reply(c, 403, {
        code: 'DOC_MANAGEMENT_UNAVAILABLE',
        error: 'Document controls are not available.',
      });
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
  router.post('/:id/tokens', async (c) => {
    c.header('Cache-Control', 'no-store');
    try {
      const credential = c.env.incoming.headers.authorization;
      if (typeof credential === 'string' && /^Bearer dct_/iu.test(credential))
        throw new Error('Document bearer cannot authorize operator issuance.');
      const parsed = tokenIssueInput.safeParse(readJsonBody(c));
      const id = documentId(c);
      if (
        Object.keys(readQuery(c)).length !== 0 ||
        !parsed.success ||
        parsed.data.request.documentId !== id
      ) {
        return reply(c, 400, {
          code: 'INVALID_DOC_TOKEN_ISSUANCE',
          error: 'The document token scope is not valid.',
        });
      }
      const deps = dependencies();
      const response = await issueServiceOriginalDocToken(
        deps.service,
        deps.actor(honoRequestFacts(c)),
        parsed.data.request,
        parsed.data.approvedGrantIds
      );
      return reply(c, 201, response);
    } catch {
      // Never expose credentials, native rows, paths or the private failure to the response/log.
      return reply(c, 403, {
        code: 'DOC_TOKEN_ISSUANCE_UNAVAILABLE',
        error: 'The document token cannot be issued.',
      });
    }
  });
  router.post('/:id/tokens/:tokenId/revoke', async (c) => {
    try {
      const credential = c.env.incoming.headers.authorization;
      // An installation permitting anonymous operators must still never promote a document bearer.
      if (typeof credential === 'string' && /^Bearer dct_/iu.test(credential))
        throw new Error('Document bearer cannot authorize operator revocation.');
      const body = readJsonBody(c);
      if (
        Object.keys(readQuery(c)).length !== 0 ||
        (body !== undefined &&
          (!body ||
            typeof body !== 'object' ||
            Array.isArray(body) ||
            Object.keys(body).length !== 0))
      ) {
        return reply(c, 400, {
          code: 'INVALID_DOC_TOKEN_REVOCATION',
          error: 'The document token revocation is not valid.',
        });
      }
      const tokenId = c.req.param('tokenId');
      if (typeof tokenId !== 'string' || !tokenId || tokenId.length > 200)
        throw new Error('Invalid token identifier.');
      const deps = dependencies();
      const result = await revokeServiceOriginalDocToken(
        deps.service,
        deps.actor(honoRequestFacts(c)),
        documentId(c),
        tokenId
      );
      c.header('Cache-Control', 'no-store');
      return c.json(result);
    } catch {
      // No token existence, native row, credential, path or private raw failure is disclosed.
      return reply(c, 403, {
        code: 'DOC_TOKEN_REVOCATION_UNAVAILABLE',
        error: 'The document token cannot be revoked.',
      });
    }
  });
  router.all('*', (c) => c.notFound());
  return router;
}
