import type { OriginalEventAdmissionFacet } from './current-event-admission-context.js';
import type { OriginalMountedPresenceFacet } from '../presence/current-mounted-presence-context.js';
import type { createOriginalEditorSelectionReader } from '../../editor/selection-source.js';
import type { inspectCurrent } from './current-read-projection-facet.js';
/** Original private native FILE and editor admission delegates; no structural owner fallback. */
export interface OriginalEditorSaveSelectionFacet extends OriginalEventAdmissionFacet {
  readonly editorSelectionReader: ReturnType<typeof createOriginalEditorSelectionReader>;
  readonly submitCurrent: OriginalMountedPresenceFacet['submitCurrent'];
  readonly inspectCurrent: (
    ...args: Parameters<typeof inspectCurrent> extends [object, ...infer Args] ? Args : never
  ) => ReturnType<typeof inspectCurrent>;
}
