/**
 * @vitest-environment jsdom
 */
import { useState } from 'react';
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { FileEntry } from '@dorkos/shared/types';
import type { FlatRow } from '../model/types';
import { useFileExplorerStore } from '../model/file-explorer-store';
import { FileTree } from '../ui/FileTree';

// jsdom stores `scrollTop` verbatim (no layout, no clamping) and reports
// `scrollHeight`/`clientHeight` as 0, so the scroll-restore latch can't be
// exercised as-is. This installs a real scroll simulation on the container: a
// clamping `scrollTop` and controllable `scrollHeight`/`clientHeight`, so growing
// content (deeper tree levels streaming in) can be modelled.
function installScrollSim(el: HTMLElement, clientHeight: number, scrollHeight: number) {
  const state = { top: 0, clientHeight, scrollHeight };
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => state.clientHeight });
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => state.scrollHeight });
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get: () => state.top,
    set: (v: number) => {
      const max = Math.max(0, state.scrollHeight - state.clientHeight);
      state.top = Math.max(0, Math.min(v, max));
    },
  });
  return state;
}

function file(path: string): FileEntry {
  const name = path.includes('/') ? path.slice(path.lastIndexOf('/') + 1) : path;
  return { name, path, type: 'file', size: 1, mtime: 0, isSymlink: false };
}

function dir(path: string): FileEntry {
  const name = path.includes('/') ? path.slice(path.lastIndexOf('/') + 1) : path;
  return { name, path, type: 'dir', size: 0, mtime: 0, isSymlink: false };
}

function rowOf(entry: FileEntry): FlatRow {
  return { entry, depth: 0, expanded: false, loading: false };
}

/**
 * A stand-in for the real `DataTransfer`, which jsdom does not implement.
 * Lowercases type keys the way a browser does, so the readers' case handling is
 * exercised rather than assumed.
 */
function fakeDataTransfer(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    dropEffect: 'none',
    effectAllowed: 'none',
    get types() {
      return [...data.keys()];
    },
    setData(type: string, value: string) {
      data.set(type.toLowerCase(), value);
    },
    getData(type: string) {
      return data.get(type.toLowerCase()) ?? '';
    },
  };
}

const PATH_TYPE = 'application/x-dorkos-file-path';

/**
 * Dispatch a drag event carrying a `dataTransfer` and a real `altKey`.
 *
 * `fireEvent.dragOver` and friends cannot do this: jsdom implements no
 * `DragEvent`, so Testing Library falls back to a plain `Event`, which drops
 * every modifier key from the init — and the Alt-to-copy behaviour under test
 * would silently read as a move. A `MouseEvent` keeps the modifier, and React
 * dispatches on the event's NAME, so it reaches the drag handlers all the same.
 */
function fireDrag(
  el: Element,
  type: 'dragstart' | 'dragover' | 'drop',
  init: { dataTransfer: ReturnType<typeof fakeDataTransfer>; altKey?: boolean }
) {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    altKey: init.altKey ?? false,
  });
  Object.defineProperty(event, 'dataTransfer', { value: init.dataTransfer });
  fireEvent(el, event);
}

/** Build `n` distinct file rows (well under the virtualization threshold). */
function rowsOf(n: number): FlatRow[] {
  return Array.from({ length: n }, (_, i) => ({
    entry: file(`f${i}.ts`),
    depth: 0,
    expanded: false,
    loading: false,
  }));
}

const noop = () => {};
const baseProps = {
  selectedPath: null,
  renamingPath: null,
  errorPaths: new Set<string>(),
  onSelectPath: noop,
  onToggle: noop,
  onOpen: noop,
  onRetryDir: noop,
  onSubmitRename: noop,
  onCancelRename: noop,
  onStartRename: noop,
  onNewFile: noop,
  onNewFolder: noop,
  onDelete: noop,
  onMove: noop,
  onCopyInto: noop,
  onCopy: noop,
  onPaste: noop,
  onDuplicate: noop,
  canPaste: false,
  revealLabel: 'Reveal in Finder',
  onReveal: noop,
  onAddToChat: noop,
  onCopyPath: noop,
};

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

beforeEach(() => {
  localStorage.clear();
  useFileExplorerStore.setState({
    showHidden: false,
    commands: null,
    scopeKey: '/repo',
    expanded: {},
    selectedPath: null,
    scrollTop: 500,
  });
});

afterEach(() => cleanup());

describe('FileTree scroll restore (review nit 2)', () => {
  // A cold refresh with a deep saved offset renders root-only first (too short to
  // hold the offset). The restore must keep re-applying as deeper levels stream
  // in, and latch only once the container is finally tall enough to apply it
  // unclamped.
  it('re-applies the saved offset as content grows, then latches when it fits', () => {
    const view = render(<FileTree {...baseProps} rows={[]} />);
    const tree = screen.getByRole('tree');
    const sim = installScrollSim(tree, 100, 200); // short: max scroll 100

    // First non-empty render is short → the restore clamps and does NOT latch.
    view.rerender(<FileTree {...baseProps} rows={rowsOf(3)} />);
    expect(tree.scrollTop).toBe(100);

    // Deeper levels stream in and the container grows tall enough for 500 → the
    // offset now applies unclamped and the restore latches.
    sim.scrollHeight = 800; // max scroll 700
    view.rerender(<FileTree {...baseProps} rows={rowsOf(6)} />);
    expect(tree.scrollTop).toBe(500);

    // Latched permanently: a later saved-offset change is never re-applied.
    useFileExplorerStore.setState({ scrollTop: 123 });
    view.rerender(<FileTree {...baseProps} rows={rowsOf(9)} />);
    expect(tree.scrollTop).toBe(500);
  });

  // The user always wins: once they scroll, the restore must never yank them
  // back, even as more content streams in and the container grows.
  it('cancels the restore the moment the user scrolls', () => {
    const view = render(<FileTree {...baseProps} rows={[]} />);
    const tree = screen.getByRole('tree');
    const sim = installScrollSim(tree, 100, 200); // short: restore will clamp to 100

    view.rerender(<FileTree {...baseProps} rows={rowsOf(3)} />);
    expect(tree.scrollTop).toBe(100); // clamped, not yet latched

    // The user scrolls up to 40 — a scroll we did not initiate.
    tree.scrollTop = 40;
    fireEvent.scroll(tree);

    // Content grows tall enough to hold 500, but the restore is cancelled: the
    // user's position is preserved, never yanked back to the saved offset.
    sim.scrollHeight = 800;
    view.rerender(<FileTree {...baseProps} rows={rowsOf(6)} />);
    expect(tree.scrollTop).toBe(40);
  });
});

describe('FileTree drag and drop (DOR-1032)', () => {
  const treeRows = [rowOf(dir('src')), rowOf(file('a.ts'))];

  it('puts both the plain path and our own file-reference type on a dragged row', () => {
    render(<FileTree {...baseProps} rows={treeRows} />);
    const dataTransfer = fakeDataTransfer();

    fireDrag(screen.getByRole('treeitem', { name: 'a.ts' }), 'dragstart', { dataTransfer });

    expect(dataTransfer.getData('text/plain')).toBe('a.ts');
    expect(dataTransfer.getData(PATH_TYPE)).toBe('a.ts');
    // Without this the browser refuses an Alt-held copy outright.
    expect(dataTransfer.effectAllowed).toBe('copyMove');
  });

  it('shows the copy cursor while Alt is held over a folder, and the move cursor otherwise', () => {
    render(<FileTree {...baseProps} rows={treeRows} />);
    const folder = screen.getByRole('treeitem', { name: 'src' });

    const moving = fakeDataTransfer({ [PATH_TYPE]: 'a.ts' });
    fireDrag(folder, 'dragover', { dataTransfer: moving, altKey: false });
    expect(moving.dropEffect).toBe('move');

    const copying = fakeDataTransfer({ [PATH_TYPE]: 'a.ts' });
    fireDrag(folder, 'dragover', { dataTransfer: copying, altKey: true });
    expect(copying.dropEffect).toBe('copy');
  });

  it('moves on a plain drop into a folder and copies when Alt is held', () => {
    const onMove = vi.fn();
    const onCopyInto = vi.fn();
    render(<FileTree {...baseProps} rows={treeRows} onMove={onMove} onCopyInto={onCopyInto} />);
    const folder = screen.getByRole('treeitem', { name: 'src' });
    const dataTransfer = fakeDataTransfer({ 'text/plain': 'a.ts', [PATH_TYPE]: 'a.ts' });

    fireDrag(folder, 'drop', { dataTransfer, altKey: false });
    expect(onMove).toHaveBeenCalledWith('a.ts', 'src');
    expect(onCopyInto).not.toHaveBeenCalled();

    fireDrag(folder, 'drop', { dataTransfer, altKey: true });
    expect(onCopyInto).toHaveBeenCalledWith('a.ts', 'src');
    expect(onMove).toHaveBeenCalledTimes(1);
  });

  it('does not let a drop on a folder count as a drop on the root as well', () => {
    const onMove = vi.fn();
    render(<FileTree {...baseProps} rows={treeRows} onMove={onMove} />);

    fireDrag(screen.getByRole('treeitem', { name: 'src' }), 'drop', {
      dataTransfer: fakeDataTransfer({ 'text/plain': 'a.ts', [PATH_TYPE]: 'a.ts' }),
    });

    expect(onMove).toHaveBeenCalledTimes(1);
    expect(onMove).toHaveBeenCalledWith('a.ts', 'src');
  });

  it.each([['plain', false] as const, ['virtualized', true] as const])(
    'accepts a drop in the empty space below the rows (%s)',
    (_mode, virtualized) => {
      const onMove = vi.fn();
      const onCopyInto = vi.fn();
      // Past VIRTUALIZE_THRESHOLD (100) the tree windows its rows; the drop
      // target is the scroll container either way, so both must behave.
      const rows = virtualized ? rowsOf(150) : treeRows;
      render(<FileTree {...baseProps} rows={rows} onMove={onMove} onCopyInto={onCopyInto} />);
      const tree = screen.getByRole('tree');

      fireDrag(tree, 'drop', {
        dataTransfer: fakeDataTransfer({ 'text/plain': 'src/a.ts', [PATH_TYPE]: 'src/a.ts' }),
      });
      expect(onMove).toHaveBeenCalledWith('src/a.ts', '');

      fireDrag(tree, 'drop', {
        dataTransfer: fakeDataTransfer({ 'text/plain': 'src/a.ts', [PATH_TYPE]: 'src/a.ts' }),
        altKey: true,
      });
      expect(onCopyInto).toHaveBeenCalledWith('src/a.ts', '');
    }
  );

  it('ignores a drag that carries files from the operating system', () => {
    const onMove = vi.fn();
    render(<FileTree {...baseProps} rows={treeRows} onMove={onMove} />);
    const tree = screen.getByRole('tree');
    const dataTransfer = fakeDataTransfer({ Files: '' });

    fireDrag(tree, 'dragover', { dataTransfer });
    fireDrag(tree, 'drop', { dataTransfer });

    // Not our drag: no drop effect claimed, and nothing moved.
    expect(dataTransfer.dropEffect).toBe('none');
    expect(onMove).not.toHaveBeenCalled();
  });
});

describe('FileTree copy and paste keys (DOR-1032)', () => {
  const treeRows = [rowOf(dir('src')), rowOf(file('src/a.ts')), rowOf(file('b.ts'))];

  it('copies the selected row on the platform modifier + C', () => {
    const onCopy = vi.fn();
    render(<FileTree {...baseProps} rows={treeRows} selectedPath="b.ts" onCopy={onCopy} />);

    fireEvent.keyDown(screen.getByRole('tree'), { key: 'c', metaKey: true });

    expect(onCopy).toHaveBeenCalledWith(expect.objectContaining({ path: 'b.ts' }));
  });

  it('pastes into a selected folder, beside a selected file, or into the root', () => {
    const onPaste = vi.fn();
    function Harness({ selected }: { selected: string | null }) {
      return <FileTree {...baseProps} rows={treeRows} selectedPath={selected} onPaste={onPaste} />;
    }

    const view = render(<Harness selected="src" />);
    fireEvent.keyDown(screen.getByRole('tree'), { key: 'v', metaKey: true });
    expect(onPaste).toHaveBeenLastCalledWith('src');

    view.rerender(<Harness selected="src/a.ts" />);
    fireEvent.keyDown(screen.getByRole('tree'), { key: 'v', metaKey: true });
    expect(onPaste).toHaveBeenLastCalledWith('src');

    view.rerender(<Harness selected={null} />);
    fireEvent.keyDown(screen.getByRole('tree'), { key: 'v', metaKey: true });
    expect(onPaste).toHaveBeenLastCalledWith('');
  });

  it('answers to Ctrl as well as Cmd, since only one of them exists per platform', () => {
    const onPaste = vi.fn();
    render(<FileTree {...baseProps} rows={treeRows} selectedPath="src" onPaste={onPaste} />);

    fireEvent.keyDown(screen.getByRole('tree'), { key: 'v', ctrlKey: true });

    expect(onPaste).toHaveBeenCalledWith('src');
  });

  it('leaves copy and paste to the rename box while a name is being typed', () => {
    const onCopy = vi.fn();
    const onPaste = vi.fn();
    render(
      <FileTree
        {...baseProps}
        rows={treeRows}
        selectedPath="b.ts"
        renamingPath="b.ts"
        onCopy={onCopy}
        onPaste={onPaste}
      />
    );
    const tree = screen.getByRole('tree');

    fireEvent.keyDown(tree, { key: 'c', metaKey: true });
    fireEvent.keyDown(tree, { key: 'v', metaKey: true });

    expect(onCopy).not.toHaveBeenCalled();
    expect(onPaste).not.toHaveBeenCalled();
  });

  it('does not treat the modifier as plain navigation', () => {
    const onSelectPath = vi.fn();
    const onDelete = vi.fn();
    render(
      <FileTree
        {...baseProps}
        rows={treeRows}
        selectedPath="b.ts"
        onSelectPath={onSelectPath}
        onDelete={onDelete}
      />
    );
    const tree = screen.getByRole('tree');

    fireEvent.keyDown(tree, { key: 'ArrowDown', metaKey: true });
    fireEvent.keyDown(tree, { key: 'Backspace', metaKey: true });

    expect(onSelectPath).not.toHaveBeenCalled();
    expect(onDelete).not.toHaveBeenCalled();
  });
});

describe('FileTree selection reveal (mount vs restore, DOR-404)', () => {
  // A stubbed `scrollIntoView` — jsdom leaves it undefined, so the reveal path
  // never runs by accident. Each test decides whether it merely records calls or
  // (regression) also models a real browser reveal that moves the container and
  // fires a scroll event.
  let scrollIntoView: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView as never;
  });
  afterEach(() => {
    delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    vi.useRealTimers();
  });

  // Regression: the reveal effect used to fire on mount, dragging the restored
  // offset to the selection AND persisting that reveal over the user's saved
  // position (the reveal scroll wasn't marked programmatic, so `handleScroll`
  // treated it as a user scroll). Mount must not reveal, and the saved offset
  // must survive untouched. jsdom stores `scrollTop` verbatim, so restoring 40
  // needs no scroll sim.
  it('does not reveal the selection on mount, and preserves the restored offset', () => {
    vi.useFakeTimers();
    // Model a real-browser reveal: scroll the container to the row and notify.
    scrollIntoView.mockImplementation(function (this: HTMLElement) {
      const container = this.closest('[role="tree"]') as HTMLElement | null;
      if (!container) return;
      container.scrollTop = 300; // reveal would drag the offset down to the row
      fireEvent.scroll(container);
    });
    const setScrollTop = vi.fn();
    // Saved offset 40; selection f5 is passed as a prop (out of the restored view).
    useFileExplorerStore.setState({ scrollTop: 40, setScrollTop });

    render(<FileTree {...baseProps} rows={rowsOf(6)} selectedPath="f5.ts" />);
    vi.advanceTimersByTime(300); // past SCROLL_PERSIST_MS (250)

    expect(scrollIntoView).not.toHaveBeenCalled();
    // A mount-time reveal persist would have written 300 over the saved 40.
    expect(setScrollTop).not.toHaveBeenCalledWith(300);
  });

  // Existing behavior preserved: once the user moves the selection (ArrowDown),
  // the tree reveals the new row.
  it('reveals the selection when it changes after mount (keyboard nav)', () => {
    useFileExplorerStore.setState({ scrollTop: 0, selectedPath: 'f0.ts' });

    function Harness() {
      const [sel, setSel] = useState<string | null>('f0.ts');
      return <FileTree {...baseProps} rows={rowsOf(6)} selectedPath={sel} onSelectPath={setSel} />;
    }
    render(<Harness />);
    const tree = screen.getByRole('tree');

    // No reveal on mount.
    expect(scrollIntoView).not.toHaveBeenCalled();

    // ArrowDown moves the selection f0 → f1; the reveal fires for the change.
    fireEvent.keyDown(tree, { key: 'ArrowDown' });
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });

  // A row click that changes the selection also reveals it.
  it('reveals the selection when a different row is clicked', () => {
    useFileExplorerStore.setState({ scrollTop: 0, selectedPath: 'f0.ts' });

    function Harness() {
      const [sel, setSel] = useState<string | null>('f0.ts');
      return <FileTree {...baseProps} rows={rowsOf(6)} selectedPath={sel} onSelectPath={setSel} />;
    }
    render(<Harness />);
    expect(scrollIntoView).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('f4.ts'));
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });
});
