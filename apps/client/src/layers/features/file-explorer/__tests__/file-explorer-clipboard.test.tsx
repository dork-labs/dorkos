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
function transportOverTree(options: { copyError?: unknown; hidden?: FileEntry[] } = {}) {
  const tree: Record<string, FileEntry[]> = {
    '': [dir('src'), file('README.md')],
    src: [file('src/a.ts')],
  };
  const copyEntry = vi.fn(async (_cwd: string, _from: string, to: string) => {
    if (options.copyError) throw options.copyError;
    const parent = to.includes('/') ? to.slice(0, to.lastIndexOf('/')) : '';
    tree[parent] = [...(tree[parent] ?? []), file(to)];
    return { ok: true as const };
  });
  // Hidden entries are in the directory but out of the tree's own listing —
  // exactly what the show-hidden toggle does on the server.
  const readFileTree = vi.fn(
    async (_cwd: string, opts?: { path?: string; showHidden?: boolean }) => {
      const visible = tree[opts?.path ?? ''] ?? [];
      const hidden = opts?.path ? [] : (options.hidden ?? []);
      return { entries: opts?.showHidden ? [...visible, ...hidden] : visible };
    }
  );
  const transport = createMockTransport({
    readFileTree,
    getConfig: vi.fn(async () => ({ platform: 'darwin-arm64' }) as ServerConfig),
    copyEntry,
  });
  return { transport, copyEntry, readFileTree };
}

/** A coded file-service error, the shape both transports throw. */
function codedError(code: string) {
  return Object.assign(new Error(code), { code });
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
    const { transport } = transportOverTree({ copyError: new Error('disk full') });
    await openMenuOn('README.md', transport);

    fireEvent.click(await screen.findByText('Duplicate'));

    await waitFor(() => expect(toastError).toHaveBeenCalledWith("Couldn't copy"));
    await waitFor(() => expect(screen.queryByText('README copy.md')).not.toBeInTheDocument());
  });

  it('steers around a name the tree is not even showing', async () => {
    // `.env` is hidden while the show-hidden toggle is off, but it still owns
    // its name: naming the copy from the visible listing alone lands on top of
    // it and the server answers 409.
    const { transport, copyEntry, readFileTree } = transportOverTree({ hidden: [file('.env')] });
    await openMenuOn('README.md', transport);
    fireEvent.click(await screen.findByText('Copy'));
    await waitFor(() => expect(useFileExplorerStore.getState().clipboard).not.toBeNull());
    useFileExplorerStore.getState().setClipboard({ path: '.env', isDir: false });

    fireEvent.contextMenu(screen.getByRole('treeitem', { name: 'README.md' }));
    fireEvent.click(await screen.findByText('Paste'));

    await waitFor(() => expect(copyEntry).toHaveBeenCalledWith(CWD, '.env', '.env copy'));
    expect(readFileTree).toHaveBeenCalledWith(CWD, expect.objectContaining({ showHidden: true }));
  });

  it('says so instead of doing nothing when a folder is pasted into itself', async () => {
    // The most natural way to hit this: copy a folder, then paste with it still
    // selected. It used to return in silence, which reads as a broken Paste.
    const { transport, copyEntry } = transportOverTree();
    await openMenuOn('src', transport);
    fireEvent.click(await screen.findByText('Copy'));
    await waitFor(() =>
      expect(useFileExplorerStore.getState().clipboard).toEqual({ path: 'src', isDir: true })
    );

    // The menu item is dimmed for exactly this target...
    fireEvent.contextMenu(screen.getByRole('treeitem', { name: 'src' }));
    expect(await screen.findByText('Paste')).toHaveAttribute('aria-disabled', 'true');

    // ...and the keyboard, which the dimming cannot stop, is told why. The open
    // menu hides the rest of the page from the accessibility tree, so close it
    // the way a person would before reaching for the shortcut.
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(await screen.findByRole('treeitem', { name: 'src' }));
    fireEvent.keyDown(screen.getByRole('tree'), { key: 'v', metaKey: true });

    await waitFor(() => expect(toastError).toHaveBeenCalledWith("Can't copy a folder into itself"));
    expect(copyEntry).not.toHaveBeenCalled();
  });

  it('explains the server refusing a folder copied into itself in the same words', async () => {
    // A case-insensitive filesystem can call `SRC` and `src` the same folder,
    // which the client's own path check cannot see. The server catches it, and
    // its coded answer must not degrade into the generic "Couldn't copy".
    const { transport } = transportOverTree({ copyError: codedError('COPY_INTO_SELF') });
    await openMenuOn('src', transport);

    fireEvent.click(await screen.findByText('Duplicate'));

    await waitFor(() => expect(toastError).toHaveBeenCalledWith("Can't copy a folder into itself"));
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
