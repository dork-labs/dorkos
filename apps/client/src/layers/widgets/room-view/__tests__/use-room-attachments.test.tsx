// @vitest-environment jsdom
/**
 * The room composer's chip bar — what it promises between picking a file and
 * pressing Enter.
 *
 * The behaviors mirror chat's `use-file-upload` one for one, because they are
 * the same hook pointed somewhere else. What is asserted here that chat cannot
 * assert: the ids come back in render order, and a failed chip stops the send
 * instead of being quietly dropped (DOR-480).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, act, cleanup, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import type { Transport } from '@dorkos/shared/transport';
import type { RoomAttachment } from '@dorkos/shared/room-schemas';
import { createQueryClientConfig } from '@/layers/shared/lib';
import { TransportProvider } from '@/layers/shared/model';
import { useRoomAttachments } from '../model/use-room-attachments';

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));

afterEach(cleanup);

/** One stored attachment, as the room's upload route answers it. */
function attachmentNamed(name: string, id: string): RoomAttachment {
  return {
    id,
    name,
    mimeType: 'text/plain',
    size: 12,
    preview: null,
    url: `/api/rooms/room-1/attachments/${id}`,
  };
}

/** A file the composer can hold — a real `File`, since the chip renders it. */
function fileNamed(name: string): File {
  return new File(['hello'], name, { type: 'text/plain' });
}

/** Mount the hook under the app's real cache configuration, retries off. */
function renderAttachments(transport: Transport, roomId = 'room-1') {
  const config = createQueryClientConfig();
  const queryClient = new QueryClient({
    ...config,
    defaultOptions: {
      ...config.defaultOptions,
      queries: { ...config.defaultOptions?.queries, retry: false, gcTime: 0 },
      mutations: { ...config.defaultOptions?.mutations, retry: false },
    },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
  return renderHook(() => useRoomAttachments(roomId), { wrapper });
}

describe('useRoomAttachments — holding files until the message goes', () => {
  it('adds files as pending chips, and removes one by id', () => {
    const { result } = renderAttachments(createMockTransport());

    act(() => result.current.addFiles([fileNamed('a.txt'), fileNamed('b.txt')]));
    expect(result.current.pendingFiles.map((f) => f.file.name)).toEqual(['a.txt', 'b.txt']);
    expect(result.current.pendingFiles.every((f) => f.status === 'pending')).toBe(true);
    expect(result.current.hasPendingFiles).toBe(true);

    act(() => result.current.removeFile(result.current.pendingFiles[0].id));
    expect(result.current.pendingFiles.map((f) => f.file.name)).toEqual(['b.txt']);

    act(() => result.current.clearFiles());
    expect(result.current.pendingFiles).toEqual([]);
    expect(result.current.hasPendingFiles).toBe(false);
  });

  it('uploads pending files and hands back their ids in render order', async () => {
    const transport = createMockTransport();
    vi.mocked(transport.uploadRoomAttachments).mockResolvedValue([
      attachmentNamed('a.txt', 'att-a'),
      attachmentNamed('b.txt', 'att-b'),
    ]);
    const { result } = renderAttachments(transport);

    act(() => result.current.addFiles([fileNamed('a.txt'), fileNamed('b.txt')]));

    let ids: string[] = [];
    await act(async () => {
      ids = await result.current.uploadAndGetIds();
    });

    expect(ids).toEqual(['att-a', 'att-b']);
    expect(transport.uploadRoomAttachments).toHaveBeenCalledTimes(1);
    expect(vi.mocked(transport.uploadRoomAttachments).mock.calls[0][0]).toBe('room-1');
    expect(result.current.pendingFiles.every((f) => f.status === 'uploaded')).toBe(true);
  });

  it('does not re-upload a file that already went up', async () => {
    const transport = createMockTransport();
    vi.mocked(transport.uploadRoomAttachments).mockResolvedValue([
      attachmentNamed('a.txt', 'att-a'),
    ]);
    const { result } = renderAttachments(transport);

    act(() => result.current.addFiles([fileNamed('a.txt')]));
    await act(async () => {
      await result.current.uploadAndGetIds();
    });

    let ids: string[] = [];
    await act(async () => {
      ids = await result.current.uploadAndGetIds();
    });

    // The same id, and no second request: the bytes are already on the server.
    expect(ids).toEqual(['att-a']);
    expect(transport.uploadRoomAttachments).toHaveBeenCalledTimes(1);
  });

  it('refuses to hand back ids while a chip is in error, naming the file', async () => {
    // The DOR-480 lesson: dropping the failed one silently sends a message
    // about a file that never arrived.
    const transport = createMockTransport();
    vi.mocked(transport.uploadRoomAttachments).mockRejectedValue(new Error('Upload failed'));
    const { result } = renderAttachments(transport);

    act(() => result.current.addFiles([fileNamed('a.txt')]));
    await act(async () => {
      await expect(result.current.uploadAndGetIds()).rejects.toThrow('Upload failed');
    });

    await waitFor(() => expect(result.current.hasFailedUpload).toBe(true));

    await expect(result.current.uploadAndGetIds()).rejects.toThrow(
      'a.txt did not upload. Retry it or remove it, then send again.'
    );
  });

  it('puts a failed chip back in line on retry', async () => {
    const transport = createMockTransport();
    vi.mocked(transport.uploadRoomAttachments).mockRejectedValue(new Error('Upload failed'));
    const { result } = renderAttachments(transport);

    act(() => result.current.addFiles([fileNamed('a.txt')]));
    await act(async () => {
      await expect(result.current.uploadAndGetIds()).rejects.toThrow();
    });
    await waitFor(() => expect(result.current.hasFailedUpload).toBe(true));

    act(() => result.current.retryFile(result.current.pendingFiles[0].id));

    expect(result.current.pendingFiles[0].status).toBe('pending');
    expect(result.current.pendingFiles[0].error).toBeUndefined();
    expect(result.current.hasFailedUpload).toBe(false);
  });

  it('cancels the request itself, not just this hook’s view of it', async () => {
    // DOR-494: the bytes must stop, so what the transport was handed has to be
    // the signal that reports aborted.
    const transport = createMockTransport();
    let seen: AbortSignal | undefined;
    vi.mocked(transport.uploadRoomAttachments).mockImplementation(
      (_id, _files, _onProgress, signal) =>
        new Promise((_resolve, reject) => {
          seen = signal;
          signal?.addEventListener('abort', () => reject(new Error('Upload canceled')));
        })
    );
    const { result } = renderAttachments(transport);

    act(() => result.current.addFiles([fileNamed('a.txt')]));
    let pending: Promise<string[]> = Promise.resolve([]);
    act(() => {
      pending = result.current.uploadAndGetIds();
      void pending.catch(() => {});
    });

    await waitFor(() => expect(seen).toBeDefined());
    act(() => result.current.cancelUpload());

    expect(seen?.aborted).toBe(true);
    await expect(pending).rejects.toThrow('Upload canceled');
  });

  it('gives each room its own bar', async () => {
    // Two mounts, two `useState`s. Nothing is keyed and nothing is shared, which
    // is why a thread's composer and its room's composer cannot collide either.
    const transport = createMockTransport();
    const one = renderAttachments(transport, 'room-1');
    const two = renderAttachments(transport, 'room-2');

    act(() => one.result.current.addFiles([fileNamed('a.txt')]));

    expect(one.result.current.pendingFiles).toHaveLength(1);
    expect(two.result.current.pendingFiles).toHaveLength(0);
  });
});
