/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import type { FileEntry, ServerConfig } from '@dorkos/shared/types';
import type { Transport } from '@dorkos/shared/transport';
import { TransportProvider, useAppStore } from '@/layers/shared/model';
import { registerComposerInsert } from '@/layers/shared/lib';
import { useFileExplorerStore } from '../model/file-explorer-store';

const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }));

// Capture error toasts (they render to a portal otherwise).
vi.mock('sonner', () => ({ toast: { error: toastError, success: vi.fn(), message: vi.fn() } }));

import { FileExplorer } from '../ui/FileExplorer';

const CWD = '/Users/kai/repo';

function file(path: string): FileEntry {
  const name = path.includes('/') ? path.slice(path.lastIndexOf('/') + 1) : path;
  return { name, path, type: 'file', size: 1, mtime: 0, isSymlink: false };
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
  // The context menu needs both for jsdom.
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
    scopeKey: null,
    expanded: {},
    selectedPath: null,
    scrollTop: 0,
  });
  writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  });
});

afterEach(() => cleanup());

/** A mock transport whose tree holds one file and whose server reports `platform`. */
function transportOn(platform: string, overrides: Partial<Transport> = {}) {
  const config = { platform } as ServerConfig;
  return createMockTransport({
    readFileTree: vi.fn(async () => ({ entries: [file('README.md')] })),
    getConfig: vi.fn(async () => config),
    ...overrides,
  });
}

/** Render the tree and open the context menu on its one row. */
async function openRowMenu(transport = transportOn('darwin-arm64')) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>
        <FileExplorer />
      </TransportProvider>
    </QueryClientProvider>
  );
  const row = await screen.findByRole('treeitem', { name: 'README.md' });
  fireEvent.contextMenu(row);
  return transport;
}

describe('File explorer context-menu actions', () => {
  it('names the reveal item after the file manager the SERVER platform ships', async () => {
    await openRowMenu(transportOn('darwin-arm64'));

    expect(await screen.findByText('Reveal in Finder')).toBeInTheDocument();
  });

  it('names it File Explorer when the server runs Windows', async () => {
    await openRowMenu(transportOn('win32-x64'));

    expect(await screen.findByText('Reveal in File Explorer')).toBeInTheDocument();
  });

  it('offers no reveal item at all on a transport that cannot open a file manager', async () => {
    await openRowMenu(transportOn('darwin-arm64', { supportsReveal: false }));

    await screen.findByText('Add to Chat');
    expect(screen.queryByText('Reveal in Finder')).not.toBeInTheDocument();
    expect(screen.queryByText('Show in File Manager')).not.toBeInTheDocument();
  });

  it('asks the server to reveal the clicked entry', async () => {
    const transport = await openRowMenu();

    fireEvent.click(await screen.findByText('Reveal in Finder'));

    await waitFor(() => expect(transport.revealEntry).toHaveBeenCalledWith(CWD, 'README.md'));
  });

  it('toasts when the server cannot open a file manager', async () => {
    await openRowMenu(
      transportOn('linux-x64', {
        revealEntry: vi.fn(async () => {
          throw new Error('no file manager');
        }),
      })
    );
    fireEvent.click(await screen.findByText('Show in File Manager'));

    await waitFor(() => expect(toastError).toHaveBeenCalledWith("Couldn't open the file manager"));
  });

  it('copies the absolute path, and says nothing when it works', async () => {
    await openRowMenu();

    fireEvent.click(await screen.findByText('Copy Path'));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('/Users/kai/repo/README.md'));
    expect(toastError).not.toHaveBeenCalled();
  });

  it('copies the path relative to the working directory', async () => {
    await openRowMenu();

    fireEvent.click(await screen.findByText('Copy Relative Path'));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('README.md'));
  });

  it('toasts when the browser refuses the clipboard write', async () => {
    writeText.mockRejectedValueOnce(new Error('denied'));

    await openRowMenu();
    fireEvent.click(await screen.findByText('Copy Path'));

    await waitFor(() => expect(toastError).toHaveBeenCalledWith("Couldn't copy to the clipboard"));
  });

  it('inserts a space-terminated @reference into the composer', async () => {
    const insert = vi.fn();
    const unregister = registerComposerInsert(insert);

    await openRowMenu();
    fireEvent.click(await screen.findByText('Add to Chat'));

    expect(insert).toHaveBeenCalledWith('@README.md ');
    unregister();
  });

  it('says so when there is no composer to add the file to', async () => {
    await openRowMenu();

    fireEvent.click(await screen.findByText('Add to Chat'));

    expect(toastError).toHaveBeenCalledWith('Open a chat first to add a file to it');
  });
});
