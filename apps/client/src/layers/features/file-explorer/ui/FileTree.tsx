import { useCallback, useEffect, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { FileEntry } from '@dorkos/shared/types';
import { parentOf } from '../model/tree-reducer';
import type { FlatRow } from '../model/types';
import { FileTreeRow } from './FileTreeRow';

/** Above this many visible rows, switch from a plain list to a virtualized one. */
const VIRTUALIZE_THRESHOLD = 100;
/** Estimated row height (px) for the virtualizer. */
const ROW_HEIGHT = 28;

interface FileTreeProps {
  rows: FlatRow[];
  selectedPath: string | null;
  renamingPath: string | null;
  onSelectPath: (path: string) => void;
  onToggle: (entry: FileEntry) => void;
  onOpen: (entry: FileEntry) => void;
  onSubmitRename: (entry: FileEntry, newName: string) => void;
  onCancelRename: () => void;
  onStartRename: (entry: FileEntry) => void;
  onNewFile: (parent: string) => void;
  onNewFolder: (parent: string) => void;
  onDelete: (entry: FileEntry) => void;
  onMove: (fromPath: string, toDir: string) => void;
}

/**
 * The scrollable, keyboard-navigable tree body (spec right-panel-workbench,
 * Chunk B). Renders a plain list for small trees and a `@tanstack/react-virtual`
 * windowed list once a directory grows past {@link VIRTUALIZE_THRESHOLD} rows.
 * Arrow keys move and expand/collapse the selection; Enter opens, F2 renames,
 * Delete removes.
 */
export function FileTree(props: FileTreeProps) {
  const { rows, selectedPath, renamingPath, onSelectPath } = props;
  const scrollRef = useRef<HTMLDivElement>(null);

  const activate = useCallback(
    (entry: FileEntry) => (entry.type === 'dir' ? props.onToggle(entry) : props.onOpen(entry)),
    [props]
  );

  const handleKeyDown = useKeyboardNav(props, activate);

  const virtualize = rows.length > VIRTUALIZE_THRESHOLD;
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
    enabled: virtualize,
  });

  // Keep the selected row in view as the keyboard moves it.
  useEffect(() => {
    if (selectedPath === null) return;
    const index = rows.findIndex((r) => r.entry.path === selectedPath);
    if (index < 0) return;
    if (virtualize) {
      virtualizer.scrollToIndex(index, { align: 'auto' });
      return;
    }
    const el = scrollRef.current?.querySelector(`[data-row-index="${index}"]`);
    // `scrollIntoView` is unimplemented in jsdom — guard so tests don't throw.
    el?.scrollIntoView?.({ block: 'nearest' });
  }, [selectedPath, rows, virtualize, virtualizer]);

  const renderRow = (row: FlatRow) => (
    <FileTreeRow
      row={row}
      selected={row.entry.path === selectedPath}
      renaming={row.entry.path === renamingPath}
      onSelect={(entry) => onSelectPath(entry.path)}
      onActivate={activate}
      onSubmitRename={props.onSubmitRename}
      onCancelRename={props.onCancelRename}
      onStartRename={props.onStartRename}
      onNewFile={props.onNewFile}
      onNewFolder={props.onNewFolder}
      onDelete={props.onDelete}
      onMove={props.onMove}
    />
  );

  return (
    <div
      ref={scrollRef}
      role="tree"
      aria-label="File explorer"
      tabIndex={0}
      onKeyDown={handleKeyDown}
      className="focus-visible:ring-ring/40 h-full overflow-auto outline-none focus-visible:ring-1 focus-visible:ring-inset"
    >
      {virtualize ? (
        <div style={{ height: virtualizer.getTotalSize() }} className="relative w-full">
          {virtualizer.getVirtualItems().map((vi) => (
            <div
              key={rows[vi.index].entry.path}
              data-row-index={vi.index}
              className="absolute top-0 left-0 w-full"
              style={{ transform: `translateY(${vi.start}px)` }}
            >
              {renderRow(rows[vi.index])}
            </div>
          ))}
        </div>
      ) : (
        rows.map((row, index) => (
          <div key={row.entry.path} data-row-index={index}>
            {renderRow(row)}
          </div>
        ))
      )}
    </div>
  );
}

/** Keyboard navigation for the tree, returning the container `onKeyDown` handler. */
function useKeyboardNav(props: FileTreeProps, activate: (entry: FileEntry) => void) {
  const { rows, selectedPath, renamingPath, onSelectPath } = props;

  return useCallback(
    (e: React.KeyboardEvent) => {
      if (renamingPath !== null) return; // the rename input owns keys while open
      const index = rows.findIndex((r) => r.entry.path === selectedPath);
      const current = index >= 0 ? rows[index] : undefined;

      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          onSelectPath(
            rows[Math.min(index + 1, rows.length - 1)]?.entry.path ?? rows[0]?.entry.path
          );
          break;
        case 'ArrowUp':
          e.preventDefault();
          onSelectPath(rows[Math.max(index - 1, 0)]?.entry.path ?? rows[0]?.entry.path);
          break;
        case 'ArrowRight':
          if (current?.entry.type === 'dir' && !current.expanded) {
            e.preventDefault();
            props.onToggle(current.entry);
          }
          break;
        case 'ArrowLeft':
          if (!current) break;
          e.preventDefault();
          if (current.entry.type === 'dir' && current.expanded) props.onToggle(current.entry);
          else {
            const parent = parentOf(current.entry.path);
            if (parent) onSelectPath(parent);
          }
          break;
        case 'Enter':
          if (current) {
            e.preventDefault();
            activate(current.entry);
          }
          break;
        case 'F2':
          if (current) {
            e.preventDefault();
            props.onStartRename(current.entry);
          }
          break;
        case 'Delete':
        case 'Backspace':
          if (current) {
            e.preventDefault();
            props.onDelete(current.entry);
          }
          break;
      }
    },
    [rows, selectedPath, renamingPath, onSelectPath, props, activate]
  );
}
