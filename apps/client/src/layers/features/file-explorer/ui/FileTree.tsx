import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { FileEntry } from '@dorkos/shared/types';
import { parentOf } from '../model/tree';
import type { FlatRow } from '../model/types';
import { useFileExplorerStore } from '../model/file-explorer-store';
import { FileTreeRow } from './FileTreeRow';

/** Above this many visible rows, switch from a plain list to a virtualized one. */
const VIRTUALIZE_THRESHOLD = 100;
/** Estimated row height (px) for the virtualizer. */
const ROW_HEIGHT = 28;
/** Trailing-debounce window before a scroll position is persisted (ms). */
const SCROLL_PERSIST_MS = 250;

interface FileTreeProps {
  rows: FlatRow[];
  selectedPath: string | null;
  renamingPath: string | null;
  /** Visible expanded directories whose listing failed (render an inline retry). */
  errorPaths: Set<string>;
  onSelectPath: (path: string) => void;
  onToggle: (entry: FileEntry) => void;
  onOpen: (entry: FileEntry) => void;
  /** Retry a directory whose listing failed. */
  onRetryDir: (path: string) => void;
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
  const { rows, selectedPath, renamingPath, errorPaths, onSelectPath, onRetryDir } = props;
  const scrollRef = useRef<HTMLDivElement>(null);

  const setScrollTop = useFileExplorerStore((s) => s.setScrollTop);
  const scopeKey = useFileExplorerStore((s) => s.scopeKey);

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

  // Restore the saved scroll offset for the active cwd (§4, review nit 2). A cold
  // refresh with a deep saved offset renders root-only first — too short to hold
  // it — so re-apply the offset every time the content grows (rows.length climbs
  // as deeper levels stream in), and latch permanently only once either the
  // container is finally tall enough to apply it unclamped, or the user scrolls
  // (a user scroll always wins — see `handleScroll`). `scope` resets the latch on
  // a cwd change so each cwd restores its own offset; `programmaticTop` records
  // the offset our own restore applied so the scroll events it emits are never
  // mistaken for a user scroll.
  const scrollRestoreRef = useRef<{ scope: string | null | undefined; done: boolean }>({
    scope: undefined,
    done: false,
  });
  const programmaticTopRef = useRef<number | null>(null);
  useLayoutEffect(() => {
    const restore = scrollRestoreRef.current;
    if (restore.scope !== scopeKey) {
      restore.scope = scopeKey;
      restore.done = false;
    }
    if (restore.done || rows.length === 0) return;
    const el = scrollRef.current;
    if (!el) return;
    const saved = useFileExplorerStore.getState().scrollTop;
    if (saved <= 0) {
      restore.done = true; // nothing to restore for this cwd
      return;
    }
    if (virtualize) virtualizer.scrollToOffset(saved);
    else el.scrollTop = saved;
    programmaticTopRef.current = el.scrollTop;
    // Latch once the offset landed unclamped — the container can finally hold it.
    if (el.scrollTop >= saved) restore.done = true;
  }, [rows.length, scopeKey, virtualize, virtualizer]);

  // Persist the scroll offset, trailing-debounced so localStorage is never
  // written per frame (the PIP "never per-frame" rule); the latest value flushes
  // on unmount so a tab switch or file-open keeps the exact position.
  const pendingScrollRef = useRef<number | null>(null);
  const scrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    // Ignore the scroll events our own restore emits — only a genuine user scroll
    // latches the restore (the user always wins) and gets persisted. Persisting a
    // programmatic, possibly-clamped offset would corrupt the saved position.
    if (el.scrollTop === programmaticTopRef.current) return;
    scrollRestoreRef.current.done = true;
    pendingScrollRef.current = el.scrollTop;
    if (scrollTimerRef.current) clearTimeout(scrollTimerRef.current);
    scrollTimerRef.current = setTimeout(() => {
      scrollTimerRef.current = null;
      if (pendingScrollRef.current !== null) setScrollTop(pendingScrollRef.current);
    }, SCROLL_PERSIST_MS);
  }, [setScrollTop]);
  useEffect(
    () => () => {
      if (scrollTimerRef.current) clearTimeout(scrollTimerRef.current);
      if (pendingScrollRef.current !== null) setScrollTop(pendingScrollRef.current);
    },
    [setScrollTop]
  );

  // Reveal the selected row when the selection *changes* — on keyboard nav or a
  // row click — never on mount, and never when rows merely stream in under an
  // unchanged selection; either would drag a restored scroll offset back to the
  // selection and fight the restore above. The previous selection is tracked in
  // a ref: the first run for a mount only records it, and any run where the
  // selection is unchanged does nothing (so late query loads never re-reveal). A
  // reveal scroll is marked programmatic (`programmaticTop`), exactly like the
  // restore path, so `handleScroll` never mistakes it for a user scroll — it must
  // neither latch the restore nor be persisted.
  const prevSelectedPathRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    const prev = prevSelectedPathRef.current;
    prevSelectedPathRef.current = selectedPath;
    if (prev === undefined || selectedPath === prev) return;
    if (selectedPath === null) return;
    const index = rows.findIndex((r) => r.entry.path === selectedPath);
    if (index < 0) return;
    const el = scrollRef.current;
    if (!el) return;
    if (virtualize) {
      virtualizer.scrollToIndex(index, { align: 'auto' });
    } else {
      // `scrollIntoView` is unimplemented in jsdom — guard so tests don't throw.
      el.querySelector(`[data-row-index="${index}"]`)?.scrollIntoView?.({ block: 'nearest' });
    }
    // `scrollTo`/`scrollIntoView` update `scrollTop` synchronously, so the
    // container's post-reveal offset is what to record (same as the restore path).
    programmaticTopRef.current = el.scrollTop;
  }, [selectedPath, rows, virtualize, virtualizer]);

  const renderRow = (row: FlatRow) => (
    <FileTreeRow
      row={row}
      selected={row.entry.path === selectedPath}
      renaming={row.entry.path === renamingPath}
      error={row.entry.type === 'dir' && row.expanded && errorPaths.has(row.entry.path)}
      onSelect={(entry) => onSelectPath(entry.path)}
      onActivate={activate}
      onRetry={() => onRetryDir(row.entry.path)}
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
      onScroll={handleScroll}
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
