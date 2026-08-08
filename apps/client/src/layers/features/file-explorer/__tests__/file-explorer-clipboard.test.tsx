/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import type { FileEntry, ServerConfig } from '@dorkos/shared/types';
import { TransportProvider, useAppStore } from '@/layers/shared/model';
import { useFileExplorerStore } from '../model/file-explorer-store';

const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }));
vi.mock('sonner', () => ({ toast: { error: toastError, success: vi.fn(), message: vi.fn() } }));

import { FileExplorer } from '../ui/FileExplorer';

const CWD = '/Users/kai/repo';

function file(path: string): FileEntry {
  const name = path.includes('/') ? path.slice(path.lastIndexOf('/') + 1) : path;
  return { name, path, type: 'file', size: 1, mtime: 0, isSymlink: false };
}

function dir(path: string): FileEntry {
  const name = path.includes('/') ? path.slice(path.lastIndexOf('/') + 1) : path;
  return { name, path, type: 'dir', size: 0, mtime: 0, isSymlink: false };
}

let writeText: ReturnType<typeof vi.fn>;

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
  global.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  useAppStore.setState({ selectedCwd: CWD });
  useFileExplorerStore.setState({
    showHidden: false,
    commands: null,
    clipboard: null,
    scopeKey: null,
    expanded: {},
    selectedPath: null,
    scrollTop: 0,
  });
  writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
});

afterEach(() => cleanup());

/**
 * A transport over a small in-memory tree. `copyEntry` actually writes into it,
 * so what the tree shows after a paste is what the server would have produced —
 * an optimistic row that the refetch then contradicts would be visible here.
 */
function transportOverTree(copyFails = false) {
  const tree: Record<string, FileEntry[]> = {
    '': [dir('src'), file('README.md')],
    src: [file('src/a.ts')],
  };
  const copyEntry = vi.fn(async (_cwd: string, _from: string, to: string) => {
    if (copyFails) throw new Error('disk full');
    const parent = to.includes('/') ? to.slice(0, to.lastIndexOf('/')) : '';
    tree[parent] = [...(tree[parent] ?? []), file(to)];
    return { ok: true as const };
  });
  const transport = createMockTransport({
    readFileTree: vi.fn(async (_cwd: string, opts?: { path?: string }) => ({
      entries: tree[opts?.path ?? ''] ?? [],
    })),
    getConfig: vi.fn(async () => ({ platform: 'darwin-arm64' }) as ServerConfig),
    copyEntry,
  });
  return { transport, copyEntry };
}

/** Render the explorer and open the context menu on one row. */
async function openMenuOn(rowName: string, transport: ReturnType<typeof createMockTransport>) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>
        <FileExplorer />
      </TransportProvider>
    </QueryClientProvider>
  );
  fireEvent.contextMenu(await screen.findByRole('treeitem', { name: rowName }));
}

describe('File explorer clipboard (DOR-1032)', () => {
  it('offers nothing to paste until something has been copied', async () => {
    const { transport } = transportOverTree();
    await openMenuOn('README.md', transport);

    expect(await screen.findByText('Paste')).toHaveAttribute('aria-disabled', 'true');
  });

  it('copies an entry, then pastes it into a folder', async () => {
    const { transport, copyEntry } = transportOverTree();
    await openMenuOn('README.md', transport);
    fireEvent.click(await screen.findByText('Copy'));

    // Copy puts the path on the system clipboard too, so a paste into the chat
    // or another app yields the path.
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('README.md'));
    expect(useFileExplorerStore.getState().clipboard).toEqual({
      path: 'README.md',
      isDir: false,
    });

    fireEvent.contextMenu(screen.getByRole('treeitem', { name: 'src' }));
    const paste = await screen.findByText('Paste');
    expect(paste).not.toHaveAttribute('aria-disabled');
    fireEvent.click(paste);

    // The name is free inside `src`, so nothing is renamed.
    await waitFor(() => expect(copyEntry).toHaveBeenCalledWith(CWD, 'README.md', 'src/README.md'));
  });

  it('names the copy out of the way when the destination already has that name', async () => {
    const { transport, copyEntry } = transportOverTree();
    await openMenuOn('README.md', transport);
    fireEvent.click(await screen.findByText('Copy'));
    await waitFor(() => expect(useFileExplorerStore.getState().clipboard).not.toBeNull());

    // Pasting on a FILE row targets its folder — here the root, which already
    // holds README.md.
    fireEvent.contextMenu(screen.getByRole('treeitem', { name: 'README.md' }));
    fireEvent.click(await screen.findByText('Paste'));

    await waitFor(() => expect(copyEntry).toHaveBeenCalledWith(CWD, 'README.md', 'README copy.md'));
    expect(await screen.findByText('README copy.md')).toBeInTheDocument();
  });

  it('duplicates an entry beside itself in one step', async () => {
    const { transport, copyEntry } = transportOverTree();
    await openMenuOn('README.md', transport);

    fireEvent.click(await screen.findByText('Duplicate'));

    await waitFor(() => expect(copyEntry).toHaveBeenCalledWith(CWD, 'README.md', 'README copy.md'));
    expect(await screen.findByText('README copy.md')).toBeInTheDocument();
  });

  it('takes the copy back off the tree when the server refuses it', async () => {
    const { transport } = transportOverTree(true);
    await openMenuOn('README.md', transport);

    fireEvent.click(await screen.findByText('Duplicate'));

    await waitFor(() => expect(toastError).toHaveBeenCalledWith("Couldn't copy"));
    await waitFor(() => expect(screen.queryByText('README copy.md')).not.toBeInTheDocument());
  });

  it('empties the clipboard when the working directory changes', () => {
    useFileExplorerStore.getState().loadExplorerForCwd(CWD);
    useFileExplorerStore.getState().setClipboard({ path: 'README.md', isDir: false });

    // A remount of the same directory is not a change — what was copied survives.
    useFileExplorerStore.getState().loadExplorerForCwd(CWD);
    expect(useFileExplorerStore.getState().clipboard).not.toBeNull();

    useFileExplorerStore.getState().loadExplorerForCwd('/Users/kai/other');

    // The path meant something only inside the directory it was copied in.
    expect(useFileExplorerStore.getState().clipboard).toBeNull();
  });
});
