/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import type { FileEntry } from '@dorkos/shared/types';
import { TransportProvider, useAppStore } from '@/layers/shared/model';
import { useFileExplorerStore } from '../model/file-explorer-store';

// Hoisted so the (hoisted) vi.mock factories below can reference them.
const { executeUiCommand, toastError } = vi.hoisted(() => ({
  executeUiCommand: vi.fn(),
  toastError: vi.fn(),
}));

// Observe the shared UI-command seam that a file click drives, without running
// the real canvas dispatch.
vi.mock('@/layers/shared/lib', async (importActual) => {
  const actual = await importActual<typeof import('@/layers/shared/lib')>();
  return { ...actual, executeUiCommand };
});

// Capture error toasts (rendered to a portal otherwise).
vi.mock('sonner', () => ({ toast: { error: toastError, success: vi.fn(), message: vi.fn() } }));

import { FileExplorer } from '../ui/FileExplorer';
import { FileExplorerActions } from '../ui/FileExplorerActions';

const CWD = '/repo';

function dir(path: string): FileEntry {
  const name = path.includes('/') ? path.slice(path.lastIndexOf('/') + 1) : path;
  return { name, path, type: 'dir', size: 0, mtime: 0, isSymlink: false };
}
function file(path: string): FileEntry {
  const name = path.includes('/') ? path.slice(path.lastIndexOf('/') + 1) : path;
  return { name, path, type: 'file', size: 1, mtime: 0, isSymlink: false };
}

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
  vi.clearAllMocks();
  // The explorer persists per-cwd navigation state to localStorage; clear it so
  // expansion/selection from one test never leaks into the next.
  localStorage.clear();
  useAppStore.setState({ selectedCwd: CWD });
  // The toolbar and tree share this store; reset it so per-test state (the
  // show-hidden toggle, the published command bridge, and the per-cwd
  // expansion/selection/scroll) never leaks.
  useFileExplorerStore.setState({
    showHidden: false,
    commands: null,
    scopeKey: null,
    expanded: {},
    selectedPath: null,
    scrollTop: 0,
  });
});

afterEach(() => cleanup());

/**
 * Render the tree alongside its toolbar, mirroring how the container mounts
 * the Files panel: the toolbar (`FileExplorerActions`) lives in the shared
 * header, the tree below it, both wired through the file-explorer store. The
 * mock transport's tree responds by requested path.
 */
function renderExplorer(transport = createMockTransport()) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>
        <FileExplorerActions />
        <FileExplorer />
      </TransportProvider>
    </QueryClientProvider>
  );
}

describe('FileExplorer', () => {
  // The toolbar (rendered in the shared header) drives the separately-mounted
  // tree through the file-explorer store — no prop drilling across the header
  // boundary. These assert that bridge end-to-end.
  it('refetches the tree when the header Refresh button is clicked', async () => {
    const readFileTree = vi.fn(async () => ({ entries: [file('README.md')] }));
    const transport = createMockTransport();
    transport.readFileTree = readFileTree;

    renderExplorer(transport);
    await screen.findByRole('treeitem', { name: 'README.md' });

    const callsBefore = readFileTree.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(readFileTree.mock.calls.length).toBeGreaterThan(callsBefore));
  });

  it('reloads with hidden entries when the header toggle is flipped', async () => {
    const transport = createMockTransport();
    transport.readFileTree = vi.fn(async () => ({ entries: [file('README.md')] }));

    renderExplorer(transport);
    await screen.findByRole('treeitem', { name: 'README.md' });

    fireEvent.click(screen.getByRole('button', { name: 'Show hidden files' }));
    await waitFor(() =>
      expect(transport.readFileTree).toHaveBeenCalledWith(
        CWD,
        expect.objectContaining({ showHidden: true })
      )
    );
  });

  it("lazily fetches and renders a directory's children when it is expanded", async () => {
    const transport = createMockTransport();
    transport.readFileTree = vi.fn(async (_cwd, opts?: { path?: string }) => {
      if (!opts?.path) return { entries: [dir('src'), file('README.md')] };
      if (opts.path === 'src') return { entries: [file('src/index.ts')] };
      return { entries: [] };
    });

    renderExplorer(transport);

    // Root level renders; the child is not fetched yet.
    expect(await screen.findByRole('treeitem', { name: 'src' })).toBeInTheDocument();
    expect(screen.queryByRole('treeitem', { name: 'index.ts' })).not.toBeInTheDocument();

    // Expanding the directory fetches and renders its children.
    fireEvent.click(screen.getByRole('treeitem', { name: 'src' }));
    expect(await screen.findByRole('treeitem', { name: 'index.ts' })).toBeInTheDocument();
    expect(transport.readFileTree).toHaveBeenCalledWith(
      CWD,
      expect.objectContaining({ path: 'src' })
    );
  });

  it('opens a clicked file into the canvas via the open_file command', async () => {
    const transport = createMockTransport();
    transport.readFileTree = vi.fn(async () => ({ entries: [file('README.md')] }));

    renderExplorer(transport);

    fireEvent.click(await screen.findByRole('treeitem', { name: 'README.md' }));
    // Origin 'user': a click in the tree is an explicit pick, so the resulting
    // tab switch persists the per-agent preference (DOR-227).
    expect(executeUiCommand).toHaveBeenCalledWith(
      expect.anything(),
      {
        action: 'open_file',
        sourcePath: 'README.md',
      },
      'user'
    );
  });

  it('rolls the optimistic create back and toasts when the write conflicts', async () => {
    const transport = createMockTransport();
    transport.readFileTree = vi.fn(async () => ({ entries: [file('existing.ts')] }));
    transport.createEntry = vi.fn(async () => {
      throw Object.assign(new Error('exists'), { code: 'CONFLICT' });
    });

    renderExplorer(transport);
    await screen.findByRole('treeitem', { name: 'existing.ts' });

    // Start a new file, name it, and commit.
    fireEvent.click(screen.getByRole('button', { name: 'New File' }));
    const input = screen.getByRole('textbox', { name: 'New file name' });
    fireEvent.change(input, { target: { value: 'new.ts' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    // The optimistic row is rolled back (never persists) and the error surfaces,
    // while the pre-existing sibling is untouched.
    await waitFor(() => expect(transport.createEntry).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByRole('treeitem', { name: 'new.ts' })).toBeNull());
    expect(screen.getByRole('treeitem', { name: 'existing.ts' })).toBeInTheDocument();
    expect(toastError).toHaveBeenCalledWith('That name already exists');
  });

  it('leaves a colliding sibling intact when a rename conflicts', async () => {
    const transport = createMockTransport();
    transport.readFileTree = vi.fn(async () => ({ entries: [file('a.ts'), file('b.ts')] }));
    transport.renameEntry = vi.fn(async () => {
      throw Object.assign(new Error('exists'), { code: 'CONFLICT' });
    });

    renderExplorer(transport);
    const target = await screen.findByRole('treeitem', { name: 'a.ts' });

    // Select a.ts, then F2 to rename it → b.ts, a name a sibling already holds.
    fireEvent.click(target);
    fireEvent.keyDown(screen.getByRole('tree'), { key: 'F2' });
    const input = screen.getByRole('textbox', { name: 'New name' });
    fireEvent.change(input, { target: { value: 'b.ts' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(transport.renameEntry).toHaveBeenCalledWith(CWD, 'a.ts', 'b.ts'));
    // The tree is untouched: a.ts survives (not duplicated), b.ts is not destroyed.
    await waitFor(() => expect(toastError).toHaveBeenCalledWith('That name already exists'));
    expect(screen.getAllByRole('treeitem', { name: 'a.ts' })).toHaveLength(1);
    expect(screen.getAllByRole('treeitem', { name: 'b.ts' })).toHaveLength(1);
  });

  it('leaves the destination sibling intact when a drag-move conflicts', async () => {
    // Root shows a file x.ts and a directory dst that already contains an x.ts.
    const transport = createMockTransport();
    transport.readFileTree = vi.fn(async (_cwd, opts?: { path?: string }) =>
      opts?.path === 'dst'
        ? { entries: [file('dst/x.ts')] }
        : { entries: [dir('dst'), file('x.ts')] }
    );
    transport.renameEntry = vi.fn(async () => {
      throw Object.assign(new Error('exists'), { code: 'CONFLICT' });
    });

    renderExplorer(transport);

    // Expand dst so its pre-existing x.ts is loaded — now two x.ts rows exist
    // (DOM order: dst, dst/x.ts, root x.ts).
    fireEvent.click(await screen.findByRole('treeitem', { name: 'dst' }));
    await waitFor(() => expect(screen.getAllByRole('treeitem', { name: 'x.ts' })).toHaveLength(2));

    // Drag the root x.ts onto dst, which collides with dst/x.ts. One shared
    // dataTransfer round-trips setData (dragStart) → getData (drop).
    const dataTransfer = {
      store: {} as Record<string, string>,
      getData(k: string) {
        return this.store[k];
      },
      setData(k: string, v: string) {
        this.store[k] = v;
      },
    };
    const rootX = screen.getAllByRole('treeitem', { name: 'x.ts' })[1];
    const dstRow = screen.getByRole('treeitem', { name: 'dst' });
    fireEvent.dragStart(rootX, { dataTransfer });
    fireEvent.drop(dstRow, { dataTransfer });

    await waitFor(() =>
      expect(transport.renameEntry).toHaveBeenCalledWith(CWD, 'x.ts', 'dst/x.ts')
    );
    await waitFor(() => expect(toastError).toHaveBeenCalledWith('That name already exists'));
    // Both survive: dst/x.ts was never touched, root x.ts snapped back.
    expect(screen.getAllByRole('treeitem', { name: 'x.ts' })).toHaveLength(2);
  });

  it('confirms before recursively deleting a non-empty directory', async () => {
    const transport = createMockTransport();
    transport.readFileTree = vi.fn(async (_cwd, opts?: { path?: string }) =>
      opts?.path ? { entries: [] } : { entries: [dir('pkg')] }
    );
    transport.deleteEntry = vi.fn(async (_cwd, _path, opts?: { recursive?: boolean }) => {
      if (!opts?.recursive) throw Object.assign(new Error('not empty'), { code: 'DIR_NOT_EMPTY' });
      return { ok: true as const };
    });

    renderExplorer(transport);

    // Select the directory, then press Delete.
    const row = await screen.findByRole('treeitem', { name: 'pkg' });
    fireEvent.click(row);
    fireEvent.keyDown(screen.getByRole('tree'), { key: 'Delete' });

    await waitFor(() => expect(transport.deleteEntry).toHaveBeenCalledWith(CWD, 'pkg'));

    // The non-recursive delete failed → a confirm dialog appears.
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent(/isn.t empty/i);

    // Confirming retries with recursive: true.
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() =>
      expect(transport.deleteEntry).toHaveBeenLastCalledWith(CWD, 'pkg', { recursive: true })
    );
  });

  // The headline regression (DOR-404): the reported bug is that navigating deep,
  // opening a file (which unmounts the explorer), and coming back collapses the
  // tree to root. Expansion + selection must survive the unmount, and the
  // children must render from cache without a fresh fetch.
  it('restores expansion and selection from cache across unmount and remount', async () => {
    const readFileTree = vi.fn(async (_cwd: string, opts?: { path?: string }) => {
      if (!opts?.path) return { entries: [dir('src'), file('README.md')] };
      if (opts.path === 'src') return { entries: [file('src/index.ts')] };
      return { entries: [] };
    });
    const transport = createMockTransport();
    transport.readFileTree = readFileTree;

    // One QueryClient shared across the unmount → the tree cache survives, the
    // way it does within a real page session.
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    function Wrapper({ children }: { children: ReactNode }) {
      return (
        <QueryClientProvider client={queryClient}>
          <TransportProvider transport={transport}>{children}</TransportProvider>
        </QueryClientProvider>
      );
    }

    const view = render(<FileExplorer />, { wrapper: Wrapper });

    // Expand src, then select its child file.
    fireEvent.click(await screen.findByRole('treeitem', { name: 'src' }));
    fireEvent.click(await screen.findByRole('treeitem', { name: 'index.ts' }));
    await waitFor(() =>
      expect(screen.getByRole('treeitem', { name: 'index.ts' })).toHaveAttribute(
        'aria-selected',
        'true'
      )
    );
    const callsBeforeRemount = readFileTree.mock.calls.length;

    // Switch away (unmount) and back (remount).
    view.unmount();
    render(<FileExplorer />, { wrapper: Wrapper });

    // Expansion + selection intact, and the child renders straight from cache —
    // no new transport call for either level.
    const child = await screen.findByRole('treeitem', { name: 'index.ts' });
    expect(child).toHaveAttribute('aria-selected', 'true');
    expect(readFileTree.mock.calls.length).toBe(callsBeforeRemount);
  });

  // Review nit 1: a *failed* optimistic delete must leave store selection and
  // expansion exactly as they were. The optimistic cache filter briefly removes
  // the row before the transport rejects; the prune effect must not read that as
  // "the entry vanished" and drop the selection/subtree — a store prune the
  // rollback can't undo (the row would reappear unselected / collapsed).
  it('keeps a file selected when its optimistic delete fails (row returns, still selected)', async () => {
    // A test-controlled rejection: the optimistic removal must *commit* (and the
    // prune effect run) before the transport rejects — an immediate throw would
    // let React coalesce the optimistic + rollback renders and never reproduce it.
    const deferred: { reject: (e: unknown) => void } = { reject: () => {} };
    const transport = createMockTransport();
    transport.readFileTree = vi.fn(async () => ({
      entries: [file('README.md'), file('other.ts')],
    }));
    transport.deleteEntry = vi.fn(
      () => new Promise<never>((_resolve, reject) => (deferred.reject = reject))
    );

    renderExplorer(transport);
    const row = await screen.findByRole('treeitem', { name: 'README.md' });

    // Select it, then Delete → the optimistic removal commits (the row vanishes).
    fireEvent.click(row);
    await waitFor(() =>
      expect(screen.getByRole('treeitem', { name: 'README.md' })).toHaveAttribute(
        'aria-selected',
        'true'
      )
    );
    fireEvent.keyDown(screen.getByRole('tree'), { key: 'Delete' });
    await waitFor(() => expect(screen.queryByRole('treeitem', { name: 'README.md' })).toBeNull());

    // Now the transport rejects → the cache rolls back with an uncoded error.
    deferred.reject(new Error('denied'));

    // The row comes back AND is still selected — the prune never fired mid-delete.
    const restored = await screen.findByRole('treeitem', { name: 'README.md' });
    expect(restored).toHaveAttribute('aria-selected', 'true');
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("Couldn't delete"));
  });

  it('keeps a directory expanded when its optimistic recursive delete fails', async () => {
    const deferred: { reject: (e: unknown) => void } = { reject: () => {} };
    const transport = createMockTransport();
    transport.readFileTree = vi.fn(async (_cwd, opts?: { path?: string }) =>
      opts?.path === 'pkg' ? { entries: [file('pkg/index.ts')] } : { entries: [dir('pkg')] }
    );
    transport.deleteEntry = vi.fn((_cwd, _path, opts?: { recursive?: boolean }) =>
      // Non-recursive → DIR_NOT_EMPTY (surfaces the confirm); recursive → hangs
      // until the test rejects, so the optimistic removal commits first.
      opts?.recursive
        ? new Promise<never>((_resolve, reject) => (deferred.reject = reject))
        : Promise.reject(Object.assign(new Error('not empty'), { code: 'DIR_NOT_EMPTY' }))
    );

    renderExplorer(transport);

    // Expand pkg (this also selects it), so its child loads and the subtree is open.
    fireEvent.click(await screen.findByRole('treeitem', { name: 'pkg' }));
    await screen.findByRole('treeitem', { name: 'index.ts' });
    await waitFor(() =>
      expect(screen.getByRole('treeitem', { name: 'pkg' })).toHaveAttribute('aria-selected', 'true')
    );

    // Delete pkg → DIR_NOT_EMPTY → confirm, then confirm the recursive delete.
    fireEvent.keyDown(screen.getByRole('tree'), { key: 'Delete' });
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent(/isn.t empty/i);
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    // The optimistic removal commits: pkg (and its child) briefly vanish.
    await waitFor(() =>
      expect(transport.deleteEntry).toHaveBeenLastCalledWith(CWD, 'pkg', { recursive: true })
    );
    await waitFor(() => expect(screen.queryByRole('treeitem', { name: 'pkg' })).toBeNull());

    // Now the recursive delete fails → rollback.
    deferred.reject(new Error('denied'));

    // pkg returns AND is still expanded — its child renders from the surviving
    // cache (the store's expansion was never pruned during the failed delete).
    expect(await screen.findByRole('treeitem', { name: 'pkg' })).toBeInTheDocument();
    expect(await screen.findByRole('treeitem', { name: 'index.ts' })).toBeInTheDocument();
  });

  // Review nit 3: toggling show-hidden repartitions every query key. Without
  // placeholder data the tree blanks to a root spinner while the new keys fetch;
  // `keepPreviousData` must hold the previous rows across the toggle.
  it('holds the previous rows while a show-hidden toggle refetches (no blank spinner)', async () => {
    const deferred: { resolve: (v: { entries: FileEntry[] }) => void } = { resolve: () => {} };
    const transport = createMockTransport();
    transport.readFileTree = vi.fn((_cwd, opts?: { showHidden?: boolean }) =>
      opts?.showHidden
        ? new Promise<{ entries: FileEntry[] }>((res) => {
            deferred.resolve = res;
          })
        : Promise.resolve({ entries: [file('README.md')] })
    );

    renderExplorer(transport);
    await screen.findByRole('treeitem', { name: 'README.md' });

    // Flip show-hidden: the new key's fetch hangs, but the previous row holds.
    fireEvent.click(screen.getByRole('button', { name: 'Show hidden files' }));
    expect(screen.getByRole('treeitem', { name: 'README.md' })).toBeInTheDocument();

    // Resolving the hidden fetch swaps the dotfile in alongside.
    deferred.resolve({ entries: [file('README.md'), file('.env')] });
    await screen.findByRole('treeitem', { name: '.env' });
  });

  it('refreshes the whole expanded subtree, not just the root (D4)', async () => {
    const readFileTree = vi.fn(async (_cwd: string, opts?: { path?: string }) => {
      if (!opts?.path) return { entries: [dir('src')] };
      if (opts.path === 'src') return { entries: [file('src/index.ts')] };
      return { entries: [] };
    });
    const transport = createMockTransport();
    transport.readFileTree = readFileTree;

    renderExplorer(transport);

    // Expand src so both root and src are active queries.
    fireEvent.click(await screen.findByRole('treeitem', { name: 'src' }));
    await screen.findByRole('treeitem', { name: 'index.ts' });

    readFileTree.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));

    // Refresh refetched BOTH levels (root + the expanded src), not root-only.
    await waitFor(() => {
      const paths = readFileTree.mock.calls.map((c) => c[1]?.path);
      expect(paths).toContain(undefined); // root
      expect(paths).toContain('src'); // the expanded subdirectory
    });
  });
});
