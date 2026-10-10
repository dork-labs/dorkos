/**
 * OpenAPI entries for the commitment routes (spec `heartbeats` §12), projected
 * from the schemas the routes parse and answer with.
 *
 * @module services/commitments/commitments-openapi
 */
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import {
  CommitmentSchema,
  CreateCommitmentRequestSchema,
  ListCommitmentsQuerySchema,
  ListCommitmentsResponseSchema,
  UpdateCommitmentRequestSchema,
} from '@dorkos/shared/commitment-schemas';

/** A refusal: plain words and a stable code. */
const CommitmentErrorSchema = z
  .object({ error: z.string(), code: z.string() })
  .openapi('CommitmentError');

/**
 * Register the commitment routes.
 *
 * @param registry - The server's OpenAPI registry.
 */
export function registerCommitmentsOpenApi(registry: OpenAPIRegistry): void {
  registry.registerPath({
    method: 'get',
    path: '/api/commitments',
    tags: ['Commitments'],
    summary: 'What agents promised',
    description:
      "Every agent's promises, readable by anyone in the space: open first (soonest due " +
      'first), then kept, missed and dropped, newest first. `overdue` is computed on read.',
    request: { query: ListCommitmentsQuerySchema },
    responses: {
      200: {
        description: 'The promises',
        content: { 'application/json': { schema: ListCommitmentsResponseSchema } },
      },
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/agents/{id}/commitments',
    tags: ['Commitments'],
    summary: 'Add a promise for an agent',
    description:
      'A person records something an agent promised. Agents record their own with ' +
      '`commitment_add`, so a caller presenting an agent identity is refused.',
    request: {
      params: z.object({ id: z.string() }),
      body: { content: { 'application/json': { schema: CreateCommitmentRequestSchema } } },
    },
    responses: {
      201: {
        description: 'The new promise',
        content: { 'application/json': { schema: CommitmentSchema } },
      },
      400: {
        description: 'Invalid body, or a past date (`PAST_DUE`)',
        content: { 'application/json': { schema: CommitmentErrorSchema } },
      },
      403: {
        description: 'The caller is an agent (`NOT_A_PERSON`), or not the owner (`NOT_YOURS`)',
        content: { 'application/json': { schema: CommitmentErrorSchema } },
      },
      404: {
        description: 'No agent has that id (`UNKNOWN_AGENT`)',
        content: { 'application/json': { schema: CommitmentErrorSchema } },
      },
    },
  });

  registry.registerPath({
    method: 'patch',
    path: '/api/commitments/{id}',
    tags: ['Commitments'],
    summary: 'Close a promise or move its date',
    description:
      'Mark a promise kept, missed or dropped. `state: "open"` moves an open promise to a new ' +
      '`dueAt`, or reopens a closed one. Only the agent that promised, or a person, may change it.',
    request: {
      params: z.object({ id: z.string() }),
      body: { content: { 'application/json': { schema: UpdateCommitmentRequestSchema } } },
    },
    responses: {
      200: {
        description: 'The promise, changed',
        content: { 'application/json': { schema: CommitmentSchema } },
      },
      400: {
        description:
          'Invalid body, nothing to change (`NOTHING_TO_CHANGE`), or a past date (`PAST_DUE`)',
        content: { 'application/json': { schema: CommitmentErrorSchema } },
      },
      403: {
        description: 'Another agent made it, or the person is not the owner (`NOT_YOURS`)',
        content: { 'application/json': { schema: CommitmentErrorSchema } },
      },
      404: {
        description: 'No promise has that id (`NOT_FOUND`)',
        content: { 'application/json': { schema: CommitmentErrorSchema } },
      },
      409: {
        description: 'It is no longer in the `from` state the caller named (`CONFLICT`)',
        content: { 'application/json': { schema: CommitmentErrorSchema } },
      },
    },
  });
}
