import { lazy, Suspense, type RefObject, type Dispatch, type SetStateAction } from 'react';
import { Check, Pencil, RotateCw } from 'lucide-react';
import type { UiCanvasContent } from '@dorkos/shared/types';
import type { MarkdownSourcePort, SourceTaskToggleRequest } from 'blintz';
import type { useCanvasFileSave } from '../model/use-canvas-file-save';
import type { useNativeCheckboxWrite } from '../model/use-native-checkbox-write';
import { cn } from '@/layers/shared/lib';
import { Button } from '@/layers/shared/ui';
// Lazy: the CodeMirror chunk (editor core + on-demand language grammar) and the
// Blintz chunk load only when a file document first renders — never for the main
// bundle. Named exports mapped to default for React.lazy.
const CodeMirrorEditor = lazy(() =>
  import('./CodeMirrorEditor').then((m) => ({ default: m.CodeMirrorEditor }))
);
const BlintzCanvas = lazy(() =>
  import('./BlintzCanvas').then((m) => ({ default: m.BlintzCanvas }))
);

interface FileEditorSurfaceProps {
  markdown: boolean;
  selectionBusy: boolean;
  checkboxBusy: boolean;
  selectionCommand: RefObject<object | null>;
  selectionReady: boolean;
  askSelection: (retry?: boolean) => Promise<void>;
  editable: boolean;
  statusLabel: string | null;
  fileSave: ReturnType<typeof useCanvasFileSave>;
  isEditing: boolean;
  handleRefresh: () => void;
  taskPending: RefObject<object | null>;
  exitEdit: () => Promise<void>;
  enterEdit: () => void;
  selectionNotice: string | null;
  checkboxError: string | null;
  checkbox: ReturnType<typeof useNativeCheckboxWrite>;
  retryCheckbox: () => Promise<void>;
  reloadCheckboxConflict: () => Promise<void>;
  handleReload: () => void;
  handleOverwrite: () => void;
  value: string;
  fileVersion: string;
  sourcePort: RefObject<MarkdownSourcePort | null>;
  setSelectionReady: Dispatch<SetStateAction<boolean>>;
  toggleTask: (request: SourceTaskToggleRequest) => Promise<void>;
  handleChange: (value: string) => void;
  content: Extract<UiCanvasContent, { type: 'file' }>;
  theme: 'light' | 'dark';
}
/** Display-only surface; every command remains bound by the original editor owner. */
export function renderFileEditorSurface({
  markdown,
  selectionBusy,
  checkboxBusy,
  selectionCommand,
  selectionReady,
  askSelection,
  editable,
  statusLabel,
  fileSave,
  isEditing,
  handleRefresh,
  taskPending,
  exitEdit,
  enterEdit,
  selectionNotice,
  checkboxError,
  checkbox,
  retryCheckbox,
  reloadCheckboxConflict,
  handleReload,
  handleOverwrite,
  value,
  fileVersion,
  sourcePort,
  setSelectionReady,
  toggleTask,
  handleChange,
  content,
  theme,
}: FileEditorSurfaceProps) {
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
