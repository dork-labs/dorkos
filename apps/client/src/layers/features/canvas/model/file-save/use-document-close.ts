/** The mounted editor alone prepares close; retired drains retain observation, never new authority. */
import { useLayoutEffect, useRef } from 'react';
import { registerCanvasDocumentClosePreparation, useAppStore } from '@/layers/shared/model';
import type { FileSaveBinding } from './receipt-operation';
import type { useCanvasFileSave } from '../use-canvas-file-save';
type Save = ReturnType<typeof useCanvasFileSave>['save'];
type Mutable<T> = { current: T };
interface Preparation {
  documentId: string;
  sourcePath: string;
  binding?: FileSaveBinding;
  save: Save;
  invalidateConfirmedFile(): void;
  draftRef: Mutable<string>;
  revisionRef: Mutable<number>;
  finishAttemptRef: Mutable<number>;
  timerRef: Mutable<ReturnType<typeof setTimeout> | null>;
  finalSaveRef: Mutable<ReturnType<ReturnType<typeof useCanvasFileSave>['prepareFinalSave']>>;
}
/** Return this exact registration so passive cleanup can settle its prior layout retirement. */
export function useCanvasDocumentClosePreparation({
  documentId,
  sourcePath,
  binding,
  save,
  draftRef,
  revisionRef,
  finishAttemptRef,
  timerRef,
  finalSaveRef,
  invalidateConfirmedFile,
}: Preparation) {
  const closePreparationRef = useRef({ binding, save, invalidateConfirmedFile });
  const closeOwnerRef = useRef<ReturnType<typeof registerCanvasDocumentClosePreparation> | null>(
    null
  );
  const closeApprovalRef = useRef<{
    revision: number;
    attempt: number;
    binding: FileSaveBinding;
    save: Save;
  } | null>(null);
  useLayoutEffect(() => {
    closePreparationRef.current = { binding, save, invalidateConfirmedFile };
  });
  useLayoutEffect(() => {
    const row = useAppStore.getState().openDocuments.find((item) => item.id === documentId);
    if (!row || typeof row.openedAt !== 'number') return;
    const own = registerCanvasDocumentClosePreparation(documentId, row.openedAt, sourcePath, {
      required: () => !!closePreparationRef.current.binding,
      current: () => {
        const approval = closeApprovalRef.current;
        return (
          !!approval &&
          approval.revision === revisionRef.current &&
          approval.attempt === finishAttemptRef.current &&
          approval.binding === closePreparationRef.current.binding &&
          approval.save === closePreparationRef.current.save &&
          approval.binding.current()
        );
      },
      invalidateConfirmedFile: () => closePreparationRef.current.invalidateConfirmedFile(),
      prepare: async () => {
        closeApprovalRef.current = null;
        const { binding, save } = closePreparationRef.current;
        if (!binding?.current()) return false;
        if (timerRef.current) {
          clearTimeout(timerRef.current);
          timerRef.current = null;
        }
        const submitted = draftRef.current,
          revision = revisionRef.current;
        const attempt = ++finishAttemptRef.current;
        const outcome = await save(submitted);
        if (
          (outcome.status !== 'changed' && outcome.status !== 'no_op') ||
          outcome.confirmed.content !== submitted ||
          revisionRef.current !== revision ||
          finishAttemptRef.current !== attempt ||
          closePreparationRef.current.binding !== binding ||
          closePreparationRef.current.save !== save ||
          !binding.current()
        )
          return false;
        finalSaveRef.current?.cancel();
        finalSaveRef.current = null;
        closeApprovalRef.current = { revision, attempt, binding, save };
        return true;
      },
    });
    closeOwnerRef.current = own;
    return () => own.retire();
  }, [documentId, sourcePath, draftRef, revisionRef, finishAttemptRef, timerRef, finalSaveRef]);

  return closeOwnerRef;
}
