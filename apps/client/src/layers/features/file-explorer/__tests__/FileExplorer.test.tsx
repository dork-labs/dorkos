/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
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
  useAppStore.setState({ selectedCwd: CWD });
  // The toolbar and tree share this store; reset it so per-test state (the
  // show-hidden toggle, the published command bridge) never leaks.
  useFileExplorerStore.setState({ showHidden: false, commands: null });
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
});
