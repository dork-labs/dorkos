/** Ordinary authenticated operator recovery: content/path/authority never come from this body. */
import { Hono, type Context } from 'hono';
import {
  DocChannelNotFoundError,
  disclosableRefusalReason,
} from '../../services/canvas/doc-channel/authorization.js';
import { logger } from '../../lib/logger.js';
import { z } from 'zod';
import {
  FileSaveRecoverBodySchema,
  FileSaveRecoveryLookupSchema,
} from '@dorkos/shared/file-save/recovery';
import type { ApiEnv } from '../../http/api-chain.js';
import { honoRequestFacts } from '../../http/request-facts.js';
import { problem, readJsonBody } from '@dorkos/http-kit';
import { readQuery } from '../../http/request-query.js';
import {
  discoverOriginalDocumentFileSaves,
  recoverOriginalDocumentFileSave,
  type InstallationFileWrites,
} from '../../services/canvas/doc-channel/writes/installation-file-writes.js';
import type { DocSaveRefusalReason } from '@dorkos/shared/file-save/recovery';

/**
 * Why a chat's canvas will not save its file, for the owner once they are
 * known to be asking (DOR-4442): one sentence per check, never a path.
 */
const REFUSED_BECAUSE: Readonly<Record<DocSaveRefusalReason, string>> = {
  not_session: 'Only files on a chat’s canvas can be edited here.',
  no_recorded_folder: 'This file’s folder wasn’t recorded when it was opened, so editing is off.',
  root_mismatch: 'This file isn’t in this chat’s agent folder, so editing is off.',
  folder_gone: 'This file’s folder was moved or deleted, so editing is off.',
  outside_boundary: 'This file is outside the folders this chat can edit.',
};
/** Fixed owning installation source, supplied only by the server composition. */
export function createFileSaveRecoveryRoutes(source: () => InstallationFileWrites | undefined) {
  const router = new Hono<ApiEnv>();
  const documentId = (value: unknown) => z.string().min(1).max(200).parse(value);
  /**
   * Answer a refusal as a problem: a fixed sentence per case, and for a 404 a
   * sentence naming which check refused when the owner may know (DOR-4442).
   * Never a path; anything else stays in the log.
   */
  const failure = (c: Context<ApiEnv>, error: unknown): Response => {
    if (error instanceof z.ZodError)
      return problem(c, 'invalid_request', { detail: 'That save recovery request isn’t valid.' });
    if (error instanceof DocChannelNotFoundError) {
      logger.info('[file-saves] a document save check refused', { reason: error.reason ?? null });
      const reason = disclosableRefusalReason(error);
      return problem(c, 'not_found', {
        detail: reason ? REFUSED_BECAUSE[reason] : 'The document save evidence is not available.',
      });
    }
    if (error !== undefined) logger.warn('[file-saves] save evidence failed', { error });
    return problem(c, 'temporarily_unavailable', {
      detail: 'Save evidence isn’t available right now. Try again soon.',
    });
  };
  router.get('/:id/file-saves', async (c) => {
    c.header('Cache-Control', 'no-store');
    try {
      if (Object.keys(readQuery(c)).length) throw new z.ZodError([]);
      const owner = source();
      if (!owner) return failure(c, undefined);
      return c.json(
        await discoverOriginalDocumentFileSaves(
          owner,
          documentId(c.req.param('id')),
          honoRequestFacts(c)
        )
      );
    } catch (error) {
      return failure(c, error);
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
      if (!owner) return failure(c, undefined);
      return c.json(await recoverOriginalDocumentFileSave(owner, lookup, honoRequestFacts(c)));
    } catch (error) {
      return failure(c, error);
    }
  });
  return router;
}
