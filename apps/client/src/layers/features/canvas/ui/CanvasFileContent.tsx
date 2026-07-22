import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { Check, Pencil, RotateCw } from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { FileContentResponse, UiCanvasContent } from '@dorkos/shared/types';
import { cn } from '@/layers/shared/lib';
import { useAppStore, useResolvedTheme, useTransport } from '@/layers/shared/model';
import { Button } from '@/layers/shared/ui';
import { useCanvasFileSave } from '../model/use-canvas-file-save';

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
      return "This file doesn't exist.";
    case 'NOT_A_FILE':
      return 'This path is a directory, not a file.';
    case 'TOO_LARGE':
      return 'This file is too large to open here.';
    case 'BINARY_FILE':
      return "This file isn't text and can't be shown in the editor.";
    default:
      return "This file couldn't be loaded.";
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
      return "Couldn't save";
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
  const [editSession, setEditSession] = useState<{ pinnedHash: string } | null>(null);
  const handleEditingChange = (editing: boolean) => {
    setEditSession(editing && data ? { pinnedHash: data.hash } : null);
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

  // Remount the editor when the loaded document identity changes (path or the
  // on-disk bytes) so edit state + save baseline never straddle two documents —
  // except mid-edit, where the pinned hash keeps the mounted editor stable.
  const mountHash = editSession?.pinnedHash ?? data.hash;

  return (
    <FileEditor
      key={`${content.sourcePath}:${mountHash}`}
      content={content}
      documentId={documentId}
      cwd={cwd}
      loaded={data.content}
      theme={resolvedTheme}
      isEditing={editSession !== null}
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
  theme,
  isEditing,
  onEditingChange,
  setDocumentEditing,
}: FileEditorProps) {
  const editable = content.readOnly !== true;
  const markdown = isMarkdown(content.sourcePath, content.language);
  const queryClient = useQueryClient();

  const [draft, setDraft] = useState(loaded);

  const fileSave = useCanvasFileSave({
    sourcePath: content.sourcePath,
    cwd,
    loadedContent: loaded,
  });

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draftRef = useRef(draft);
  const saveRef = useRef(fileSave.save);
  const onEditingChangeRef = useRef(onEditingChange);
  useEffect(() => {
    draftRef.current = draft;
    saveRef.current = fileSave.save;
    onEditingChangeRef.current = onEditingChange;
  });

  const handleChange = useCallback((next: string) => {
    setDraft(next);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      void saveRef.current(draftRef.current);
    }, AUTOSAVE_DELAY_MS);
  }, []);

  const enterEdit = () => {
    setDraft(loaded);
    onEditingChange(true);
    setDocumentEditing(documentId, true);
  };
  const exitEdit = async () => {
    // Cancel the debounce and flush the latest draft, AWAITING the write so the
    // view renders exactly what was saved — no flash of pre-edit content. `save`
    // is a no-op when the draft already matches the tracked base.
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const outcome = await saveRef.current(draftRef.current);
    // The draft did NOT land on disk: leaving edit mode would silently discard
    // it. A conflict is owned by the banner's Reload / Overwrite; an error keeps
    // the "Couldn't save" label up next to the checkmark so the user can retry.
    if (outcome === 'conflict' || outcome === 'error') return;

    // Reflect the just-saved bytes into the read cache so exiting shows them. We
    // deferred every mid-edit sync to here on purpose: writing a new hash into
    // the cache re-keys the editor (mounted by `${sourcePath}:${hash}`) and would
    // remount it — fine now that we're leaving edit mode, unacceptable mid-edit.
    const base = fileSave.getConfirmedBase();
    if (base.hash !== null && base.content === draftRef.current) {
      queryClient.setQueryData<FileContentResponse>(
        fileContentQueryKey(cwd, content.sourcePath),
        (prev) => (prev ? { ...prev, content: base.content, hash: base.hash as string } : prev)
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

  const statusLabel = saveStatusLabel(fileSave.status);
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
        {!isEditing && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
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
            size="icon"
            className="text-muted-foreground hover:text-foreground mt-2"
            onClick={isEditing ? () => void exitEdit() : enterEdit}
            aria-label={isEditing ? 'Finish editing' : 'Edit file'}
          >
            {isEditing ? <Check className="size-4" /> : <Pencil className="size-4" />}
          </Button>
        )}
      </div>

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
