import { useEffect, useRef, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  File,
  Folder,
  FolderOpen,
  Loader2,
  RotateCw,
} from 'lucide-react';
import type { FileEntry } from '@dorkos/shared/types';
import {
  ResponsiveContextMenu,
  ResponsiveContextMenuContent,
  ResponsiveContextMenuItem,
  ResponsiveContextMenuSeparator,
  ResponsiveContextMenuTrigger,
} from '@/layers/shared/ui';
import { cn, FILE_PATH_DRAG_TYPE } from '@/layers/shared/lib';
import { parentOf } from '../model/tree';
import type { FlatRow } from '../model/types';
import type { CopyPathKind } from '../model/use-file-actions';

/** Left indentation per nesting level, in pixels. */
const INDENT_STEP = 12;

interface FileTreeRowProps {
  row: FlatRow;
  selected: boolean;
  renaming: boolean;
  /** True when this is an expanded directory whose listing failed to load. */
  error: boolean;
  onSelect: (entry: FileEntry) => void;
  onActivate: (entry: FileEntry) => void;
  /** Retry this directory's failed listing. */
  onRetry: () => void;
  onSubmitRename: (entry: FileEntry, newName: string) => void;
  onCancelRename: () => void;
  onNewFile: (parent: string) => void;
  onNewFolder: (parent: string) => void;
  onStartRename: (entry: FileEntry) => void;
  onDelete: (entry: FileEntry) => void;
  onMove: (fromPath: string, toDir: string) => void;
  /** Copy rather than move — an Alt-held drop, or Paste and Duplicate. */
  onCopyInto: (fromPath: string, toDir: string) => void;
  /** Put this entry on the explorer clipboard. */
  onCopy: (entry: FileEntry) => void;
  /** Paste the clipboard into a directory. */
  onPaste: (toDir: string) => void;
  /** Copy this entry beside itself. */
  onDuplicate: (entry: FileEntry) => void;
  /** Whether anything is on the explorer clipboard (else Paste is dimmed). */
  canPaste: boolean;
  /**
   * Label for the reveal item, named after the server platform's file manager —
   * `null` hides the item where no file manager can be opened at all.
   */
  revealLabel: string | null;
  onReveal: (entry: FileEntry) => void;
  onAddToChat: (entry: FileEntry) => void;
  onCopyPath: (entry: FileEntry, kind: CopyPathKind) => void;
}

/**
 * One file-explorer tree row (spec right-panel-workbench, Chunk B): indentation
 * by depth, an expand chevron for directories, an inline rename input, a
 * right-click / long-press context menu, and HTML5 drag-to-move. Selection and
 * keyboard navigation are owned by the parent `FileTree`; this row only reports
 * intent.
 *
 * The menu is grouped the way editors group theirs (DOR-1032): make something,
 * then take it somewhere (the file manager, the chat), then copy and paste it,
 * then copy its path, then change or remove it — destructive last.
 *
 * Dragging a row moves it; holding Alt while dropping copies instead.
 */
export function FileTreeRow({
  row,
  selected,
  renaming,
  error,
  onSelect,
  onActivate,
  onRetry,
  onSubmitRename,
  onCancelRename,
  onNewFile,
  onNewFolder,
  onStartRename,
  onDelete,
  onMove,
  onCopyInto,
  onCopy,
  onPaste,
  onDuplicate,
  canPaste,
  revealLabel,
  onReveal,
  onAddToChat,
  onCopyPath,
}: FileTreeRowProps) {
  const { entry, depth, expanded, loading } = row;
  const isDir = entry.type === 'dir';
  const parent = isDir ? entry.path : parentOf(entry.path);
  const [dropTarget, setDropTarget] = useState(false);

  return (
    <ResponsiveContextMenu>
      <ResponsiveContextMenuTrigger asChild>
        <div
          role="treeitem"
          aria-label={entry.name}
          aria-expanded={isDir ? expanded : undefined}
          aria-selected={selected}
          // Roving-tabindex: the parent `role="tree"` owns arrow-key navigation
          // and holds the real tab stop; rows are focusable only programmatically
          // but still activate on Enter/Space when focus lands on one.
          tabIndex={-1}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              onSelect(entry);
              onActivate(entry);
            }
          }}
          draggable={!renaming}
          onDragStart={(e) => {
            // `text/plain` so dropping into an outside editor pastes the path;
            // the custom type is what our own surfaces recognise as a file
            // reference rather than a file upload.
            e.dataTransfer.setData('text/plain', entry.path);
            e.dataTransfer.setData(FILE_PATH_DRAG_TYPE, entry.path);
            // Without `copyMove` the browser refuses an Alt-held copy outright.
            e.dataTransfer.effectAllowed = 'copyMove';
          }}
          onDragOver={(e) => {
            // Even a file row swallows this: whatever is under the pointer is a
            // row, so the tree's own empty-space drop (the root) must not also
            // claim it.
            e.stopPropagation();
            if (!isDir) return;
            e.preventDefault();
            // Alt held = copy, so the cursor shows a + before the drop lands.
            e.dataTransfer.dropEffect = e.altKey ? 'copy' : 'move';
            setDropTarget(true);
          }}
          onDragLeave={() => setDropTarget(false)}
          onDrop={(e) => {
            e.stopPropagation();
            if (!isDir) return;
            e.preventDefault();
            setDropTarget(false);
            const from = e.dataTransfer.getData('text/plain');
            if (!from) return;
            if (e.altKey) onCopyInto(from, entry.path);
            else onMove(from, entry.path);
          }}
          onClick={() => {
            onSelect(entry);
            onActivate(entry);
          }}
          className={cn(
            'flex w-full cursor-pointer items-center gap-1 py-1 pr-2 text-sm transition-colors',
            selected ? 'bg-accent text-foreground' : 'hover:bg-accent/50',
            dropTarget && 'ring-ring/60 bg-accent ring-1'
          )}
          style={{ paddingLeft: depth * INDENT_STEP + 8 }}
        >
          <span className="flex size-4 flex-shrink-0 items-center justify-center">
            {isDir &&
              (loading ? (
                <Loader2 className="text-muted-foreground size-3.5 animate-spin" />
              ) : error ? (
                <button
                  type="button"
                  aria-label="Retry loading"
                  title="Couldn't load — retry"
                  onClick={(e) => {
                    e.stopPropagation();
                    onRetry();
                  }}
                  className="flex items-center justify-center"
                >
                  <RotateCw className="text-destructive size-3.5" />
                </button>
              ) : expanded ? (
                <ChevronDown className="text-muted-foreground size-3.5" />
              ) : (
                <ChevronRight className="text-muted-foreground size-3.5" />
              ))}
          </span>
          {isDir ? (
            expanded ? (
              <FolderOpen className="size-(--size-icon-sm) flex-shrink-0 text-sky-500" />
            ) : (
              <Folder className="size-(--size-icon-sm) flex-shrink-0 text-sky-500" />
            )
          ) : (
            <File className="text-muted-foreground size-(--size-icon-sm) flex-shrink-0" />
          )}
          {renaming ? (
            <RenameInput
              initialName={entry.name}
              onSubmit={(name) => onSubmitRename(entry, name)}
              onCancel={onCancelRename}
            />
          ) : (
            <span className="min-w-0 flex-1 truncate">{entry.name}</span>
          )}
        </div>
      </ResponsiveContextMenuTrigger>
      <ResponsiveContextMenuContent className="w-52">
        <ResponsiveContextMenuItem onClick={() => onNewFile(parent)}>
          New File
        </ResponsiveContextMenuItem>
        <ResponsiveContextMenuItem onClick={() => onNewFolder(parent)}>
          New Folder
        </ResponsiveContextMenuItem>
        <ResponsiveContextMenuSeparator />
        {revealLabel && (
          <ResponsiveContextMenuItem onClick={() => onReveal(entry)}>
            {revealLabel}
          </ResponsiveContextMenuItem>
        )}
        <ResponsiveContextMenuItem onClick={() => onAddToChat(entry)}>
          Add to Chat
        </ResponsiveContextMenuItem>
        <ResponsiveContextMenuSeparator />
        <ResponsiveContextMenuItem onClick={() => onCopy(entry)}>Copy</ResponsiveContextMenuItem>
        {/* On a folder the paste lands inside it; on a file, beside it. */}
        <ResponsiveContextMenuItem disabled={!canPaste} onClick={() => onPaste(parent)}>
          Paste
        </ResponsiveContextMenuItem>
        <ResponsiveContextMenuItem onClick={() => onDuplicate(entry)}>
          Duplicate
        </ResponsiveContextMenuItem>
        <ResponsiveContextMenuSeparator />
        <ResponsiveContextMenuItem onClick={() => onCopyPath(entry, 'absolute')}>
          Copy Path
        </ResponsiveContextMenuItem>
        <ResponsiveContextMenuItem onClick={() => onCopyPath(entry, 'relative')}>
          Copy Relative Path
        </ResponsiveContextMenuItem>
        <ResponsiveContextMenuSeparator />
        <ResponsiveContextMenuItem onClick={() => onStartRename(entry)}>
          Rename
        </ResponsiveContextMenuItem>
        <ResponsiveContextMenuItem variant="destructive" onClick={() => onDelete(entry)}>
          Delete
        </ResponsiveContextMenuItem>
      </ResponsiveContextMenuContent>
    </ResponsiveContextMenu>
  );
}

/** Inline rename field: autofocused, basename pre-selected, Enter/blur commits, Escape cancels. */
function RenameInput({
  initialName,
  onSubmit,
  onCancel,
}: {
  initialName: string;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(initialName);

  useEffect(() => {
    const input = ref.current;
    if (!input) return;
    input.focus();
    // Select the base name, leaving any extension out of the initial selection.
    const dot = initialName.lastIndexOf('.');
    input.setSelectionRange(0, dot > 0 ? dot : initialName.length);
  }, [initialName]);

  const commit = () => {
    const trimmed = value.trim();
    if (trimmed && trimmed !== initialName) onSubmit(trimmed);
    else onCancel();
  };

  return (
    <input
      ref={ref}
      type="text"
      value={value}
      aria-label="New name"
      onChange={(e) => setValue(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
        else if (e.key === 'Escape') onCancel();
      }}
      className="border-border bg-background min-w-0 flex-1 rounded border px-1 py-0 text-sm outline-none"
    />
  );
}
