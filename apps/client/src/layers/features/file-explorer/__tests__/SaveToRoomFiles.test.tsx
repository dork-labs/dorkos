/**
 * @vitest-environment jsdom
 */
/**
 * "Save to room files" on a chat attachment (spec `agent-home-desk` §7.3): a
 * folder picker over the room's tree, a name, and one save — and a taken name
 * answered with another name, never a replace.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import type { Transport } from '@dorkos/shared/transport';
import type { RoomAttachment } from '@dorkos/shared/room-schemas';
import type { RoomFileEntry } from '@dorkos/shared/room-files';
import { TransportProvider } from '@/layers/shared/model';

const { toastSuccess } = vi.hoisted(() => ({ toastSuccess: vi.fn() }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: toastSuccess, message: vi.fn() } }));

import { SaveToRoomFilesButton } from '../ui/SaveToRoomFiles';

const ROOM_ID = 'room-1';

const ATTACHMENT: RoomAttachment = {
  id: 'att-1',
  name: 'screenshot.png',
  mimeType: 'image/png',
  size: 2048,
  preview: 'image',
  url: '/api/rooms/room-1/attachments/att-1',
};

function dir(path: string): RoomFileEntry {
  return {
    name: path.slice(path.lastIndexOf('/') + 1),
    path,
    kind: 'dir',
    size: 0,
    lastCommit: null,
  };
}

function roomWith(tree: Record<string, RoomFileEntry[]>): Transport {
  const transport = createMockTransport();
  transport.readRoomFiles = vi.fn(async (_id: string, path?: string) => ({
    path: path ?? '',
    commit: path ? `commit-${path}` : 'commit-root',
    entries: tree[path ?? ''] ?? [],
  }));
  transport.saveAttachmentToRoomFiles = vi
    .fn()
    .mockResolvedValue({ commit: 'new', paths: [], lastCommit: null });
  transport.getRoom = vi.fn().mockResolvedValue({ id: ROOM_ID, archived: false, members: [] });
  return transport;
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

beforeEach(() => vi.clearAllMocks());
afterEach(() => cleanup());

function renderButton(transport: Transport) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>
        <SaveToRoomFilesButton roomId={ROOM_ID} attachment={ATTACHMENT} />
      </TransportProvider>
    </QueryClientProvider>
  );
}

describe('Save to room files', () => {
  it('saves into the folder the person walked into, under the name they chose', async () => {
    const transport = roomWith({ '': [dir('designs')], designs: [dir('designs/v2')] });
    renderButton(transport);

    fireEvent.click(
      await screen.findByRole('button', { name: 'Save screenshot.png to the room’s files' })
    );
    fireEvent.click(await screen.findByRole('button', { name: 'designs' }));
    await screen.findByRole('button', { name: 'Up one folder' });
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'home.png' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Save to designs' }));

    await waitFor(() =>
      expect(transport.saveAttachmentToRoomFiles).toHaveBeenCalledWith(ROOM_ID, {
        attachmentId: 'att-1',
        dir: 'designs',
        name: 'home.png',
        baseCommit: 'commit-designs',
      })
    );
    expect(toastSuccess).toHaveBeenCalledWith('Saved home.png to the room’s files');
  });

  it('answers a taken name with another one, and saving under it works', async () => {
    const transport = roomWith({ '': [] });
    transport.saveAttachmentToRoomFiles = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error('`screenshot.png` is already there.'), {
          code: 'ROOM_FILE_EXISTS',
          status: 409,
        })
      )
      .mockResolvedValueOnce({ commit: 'new', paths: [], lastCommit: null });
    renderButton(transport);

    fireEvent.click(
      await screen.findByRole('button', { name: 'Save screenshot.png to the room’s files' })
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Save to the top folder' }));

    expect(
      await screen.findByText(
        'This folder already has a file called “screenshot.png”. Pick another name.'
      )
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Use “screenshot copy.png”' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save to the top folder' }));

    await waitFor(() =>
      expect(transport.saveAttachmentToRoomFiles).toHaveBeenLastCalledWith(
        ROOM_ID,
        expect.objectContaining({ name: 'screenshot copy.png', dir: '' })
      )
    );
  });

  it('is not offered in an archived room, which refuses every change to its files', async () => {
    const transport = roomWith({ '': [] });
    transport.getRoom = vi.fn().mockResolvedValue({ id: ROOM_ID, archived: true, members: [] });
    renderButton(transport);

    await waitFor(() => expect(transport.getRoom).toHaveBeenCalled());
    await waitFor(() => expect(transport.readRoomFiles).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: /to the room’s files/ })).not.toBeInTheDocument();
  });

  it('says plainly when the attachment is gone', async () => {
    const transport = roomWith({ '': [] });
    transport.saveAttachmentToRoomFiles = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error('No such file.'), { code: 'ATTACHMENT_NOT_FOUND', status: 404 })
      );
    renderButton(transport);

    fireEvent.click(
      await screen.findByRole('button', { name: 'Save screenshot.png to the room’s files' })
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Save to the top folder' }));
    expect(
      await screen.findByText('That file isn’t in this room’s chat any more.')
    ).toBeInTheDocument();
  });
});
