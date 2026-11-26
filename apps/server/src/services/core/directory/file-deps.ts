/**
 * What the file browser's capabilities (`file-capabilities.ts`) are handed at
 * boot: a person's save through the installation's one file writer. Handed
 * over rather than imported, so this domain reaches no other domain's code
 * (the import boundary, DOR-4924); the composition root wires it
 * (`startup/steps/capabilities.ts`).
 *
 * @module services/core/directory/file-deps
 */
import type { WriteFileRequest } from '@dorkos/shared/schemas';
import type { PersonFileSaveOutcome } from '../../canvas/doc-channel/writes/person-file-save.js';
import type { CapabilityDeps } from '../capabilities/capability-definition.js';
import { FILE_SENTENCES, fileRefusal } from './file-refusals.js';

declare module '../capabilities/capability-definition.js' {
  interface CapabilityDeps {
    /** The file browser's writer; present once the document channel started. */
    fileDeps?: {
      /**
       * Saves a file for a person (`savePersonFile`): an ordinary save, or a chat
       * canvas's document save when `owner` (the document channel's operator rule).
       */
      save(input: WriteFileRequest, owner: boolean): Promise<PersonFileSaveOutcome>;
    };
  }
}

/**
 * The bag, or a refusal that says saving is not ready while boot has not handed it over.
 *
 * @param deps - The registry's deps.
 */
export function fileDepsOf(deps: CapabilityDeps): NonNullable<CapabilityDeps['fileDeps']> {
  if (!deps.fileDeps) throw fileRefusal('FILE_SAVE_UNAVAILABLE', FILE_SENTENCES.saveNotReady);
  return deps.fileDeps;
}

/** Why a person's file writes have no area: no agent can call them. */
export const FILE_WRITE_AREA_NOTE =
  'a person’s own file browser; agents change files with their own runtime’s tools';
