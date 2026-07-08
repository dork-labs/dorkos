import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { Check, Pencil } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import type { UiCanvasContent } from '@dorkos/shared/types';
import { useAppStore, useTheme, useTransport } from '@/layers/shared/model';
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

interface CanvasFileContentProps {
  /** File canvas content variant. */
  content: Extract<UiCanvasContent, { type: 'file' }>;
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
export function CanvasFileContent({ content }: CanvasFileContentProps) {
  const transport = useTransport();
  const cwd = useAppStore((s) => s.selectedCwd);
  const setEditing = useAppStore((s) => s.setActiveDocumentEditing);
  const { theme } = useTheme();

  const { data, error, isLoading } = useQuery({
    queryKey: ['canvas-file', cwd, content.sourcePath],
    enabled: cwd !== null,
    queryFn: () => transport.readFileContent(cwd as string, content.sourcePath),
    staleTime: 30_000,
    retry: false,
  });

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
  // on-disk bytes) so edit state + save baseline never straddle two documents.
  return (
    <FileEditor
      key={`${content.sourcePath}:${data.hash}`}
      content={content}
      cwd={cwd}
      loaded={data.content}
      theme={theme === 'dark' ? 'dark' : 'light'}
      setEditing={setEditing}
    />
  );
}

interface FileEditorProps {
  content: Extract<UiCanvasContent, { type: 'file' }>;
  cwd: string;
  loaded: string;
  theme: 'light' | 'dark';
  setEditing: (editing: boolean) => void;
}

/** The editor surface for a loaded file (mounted fresh per loaded document). */
function FileEditor({ content, cwd, loaded, theme, setEditing }: FileEditorProps) {
  const editable = content.readOnly !== true;
  const markdown = isMarkdown(content.sourcePath, content.language);

  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState(loaded);

  const fileSave = useCanvasFileSave({
    sourcePath: content.sourcePath,
    cwd,
    loadedContent: loaded,
  });

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draftRef = useRef(draft);
  const saveRef = useRef(fileSave.save);
  useEffect(() => {
    draftRef.current = draft;
    saveRef.current = fileSave.save;
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
    setIsEditing(true);
    setEditing(true);
  };
  const exitEdit = () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
      void saveRef.current(draftRef.current);
    }
    setIsEditing(false);
    setEditing(false);
  };

  // Flush a pending save on unmount (canvas closed / document switched mid-edit).
  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        void saveRef.current(draftRef.current);
      }
    };
  }, []);

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
          <span className="text-muted-foreground mt-3 text-xs" aria-live="polite">
            {statusLabel}
          </span>
        )}
        {editable && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="text-muted-foreground hover:text-foreground mt-2"
            onClick={isEditing ? exitEdit : enterEdit}
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
