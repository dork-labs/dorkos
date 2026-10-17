import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Check, Pencil, RotateCw } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import type { FileContentResponse, UiCanvasContent } from '@dorkos/shared/types';
import { sameCanvasDocIncarnation } from '@dorkos/shared/canvas-doc-frame-wire';
import { cn } from '@/layers/shared/lib';
import { Button } from '@/layers/shared/ui';
import { useDocWikiLinks } from '@/layers/features/docs';
import { useCanvasFileSave } from '../../model/use-canvas-file-save';
import { useCanvasDocumentClosePreparation } from '../../model/file-save/use-document-close';
import type { FileSaveBinding } from '../../model/file-save/receipt-operation';
import { fileContentQueryKey } from '../../model/file-save/content-query';
import { useFileSaveRecovery } from '../../model/file-save/use-file-save-recovery';
import { FileSaveRecoveryPanel } from './FileSaveRecoveryPanel';
// Lazy: the CodeMirror chunk (editor core + on-demand language grammar) and the
// Blintz chunk load only when a file document first renders — never for the main
// bundle. Named exports mapped to default for React.lazy.
const CodeMirrorEditor = lazy(() =>
  import('../CodeMirrorEditor').then((m) => ({ default: m.CodeMirrorEditor }))
);
const BlintzCanvas = lazy(() =>
  import('../BlintzCanvas').then((m) => ({ default: m.BlintzCanvas }))
);

/** Autosave debounce, matching the markdown canvas. */
const AUTOSAVE_DELAY_MS = 500;

/** Whether a path (or explicit hint) denotes a markdown document → the rich editor. */
function isMarkdown(sourcePath: string, language?: string): boolean {
  return language === 'markdown' || /\.(md|markdown|mdx)$/i.test(sourcePath);
}

/** The muted save-state line shown next to the edit toggle. */
function saveStatusLabel(status: ReturnType<typeof useCanvasFileSave>['status']): string | null {
  switch (status) {
    case 'saving':
      return 'Saving…';
    case 'saved':
      return 'Saved';
    case 'error':
      return 'Couldn’t save';
    case 'uncertain':
      return 'Save not confirmed';
    default:
      return null;
  }
}

export interface FileEditorProps {
  fileSaveObservation?: 'pending' | 'ready' | 'unavailable';
  recoveryBinding?: FileSaveBinding;
  observedBinding?: FileSaveBinding;
  content: Extract<UiCanvasContent, { type: 'file' }>;
  documentId: string;
  cwd: string;
  loaded: string;
  theme: 'light' | 'dark';
  /** Edit mode, owned by the parent (it gates the editor's mount key). */
  isEditing: boolean;
  /** Reports edit-mode transitions up so the parent can pin/unpin the mount key. */
  onEditingChange: (editing: boolean) => void;
  setDocumentEditing: (id: string, editing: boolean) => void;
}

/** The editor surface for a loaded file (mounted fresh per loaded document). */
export function FileEditor({
  content,
  documentId,
  cwd,
  loaded,
  theme,
  isEditing,
  onEditingChange,
  setDocumentEditing,
  observedBinding,
  fileSaveObservation = 'unavailable',
  recoveryBinding,
}: FileEditorProps) {
  const editable = content.readOnly !== true;
  const markdown = isMarkdown(content.sourcePath, content.language);
  const queryClient = useQueryClient();

  const [draft, setDraft] = useState(loaded);
  const [documentSaveBinding, setDocumentSaveBinding] = useState<FileSaveBinding>();
  const observedBindingRef = useRef(observedBinding);
  useLayoutEffect(() => {
    observedBindingRef.current = observedBinding;
  }, [observedBinding]);

  const fileSave = useCanvasFileSave({
    documentId,
    sourcePath: content.sourcePath,
    cwd,
    loadedContent: loaded,
    documentSaveBinding,
    documentRecoveryBinding: recoveryBinding,
  });

  const recovery = useFileSaveRecovery(fileSave.recovery, fileSaveObservation, recoveryBinding);
  // Wiki links to the other docs in this space (Docs experiment; undefined while off).
  const wikiLinks = useDocWikiLinks({
    cwd,
    sourcePath: markdown ? content.sourcePath : null,
    saved: fileSave.status === 'saved',
  });
  const editorActive = useRef(false);
  const editingRef = useRef(isEditing);
  useLayoutEffect(() => {
    editorActive.current = true;
    editingRef.current = isEditing;
    return () => {
      editorActive.current = false;
    };
  }, [isEditing]);

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draftRef = useRef(draft);
  const editRevisionRef = useRef(0);
  const finishAttemptRef = useRef(0);
  const saveRef = useRef(fileSave.save);
  const prepareFinalRef = useRef(fileSave.prepareFinalSave);
  const waitForCloseDrainRef = useRef(fileSave.waitForCloseDrain);
  const finalSaveRef = useRef<ReturnType<typeof fileSave.prepareFinalSave>>(null);
  const onEditingChangeRef = useRef(onEditingChange);
  const closeOwnerRef = useCanvasDocumentClosePreparation({
    documentId,
    sourcePath: content.sourcePath,
    binding: documentSaveBinding,
    save: fileSave.save,
    draftRef,
    revisionRef: editRevisionRef,
    finishAttemptRef,
    timerRef,
    finalSaveRef,
    invalidateConfirmedFile: () => {
      void queryClient
        .invalidateQueries({
          queryKey: fileContentQueryKey(cwd, content.sourcePath),
        })
        .catch(() => undefined);
    },
  });
  useEffect(() => {
    draftRef.current = draft;
    saveRef.current = fileSave.save;
    prepareFinalRef.current = fileSave.prepareFinalSave;
    waitForCloseDrainRef.current = fileSave.waitForCloseDrain;
    onEditingChangeRef.current = onEditingChange;
  });

  const handleChange = useCallback((next: string) => {
    editRevisionRef.current += 1;
    draftRef.current = next;
    setDraft(next);
    finalSaveRef.current?.cancel();
    finalSaveRef.current = prepareFinalRef.current(next);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      void saveRef.current(draftRef.current);
    }, AUTOSAVE_DELAY_MS);
  }, []);

  const enterEdit = () => {
    if (
      recovery.editBlocked ||
      fileSaveObservation === 'pending' ||
      (fileSaveObservation === 'ready' && !observedBindingRef.current?.current())
    )
      return;
    // Capture once per edit session. Metadata arriving later cannot retire a draft.
    const observed = observedBindingRef.current;
    const incarnation = observed && Object.freeze({ ...observed.incarnation });
    setDocumentSaveBinding(
      observed?.current() && incarnation
        ? {
            incarnation,
            current: () => {
              const latest = observedBindingRef.current;
              return (
                !!latest &&
                sameCanvasDocIncarnation(incarnation, latest.incarnation) &&
                latest.current()
              );
            },
          }
        : undefined
    );
    editRevisionRef.current += 1;
    draftRef.current = loaded;
    setDraft(loaded);
    onEditingChange(true);
    setDocumentEditing(documentId, true);
  };
  const exitEdit = async () => {
    // Cancel the debounce and flush the latest draft, AWAITING the write so the
    // view renders exactly what the server acknowledged. A server no-op still
    // confirms this request's bytes and hash.
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const submitted = draftRef.current;
    const revision = editRevisionRef.current;
    const attempt = ++finishAttemptRef.current;
    const outcome = await saveRef.current(submitted);
    // The draft did NOT land on disk: leaving edit mode would silently discard
    // it. A conflict is owned by the banner's Reload / Overwrite; an error keeps
    // the "Couldn't save" label up next to the checkmark so the user can retry.
    if (outcome.status !== 'changed' && outcome.status !== 'no_op') return;
    // Acknowledging an older write must not close a newer edit or finish attempt.
    if (
      editRevisionRef.current !== revision ||
      finishAttemptRef.current !== attempt ||
      outcome.confirmed.content !== submitted
    )
      return;

    // Reflect the just-saved bytes into the read cache so exiting shows them. We
    // deferred every mid-edit sync to here on purpose: writing a new hash into
    // the cache re-keys the editor (mounted by `${sourcePath}:${hash}`) and would
    // remount it — fine now that we're leaving edit mode, unacceptable mid-edit.
    const base = outcome.confirmed;
    if (base.content === draftRef.current) {
      queryClient.setQueryData<FileContentResponse>(
        fileContentQueryKey(cwd, content.sourcePath),
        (prev) => (prev ? { ...prev, content: base.content, hash: base.hash } : prev)
      );
    }
    onEditingChange(false);
    setDocumentEditing(documentId, false);
  };

  // Refetch the file from disk (covers an agent editing it while you view). Only
  // offered outside edit mode — mid-edit, the 409 Reload / Overwrite flow owns
  // the concurrent-change story, so a blind refetch there would fight the draft.
  const handleRefresh = () => {
    void queryClient.invalidateQueries({
      queryKey: fileContentQueryKey(cwd, content.sourcePath),
    });
  };

  // The edit can also end from OUTSIDE: "Reload" on the held-update banner takes
  // the agent's version, and the parent's derived `isEditing` goes false. Cancel
  // the pending autosave when that happens rather than letting it flush a draft
  // the person just gave up. Every other exit path has already nulled the timer,
  // so this is a no-op on all of them.
  useEffect(() => {
    if (isEditing) return;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    finalSaveRef.current?.cancel();
    finalSaveRef.current = null;
  }, [isEditing]);

  // Flush a pending save AND release this document's edit-protection on unmount
  // (canvas closed / tab switched mid-edit). Because the setter is id-scoped, it
  // clears THIS document's flag even though the active document may already have
  // changed — otherwise the doc would stay locked against agent updates forever.
  useEffect(() => {
    const closeOwner = closeOwnerRef.current;
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      const drain = finalSaveRef.current?.flush();
      const content = draftRef.current;
      closeOwner?.settleRetirement(
        Promise.resolve(drain).then(() => waitForCloseDrainRef.current(content))
      );
      finalSaveRef.current = null;
      setDocumentEditing(documentId, false);
      // Unpin the parent's mount key too — without this, an unmount that isn't
      // exit-edit (e.g. the document's sourcePath changing mid-edit) would leave
      // the parent editing=true and pinned to a hash no editor is showing.
      onEditingChangeRef.current(false);
    };
    // These dependencies are stable: documentId is fixed per document, the
    // setter is a stable action, and closeOwnerRef is the useRef object returned
    // by useCanvasDocumentClosePreparation. This cleanup still runs on unmount.
  }, [documentId, setDocumentEditing, closeOwnerRef]);

  const loadRecoveredCurrent = async () => {
    if (isEditing || !editorActive.current || recovery.editBlocked) return;
    const revision = editRevisionRef.current;
    const result = await recovery.inspectCurrent();
    if (
      result.status !== 'observed' ||
      !editorActive.current ||
      editingRef.current ||
      editRevisionRef.current !== revision ||
      !fileSave.recovery.current()
    )
      return;
    queryClient.setQueryData<FileContentResponse>(
      fileContentQueryKey(cwd, content.sourcePath),
      (previous) => (previous ? { ...previous, ...result.value } : previous)
    );
  };

  const handleReload = () => {
    const adopted = fileSave.adoptDisk();
    if (adopted != null) setDraft(adopted);
  };
  const handleOverwrite = () => {
    void fileSave.overwrite(draftRef.current);
  };

  const statusLabel =
    fileSave.status === 'saved'
      ? fileSave.confirmedContent !== draft
        ? 'Unsaved changes'
        : fileSave.documentReceipt
          ? 'Save recorded'
          : 'Saved to file'
      : saveStatusLabel(fileSave.status);
  const value = isEditing ? draft : loaded;

  return (
    <div className="relative flex h-full flex-col">
      <div className="sticky top-0 z-10 flex h-0 items-start justify-end gap-2 pr-2">
        {editable && statusLabel && (
          <span
            className={cn(
              'mt-3 text-xs',
              // A failed save must not read as ambient status — it is the only
              // signal that the checkmark refused to leave edit mode.
              fileSave.status === 'error' ? 'text-destructive' : 'text-muted-foreground'
            )}
            aria-live="polite"
          >
            {statusLabel}
          </span>
        )}
        {!isEditing && fileSaveObservation === 'pending' && (
          <span role="status">Checking document…</span>
        )}
        {!isEditing && (
          <Button
            type="button"
            variant="ghost"
            size="icon-md"
            className="text-muted-foreground hover:text-foreground mt-2"
            onClick={handleRefresh}
            aria-label="Refresh from disk"
          >
            <RotateCw className="size-4" />
          </Button>
        )}
        {editable && (
          <Button
            type="button"
            variant="ghost"
            size="icon-md"
            className="text-muted-foreground hover:text-foreground mt-2"
            onClick={isEditing ? () => void exitEdit() : enterEdit}
            aria-label={isEditing ? 'Finish editing' : 'Edit file'}
            disabled={!isEditing && (fileSaveObservation === 'pending' || recovery.editBlocked)}
            data-document-save-observation={fileSaveObservation}
          >
            {isEditing ? <Check className="size-4" /> : <Pencil className="size-4" />}
          </Button>
        )}
      </div>

      <FileSaveRecoveryPanel
        recovery={recovery}
        editing={isEditing}
        loadCurrent={() => void loadRecoveredCurrent()}
      />

      {fileSave.status === 'uncertain' && (
        <div role="status" className="mx-2 mt-2 flex items-center gap-2 text-sm">
          <span>Save not confirmed. Retry the original save before saving another draft.</span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => void fileSave.retryUnconfirmed()}
          >
            Retry original save
          </Button>
        </div>
      )}
      {fileSave.status === 'conflict' && (
        <div className="bg-destructive/10 text-destructive mx-2 mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md px-3 py-2 text-sm">
          <span className="flex-1">This file changed on disk since you opened it.</span>
          <Button type="button" variant="ghost" size="sm" className="h-7" onClick={handleReload}>
            Reload
          </Button>
          <Button
            type="button"
            variant="destructive"
            size="sm"
            className="h-7"
            onClick={handleOverwrite}
          >
            Overwrite
          </Button>
        </div>
      )}

      <div className="min-h-0 flex-1">
        <Suspense
          fallback={<div className="text-muted-foreground p-4 text-sm">Loading editor…</div>}
        >
          {markdown ? (
            <div className="px-2 pb-6">
              <BlintzCanvas
                value={value}
                editable={isEditing}
                onChange={isEditing ? handleChange : undefined}
                wikiLinks={wikiLinks}
              />
            </div>
          ) : (
            <CodeMirrorEditor
              value={value}
              editable={isEditing}
              filename={content.sourcePath}
              languageHint={content.language}
              theme={theme}
              onChange={isEditing ? handleChange : undefined}
            />
          )}
        </Suspense>
      </div>
    </div>
  );
}
