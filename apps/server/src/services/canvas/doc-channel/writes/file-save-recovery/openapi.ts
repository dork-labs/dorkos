/** Read-only filesystem effect contract; generated API artifacts remain normal build outputs. */
import { z } from 'zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import {
  FileSaveDiscoverySchema,
  FileSaveRecoverBodySchema,
  FileSaveRecoverResultSchema,
} from '@dorkos/shared/file-save/recovery';
const refusal = z.object({ error: z.string(), code: z.string() });
/** Register current-birth discovery and proof-only recovery API documentation. */
export function registerFileSaveRecoveryOpenApi(registry: OpenAPIRegistry): void {
  const id = z.string().min(1).max(200);
  const failures = {
    400: {
      description: 'Invalid recovery input',
      content: { 'application/json': { schema: refusal } },
    },
    404: {
      description: 'Current owning chat document or original operation unavailable',
      content: { 'application/json': { schema: refusal } },
    },
    503: {
      description: 'Evidence, authority or storage unavailable; no fence is cleared',
      content: { 'application/json': { schema: refusal } },
    },
  };
  registry.registerPath({
    method: 'get',
    path: '/api/canvas/docs/{id}/file-saves',
    tags: ['Canvas'],
    summary: 'Discover current-owner original save evidence',
    description:
      'Ordinary authenticated operator, current chat FILE only. Latest25 current-owner/full-birth summaries, explicit truncation; no draft, path, credentials or foreign operation identifiers. Admission result is a momentary observation, never a write capability or proof of global vacancy.',
    request: { params: z.object({ id }) },
    responses: {
      200: {
        description: 'Bounded historical evidence; no filesystem effects',
        content: { 'application/json': { schema: FileSaveDiscoverySchema } },
      },
      ...failures,
    },
  });
  registry.registerPath({
    method: 'post',
    path: '/api/canvas/docs/{id}/file-saves/{eventId}/recover',
    tags: ['Canvas'],
    summary: 'Inspect or complete one original save receipt without repeating its file effect',
    description:
      'Accepts only expected full incarnation. Exact owner/source/path/replacement inode+hash and canonical gate are required for original staged completion. Prepared-without-replacement remains manual. A returned receipt is historical; current match is a separately observed classification. Existing history-only routing stays history-only; frozen original routes are never reselected.',
    request: {
      params: z.object({ id, eventId: z.string().uuid() }),
      body: {
        required: true,
        content: { 'application/json': { schema: FileSaveRecoverBodySchema } },
      },
    },
    responses: {
      200: {
        description:
          'Historical receipt, no-op, proven failed or unresolved review; no rename/write',
        content: { 'application/json': { schema: FileSaveRecoverResultSchema } },
      },
      ...failures,
    },
  });
}
