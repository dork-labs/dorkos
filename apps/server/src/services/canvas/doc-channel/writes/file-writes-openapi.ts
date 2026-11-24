import { registerFileSaveRecoveryOpenApi } from './file-save-recovery/openapi.js';
/** Ordinary file-save API documentation, including safe identity-change refusal. */
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import { WriteFileRequestSchema, WriteFileResponseSchema } from '@dorkos/shared/schemas';
import { PROBLEM_CONTENT_TYPE, ProblemSchema } from '@dorkos/shared/problem';
import { problemResponse } from '../../../core/openapi/problem-openapi.js';

/** A 412 answer: a problem, carrying the file as it is now when it changed underneath. */
const StaleFileProblemSchema = ProblemSchema.extend({
  currentHash: z.string().optional().describe('The SHA-256 of the file as it is now.'),
  currentContent: z.string().optional().describe('The file as it is now.'),
});

/** Register the existing ordinary file save and its cooperative-write outcomes. */
export function registerFileWriteOpenApi(registry: OpenAPIRegistry): void {
  registerFileSaveRecoveryOpenApi(registry);
  registry.registerPath({
    method: 'put',
    path: '/api/files/content',
    tags: ['Files'],
    summary: 'Save an existing file within the working directory',
    description:
      'Confined to cwd. Cooperating ordinary and checkbox writes share the installation file gate. ' +
      'A stale content baseline returns 412 `precondition_failed` with the current content. A replaced physical identity ' +
      'returns 412 `precondition_failed` too; reload before saving again. This does not create files ' +
      'or produce a document event receipt without optional documentSave metadata. That lane is ' +
      'operator-only and chat-document-only, validates the server-projected incarnation, and ' +
      'returns an original host saved receipt without route-delivery claims. Identical retries never repeat the file effect. ' +
      'A duplicate acknowledges the original operation: its hash is historical, not proof against later writes. ' +
      'A no-op without a prior committed save has no saved receipt.',
    request: {
      body: { required: true, content: { 'application/json': { schema: WriteFileRequestSchema } } },
    },
    responses: {
      200: {
        description:
          'Content saved or already identical; a verified original document operation may include its durable receipt',
        content: { 'application/json': { schema: WriteFileResponseSchema } },
      },
      400: problemResponse(
        '`invalid_request` (a bad body, or a path with a NUL byte or one that cannot be followed) or `not_a_file` (the path is a folder)'
      ),
      403: problemResponse(
        '`outside_boundary` (the path leaves the working directory) or `forbidden` (the system would not let DorkOS write it)'
      ),
      404: problemResponse(
        '`not_found`: no file at that path, or the document save was refused; for the owner, `detail` names the check that refused (DOR-4442)'
      ),
      412: {
        description:
          '`precondition_failed`: the file changed since the caller read it (the body carries `currentHash` and `currentContent`), the file was replaced while saving, or a document save reused its id for different content. `save_not_applied`: the recorded document save failed before it changed the file, so sending it again is safe.',
        content: { [PROBLEM_CONTENT_TYPE]: { schema: StaleFileProblemSchema } },
      },
      500: problemResponse('`internal_error`: the save failed'),
      503: problemResponse(
        '`temporarily_unavailable`: the original document save is uncertain; no effect is replayed and no receipt is invented'
      ),
    },
  });
}
