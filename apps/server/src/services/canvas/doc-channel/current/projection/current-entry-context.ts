import type { DbTransaction } from '@dorkos/db';
import type { DocChannelActor } from '../../authorization.js';
import type { CurrentOperationScope } from '../current-operation-types.js';
import type { OriginalEventAdmissionFacet } from './current-event-admission-context.js';
import type { OriginalReadProjectionFacet } from './current-read-projection-context.js';
import type { OriginalEditorSaveSelectionFacet } from './current-editor-save-selection-context.js';
import type { OriginalTokenNativeInputFacet } from '../token/current-token-native-input-context.js';
/** Original active SQL entry, latches and exact transaction maps, never caller context. */
export interface OriginalCurrentEntryFacet extends OriginalEventAdmissionFacet {
  currentEntry: boolean;
  readonly scopes: WeakMap<DbTransaction, CurrentOperationScope>;
  readonly activeCurrent: WeakSet<DbTransaction>;
  readonly editorSelectionReader: OriginalEditorSaveSelectionFacet['editorSelectionReader'];
  readonly documentSaveInspections: OriginalReadProjectionFacet['documentSaveInspections'];
  readonly restoredTokens: OriginalTokenNativeInputFacet['restoredTokens'];
  readonly tokenNativeCurrent: OriginalTokenNativeInputFacet['tokenNativeCurrent'];
  readonly requirePresenceFocus: (
    stage: object,
    store: import('../../store.js').DocChannelStore
  ) => void;
  readonly fixedCurrent: (
    documentId: string,
    actor: DocChannelActor,
    write: boolean,
    tx: DbTransaction | undefined,
    ready: boolean
  ) => { id: string; scope: string };
  readonly documentGrantRows: (documentId: string, tx: DbTransaction) => unknown;
  readonly documentScopeBaseline: (scope: CurrentOperationScope, dependencies: unknown) => unknown;
}
