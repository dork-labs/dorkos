/**
 * A person's file save through the installation's one file writer, for the file
 * browser's `files.save` capability (DOR-4978): an ordinary save, or a chat
 * canvas's document save for the owner. It answers what happened as data, so
 * the capability (on the other side of a domain line) needs no class from here.
 *
 * Only this channel's own refusals become an outcome; any other failure (a path
 * the boundary refused, an errno) is thrown as it came, for the caller to sort.
 *
 * @module services/canvas/doc-channel/writes/person-file-save
 */
import type { WriteFileRequest, WriteFileResponse } from '@dorkos/shared/schemas';
import type { DocSaveRefusalReason } from '@dorkos/shared/file-save/recovery';
import { logger } from '../../../../lib/logger.js';
import { disclosableRefusalReason } from '../authorization.js';
import { CanonicalFileIdentityChangedError } from './canonical-writer.js';
import {
  saveOriginalDocumentFile,
  type InstallationFileWrites,
} from './installation-file-writes.js';

/** Why the document channel refused a save, in the words a refusal needs. */
export type PersonFileSaveRefusal =
  /** The file was replaced while the save waited. */
  | 'replaced'
  /** A document save reused its id for something else. */
  | 'id_conflict'
  /** The recorded document save failed before it changed the file. */
  | 'not_applied'
  /** The last document save needs checking first. */
  | 'in_doubt'
  /** The document is not available to this caller. */
  | 'document';

/** The file as it is now, when a save's baseline no longer matches it. */
type Stale = { readonly currentHash: string; readonly currentContent: string };

/** What a person's save came to. */
export type PersonFileSaveOutcome =
  | { readonly saved: WriteFileResponse }
  | { readonly stale: Stale }
  | {
      readonly refused: PersonFileSaveRefusal;
      /** For a refused document, the check that refused, when the owner may know (DOR-4442). */
      readonly reason?: DocSaveRefusalReason;
    };

/** The refusals each document save failure code means. */
const REFUSED_BY_CODE: Readonly<Record<string, PersonFileSaveRefusal>> = {
  DOC_SAVE_ID_CONFLICT: 'id_conflict',
  DOC_SAVE_FAILED: 'not_applied',
  DOC_SAVE_IN_DOUBT: 'in_doubt',
};

/**
 * Save a file for a person.
 *
 * @param writes - The installation's file writer.
 * @param input - The parsed save request.
 * @param owner - Whether the caller passes the document channel's operator rule
 *   (`isDocOperatorAccount`, the mount's `ownerOrNoAccount`); a document save needs it.
 */
export async function savePersonFile(
  writes: InstallationFileWrites,
  input: WriteFileRequest,
  owner: boolean
): Promise<PersonFileSaveOutcome> {
  try {
    if (input.documentSave && !owner) {
      // The hand route's caller check, from the mount's answer: a signed-in account that is
      // not the owner is refused the way the document channel refuses one, never disclosed.
      logger.info('[files] a document save check refused', { reason: 'not_operator' });
      return { refused: 'document' };
    }
    // An agent and a bearer never reach here (the capability is a person's door), so the
    // document channel sees the owner's request with no credential headers.
    const result: { stale: Stale } | { body: WriteFileResponse } = input.documentSave
      ? await saveOriginalDocumentFile(writes, input, { headers: {} })
      : await writes.save(input);
    return 'stale' in result ? { stale: result.stale } : { saved: result.body };
  } catch (err) {
    if (err instanceof CanonicalFileIdentityChangedError) return { refused: 'replaced' };
    const code = (err as { code?: unknown } | null)?.code;
    if (code === 'CANVAS_DOCUMENT_NOT_FOUND') {
      // Which check refused, logged always and told to the owner when safe (DOR-4442).
      logger.info('[files] a document save check refused', {
        reason: (err as { reason?: string }).reason ?? null,
      });
      const reason = disclosableRefusalReason(err);
      return reason ? { refused: 'document', reason } : { refused: 'document' };
    }
    const refused = typeof code === 'string' ? REFUSED_BY_CODE[code] : undefined;
    if (refused) return { refused };
    throw err;
  }
}
