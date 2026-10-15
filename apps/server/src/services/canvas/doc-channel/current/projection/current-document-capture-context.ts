import type { DbTransaction } from '@dorkos/db';
import type { DocChannelStore } from '../../store.js';
import type { OriginalCurrentEntryFacet } from './current-entry-context.js';
/** Original private native document and live checkbox entry, no caller context fallback. */
export interface OriginalDocumentCaptureFacet extends OriginalCurrentEntryFacet {
  readonly checkboxCommits: WeakMap<
    DbTransaction,
    {
      owner: object;
      store: DocChannelStore;
      now: string;
      generation: string;
      physical: Record<string, unknown>;
      channelBirth: Record<string, unknown>;
      roomPrepared: boolean;
    }
  >;
}
