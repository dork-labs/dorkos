/**
 * @vitest-environment jsdom
 */
/**
 * A person changing a room's files from the Files panel (spec `agent-home-desk`
 * §7.3): new files and folders, uploads, renames and moves, deletes — each one
 * optimistic, each rolled back on anything but success, and each refusal told in
 * words a person can act on.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import type { Transport } from '@dorkos/shared/transport';
import type { RoomFileChangeResponse, RoomFileEntry } from '@dorkos/shared/room-files';
import { TransportProvider } from '@/layers/shared/model';
import { useFileExplorerStore } from '../model/file-explorer-store';

const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }));
vi.mock('sonner', () => ({ toast: { error: toastError, success: vi.fn(), message: vi.fn() } }));

import { RoomFilesSection } from '../ui/RoomFilesSection';

const ROOM_ID = 'room-1';
const HEAD = 'aaa1111';
const THEIRS = {
  sha: 'bbb2222bbb2222',
  author: 'Ana',
  at: '2026-09-26T09:00:00.000Z',
  subject: 'Tidy the notes',
};

function file(path: string, kind: RoomFileEntry['kind'] = 'file'): RoomFileEntry {
  return { name: path.slice(path.lastIndexOf('/') + 1), path, kind, size: 3, lastCommit: null };
}

/** A room whose files hold `tree` (directory → entries), all read at {@link HEAD}. */
function roomWith(tree: Record<string, RoomFileEntry[]>): Transport {
  const transport = createMockTransport();
  transport.readRoomFiles = vi.fn(async (_id: string, path?: string) => ({
    path: path ?? '',
    commit: HEAD,
    entries: tree[path ?? ''] ?? [],
  }));
  const changed = { commit: 'ccc3333', paths: [], lastCommit: null };
  transport.moveRoomFile = vi.fn().mockResolvedValue(changed);
  transport.deleteRoomFile = vi.fn().mockResolvedValue(changed);
  transport.uploadRoomFiles = vi.fn().mockResolvedValue(changed);
  return transport;
}

/**
 * Refuse a change the way the room does — and, first, stop the tree from ever
 * hearing back from the server again.
 *
 * Every change ends by re-reading the tree, and a mock that answers that read
 * instantly puts the right rows back whether or not the change rolled back its
 * own optimistic edit. Freezing the listings at the moment of refusal leaves
 * the rollback as the only thing that can put the tree right, which is what
 * these tests are about.
 */
function refuseAndFreeze(transport: Transport, error: Error) {
  return vi.fn(async () => {
    transport.readRoomFiles = vi.fn(() => new Promise<never>(() => {}));
    throw error;
  });
}

/** A refusal as the HTTP transport throws it. */
function refusal(code: string, message = 'refused', body?: unknown): Error {
  return Object.assign(new Error(message), { code, status: 409, body });
}

/** A lost race, with the conflict body the server sends. */
function lostRace(path: string): Error {
  return refusal('FILE_CHANGED', 'Somebody changed these files after you opened them.', {
    error: 'Somebody changed these files after you opened them.',
    code: 'FILE_CHANGED',
    conflict: { path, commit: 'ddd4444', lastCommit: THEIRS },
  });
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
  localStorage.clear();
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

function renderSection(transport: Transport, canChange = true) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>
        <RoomFilesSection roomId={ROOM_ID} canChange={canChange} />
      </TransportProvider>
    </QueryClientProvider>
  );
  return { queryClient };
}

/**
 * Select a row with the keyboard and press a key on the tree — F2 renames,
 * Delete deletes. The keyboard rather than the row menu because clicking a
 * file row in a room opens it; the menu's own items are pinned in
 * `RoomFilesSection.test.tsx` and driven for real in the browser spec.
 */
async function press(rowName: string, key: 'F2' | 'Delete') {
  const row = await screen.findByRole('treeitem', { name: rowName });
  const tree = screen.getByRole('tree', { name: 'File explorer' });
  for (let i = 0; i < 10 && row.getAttribute('aria-selected') !== 'true'; i += 1) {
    fireEvent.keyDown(tree, { key: 'ArrowDown' });
  }
  fireEvent.keyDown(tree, { key });
}

/** Drop files from outside the app onto an element. */
function dropFiles(target: Element, files: File[]) {
  const dataTransfer = { types: ['Files'], files, items: undefined, dropEffect: 'none' };
  fireEvent.dragOver(target, { dataTransfer });
  fireEvent.drop(target, { dataTransfer });
}

describe('renaming a room’s file', () => {
  it('renames in place at once, and sends the version the person saw', async () => {
    const transport = roomWith({ '': [file('notes.md')] });
    let land!: () => void;
    transport.moveRoomFile = vi.fn(
      () =>
        new Promise<RoomFileChangeResponse>((resolve) => {
          land = () => resolve({ commit: 'ccc3333', paths: ['plan.md'], lastCommit: null });
        })
    );
    renderSection(transport);

    await press('notes.md', 'F2');
    const input = screen.getByRole('textbox', { name: 'New name' });
    fireEvent.change(input, { target: { value: 'plan.md' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    // Optimistic: the row reads the new name before the room has answered.
    expect(await screen.findByRole('treeitem', { name: 'plan.md' })).toBeInTheDocument();
    expect(transport.moveRoomFile).toHaveBeenCalledWith(ROOM_ID, {
      from: 'notes.md',
      to: 'plan.md',
      baseCommit: HEAD,
    });
    land();
  });

  it('puts the name back and says so when the new name is taken', async () => {
    const transport = roomWith({ '': [file('notes.md')] });
    transport.moveRoomFile = refuseAndFreeze(transport, refusal('ROOM_FILE_EXISTS'));
    renderSection(transport);

    await press('notes.md', 'F2');
    const input = screen.getByRole('textbox', { name: 'New name' });
    fireEvent.change(input, { target: { value: 'plan.md' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        'There’s already something called “plan.md” there, so nothing was changed. Pick another name.'
      )
    );
    expect(screen.getByRole('treeitem', { name: 'notes.md' })).toBeInTheDocument();
    expect(screen.queryByRole('treeitem', { name: 'plan.md' })).not.toBeInTheDocument();
  });

  it('tells a paused room plainly, and rolls the row back', async () => {
    const transport = roomWith({ '': [file('notes.md')] });
    transport.moveRoomFile = refuseAndFreeze(transport, refusal('MAIN_CHECKOUT_DIRTY'));
    renderSection(transport);

    await press('notes.md', 'F2');
    const input = screen.getByRole('textbox', { name: 'New name' });
    fireEvent.change(input, { target: { value: 'plan.md' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        'Somebody changed this room’s files outside DorkOS, so changes are paused until that is sorted out. The warning above the files says how.'
      )
    );
    expect(screen.getByRole('treeitem', { name: 'notes.md' })).toBeInTheDocument();
    expect(screen.queryByRole('treeitem', { name: 'plan.md' })).not.toBeInTheDocument();
  });

  it('a rename the network loses puts the name back and says it did not happen', async () => {
    const transport = roomWith({ '': [file('notes.md')] });
    // A plain Error — no code, no body — is what a dropped connection throws.
    transport.moveRoomFile = refuseAndFreeze(transport, new Error('Failed to fetch'));
    renderSection(transport);

    await press('notes.md', 'F2');
    const input = screen.getByRole('textbox', { name: 'New name' });
    fireEvent.change(input, { target: { value: 'plan.md' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(toastError).toHaveBeenCalledWith('Couldn’t rename'));
    expect(screen.getByRole('treeitem', { name: 'notes.md' })).toBeInTheDocument();
    expect(screen.queryByRole('treeitem', { name: 'plan.md' })).not.toBeInTheDocument();
  });

  it('a move into a folder that is refused puts the row back where it was', async () => {
    const transport = roomWith({ '': [file('notes.md'), file('docs', 'dir')], docs: [] });
    transport.moveRoomFile = refuseAndFreeze(transport, refusal('MERGE_IN_FLIGHT'));
    renderSection(transport);

    const row = await screen.findByRole('treeitem', { name: 'notes.md' });
    const dataTransfer = {
      types: ['application/x-dorkos-file-path', 'text/plain'],
      getData: (type: string) => (type === 'text/plain' ? '' : 'notes.md'),
      setData: vi.fn(),
      dropEffect: 'none',
      effectAllowed: 'all',
    };
    fireEvent.dragStart(row, { dataTransfer });
    const folder = screen.getByRole('treeitem', { name: 'docs' });
    fireEvent.dragOver(folder, { dataTransfer });
    fireEvent.drop(folder, { dataTransfer });

    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(transport.moveRoomFile).toHaveBeenCalledWith(ROOM_ID, {
      from: 'notes.md',
      to: 'docs/notes.md',
      baseCommit: HEAD,
    });
    expect(screen.getByRole('treeitem', { name: 'notes.md' })).toBeInTheDocument();
  });

  it('says what the server said about a name that differs only in capitals', async () => {
    const transport = roomWith({ '': [file('notes.md')] });
    transport.moveRoomFile = vi
      .fn()
      .mockRejectedValue(
        refusal(
          'ROOM_FILE_NOT_READABLE',
          'This room already has `Docs/`, and a name that differs only in capital letters or accents is the same folder on some computers. Use `Docs/` instead.'
        )
      );
    renderSection(transport);

    await press('notes.md', 'F2');
    const input = screen.getByRole('textbox', { name: 'New name' });
    fireEvent.change(input, { target: { value: 'docs/notes.md' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        'This room already has “Docs/”, and a name that differs only in capital letters or accents is the same folder on some computers. Use “Docs/” instead.'
      )
    );
  });
});

describe('deleting from a room’s files', () => {
  it('confirms a file, says the history keeps it, and deletes only on yes', async () => {
    const transport = roomWith({ '': [file('notes.md')] });
    renderSection(transport);

    await press('notes.md', 'Delete');
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('Delete this file?');
    expect(dialog).toHaveTextContent(
      '“notes.md” leaves the room’s files. The room’s history keeps a copy, so an agent or git can bring it back if you need it.'
    );
    expect(transport.deleteRoomFile).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() =>
      expect(transport.deleteRoomFile).toHaveBeenCalledWith(ROOM_ID, {
        path: 'notes.md',
        baseCommit: HEAD,
      })
    );
  });

  it('names a folder and how many files are in it', async () => {
    const transport = roomWith({
      '': [file('designs', 'dir')],
      designs: [file('designs/a.png'), file('designs/old', 'dir')],
      'designs/old': [file('designs/old/b.png')],
    });
    renderSection(transport);

    await press('designs', 'Delete');
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('Delete this folder?');
    await waitFor(() =>
      expect(dialog).toHaveTextContent('“designs” and the 2 files in it leave the room’s files.')
    );
  });

  it('a refused delete puts the row back', async () => {
    const transport = roomWith({ '': [file('notes.md')] });
    transport.deleteRoomFile = refuseAndFreeze(transport, refusal('MERGE_IN_FLIGHT'));
    renderSection(transport);

    await press('notes.md', 'Delete');
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete' })
    );

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        'Somebody else is changing this room’s files right now, so nothing was changed. Try again in a moment.'
      )
    );
    expect(screen.getByRole('treeitem', { name: 'notes.md' })).toBeInTheDocument();
  });

  it('hands the keyboard back to the tree when the confirmation closes, either way', async () => {
    const transport = roomWith({ '': [file('notes.md'), file('plan.md')] });
    renderSection(transport);
    const tree = await screen.findByRole('tree', { name: 'File explorer' });

    await press('notes.md', 'Delete');
    fireEvent.keyDown(await screen.findByRole('alertdialog'), { key: 'Escape' });
    await waitFor(() => expect(document.activeElement).toBe(tree));

    await press('plan.md', 'Delete');
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete' })
    );
    await waitFor(() => expect(document.activeElement).toBe(tree));
  });

  it('cancelling deletes nothing', async () => {
    const transport = roomWith({ '': [file('notes.md')] });
    renderSection(transport);

    await press('notes.md', 'Delete');
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(transport.deleteRoomFile).not.toHaveBeenCalled();
    expect(screen.getByRole('treeitem', { name: 'notes.md' })).toBeInTheDocument();
  });

  it('a lost race asks, names who got there first, and "anyway" sends their version as the base', async () => {
    const transport = roomWith({ '': [file('notes.md')] });
    transport.deleteRoomFile = vi
      .fn()
      .mockRejectedValueOnce(lostRace('notes.md'))
      .mockResolvedValueOnce({ commit: 'eee5555', paths: ['notes.md'], lastCommit: null });
    renderSection(transport);

    await press('notes.md', 'Delete');
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete' })
    );

    const race = await screen.findByText(
      'Ana changed “notes.md” after you opened it, so nothing was deleted.'
    );
    // Nothing was deleted while the question is open: the row came back (behind
    // the dialog, so hidden from the accessibility tree while it is up).
    expect(screen.getByRole('treeitem', { name: 'notes.md', hidden: true })).toBeInTheDocument();
    const dialog = race.closest('[role="alertdialog"]') as HTMLElement;
    expect(within(dialog).getByText(/Tidy the notes/)).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete it anyway' }));
    await waitFor(() =>
      expect(transport.deleteRoomFile).toHaveBeenLastCalledWith(ROOM_ID, {
        path: 'notes.md',
        baseCommit: 'ddd4444',
      })
    );
  });

  it('"Open their version" shows the file somebody else changed', async () => {
    const transport = roomWith({ '': [file('notes.md')] });
    transport.deleteRoomFile = vi.fn().mockRejectedValue(lostRace('notes.md'));
    transport.readRoomFileContent = vi.fn().mockResolvedValue({
      path: 'notes.md',
      commit: 'ddd4444',
      size: 6,
      lastCommit: THEIRS,
      body: { kind: 'text', encoding: 'utf-8', text: 'theirs' },
    });
    renderSection(transport);

    await press('notes.md', 'Delete');
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete' })
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Open their version' }));

    expect(await screen.findByText('theirs')).toBeInTheDocument();
    expect(transport.deleteRoomFile).toHaveBeenCalledTimes(1);
  });
});

describe('uploading into a room’s files', () => {
  it('uploads files dropped on the panel into the top folder', async () => {
    const transport = roomWith({ '': [file('notes.md')] });
    renderSection(transport);
    await screen.findByRole('treeitem', { name: 'notes.md' });

    const a = new File(['a'], 'a.png', { type: 'image/png' });
    const b = new File(['b'], 'b.txt', { type: 'text/plain' });
    dropFiles(screen.getByRole('tree', { name: 'File explorer' }), [a, b]);

    await waitFor(() =>
      expect(transport.uploadRoomFiles).toHaveBeenCalledWith(ROOM_ID, {
        dir: '',
        baseCommit: HEAD,
        replace: [],
        files: [a, b],
      })
    );
  });

  it('uploads files dropped on a folder row into that folder', async () => {
    const transport = roomWith({ '': [file('designs', 'dir')], designs: [] });
    renderSection(transport);

    const a = new File(['a'], 'a.png', { type: 'image/png' });
    dropFiles(await screen.findByRole('treeitem', { name: 'designs' }), [a]);

    await waitFor(() =>
      expect(transport.uploadRoomFiles).toHaveBeenCalledWith(
        ROOM_ID,
        expect.objectContaining({ dir: 'designs', files: [a] })
      )
    );
  });

  it('asks before replacing, and replacing names the file', async () => {
    const transport = roomWith({ '': [file('notes.md')] });
    renderSection(transport);
    await screen.findByRole('treeitem', { name: 'notes.md' });

    const mine = new File(['mine'], 'notes.md', { type: 'text/markdown' });
    dropFiles(screen.getByRole('tree', { name: 'File explorer' }), [mine]);

    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('Replace “notes.md”?');
    expect(transport.uploadRoomFiles).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Replace' }));
    await waitFor(() =>
      expect(transport.uploadRoomFiles).toHaveBeenCalledWith(ROOM_ID, {
        dir: '',
        baseCommit: HEAD,
        replace: ['notes.md'],
        files: [mine],
      })
    );
  });

  it('keeping both uploads mine under the name a copy would get', async () => {
    const transport = roomWith({ '': [file('notes.md')] });
    renderSection(transport);
    await screen.findByRole('treeitem', { name: 'notes.md' });

    dropFiles(screen.getByRole('tree', { name: 'File explorer' }), [
      new File(['mine'], 'notes.md', { type: 'text/markdown' }),
    ]);
    fireEvent.click(await screen.findByRole('button', { name: 'Keep both' }));

    await waitFor(() => expect(transport.uploadRoomFiles).toHaveBeenCalled());
    const sent = (transport.uploadRoomFiles as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(sent.replace).toEqual([]);
    expect(sent.files.map((f: File) => f.name)).toEqual(['notes copy.md']);
  });

  it('refuses more than twenty files before sending anything', async () => {
    const transport = roomWith({ '': [file('notes.md')] });
    renderSection(transport);
    await screen.findByRole('treeitem', { name: 'notes.md' });

    const many = Array.from({ length: 21 }, (_, i) => new File(['x'], `f${i}.txt`));
    dropFiles(screen.getByRole('tree', { name: 'File explorer' }), many);

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        'One upload can carry up to 20 files, so nothing was uploaded. Try again with fewer.'
      )
    );
    expect(transport.uploadRoomFiles).not.toHaveBeenCalled();
  });

  it('takes files from the Upload button’s picker', async () => {
    const transport = roomWith({ '': [file('notes.md')] });
    renderSection(transport);
    await screen.findByRole('treeitem', { name: 'notes.md' });

    fireEvent.click(screen.getByRole('button', { name: 'Upload files' }));
    const picked = new File(['p'], 'picked.pdf', { type: 'application/pdf' });
    fireEvent.change(screen.getByTestId('room-files-upload-input'), {
      target: { files: [picked] },
    });

    await waitFor(() =>
      expect(transport.uploadRoomFiles).toHaveBeenCalledWith(
        ROOM_ID,
        expect.objectContaining({ dir: '', files: [picked] })
      )
    );
  });

  it('rolls back the optimistic rows when the room refuses', async () => {
    const transport = roomWith({ '': [file('notes.md')] });
    transport.uploadRoomFiles = refuseAndFreeze(transport, refusal('REPO_CAP_EXCEEDED'));
    renderSection(transport);
    await screen.findByRole('treeitem', { name: 'notes.md' });

    dropFiles(screen.getByRole('tree', { name: 'File explorer' }), [new File(['x'], 'big.bin')]);

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        'This room’s files are already as large as they are allowed to get, so nothing was changed. Delete something first.'
      )
    );
    expect(screen.queryByRole('treeitem', { name: 'big.bin' })).not.toBeInTheDocument();
    expect(screen.getByRole('treeitem', { name: 'notes.md' })).toBeInTheDocument();
  });
});

describe('making new files in a room', () => {
  it('a new file opens straight into the editor and is created by its first save', async () => {
    const transport = roomWith({ '': [file('notes.md')] });
    transport.saveRoomFile = vi.fn().mockResolvedValue({
      path: 'todo.md',
      commit: 'fff6666',
      committed: true,
      lastCommit: null,
    });
    renderSection(transport);
    await screen.findByRole('treeitem', { name: 'notes.md' });

    fireEvent.click(screen.getByRole('button', { name: 'New file' }));
    const name = screen.getByRole('textbox', { name: 'New file name' });
    fireEvent.change(name, { target: { value: 'todo.md' } });
    fireEvent.keyDown(name, { key: 'Enter' });

    const box = await screen.findByRole('textbox', { name: 'todo.md contents' });
    // Nothing is read for a file that does not exist yet.
    expect(transport.readRoomFileContent).not.toHaveBeenCalled();
    fireEvent.change(box, { target: { value: '- ship it\n' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(transport.saveRoomFile).toHaveBeenCalledWith(ROOM_ID, {
        path: 'todo.md',
        baseCommit: null,
        text: '- ship it\n',
      })
    );
  });

  it('a new folder is named with its first file, which opens in the editor', async () => {
    const transport = roomWith({ '': [file('notes.md')] });
    transport.saveRoomFile = vi.fn().mockResolvedValue({
      path: 'plans/q4.md',
      commit: 'fff6666',
      committed: true,
      lastCommit: null,
    });
    renderSection(transport);
    await screen.findByRole('treeitem', { name: 'notes.md' });

    fireEvent.click(screen.getByRole('button', { name: 'New folder' }));
    const folder = screen.getByRole('textbox', { name: 'New folder name' });
    fireEvent.change(folder, { target: { value: 'plans' } });
    fireEvent.keyDown(folder, { key: 'Enter' });

    expect(
      await screen.findByText('Name its first file. The folder appears when you save it.')
    ).toBeInTheDocument();
    const first = screen.getByRole('textbox', { name: 'First file in plans' });
    fireEvent.change(first, { target: { value: 'q4.md' } });
    fireEvent.keyDown(first, { key: 'Enter' });

    // Empty is a real file to write: naming it was the change.
    await screen.findByRole('textbox', { name: 'q4.md contents' });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(transport.saveRoomFile).toHaveBeenCalledWith(ROOM_ID, {
        path: 'plans/q4.md',
        baseCommit: null,
        text: '',
      })
    );
  });

  it('a new file whose name differs only in capitals is caught before anything is written', async () => {
    const transport = roomWith({ '': [file('Notes.md')] });
    renderSection(transport);
    await screen.findByRole('treeitem', { name: 'Notes.md' });

    fireEvent.click(screen.getByRole('button', { name: 'New file' }));
    const name = screen.getByRole('textbox', { name: 'New file name' });
    fireEvent.change(name, { target: { value: 'notes.md' } });
    fireEvent.keyDown(name, { key: 'Enter' });

    expect(toastError).toHaveBeenCalledWith(
      'There’s already “Notes.md” there, and a name that differs only in capital letters is the same file on some computers. Pick another name.'
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('a new file the room refuses shows the room’s own reason, not a generic one', async () => {
    const transport = roomWith({ '': [file('notes.md')] });
    transport.saveRoomFile = vi
      .fn()
      .mockRejectedValue(
        refusal(
          'ROOM_FILE_NOT_READABLE',
          'This room’s files are set to ignore `build/out.md`, so saving it would not keep it. Change the room’s `.gitignore` first, or save somewhere else.'
        )
      );
    renderSection(transport);
    await screen.findByRole('treeitem', { name: 'notes.md' });

    fireEvent.click(screen.getByRole('button', { name: 'New file' }));
    const name = screen.getByRole('textbox', { name: 'New file name' });
    fireEvent.change(name, { target: { value: 'out.md' } });
    fireEvent.keyDown(name, { key: 'Enter' });
    await screen.findByRole('textbox', { name: 'out.md contents' });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(
      await screen.findByText(
        'This room’s files are set to ignore “build/out.md”, so saving it would not keep it. Change the room’s “.gitignore” first, or save somewhere else.'
      )
    ).toBeInTheDocument();
  });

  it('a new file with a name that is taken says so and opens nothing', async () => {
    const transport = roomWith({ '': [file('notes.md')] });
    renderSection(transport);
    await screen.findByRole('treeitem', { name: 'notes.md' });

    fireEvent.click(screen.getByRole('button', { name: 'New file' }));
    const name = screen.getByRole('textbox', { name: 'New file name' });
    fireEvent.change(name, { target: { value: 'notes.md' } });
    fireEvent.keyDown(name, { key: 'Enter' });

    expect(toastError).toHaveBeenCalledWith(
      'There’s already something called “notes.md” there, so nothing was changed. Pick another name.'
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
