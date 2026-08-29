/**
 * @vitest-environment jsdom
 *
 * Editing one of a room's files, and the two ways a save can end other than
 * landing (spec `project-rooms` §3.10).
 *
 * The source under test is the real `createRoomFilesSource`, not a fixture:
 * what the 409 path has to get right is the trip from the transport's thrown
 * error, through the source's translation, into the choice the dialog offers —
 * and a hand-rolled source would test the dialog against this test's idea of
 * that trip rather than against the one the app makes.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import type { Transport } from '@dorkos/shared/transport';
import type { RoomFileContentResponse } from '@dorkos/shared/room-files';
import { createRoomFilesSource } from '../model/room-files-source';
import { FilePreviewDialog } from '../ui/FilePreviewDialog';

const ROOM_ID = 'room-1';
const COMMIT = { sha: 'aaa1111', author: 'Kai', at: '2026-08-27T09:00:00.000Z', subject: 'Add it' };

/** One markdown file, as the content route answers it. */
function markdownFile(text: string, commit = 'aaa1111'): RoomFileContentResponse {
  return {
    path: 'ROOM.md',
    commit,
    size: text.length,
    lastCommit: COMMIT,
    body: { kind: 'text', encoding: 'utf-8', text },
  };
}

/** The refusal the HTTP adapter shapes for a save that lost the race. */
function fileChanged(commit: string) {
  return Object.assign(new Error('Somebody changed this file'), {
    code: 'FILE_CHANGED',
    status: 409,
    body: {
      error: 'Somebody changed this file',
      code: 'FILE_CHANGED',
      conflict: {
        path: 'ROOM.md',
        commit,
        lastCommit: {
          sha: 'bbb2222',
          author: 'Ana',
          at: '2026-08-28T09:00:00.000Z',
          subject: 'tighten the rule about tests',
        },
      },
    },
  });
}

/** A coded refusal, shaped the way the HTTP adapter shapes one. */
function refusal(code: string, status: number) {
  return Object.assign(new Error(code), { code, status });
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
});

afterEach(() => {
  cleanup();
});

/** Mount the dialog over a real room source backed by this transport. */
function renderDialog(transport: Transport, path = 'ROOM.md') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const source = createRoomFilesSource({ transport, queryClient, roomId: ROOM_ID });
  const onClose = vi.fn();
  render(
    <QueryClientProvider client={queryClient}>
      <FilePreviewDialog source={source} path={path} onClose={onClose} />
    </QueryClientProvider>
  );
  return { onClose, queryClient };
}

/** Get into edit mode on an open markdown file, and hand back the textarea. */
async function startEditing(): Promise<HTMLTextAreaElement> {
  fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
  return (await screen.findByRole('textbox', {
    name: /ROOM\.md contents/,
  })) as HTMLTextAreaElement;
}

describe('editing one of a room’s files', () => {
  it('offers Edit on a markdown file and saves what was typed against the commit it was read at', async () => {
    const transport = createMockTransport();
    transport.readRoomFileContent = vi.fn().mockResolvedValue(markdownFile('# Rules\n'));
    transport.saveRoomFile = vi.fn().mockResolvedValue({
      path: 'ROOM.md',
      commit: 'ccc3333',
      size: 12,
      committed: true,
      lastCommit: COMMIT,
    });
    renderDialog(transport);

    const box = await startEditing();
    fireEvent.change(box, { target: { value: '# Rules\n\nBe kind.\n' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(transport.saveRoomFile).toHaveBeenCalledWith(ROOM_ID, {
        path: 'ROOM.md',
        // The commit the READ answered with — the whole of the optimistic lock.
        baseCommit: 'aaa1111',
        text: '# Rules\n\nBe kind.\n',
      });
    });
    expect(await screen.findByText('Saved')).toBeInTheDocument();
  });

  it('will not save a file nobody has changed', async () => {
    const transport = createMockTransport();
    transport.readRoomFileContent = vi.fn().mockResolvedValue(markdownFile('# Rules\n'));
    renderDialog(transport);

    await startEditing();
    // One save is one commit here, so a Save that could only produce an empty
    // one is not offered at all.
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('puts the cursor in the editor, and back on the pencil when it leaves', async () => {
    const transport = createMockTransport();
    transport.readRoomFileContent = vi.fn().mockResolvedValue(markdownFile('# Rules\n'));
    renderDialog(transport);

    // Pressing Edit unmounts the button that was focused, so without this the
    // cursor falls to the body — a keyboard reader is left outside the thing
    // they just opened, and Tab starts again from the top of the dialog.
    const box = await startEditing();
    await waitFor(() => expect(box).toHaveFocus());

    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Edit' })).toHaveFocus());
  });

  it('offers no editing on a file that is not markdown', async () => {
    const transport = createMockTransport();
    transport.readRoomFileContent = vi.fn().mockResolvedValue({
      path: 'notes.txt',
      commit: 'aaa1111',
      size: 4,
      lastCommit: null,
      body: { kind: 'text', encoding: 'utf-8', text: 'hi\n' },
    });
    renderDialog(transport, 'notes.txt');

    expect(await screen.findByText(/hi/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
  });

  it('offers no editing on a file whose bytes were never sent', async () => {
    const transport = createMockTransport();
    transport.readRoomFileContent = vi.fn().mockResolvedValue({
      path: 'ROOM.md',
      commit: 'aaa1111',
      size: 9_000_000,
      lastCommit: null,
      body: { kind: 'too-large', maxBytes: 5 * 1024 * 1024 },
    });
    renderDialog(transport);

    // A file too large to show is a file too large to save back, and offering
    // the pencil would invite somebody to replace it with an empty box.
    expect(await screen.findByText(/isn’t shown here|isn't shown here/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
  });
});

describe('when somebody else got there first', () => {
  it('never overwrites silently — it names who changed it and offers the two answers', async () => {
    const transport = createMockTransport();
    transport.readRoomFileContent = vi.fn().mockResolvedValue(markdownFile('# Rules\n'));
    transport.saveRoomFile = vi.fn().mockRejectedValue(fileChanged('ddd4444'));
    renderDialog(transport);

    const box = await startEditing();
    fireEvent.change(box, { target: { value: 'mine\n' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(
      await screen.findByText(/Ana changed this file while you were editing it/)
    ).toBeInTheDocument();
    expect(screen.getByText(/tighten the rule about tests/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open their version' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save mine over it' })).toBeInTheDocument();
    // Nothing was written and nothing was thrown away: what was typed is still
    // in the box, which is what makes "save mine over it" an answer at all.
    expect(box).toHaveValue('mine\n');
  });

  it('re-reads the file when their version is taken', async () => {
    const transport = createMockTransport();
    transport.readRoomFileContent = vi
      .fn()
      .mockResolvedValueOnce(markdownFile('# Rules\n'))
      .mockResolvedValue(markdownFile('# Rules\n\nAna’s line.\n', 'ddd4444'));
    transport.saveRoomFile = vi.fn().mockRejectedValue(fileChanged('ddd4444'));
    renderDialog(transport);

    const box = await startEditing();
    fireEvent.change(box, { target: { value: 'mine\n' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Open their version' }));

    await waitFor(() => expect(box).toHaveValue('# Rules\n\nAna’s line.\n'));
    // The choice is answered, so it is gone — and Save is dark again, because
    // what is in the box now IS what the room holds.
    expect(screen.queryByRole('button', { name: 'Open their version' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('keeps what was typed when their version cannot be fetched', async () => {
    const transport = createMockTransport();
    transport.readRoomFileContent = vi
      .fn()
      .mockResolvedValueOnce(markdownFile('# Rules\n'))
      .mockRejectedValue(new Error('the network went away'));
    transport.saveRoomFile = vi.fn().mockRejectedValue(fileChanged('ddd4444'));
    renderDialog(transport);

    const box = await startEditing();
    fireEvent.change(box, { target: { value: 'mine\n' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Open their version' }));

    // **A failed refetch still resolves, and its `data` is the copy from BEFORE
    // the conflict.** Adopting that would throw away what was typed and call
    // the pre-conflict text "their version" — the one destructive act on this
    // path, performed for a request that never arrived.
    expect(await screen.findByText(/couldn’t be fetched just now/)).toBeInTheDocument();
    expect(box).toHaveValue('mine\n');
    // And the choice is still there to take, because it was never answered.
    expect(screen.getByRole('button', { name: 'Open their version' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save mine over it' })).toBeInTheDocument();
  });

  it('says so when their version is that they deleted the file', async () => {
    const transport = createMockTransport();
    transport.readRoomFileContent = vi
      .fn()
      .mockResolvedValueOnce(markdownFile('# Rules\n'))
      .mockRejectedValue(refusal('ROOM_FILE_NOT_FOUND', 404));
    transport.saveRoomFile = vi.fn().mockRejectedValue(fileChanged('ddd4444'));
    renderDialog(transport);

    const box = await startEditing();
    fireEvent.change(box, { target: { value: 'mine\n' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Open their version' }));

    // The canonical way a re-read comes back as something other than text: the
    // other person did not change the file, they removed it. There is no
    // version to open, and a button that silently did nothing left a person
    // pressing it forever.
    // The source's own sentence for the refusal, plus what it means for the
    // text still in the box. The apostrophe class is loose on purpose: the
    // read-refusal copy predates this branch and spells it straight.
    expect(await screen.findByText(/isn.t in the room.s files any more/)).toBeInTheDocument();
    expect(screen.getByText(/save it over their change/)).toBeInTheDocument();
    expect(box).toHaveValue('mine\n');
    expect(screen.getByRole('button', { name: 'Save mine over it' })).toBeInTheDocument();
  });

  it('says the room moved AGAIN when keeping mine loses a second race', async () => {
    const transport = createMockTransport();
    transport.readRoomFileContent = vi.fn().mockResolvedValue(markdownFile('# Rules\n'));
    transport.saveRoomFile = vi
      .fn()
      .mockRejectedValueOnce(fileChanged('ddd4444'))
      .mockRejectedValue(fileChanged('eee5555'));
    renderDialog(transport);

    const box = await startEditing();
    fireEvent.change(box, { target: { value: 'mine\n' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Save mine over it' }));

    // A banner byte-identical to the one already on screen would read as a
    // dead button. Something really did happen, so it says what.
    expect(
      await screen.findByText(/changed this file again while you were deciding/)
    ).toBeInTheDocument();
  });

  it('darkens the footer Save while the choice is open', async () => {
    const transport = createMockTransport();
    transport.readRoomFileContent = vi.fn().mockResolvedValue(markdownFile('# Rules\n'));
    transport.saveRoomFile = vi.fn().mockRejectedValue(fileChanged('ddd4444'));
    renderDialog(transport);

    const box = await startEditing();
    fireEvent.change(box, { target: { value: 'mine\n' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByRole('button', { name: 'Save mine over it' });

    // It still holds the commit the room has moved past, so it could do nothing
    // but lose the same race again. Two save-shaped controls where one cannot
    // work is a choice that is not a choice.
    // `getByRole`'s name match is already whole-string, so this finds the
    // footer's Save and never the banner's "Save mine over it".
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('sends the room’s current commit as the base when mine is kept', async () => {
    const transport = createMockTransport();
    transport.readRoomFileContent = vi.fn().mockResolvedValue(markdownFile('# Rules\n'));
    transport.saveRoomFile = vi
      .fn()
      .mockRejectedValueOnce(fileChanged('ddd4444'))
      .mockResolvedValue({
        path: 'ROOM.md',
        commit: 'eee5555',
        size: 5,
        committed: true,
        lastCommit: COMMIT,
      });
    renderDialog(transport);

    const box = await startEditing();
    fireEvent.change(box, { target: { value: 'mine\n' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Save mine over it' }));

    await waitFor(() => {
      // The base is the commit the CONFLICT named, not the one the file was
      // opened at — sending the stale one back would be refused forever.
      expect(transport.saveRoomFile).toHaveBeenLastCalledWith(ROOM_ID, {
        path: 'ROOM.md',
        baseCommit: 'ddd4444',
        text: 'mine\n',
      });
    });
    expect(await screen.findByText('Saved')).toBeInTheDocument();
  });
});

describe('when the room refuses the save', () => {
  it('says the request was too large in words, not as a server error', async () => {
    const transport = createMockTransport();
    transport.readRoomFileContent = vi.fn().mockResolvedValue(markdownFile('# Rules\n'));
    transport.saveRoomFile = vi.fn().mockRejectedValue(refusal('REQUEST_TOO_LARGE', 413));
    renderDialog(transport);

    const box = await startEditing();
    fireEvent.change(box, { target: { value: 'x'.repeat(20) } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText(/too much text to send in one go/)).toBeInTheDocument();
    // No choice is offered, because there is nothing to choose between: this is
    // a fact about the file, not a race.
    expect(screen.queryByRole('button', { name: 'Open their version' })).not.toBeInTheDocument();
  });

  it('points at the warning above the files when the room is stuck', async () => {
    const transport = createMockTransport();
    transport.readRoomFileContent = vi.fn().mockResolvedValue(markdownFile('# Rules\n'));
    transport.saveRoomFile = vi.fn().mockRejectedValue(refusal('MAIN_CHECKOUT_DIRTY', 409));
    renderDialog(transport);

    const box = await startEditing();
    fireEvent.change(box, { target: { value: 'x\n' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(
      await screen.findByText(/saving is paused until that is sorted out/)
    ).toBeInTheDocument();
  });
});

describe('closing with something typed', () => {
  it('asks before throwing it away', async () => {
    const transport = createMockTransport();
    transport.readRoomFileContent = vi.fn().mockResolvedValue(markdownFile('# Rules\n'));
    const { onClose } = renderDialog(transport);

    const box = await startEditing();
    fireEvent.change(box, { target: { value: 'half a thought' } });
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });

    expect(await screen.findByText(/haven’t saved your changes/)).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
