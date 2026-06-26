import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, Pencil } from 'lucide-react';
import type { UiCanvasContent } from '@dorkos/shared/types';
import { useAppStore } from '@/layers/shared/model';
import { Button } from '@/layers/shared/ui';
import { splitFrontmatter, joinFrontmatter } from '../lib/frontmatter';
import { useCanvasFileSave } from '../model/use-canvas-file-save';

// Lazy: the Blintz chunk (Milkdown + ProseMirror + CodeMirror + KaTeX) loads
// only when a markdown canvas first renders, never for url/json canvases or the
// main bundle. The named export is mapped to a default for React.lazy.
const BlintzCanvas = lazy(() =>
  import('./BlintzCanvas').then((m) => ({ default: m.BlintzCanvas }))
);

/** Autosave debounce, matching the app's `use-debounced-input` default. */
const AUTOSAVE_DELAY_MS = 500;

interface CanvasMarkdownContentProps {
  /** Markdown canvas content variant. */
  content: Extract<UiCanvasContent, { type: 'markdown' }>;
  /** Persist edited markdown back to canvas state (keeps the rendered view in sync). */
  onContentChange: (content: UiCanvasContent) => void;
}

/** The muted save-state line shown next to the edit toggle while file-backed. */
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
 * Markdown canvas surface, rendered by a single Blintz editor in two modes:
 * read-only in view and editable in edit, toggled by the pencil/check control.
 *
 * Editing is offered only when the content is file-backed (`sourcePath` is set
 * and a working directory is known); generated markdown stays read-only so the
 * UI never implies a save that has nowhere to go. Edits autosave (debounced)
 * back to the source file through {@link useCanvasFileSave}, with three safety
 * properties: frontmatter is split off before editing and re-glued on save so
 * the editor (which cannot represent it) never corrupts it; agent pushes are
 * ignored while editing (the dispatcher honors `canvasEditing`); and every
 * persist is gated by the session that owned the edit so a draft can never leak
 * into another session. Optimistic concurrency surfaces a conflict when the file
 * changed on disk underneath, rather than silently clobbering it.
 */
export function CanvasMarkdownContent({ content, onContentChange }: CanvasMarkdownContentProps) {
  // The editor only ever sees the body; the frontmatter is preserved verbatim
  // and re-attached on save (Blintz cannot round-trip YAML frontmatter).
  const { frontmatter, body } = useMemo(() => splitFrontmatter(content.content), [content.content]);

  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState(body);

  const canvasSessionId = useAppStore((s) => s.canvasSessionId);
  const setCanvasEditing = useAppStore((s) => s.setCanvasEditing);
  const cwd = useAppStore((s) => s.selectedCwd);

  const fileSave = useCanvasFileSave({
    sourcePath: content.sourcePath,
    cwd,
    loadedContent: content.content,
  });
  const fileBacked = fileSave.canSave;

  // The session that owned the edit, captured when edit mode begins.
  const owningSessionRef = useRef<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Latest values reachable from the debounced timer and the exit/unmount flush
  // without re-subscribing those on every keystroke. Synced after render.
  const draftRef = useRef(draft);
  const frontmatterRef = useRef(frontmatter);
  const contentRef = useRef(content);
  const onContentChangeRef = useRef(onContentChange);
  const saveRef = useRef(fileSave.save);
  useEffect(() => {
    draftRef.current = draft;
    frontmatterRef.current = frontmatter;
    contentRef.current = content;
    onContentChangeRef.current = onContentChange;
    saveRef.current = fileSave.save;
  });

  // Persist an edited body: re-glue the frontmatter, sync the rendered view, and
  // write through to the source file. Gated by the owning session so a stale
  // draft can never land in (or save over) a different session's document.
  const persist = useCallback((bodyMarkdown: string) => {
    if (useAppStore.getState().canvasSessionId !== owningSessionRef.current) return;
    const full = joinFrontmatter(frontmatterRef.current, bodyMarkdown);
    onContentChangeRef.current({ ...contentRef.current, content: full });
    void saveRef.current(full);
  }, []);

  const handleChange = useCallback(
    (markdown: string) => {
      setDraft(markdown);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        // Null the ref before persisting so the exit/unmount flush does not
        // double-write what this timer already saved.
        timerRef.current = null;
        persist(markdown);
      }, AUTOSAVE_DELAY_MS);
    },
    [persist]
  );

  const enterEdit = () => {
    owningSessionRef.current = useAppStore.getState().canvasSessionId;
    setDraft(body);
    setIsEditing(true);
    setCanvasEditing(true);
  };

  const exitEdit = () => {
    // Flush a pending debounced save before leaving edit mode.
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
      persist(draftRef.current);
    }
    setIsEditing(false);
    setCanvasEditing(false);
  };

  // Exit edit mode if the active canvas session changes out from under us (a
  // session switch mid-edit), so the editor remounts fresh for the new session
  // instead of showing a stale draft.
  useEffect(() => {
    if (isEditing && canvasSessionId !== owningSessionRef.current) {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional: drop edit mode when the active canvas session changes (mirrors use-debounced-input's reset-on-key-change)
      setIsEditing(false);
      setCanvasEditing(false);
    }
  }, [canvasSessionId, isEditing, setCanvasEditing]);

  // Flush a pending save on unmount (e.g. the canvas closed mid-edit). The
  // session guard inside persist keeps this from leaking across sessions.
  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
        persist(draftRef.current);
      }
    };
  }, [persist]);

  // Conflict reconciliation (the file changed on disk since it was opened).
  const handleReload = () => {
    const adopted = fileSave.adoptDisk();
    if (adopted == null) return;
    onContentChange({ ...content, content: adopted });
    setDraft(splitFrontmatter(adopted).body);
  };
  const handleOverwrite = () => {
    void fileSave.overwrite(joinFrontmatter(frontmatterRef.current, draftRef.current));
  };

  const statusLabel = saveStatusLabel(fileSave.status);

  return (
    <div className="relative flex h-full flex-col">
      {/* Zero-height sticky row floats the controls top-right and keeps them
          pinned while the document scrolls. */}
      <div className="sticky top-0 z-10 flex h-0 items-start justify-end gap-2 pr-2">
        {fileBacked && statusLabel && (
          <span className="text-muted-foreground mt-3 text-xs" aria-live="polite">
            {statusLabel}
          </span>
        )}
        {fileBacked && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="text-muted-foreground hover:text-foreground mt-2"
            onClick={isEditing ? exitEdit : enterEdit}
            aria-label={isEditing ? 'Finish editing' : 'Edit document'}
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

      <div className="flex-1 px-2 pb-6">
        <Suspense
          fallback={<div className="text-muted-foreground p-4 text-sm">Loading editor…</div>}
        >
          {isEditing ? (
            <BlintzCanvas key="edit" value={draft} editable onChange={handleChange} />
          ) : (
            <BlintzCanvas key="view" value={body} editable={false} />
          )}
        </Suspense>
      </div>
    </div>
  );
}
