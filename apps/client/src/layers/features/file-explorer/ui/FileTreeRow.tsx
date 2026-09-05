import { useEffect, useRef, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  File,
  Folder,
  FolderOpen,
  Link2,
  Loader2,
  Pin,
  RotateCw,
} from 'lucide-react';
import type { ExplorerEntry } from '../model/source';
import { isPinnedEntryName } from '../lib/listing-shape';
import { provenanceLine } from '../lib/provenance';
import {
  ResponsiveContextMenu,
  ResponsiveContextMenuContent,
  ResponsiveContextMenuItem,
  ResponsiveContextMenuSeparator,
  ResponsiveContextMenuTrigger,
} from '@/layers/shared/ui';
import { cn, FILE_PATH_DRAG_TYPE, hasFilePathDrag, readFilePathDrag } from '@/layers/shared/lib';
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
  onSelect: (entry: ExplorerEntry) => void;
  onActivate: (entry: ExplorerEntry) => void;
  /** Retry this directory's failed listing. */
  onRetry: () => void;
  onSubmitRename: (entry: ExplorerEntry, newName: string) => void;
  onCancelRename: () => void;
  onNewFile: (parent: string) => void;
  onNewFolder: (parent: string) => void;
  onStartRename: (entry: ExplorerEntry) => void;
  onDelete: (entry: ExplorerEntry) => void;
  onMove: (fromPath: string, toDir: string) => void;
  /** Copy rather than move — an Alt-held drop, or Paste and Duplicate. */
  onCopyInto: (fromPath: string, toDir: string) => void;
  /** Put this entry on the explorer clipboard. */
  onCopy: (entry: ExplorerEntry) => void;
  /** Paste the clipboard into a directory. */
  onPaste: (toDir: string) => void;
  /** Copy this entry beside itself. */
  onDuplicate: (entry: ExplorerEntry) => void;
  /** Whether the clipboard holds something a given directory could take. */
  canPasteInto: (toDir: string) => boolean;
  /**
   * Label for the reveal item, named after the server platform's file manager —
   * `null` hides the item where no file manager can be opened at all.
   */
  revealLabel: string | null;
  onReveal: (entry: ExplorerEntry) => void;
  onAddToChat: (entry: ExplorerEntry) => void;
  onCopyPath: (entry: ExplorerEntry, kind: CopyPathKind) => void;
  /**
   * Whether this row can only be looked at.
   *
   * True over a source whose entries are a commit rather than files on disk:
   * there is nothing on the other side of a rename. Drag, the inline rename and
   * the whole context menu go away — an affordance that would always refuse is
   * worse than no affordance. Defaults to false, which is every session row.
   */
  readOnly?: boolean;
  /**
   * Whether the pane draws the provenance column. Off unless the source can
   * actually answer "who last touched this" — an empty column of em-dashes is
   * just noise taking up the width the filename wanted.
   */
  provenance?: boolean;
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
  canPasteInto,
  revealLabel,
  onReveal,
  onAddToChat,
  onCopyPath,
  readOnly = false,
  provenance = false,
}: FileTreeRowProps) {
  const { entry, depth, expanded, loading } = row;
  const isDir = entry.type === 'dir';
  const parent = isDir ? entry.path : parentOf(entry.path);
  const [dropTarget, setDropTarget] = useState(false);
  const pinned = !isDir && depth === 0 && isPinnedEntryName(entry.name);
  const line = provenanceLine(entry.lastCommit);

  const body = (
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
      draggable={!renaming && !readOnly}
      onDragStart={(e) => {
        if (readOnly) return;
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
        // Only our own rows are droppable here. Text dragged out of another
        // app carries `text/plain` too, and reading that alone turned a
        // dragged sentence into a move of whatever file it happened to name.
        if (readOnly || !isDir || !hasFilePathDrag(e.dataTransfer.types)) return;
        e.preventDefault();
        // Alt held = copy, so the cursor shows a + before the drop lands.
        e.dataTransfer.dropEffect = e.altKey ? 'copy' : 'move';
        setDropTarget(true);
      }}
      onDragLeave={() => setDropTarget(false)}
      onDrop={(e) => {
        e.stopPropagation();
        if (readOnly || !isDir) return;
        setDropTarget(false);
        const from = readFilePathDrag(e.dataTransfer);
        if (from === null) return;
        e.preventDefault();
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
              title="Couldn't load. Retry"
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
      ) : entry.isSymlink === true ? (
        // A link is listed, never followed — so it is drawn as what it is
        // rather than as the thing it names.
        <Link2 className="text-muted-foreground size-(--size-icon-sm) flex-shrink-0" />
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
      {pinned && !renaming && (
        // Subtle on purpose: the row is already at the top, so the mark only
        // has to explain why it is — not compete with the name for attention.
        <Pin
          aria-label="Pinned to the top"
          className="text-muted-foreground/60 size-3 flex-shrink-0"
        />
      )}
      {provenance && !renaming && (
        <span
          // `max-w-[45%]` rather than a fixed column: the pane is narrow and the
          // filename is what a person came to read, so provenance gives way
          // first and truncates rather than pushing the name off screen.
          className="text-muted-foreground/70 text-2xs max-w-[45%] flex-shrink-0 truncate tabular-nums"
          title={line.title ?? undefined}
        >
          {line.label}
        </span>
      )}
    </div>
  );

  // Read-only rows carry no menu at all: every item in it either writes, or
  // names a place on disk that a commit does not have.
  if (readOnly) return body;

  return (
    <ResponsiveContextMenu>
      <ResponsiveContextMenuTrigger asChild>{body}</ResponsiveContextMenuTrigger>
      <ResponsiveContextMenuContent className="w-52">
        <ResponsiveContextMenuItem onClick={() => onNewFile(parent)}>
          New file
        </ResponsiveContextMenuItem>
        <ResponsiveContextMenuItem onClick={() => onNewFolder(parent)}>
          New folder
        </ResponsiveContextMenuItem>
        <ResponsiveContextMenuSeparator />
        {revealLabel && (
          <ResponsiveContextMenuItem onClick={() => onReveal(entry)}>
            {revealLabel}
          </ResponsiveContextMenuItem>
        )}
        {/* `movesFocus`: this one puts the caret in the composer, so it runs
            once the menu is on its way out and keeps the focus it takes. */}
        <ResponsiveContextMenuItem movesFocus onClick={() => onAddToChat(entry)}>
          Add to chat
        </ResponsiveContextMenuItem>
        <ResponsiveContextMenuSeparator />
        <ResponsiveContextMenuItem onClick={() => onCopy(entry)}>Copy</ResponsiveContextMenuItem>
        {/* On a folder the paste lands inside it; on a file, beside it. */}
        <ResponsiveContextMenuItem disabled={!canPasteInto(parent)} onClick={() => onPaste(parent)}>
          Paste
        </ResponsiveContextMenuItem>
        <ResponsiveContextMenuItem onClick={() => onDuplicate(entry)}>
          Duplicate
        </ResponsiveContextMenuItem>
        <ResponsiveContextMenuSeparator />
        <ResponsiveContextMenuItem onClick={() => onCopyPath(entry, 'absolute')}>
          Copy path
        </ResponsiveContextMenuItem>
        <ResponsiveContextMenuItem onClick={() => onCopyPath(entry, 'relative')}>
          Copy relative path
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
