/** Ordinary authenticated operator recovery: content/path/authority never come from this body. */
import { Hono } from 'hono';
import { DocChannelNotFoundError } from '../../services/canvas/doc-channel/authorization.js';
import { z } from 'zod';
import {
  FileSaveRecoverBodySchema,
  FileSaveRecoveryLookupSchema,
} from '@dorkos/shared/file-save/recovery';
import type { ApiEnv } from '../../http/api-chain.js';
import { honoRequestFacts } from '../../http/request-facts.js';
import { readJsonBody } from '../../http/request-body.js';
import { readQuery } from '../../http/request-query.js';
import {
  discoverOriginalDocumentFileSaves,
  recoverOriginalDocumentFileSave,
  type InstallationFileWrites,
} from '../../services/canvas/doc-channel/writes/installation-file-writes.js';
/** Fixed owning installation source, supplied only by the server composition. */
export function createFileSaveRecoveryRoutes(source: () => InstallationFileWrites | undefined) {
  const router = new Hono<ApiEnv>();
  const documentId = (value: unknown) => z.string().min(1).max(200).parse(value);
  const failure = (error: unknown) => ({
    error: 'The document save evidence is not available.',
    code: error instanceof z.ZodError ? 'INVALID_FILE_SAVE_RECOVERY' : 'DOC_FILE_SAVE_UNAVAILABLE',
  });
  router.get('/:id/file-saves', async (c) => {
    c.header('Cache-Control', 'no-store');
    try {
      if (Object.keys(readQuery(c)).length) throw new z.ZodError([]);
      const owner = source();
      if (!owner) return c.json(failure(undefined), 503);
      return c.json(
        await discoverOriginalDocumentFileSaves(
          owner,
          documentId(c.req.param('id')),
          honoRequestFacts(c)
        )
      );
    } catch (error) {
      return c.json(
        failure(error),
        error instanceof z.ZodError ? 400 : error instanceof DocChannelNotFoundError ? 404 : 503
      );
    }
  });
  router.post('/:id/file-saves/:eventId/recover', async (c) => {
    c.header('Cache-Control', 'no-store');
    try {
      if (Object.keys(readQuery(c)).length) throw new z.ZodError([]);
      const body = FileSaveRecoverBodySchema.parse(readJsonBody(c));
      const lookup = FileSaveRecoveryLookupSchema.parse({
        ...body,
        documentId: documentId(c.req.param('id')),
        eventId: c.req.param('eventId'),
      });
      const owner = source();
      if (!owner) return c.json(failure(undefined), 503);
      return c.json(await recoverOriginalDocumentFileSave(owner, lookup, honoRequestFacts(c)));
    } catch (error) {
      return c.json(
        failure(error),
        error instanceof z.ZodError ? 400 : error instanceof DocChannelNotFoundError ? 404 : 503
      );
    }
  });
  return router;
}
