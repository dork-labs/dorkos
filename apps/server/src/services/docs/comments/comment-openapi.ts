/**
 * OpenAPI entries for comments on docs (DOR-2983, `routes/docs-comments.ts`).
 * Bodies are the protocol's own (`@dorkos/shared/doc-comments`).
 *
 * @module services/docs/comments/comment-openapi
 */
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import {
  CreateDocCommentThreadSchema,
  DocCommentMentionableListSchema,
  DocCommentThreadListSchema,
  DocCommentThreadResultSchema,
  DocCommentWriteResultSchema,
  EditDocCommentSchema,
  ReplyDocCommentSchema,
  SetDocCommentThreadResolvedSchema,
  UpdateDocCommentAnchorsResultSchema,
  UpdateDocCommentAnchorsSchema,
} from '@dorkos/shared/doc-comments';

const TAGS = ['Doc comments'];
const BASE = '/api/documents/comments';

const ErrorSchema = z.object({ error: z.string(), code: z.string() });

const json = (schema: z.ZodType, description: string) => ({
  description,
  content: { 'application/json': { schema } },
});

const OFF = json(
  ErrorSchema,
  'The `docs.enabled` experiment is off, or the thread is not on this doc'
);
const BAD = json(ErrorSchema, 'The input or the doc path is malformed');
const OUTSIDE = json(ErrorSchema, 'The folder or the doc is outside the directory boundary');
const THREAD_PARAM = z.object({ threadId: z.string() });
const body = (schema: z.ZodType) => ({ body: { content: { 'application/json': { schema } } } });
const WRITE = json(
  DocCommentWriteResultSchema,
  'The thread as it is now, and any mentioned agent that was not woken'
);
const THREAD = json(DocCommentThreadResultSchema, 'The thread as it is now');

/**
 * Register the doc comment routes.
 *
 * @param registry - The server's OpenAPI registry.
 */
export function registerDocCommentsOpenApi(registry: OpenAPIRegistry): void {
  registry.registerPath({
    method: 'get',
    path: BASE,
    tags: TAGS,
    summary: 'List the comment threads on a doc',
    description: 'Every thread on the doc named by `cwd` and `path`, resolved ones included.',
    request: { query: z.object({ cwd: z.string(), path: z.string() }) },
    responses: {
      200: json(DocCommentThreadListSchema, 'The threads, oldest first'),
      400: BAD,
      403: OUTSIDE,
      404: OFF,
    },
  });

  registry.registerPath({
    method: 'get',
    path: `${BASE}/mentionable`,
    tags: TAGS,
    summary: 'List who a comment can mention',
    description: 'Every agent, and the owner once they have a handle.',
    responses: { 200: json(DocCommentMentionableListSchema, 'The roster'), 404: OFF },
  });

  registry.registerPath({
    method: 'post',
    path: `${BASE}/threads`,
    tags: TAGS,
    summary: 'Open a comment thread',
    description:
      'Opens a thread on the words the anchor names, with its first comment. An agent the ' +
      'comment mentions is woken through the reply limits.',
    request: body(CreateDocCommentThreadSchema),
    responses: { 200: WRITE, 400: BAD, 403: OUTSIDE, 404: OFF },
  });

  registry.registerPath({
    method: 'post',
    path: `${BASE}/threads/{threadId}/replies`,
    tags: TAGS,
    summary: 'Reply in a comment thread',
    request: { params: THREAD_PARAM, ...body(ReplyDocCommentSchema) },
    responses: { 200: WRITE, 400: BAD, 403: OUTSIDE, 404: OFF },
  });

  registry.registerPath({
    method: 'patch',
    path: `${BASE}/threads/{threadId}`,
    tags: TAGS,
    summary: 'Resolve or reopen a comment thread',
    request: { params: THREAD_PARAM, ...body(SetDocCommentThreadResolvedSchema) },
    responses: { 200: THREAD, 400: BAD, 403: OUTSIDE, 404: OFF },
  });

  registry.registerPath({
    method: 'patch',
    path: `${BASE}/threads/{threadId}/comments/{commentId}`,
    tags: TAGS,
    summary: 'Change your own comment',
    description: 'Its mentions stay what they were when it was written.',
    request: {
      params: THREAD_PARAM.extend({ commentId: z.string() }),
      ...body(EditDocCommentSchema),
    },
    responses: {
      200: THREAD,
      400: BAD,
      403: json(ErrorSchema, 'Outside the boundary, or somebody else wrote the comment'),
      404: OFF,
    },
  });

  registry.registerPath({
    method: 'put',
    path: `${BASE}/anchors`,
    tags: TAGS,
    summary: 'Save moved comment anchors',
    description:
      'Saves the anchors the editor reports after edits, so threads re-attach next time. Ids ' +
      'that are not threads on this doc are skipped.',
    request: body(UpdateDocCommentAnchorsSchema),
    responses: {
      200: json(UpdateDocCommentAnchorsResultSchema, 'How many threads took a new anchor'),
      400: BAD,
      403: OUTSIDE,
      404: OFF,
    },
  });
}
