/**
 * `/api/documents/comments`: comments on docs (DOR-2983).
 *
 * - `GET /?cwd&path`: every thread on a doc.
 * - `GET /mentionable`: everybody a comment can `@`-mention.
 * - `POST /threads`: open a thread on some words, with its first comment.
 * - `POST /threads/:threadId/replies`: add a comment.
 * - `PATCH /threads/:threadId`: mark a thread done, or reopen it.
 * - `PATCH /threads/:threadId/comments/:commentId`: change your own comment.
 * - `PUT /anchors`: save the anchors the editor moved.
 *
 * Who is writing is the request's own caller (`resolveCaller`, the rooms'
 * rule), never a field in the body. A doc is `{ cwd, path }`, checked against
 * the same directory boundary as the files routes. A write answers with the
 * thread and with any mentioned agent that was not woken, so the app can say
 * so.
 *
 * The whole group answers 404 while the `docs.enabled` experiment is off.
 *
 * @module routes/docs-comments
 */
import { Hono, type Context } from 'hono';
import type { z } from 'zod';
import {
  CreateDocCommentThreadSchema,
  DocRefSchema,
  EditDocCommentSchema,
  ReplyDocCommentSchema,
  SetDocCommentThreadResolvedSchema,
  UpdateDocCommentAnchorsSchema,
} from '@dorkos/shared/doc-comments';
import type { ApiEnv } from '../http/api-chain.js';
import { readJsonBody } from '../http/request-body.js';
import { honoRequestFacts } from '../http/request-facts.js';
import { readQuery } from '../http/request-query.js';
import { BoundaryError } from '../lib/boundary.js';
import { logError, logger } from '../lib/logger.js';
import { errorBody, validationFailureBody } from '../lib/route-utils.js';
import { docsEnabled } from '../services/docs/docs-experiment.js';
import { DocPathError } from '../services/docs/doc-space.js';
import {
  DocCommentError,
  getDocComments,
  resolveDocLocation,
  type DocCommentService,
  type DocLocation,
} from '../services/docs/comments/index.js';
import type { CommentWriteResult, CommentWriter } from '../services/docs/comments/index.js';
import { RoomError } from '../services/rooms/index.js';
import { resolveCaller } from './room-caller.js';

/** What the routes read, injectable for tests. */
export interface DocCommentRouteDeps {
  /** Whether the experiment is on. */
  enabled: () => boolean;
  /** The comment service, or null before boot wired it. */
  service: () => DocCommentService | null;
  /** Who the request is. */
  writer: (c: Context<ApiEnv>) => CommentWriter;
  /** Resolve the doc a request names. */
  locate: (cwd: string, path: string) => Promise<DocLocation>;
}

const liveDeps: DocCommentRouteDeps = {
  enabled: docsEnabled,
  service: () => getDocComments()?.service ?? null,
  writer: (c) => ({ author: resolveCaller(honoRequestFacts(c)) }),
  locate: resolveDocLocation,
};

/** The HTTP status for each comment refusal. */
const REFUSAL_STATUS = {
  NOT_FOUND: 404,
  NOT_YOURS: 403,
  UNADDRESSABLE_RANGE: 400,
  NO_AUTHOR: 403,
} as const;

/** A write's answer: the thread, and who it could not wake. */
function writeAnswer(result: CommentWriteResult) {
  return {
    thread: result.thread,
    unreached: result.unreached.map(({ authorId, name, reason }) => ({ authorId, name, reason })),
  };
}

/**
 * Build the routes mounted at `/api/documents/comments`.
 *
 * @param deps - Seams for tests; the live service by default.
 */
export function createDocCommentRoutes(deps: DocCommentRouteDeps = liveDeps): Hono<ApiEnv> {
  const router = new Hono<ApiEnv>();

  router.use('*', async (c, next) => {
    if (!deps.enabled() || !deps.service()) {
      return c.json(errorBody('Not found', 'API_NOT_FOUND'), 404);
    }
    c.header('Cache-Control', 'no-store');
    await next();
  });

  /**
   * Run one request: validate its input, resolve its doc and caller, and map
   * every refusal onto a status. `handle` gets the parsed input.
   */
  async function run<S extends z.ZodType<{ cwd: string; path: string }>>(
    c: Context<ApiEnv>,
    schema: S,
    input: unknown,
    handle: (ctx: {
      service: DocCommentService;
      doc: DocLocation;
      input: z.infer<S>;
      writer: () => CommentWriter;
    }) => unknown
  ): Promise<Response> {
    const parsed = schema.safeParse(input);
    if (!parsed.success) return c.json(validationFailureBody(parsed.error), 400);
    try {
      const doc = await deps.locate(parsed.data.cwd, parsed.data.path);
      const result = await handle({
        service: deps.service()!,
        doc,
        input: parsed.data,
        writer: () => deps.writer(c),
      });
      return c.json(result as object);
    } catch (err) {
      if (err instanceof BoundaryError) return c.json(errorBody(err.message, err.code), 403);
      if (err instanceof DocPathError) return c.json(errorBody(err.message, 'INVALID_PATH'), 400);
      if (err instanceof DocCommentError) {
        return c.json(errorBody(err.message, err.code), REFUSAL_STATUS[err.code]);
      }
      if (err instanceof RoomError && err.code === 'AGENT_IDENTITY_UNVERIFIED') {
        return c.json(errorBody(err.message, err.code), 401);
      }
      logger.error('[doc-comments] request failed', { path: c.req.path, ...logError(err) });
      return c.json(errorBody('Internal server error', 'INTERNAL'), 500);
    }
  }

  router.get('/', (c) =>
    run(c, DocRefSchema, readQuery(c), ({ service, doc }) => ({ threads: service.list(doc) }))
  );

  router.get('/mentionable', (c) => c.json({ people: deps.service()!.mentionable() }));

  router.post('/threads', (c) =>
    run(c, CreateDocCommentThreadSchema, readJsonBody(c), async ({ service, doc, input, writer }) =>
      writeAnswer(
        await service.createThread(doc, writer(), { anchor: input.anchor, body: input.body })
      )
    )
  );

  router.post('/threads/:threadId/replies', (c) =>
    run(c, ReplyDocCommentSchema, readJsonBody(c), async ({ service, doc, input, writer }) =>
      writeAnswer(await service.reply(doc, writer(), c.req.param('threadId'), input.body))
    )
  );

  router.patch('/threads/:threadId', (c) =>
    run(
      c,
      SetDocCommentThreadResolvedSchema,
      readJsonBody(c),
      ({ service, doc, input, writer }) => ({
        thread: service.setResolved(doc, writer(), c.req.param('threadId'), input.resolved),
      })
    )
  );

  router.patch('/threads/:threadId/comments/:commentId', (c) =>
    run(c, EditDocCommentSchema, readJsonBody(c), ({ service, doc, input, writer }) => ({
      thread: service.edit(
        doc,
        writer(),
        c.req.param('threadId'),
        c.req.param('commentId'),
        input.body
      ),
    }))
  );

  router.put('/anchors', (c) =>
    run(c, UpdateDocCommentAnchorsSchema, readJsonBody(c), ({ service, doc, input }) => ({
      updated: service.updateAnchors(doc, input.updates),
    }))
  );

  return router;
}
