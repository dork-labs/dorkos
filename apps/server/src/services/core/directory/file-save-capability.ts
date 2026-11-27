/**
 * `files.save`: `PUT /api/files/content`, the file editor's save, as a
 * capability the mount serves (DOR-4978, ADR 261123-170830).
 *
 * Only a person (`http.audience: 'person'`): the app's editor and a chat
 * canvas's file save. An agent changes files with its own runtime's tools,
 * which carry its turn's power, so this door gives it none; the registry
 * refuses every other caller `person_only` before the handler runs.
 *
 * The save keeps the hand route's checks exactly: the target is confined to
 * `cwd` and must already exist, a stale `expectedHash` is refused with the file
 * as it is now, and a chat canvas's document save (`documentSave`) runs only for
 * the owner, through the installation's one file writer
 * (`canvas/doc-channel/writes/person-file-save.ts`). The owner bar is the
 * mount's yes/no answer (`context.request.ownerOrNoAccount`, the same rule the
 * save's recovery routes ask), never a header.
 *
 * @module services/core/directory/file-save-capability
 */
import { z } from 'zod';
import { ProblemSchema } from '@dorkos/shared/problem';
import { WriteFileRequestSchema, WriteFileResponseSchema } from '@dorkos/shared/schemas';

import { logger } from '../../../lib/logger.js';
import type { PersonFileSaveOutcome } from '../../canvas/doc-channel/writes/person-file-save.js';
import { defineCapability, type CapabilityDeps } from '../capabilities/capability-definition.js';
import { errnoOf, FILE_SENTENCES as S, fileRefusal, REFUSED_BECAUSE } from './file-refusals.js';
import { fileDepsOf, FILE_WRITE_AREA_NOTE } from './file-deps.js';
import { pathToolError } from './path-refusal.js';

/** The refusal for each way the document channel refused a save. */
function channelRefusal(outcome: Extract<PersonFileSaveOutcome, { refused: unknown }>): Error {
  switch (outcome.refused) {
    case 'replaced':
      return fileRefusal('FILE_REPLACED_WHILE_SAVING', S.replacedWhileSaving);
    case 'id_conflict':
      return fileRefusal('FILE_SAVE_ID_CONFLICT', S.saveIdConflict);
    case 'not_applied':
      return fileRefusal('FILE_SAVE_NOT_APPLIED', S.saveNotApplied);
    case 'in_doubt':
      return fileRefusal('FILE_SAVE_IN_DOUBT', S.saveInDoubt);
    case 'document':
      return fileRefusal(
        'FILE_DOCUMENT_UNAVAILABLE',
        outcome.reason ? REFUSED_BECAUSE[outcome.reason] : S.documentUnavailable
      );
  }
}

/**
 * The refusal for a save that threw: a fixed sentence per refusal, never a path
 * or the error's own text; the rest goes to the log.
 *
 * @param err - What the save threw.
 */
function saveFailure(err: unknown): Error {
  const refusal = pathToolError(err);
  if (refusal) return refusal;
  const code = errnoOf(err);
  if (code === 'ENOENT') return fileRefusal('FILE_MISSING', S.fileMissing);
  if (code === 'NOT_A_FILE') return fileRefusal('FILE_PATH_IS_FOLDER', S.folderNotFile);
  if (code === 'EACCES') return fileRefusal('FILE_CHANGE_NOT_ALLOWED', S.notAllowed);
  logger.error('[files] save failed', { err });
  return fileRefusal('FILE_ACTION_FAILED', S.saveFailed);
}

/** A stale save's refusal: a problem carrying the file as it is now. */
const StaleFileProblemSchema = ProblemSchema.extend({
  currentHash: z.string().optional().describe('The SHA-256 of the file as it is now.'),
  currentContent: z.string().optional().describe('The file as it is now.'),
});

/** `files.save`: write an existing file's new text, conditionally on its last-read hash. */
export const filesSaveCapability = defineCapability({
  id: 'files.save',
  title: 'Save a file',
  description:
    'Write new text to a file that already exists under `cwd`; it never creates one. With ' +
    '`expectedHash` (or `expectedContent`) the save is refused, unchanged, when the file ' +
    'changed since it was read, and the refusal carries the file as it is now. A chat ' +
    'canvas’s document save (`documentSave`) is the owner’s only. A person’s door: agents ' +
    'change files with their own tools.',
  tier: 'act',
  area: null,
  areaNote: FILE_WRITE_AREA_NOTE,
  input: WriteFileRequestSchema,
  output: WriteFileResponseSchema,
  surfaces: { http: { method: 'put', path: '/api/files/content', audience: 'person' } },
  httpErrors: {
    400: {
      description:
        '`invalid_request` (a bad body, a path with a NUL byte or one that cannot be followed) ' +
        'or `not_a_file` (the path is a folder)',
    },
    403: {
      description:
        '`person_only` (an agent or a program with a key), `outside_boundary` (the path leaves ' +
        'the working directory) or `forbidden` (the system would not let DorkOS write it)',
    },
    404: {
      description:
        '`not_found`: no file at that path, or the document save was refused; for the owner, ' +
        '`detail` names the check that refused (DOR-4442)',
    },
    412: {
      description:
        '`precondition_failed`: the file changed since the caller read it (the body carries ' +
        '`currentHash` and `currentContent`), the file was replaced while saving, or a document ' +
        'save reused its id for different content. `save_not_applied`: the recorded document ' +
        'save failed before it changed the file. The file is unchanged; send a new save.',
      schema: StaleFileProblemSchema,
    },
    503: {
      description:
        '`temporarily_unavailable`: the last document save needs checking first, or saving is ' +
        'not ready yet',
    },
  },
  invoke: async (deps: CapabilityDeps, input, context) => {
    const files = fileDepsOf(deps);
    let outcome: PersonFileSaveOutcome;
    try {
      // Only a document save asks the owner question, as the hand route did.
      const owner = input.documentSave ? context.request?.ownerOrNoAccount === true : false;
      outcome = await files.save(input, owner);
    } catch (err) {
      throw saveFailure(err);
    }
    if ('refused' in outcome) throw channelRefusal(outcome);
    if ('stale' in outcome) {
      // The caller's copy is out of date: hand back what is there now, so the editor can
      // reconcile without a second read.
      throw fileRefusal('FILE_CHANGED_SINCE_OPENED', S.changedSinceOpened, outcome.stale);
    }
    return outcome.saved;
  },
});
