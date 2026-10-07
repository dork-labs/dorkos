import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { Check, Pencil, RotateCw } from 'lucide-react';
import type { CanvasChannelSelectionRequest } from '@dorkos/shared/canvas-channel-schemas';
import {
  captureCurrentEditorSelection,
  requireCurrentEditorSelection,
} from '../model/editor-selection-source';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { FileContentResponse, UiCanvasContent } from '@dorkos/shared/types';
import { cn } from '@/layers/shared/lib';
import { useAppStore, useResolvedTheme, useTransport } from '@/layers/shared/model';
import { Button } from '@/layers/shared/ui';
import { useCanvasFileSave } from '../model/use-canvas-file-save';
import { useNativeCheckboxWrite } from '../model/use-native-checkbox-write';
import { currentCheckboxSource, hashCheckboxSource } from '../model/native-checkbox-source';
import type { MarkdownSourcePort, SourceTaskToggleRequest } from 'blintz';

// Lazy: the CodeMirror chunk (editor core + on-demand language grammar) and the
// Blintz chunk load only when a file document first renders — never for the main
// bundle. Named exports mapped to default for React.lazy.
const CodeMirrorEditor = lazy(() =>
  import('./CodeMirrorEditor').then((m) => ({ default: m.CodeMirrorEditor }))
);
const BlintzCanvas = lazy(() =>
  import('./BlintzCanvas').then((m) => ({ default: m.BlintzCanvas }))
);

/** Autosave debounce, matching the markdown canvas. */
const AUTOSAVE_DELAY_MS = 500;

/**
 * React-query key for a file's loaded content + hash. Shared by the loader, the
 * post-save cache sync (so leaving edit mode shows what was written), and the
 * refresh-from-disk action — one key, one cache entry, no drift.
 */
function fileContentQueryKey(cwd: string, sourcePath: string) {
  return ['canvas-file', cwd, sourcePath] as const;
}

interface CanvasFileContentProps {
  /** File canvas content variant. */
  content: Extract<UiCanvasContent, { type: 'file' }>;
  /** Id of the canvas document this viewer belongs to (owns its edit-protection flag). */
  documentId: string;
}

/** Whether a path (or explicit hint) denotes a markdown document → the rich editor. */
function isMarkdown(sourcePath: string, language?: string): boolean {
  return language === 'markdown' || /\.(md|markdown|mdx)$/i.test(sourcePath);
}

/** Friendly message for a file-load failure, keyed by the transport's coded error. */
function loadErrorMessage(error: unknown): string {
  const code = (error as { code?: string } | null)?.code;
  switch (code) {
    case 'NOT_FOUND':
      return 'This file doesn’t exist.';
    case 'NOT_A_FILE':
      return 'This path is a directory, not a file.';
    case 'TOO_LARGE':
      return 'This file is too large to open here.';
    case 'BINARY_FILE':
      return 'This file isn’t text, so the editor can’t show it.';
    default:
      return 'This file couldn’t be loaded.';
  }
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
    default:
      return null;
  }
}

/**
 * File-backed canvas viewer/editor. Loads the file's text via the file-service
 * (cwd-confined), renders it read-only by default, and offers an edit toggle
 * that saves back through the optimistic-concurrency flow (409 → Reload /
 * Overwrite). Markdown files render in the rich Blintz editor; every other
 * text/code file renders in CodeMirror. While editing, the active document's
 * edit-protection flag holds agent pushes (ADR-0292).
 */
export function CanvasFileContent({ content, documentId }: CanvasFileContentProps) {
  const transport = useTransport();
  const cwd = useAppStore((s) => s.selectedCwd);
  const setDocumentEditing = useAppStore((s) => s.setDocumentEditing);
  const documentEditing = useAppStore(
    (s) => s.openDocuments.find((d) => d.id === documentId)?.editing ?? false
  );
  const resolvedTheme = useResolvedTheme();

  const { data, error, isLoading } = useQuery({
    queryKey: fileContentQueryKey(cwd as string, content.sourcePath),
    enabled: cwd !== null,
    queryFn: () => transport.readFileContent(cwd as string, content.sourcePath),
    staleTime: 30_000,
    retry: false,
  });

  // The edit session lives HERE (not in FileEditor) because it gates the
  // editor's mount key: while a session is open, the key stays pinned to the
  // hash the session opened with, so a refetch landing mid-edit (window
  // refocus, or Refresh clicked just before the pencil) updates the cache
  // WITHOUT remounting the editor and discarding the draft. Closing the
  // session unpins, letting the exit-time cache resync re-key the editor with
  // the just-saved bytes.
  const [checkboxMountHash, setCheckboxMountHash] = useState<string | null>(null);
  const [editSession, setEditSession] = useState<{ pinnedHash: string } | null>(null);
  const handleEditingChange = (editing: boolean) => {
    setEditSession(editing && data ? { pinnedHash: data.hash } : null);
    if (!editing) setCheckboxMountHash(null);
  };

  if (cwd === null) {
    return <FileMessage>Open a session to view files.</FileMessage>;
  }
  if (isLoading) {
    return <FileMessage>Loading file…</FileMessage>;
  }
  if (error || !data) {
    return <FileMessage>{loadErrorMessage(error)}</FileMessage>;
  }

  // Edit mode is the AND of this viewer's own session and the store's flag for
  // this document, derived rather than mirrored. The flag can be cleared from
  // OUTSIDE — "Reload" on the held-update banner takes the agent's version and
  // ends the edit — and deriving is what lets that land on the next render
  // instead of through a state-sync effect.
  const editing = editSession !== null && documentEditing;

  // Remount the editor when the loaded document identity changes (path or the
  // on-disk bytes) so edit state + save baseline never straddle two documents —
  // except mid-edit, where the pinned hash keeps the mounted editor stable. A
  // session the store has already ended pins nothing, so an edit ended from
  // outside cannot leave the key stuck on a hash no editor is showing.
  const mountHash = (editing ? editSession?.pinnedHash : null) ?? checkboxMountHash ?? data.hash;

  return (
    <FileEditor
      key={`${documentId}:${content.sourcePath}:${mountHash}`}
      content={content}
      documentId={documentId}
      cwd={cwd}
      loaded={data.content}
      fileVersion={data.hash}
      onCheckboxAcknowledged={() => setCheckboxMountHash(mountHash)}
      onCheckboxReloaded={() => setCheckboxMountHash(null)}
      theme={resolvedTheme}
      isEditing={editing}
      onEditingChange={handleEditingChange}
      setDocumentEditing={setDocumentEditing}
    />
  );
}

interface FileEditorProps {
  content: Extract<UiCanvasContent, { type: 'file' }>;
  documentId: string;
  cwd: string;
  loaded: string;
  fileVersion: string;
  onCheckboxAcknowledged: () => void;
  onCheckboxReloaded: () => void;
  theme: 'light' | 'dark';
  /** Edit mode, owned by the parent (it gates the editor's mount key). */
  isEditing: boolean;
  /** Reports edit-mode transitions up so the parent can pin/unpin the mount key. */
  onEditingChange: (editing: boolean) => void;
  setDocumentEditing: (id: string, editing: boolean) => void;
}

/** The editor surface for a loaded file (mounted fresh per loaded document). */
function FileEditor({
  content,
  documentId,
  cwd,
  loaded,
  fileVersion,
  onCheckboxAcknowledged,
  onCheckboxReloaded,
  theme,
  isEditing,
  onEditingChange,
  setDocumentEditing,
}: FileEditorProps) {
  const editable = content.readOnly !== true;
  const markdown = isMarkdown(content.sourcePath, content.language);
  const queryClient = useQueryClient();
  const transport = useTransport();
  const checkbox = useNativeCheckboxWrite(documentId);
  const sourcePort = useRef<MarkdownSourcePort | null>(null);
  const taskPending = useRef<{
    request: SourceTaskToggleRequest;
    text: string;
    confirmed: string;
  } | null>(null);
  const checkboxPreparing = useRef(false);
  const [checkboxBusy, setCheckboxBusy] = useState(false);
  const [checkboxError, setCheckboxError] = useState<string | null>(null);
  const [selectionReady, setSelectionReady] = useState(false);
  const [selectionBusy, setSelectionBusy] = useState(false);
  const [selectionNotice, setSelectionNotice] = useState<string | null>(null);
  const selectionMounted = useRef(false);
  const selectionOwner = useRef({
    documentId,
    cwd,
    path: content.sourcePath,
    transport,
    retired: false,
    preparing: false,
  });
  const selectionCommand = useRef<{
    request: CanvasChannelSelectionRequest;
    port: MarkdownSourcePort;
    source: { content: string; hash: string };
  } | null>(null);
  if (
    selectionOwner.current.documentId !== documentId ||
    selectionOwner.current.cwd !== cwd ||
    selectionOwner.current.path !== content.sourcePath ||
    selectionOwner.current.transport !== transport
  ) {
    selectionOwner.current.retired = true;
    selectionOwner.current = {
      documentId,
      cwd,
      path: content.sourcePath,
      transport,
      retired: false,
      preparing: false,
    };
    selectionCommand.current = null;
    if (selectionBusy) setSelectionBusy(false);
    if (selectionReady) setSelectionReady(false);
    if (selectionNotice !== null) setSelectionNotice(null);
  }
  useEffect(() => {
    selectionMounted.current = true;
    return () => {
      selectionMounted.current = false;
    };
  }, []);

  const [draft, setDraft] = useState(loaded);

  const fileSave = useCanvasFileSave({
    sourcePath: content.sourcePath,
    cwd,
    loadedContent: loaded,
    documentId,
    initialHash: fileVersion,
  });

  const acceptCheckbox = async (result: Awaited<ReturnType<typeof checkbox.write>>) => {
    const pending = taskPending.current,
      port = sourcePort.current;
    if (!pending || !port || (result.status !== 'changed' && result.status !== 'no_op')) return;
    const confirmed = result.status === 'no_op' ? pending.text : pending.confirmed;
    if ((await hashCheckboxSource(confirmed)) !== result.fileVersion)
      throw new Error(
        'The checkbox acknowledgement does not match the source bytes. Reload and review this task.'
      );
    const applied = port.applyConfirmedTaskToggle(pending.request, confirmed);
    if (applied.kind !== 'mapped')
      throw new Error('This editor changed while the task was saved. Reload and review this task.');
    if (
      !fileSave.adoptConfirmedCheckbox(pending.text, {
        content: confirmed,
        hash: result.fileVersion,
      })
    )
      throw new Error(
        'The file draft changed while the task was saved. Reload and review this task.'
      );
    draftRef.current = confirmed;
    setDraft(confirmed);
    onCheckboxAcknowledged();
    queryClient.setQueryData<FileContentResponse>(
      fileContentQueryKey(cwd, content.sourcePath),
      (previous) =>
        previous ? { ...previous, content: confirmed, hash: result.fileVersion } : previous
    );
    taskPending.current = null;
  };
  const toggleTask = async (request: SourceTaskToggleRequest) => {
    const port = sourcePort.current;
    if (
      !editable ||
      !isEditing ||
      !port ||
      checkboxBusy ||
      checkboxPreparing.current ||
      taskPending.current ||
      !fileSave.canWriteCheckbox(draftRef.current)
    )
      return;
    checkboxPreparing.current = true;
    setCheckboxBusy(true);
    setCheckboxError(null);
    try {
      const source = currentCheckboxSource(port, request);
      const confirmedBase = fileSave.getConfirmedBase();
      if (
        source.text !== draftRef.current ||
        source.text !== confirmedBase.content ||
        (confirmedBase.hash === null && confirmedBase.content !== loaded)
      )
        throw new Error('Save or reload the current draft before changing a task.');
      // A confirmed autosave advances this baseline without remounting the editor.
      // Only the untouched initial baseline may use the loader's original hash.
      const expectedFileVersion = confirmedBase.hash ?? fileVersion;
      const textHash = await hashCheckboxSource(source.lineText);
      if (port.generation() !== request.generation)
        throw new Error('This task changed before it could be saved.');
      const currentBase = fileSave.getConfirmedBase();
      if (
        source.text !== draftRef.current ||
        currentBase.content !== confirmedBase.content ||
        currentBase.hash !== confirmedBase.hash ||
        !fileSave.canWriteCheckbox(source.text)
      )
        throw new Error('Finish the current file save before changing a task.');
      // Cancel only an unsubmitted autosave of these identical confirmed bytes.
      // A changed draft or already-started save retains its own ordinary save ownership.
      if (timerRef.current && draftRef.current === source.text) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      taskPending.current = { request, text: source.text, confirmed: source.confirmed };
      const result = await checkbox.write({
        line: request.task.line,
        done: request.done,
        textHash,
        expectedFileVersion,
      });
      await acceptCheckbox(result);
    } catch (cause) {
      setCheckboxError(
        cause instanceof Error ? cause.message : 'The checkbox write could not be confirmed.'
      );
    } finally {
      checkboxPreparing.current = false;
      setCheckboxBusy(false);
    }
  };
  const retryCheckbox = async () => {
    if (checkboxBusy) return;
    setCheckboxBusy(true);
    setCheckboxError(null);
    try {
      await acceptCheckbox(await checkbox.retry());
    } catch (cause) {
      setCheckboxError(
        cause instanceof Error ? cause.message : 'The checkbox write could not be confirmed.'
      );
    } finally {
      setCheckboxBusy(false);
    }
  };
  const reloadCheckboxConflict = async () => {
    const result = checkbox.receipt;
    if (!result || !['conflict', 'changed', 'no_op'].includes(result.status) || checkboxBusy)
      return;
    setCheckboxBusy(true);
    try {
      const fresh = await transport.readFileContent(cwd, content.sourcePath);
      if (
        !fileSave.adoptConfirmedCheckbox(fileSave.getConfirmedBase().content, {
          content: fresh.content,
          hash: fresh.hash,
        })
      )
        throw new Error('Finish the current file save before reloading.');
      if (result.status === 'conflict' && !checkbox.resolveConflictReload(result.eventId))
        throw new Error('The checkbox conflict changed before reload.');
      taskPending.current = null;
      setCheckboxError(null);
      draftRef.current = fresh.content;
      setDraft(fresh.content);
      onCheckboxReloaded();
      queryClient.setQueryData(fileContentQueryKey(cwd, content.sourcePath), fresh);
    } catch (cause) {
      setCheckboxError(cause instanceof Error ? cause.message : 'The file could not be reloaded.');
    } finally {
      setCheckboxBusy(false);
    }
  };

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draftRef = useRef(draft);
  const editRevisionRef = useRef(0);
  const finishAttemptRef = useRef(0);
  const saveRef = useRef(fileSave.save);
  const onEditingChangeRef = useRef(onEditingChange);
  useEffect(() => {
    draftRef.current = draft;
    saveRef.current = fileSave.save;
    onEditingChangeRef.current = onEditingChange;
  });

  // Ordinary text edits invalidate raw locations. Rebind only bytes confirmed by
  // this save owner and still present in the same live model; bindSource neither
  // replaces the document nor changes its selection/history.
  useEffect(() => {
    const port = sourcePort.current;
    if (
      !port ||
      fileSave.status !== 'saved' ||
      checkboxPreparing.current ||
      taskPending.current ||
      !fileSave.canWriteCheckbox(draftRef.current)
    )
      return;
    const base = fileSave.getConfirmedBase();
    if (base.hash === null || base.content !== draftRef.current) return;
    const snapshot = port.snapshot();
    if (snapshot.kind === 'mapped' && snapshot.value.text === base.content) return;
    const generation = port.generation();
    const currentBase = fileSave.getConfirmedBase();
    if (
      sourcePort.current !== port ||
      port.generation() !== generation ||
      currentBase.content !== base.content ||
      currentBase.hash !== base.hash ||
      draftRef.current !== base.content
    )
      return;
    port.bindSource(base.content, generation);
  }, [fileSave, fileSave.status, draft, checkboxBusy]);

  const askSelection = async (retry = false) => {
    const owner = selectionOwner.current;
    if (owner.preparing || selectionBusy || checkboxPreparing.current || taskPending.current)
      return;
    const isCurrent = () =>
      selectionMounted.current && selectionOwner.current === owner && !owner.retired;
    owner.preparing = true;
    setSelectionBusy(true);
    setSelectionNotice('Recording selection…');
    try {
      let command = selectionCommand.current;
      if (!retry) {
        if (command) throw new Error('Retry the same selection before asking again.');
        const port = sourcePort.current;
        const base = fileSave.getConfirmedBase();
        if (
          !port ||
          base.content !== draftRef.current ||
          !fileSave.canWriteCheckbox(base.content) ||
          (base.hash === null && base.content !== loaded)
        )
          throw new Error('Save or reload this selection before asking about it.');
        const source = { content: base.content, hash: base.hash ?? fileVersion };
        const captured = await captureCurrentEditorSelection(port, source);
        if (!isCurrent() || sourcePort.current !== port) return;
        const management = await transport.getCanvasDocManagement(documentId);
        if (!isCurrent() || sourcePort.current !== port) return;
        const currentBase = fileSave.getConfirmedBase();
        if (
          management.documentId !== documentId ||
          currentBase.content !== source.content ||
          (currentBase.hash ?? fileVersion) !== source.hash ||
          draftRef.current !== source.content ||
          !fileSave.canWriteCheckbox(source.content)
        )
          throw new Error('The saved source changed before this selection could be recorded.');
        requireCurrentEditorSelection(port, source, captured);
        const request: CanvasChannelSelectionRequest = {
          documentId,
          expectedGeneration: management.generation,
          eventId: crypto.randomUUID(),
          ...captured,
        };
        if (new TextEncoder().encode(JSON.stringify(request)).byteLength > 16 * 1024)
          throw new Error('Choose a smaller text selection.');
        for (const range of request.ranges) Object.freeze(range);
        Object.freeze(request.ranges);
        Object.freeze(request);
        command = Object.freeze({ request, port, source: Object.freeze(source) });
        selectionCommand.current = command;
      }
      if (!command) throw new Error('The original selection is unavailable.');
      const currentBase = fileSave.getConfirmedBase();
      const snapshot = command.port.snapshot();
      if (
        !isCurrent() ||
        sourcePort.current !== command.port ||
        snapshot.kind !== 'mapped' ||
        snapshot.generation !== command.request.sourceGeneration ||
        snapshot.value.text !== command.source.content ||
        currentBase.content !== command.source.content ||
        (currentBase.hash ?? fileVersion) !== command.source.hash ||
        draftRef.current !== command.source.content ||
        !fileSave.canWriteCheckbox(command.source.content)
      )
        throw new Error(
          'The saved source changed. Review document events before retrying this selection.'
        );
      const result = await transport.askCanvasDocSelection(command.request);
      if (!isCurrent() || selectionCommand.current !== command) return;
      if (result.receipt.id !== command.request.eventId)
        throw new Error('The selection receipt does not match the original request.');
      selectionCommand.current = null;
      setSelectionNotice('Selection recorded. Selected text is context, not instructions.');
    } catch (cause) {
      if (isCurrent())
        setSelectionNotice(
          cause instanceof Error
            ? cause.message
            : 'The selection could not be confirmed. Retry the same selection.'
        );
    } finally {
      owner.preparing = false;
      if (isCurrent()) setSelectionBusy(false);
    }
  };

  const handleChange = useCallback((next: string) => {
    editRevisionRef.current += 1;
    draftRef.current = next;
    setDraft(next);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      void saveRef.current(draftRef.current);
    }, AUTOSAVE_DELAY_MS);
  }, []);

  const enterEdit = () => {
    if (taskPending.current || checkboxBusy) return;
    editRevisionRef.current += 1;
    draftRef.current = loaded;
    setDraft(loaded);
    onEditingChange(true);
    setDocumentEditing(documentId, true);
  };
  const exitEdit = async () => {
    if (taskPending.current || checkboxBusy) return;
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
    if (isEditing || !timerRef.current) return;
    clearTimeout(timerRef.current);
    timerRef.current = null;
  }, [isEditing]);

  // Flush a pending save AND release this document's edit-protection on unmount
  // (canvas closed / tab switched mid-edit). Because the setter is id-scoped, it
  // clears THIS document's flag even though the active document may already have
  // changed — otherwise the doc would stay locked against agent updates forever.
  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        void saveRef.current(draftRef.current);
      }
      setDocumentEditing(documentId, false);
      // Unpin the parent's mount key too — without this, an unmount that isn't
      // exit-edit (e.g. the document's sourcePath changing mid-edit) would leave
      // the parent editing=true and pinned to a hash no editor is showing.
      onEditingChangeRef.current(false);
    };
    // Both deps are stable for a mounted editor (documentId is fixed per canvas
    // document; the setter is a stable zustand action), so this runs on unmount.
  }, [documentId, setDocumentEditing]);

  const handleReload = () => {
    const adopted = fileSave.adoptDisk();
    if (adopted != null) setDraft(adopted);
  };
  const handleOverwrite = () => {
    void fileSave.overwrite(draftRef.current);
  };

  const statusLabel =
    fileSave.status === 'saved' && draft !== fileSave.getConfirmedBase().content
      ? 'Draft not saved'
      : saveStatusLabel(fileSave.status);
  const value = isEditing ? draft : loaded;

  return (
    <div className="relative flex h-full flex-col">
      <div className="sticky top-0 z-10 flex h-0 items-start justify-end gap-2 pr-2">
        {markdown && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={
              selectionBusy || checkboxBusy || (!selectionCommand.current && !selectionReady)
            }
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => {
              void askSelection(selectionCommand.current !== null);
            }}
          >
            {selectionCommand.current ? 'Retry same selection' : 'Ask about selection'}
          </Button>
        )}
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
        {editable && fileSave.pendingDocumentSave && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={checkboxBusy || !fileSave.canRetryDocumentSave}
            onClick={() => {
              void fileSave.retryOriginalSave();
            }}
          >
            Retry original save
          </Button>
        )}
        {!isEditing && (
          <Button
            type="button"
            variant="ghost"
            size="icon-md"
            className="text-muted-foreground hover:text-foreground mt-2"
            onClick={handleRefresh}
            disabled={checkboxBusy || taskPending.current !== null}
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
            disabled={checkboxBusy || taskPending.current !== null}
            aria-label={isEditing ? 'Finish editing' : 'Edit file'}
          >
            {isEditing ? <Check className="size-4" /> : <Pencil className="size-4" />}
          </Button>
        )}
      </div>

      {selectionNotice && (
        <p role="status" aria-live="polite" className="text-muted-foreground mx-2 mt-2 text-sm">
          {selectionNotice}
        </p>
      )}

      {(checkboxBusy ||
        checkboxError ||
        checkbox.state === 'conflict' ||
        checkbox.state === 'review') && (
        <div
          role="status"
          className={cn(
            'bg-muted mx-2 mt-2 rounded-md px-3 py-2 text-sm',
            // A pending announcement must not insert/remove height above the
            // same editor viewport when its acknowledgement settles.
            checkboxBusy && 'pointer-events-none absolute inset-x-0 top-8 z-20'
          )}
        >
          <span>
            {checkboxBusy
              ? 'Saving task…'
              : checkbox.state === 'conflict'
                ? 'This task changed on disk. Reload before another write.'
                : checkbox.state === 'review'
                  ? 'This task write needs review. It will not be repeated automatically.'
                  : checkboxError}
          </span>
          {checkbox.state === 'error' && taskPending.current && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={checkboxBusy}
              onClick={() => void retryCheckbox()}
            >
              Retry same task
            </Button>
          )}
          {checkbox.state === 'saved' && taskPending.current && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={checkboxBusy}
              onClick={() => void reloadCheckboxConflict()}
            >
              Reload saved task from disk
            </Button>
          )}
          {checkbox.state === 'conflict' && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={checkboxBusy}
              onClick={() => void reloadCheckboxConflict()}
            >
              Reload task from disk
            </Button>
          )}
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
            disabled={fileSave.pendingDocumentSave}
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
                // Keep the same task control and editor selection while its response is held.
                // The synchronous preparation/pending guards prevent another task dispatch;
                // source generation and confirmed-base checks refuse an ACK after a draft edit.
                editable={isEditing}
                sourceRevision={fileVersion}
                onSourceReady={(port) => {
                  sourcePort.current = port;
                }}
                onSourceSelection={(selection) => {
                  setSelectionReady(
                    selection.kind === 'mapped' &&
                      selection.value.ranges.some((range) => range.end > range.start)
                  );
                }}
                onTaskToggleRequest={
                  editable
                    ? (request) => {
                        void toggleTask(request);
                      }
                    : undefined
                }
                onChange={isEditing ? handleChange : undefined}
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

/** Centered muted message for empty/error/loading file states. */
function FileMessage({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-muted-foreground flex h-full items-center justify-center p-8 text-center">
      <p>{children}</p>
    </div>
  );
}
