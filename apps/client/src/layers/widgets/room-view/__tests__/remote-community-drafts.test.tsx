// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { createMockTransport } from '@dorkos/test-utils';
import type { PropsWithChildren } from 'react';
import {
  RemoteCommunityEntrySchema,
  type RemoteCommunityEntry,
} from '@dorkos/shared/community-views';
import { TransportProvider } from '@/layers/shared/model';
import { useCommunityDraftStore, type CommunityDraftAddress } from '@/layers/entities/community';
import {
  useRemoteCommunityDrafts,
  type RemoteCommunityDraftOptions,
} from '../model/use-remote-community-drafts';

afterEach(() => {
  cleanup();
  useCommunityDraftStore.getState().discardAll();
});

/** The composer address for owner `owner-a`, Community `a`, room `same`. */
function at(over: Partial<CommunityDraftAddress> = {}): CommunityDraftAddress {
  return { ownerKey: 'owner-a', epoch: 1, ref: 'a', generation: 0, roomId: 'same', ...over };
}

/** Hook options with sensible defaults; the draft address follows the owner. */
function options(
  receipt: (entry: RemoteCommunityEntry) => void,
  over: Partial<RemoteCommunityDraftOptions> & { owner?: string; threadId?: string } = {}
): RemoteCommunityDraftOptions {
  const { owner = 'owner-a', threadId, ...rest } = over;
  return {
    ref: 'a',
    roomId: 'same',
    canSend: true,
    entries: [],
    onReceipt: receipt,
    draft: at({ ownerKey: owner, threadId }),
    ownerKey: owner,
    ...rest,
  };
}
const entry = RemoteCommunityEntrySchema.parse({
  community: 'a',
  roomId: 'same',
  id: 'confirmed',
  authorId: 'human',
  authorKind: 'human',
  authorDisplayName: 'Alex',
  text: 'hello',
  mentions: [],
  parentEntryId: null,
  threadRootEntryId: null,
  depth: 0,
  remoteSeq: 1,
  attachments: [],
  cursor: 'opaque',
  createdAt: '2026-09-16T10:00:00Z',
});
const file = {
  id: 'file-id',
  name: 'notes.txt',
  contentType: 'text/plain',
  byteSize: 4,
  checksum: 'sum',
};
function harness() {
  const transport = createMockTransport();
  const receipt = vi.fn();
  const wrapper = ({ children }: PropsWithChildren) => (
    <TransportProvider transport={transport}>{children}</TransportProvider>
  );
  return { transport, receipt, wrapper };
}

describe('remote community delivery drafts', () => {
  it('retries a lost receipt with the same immutable message key and uploaded files', async () => {
    const { transport, receipt, wrapper } = harness();
    vi.mocked(transport.uploadRemoteCommunityAttachment).mockResolvedValue(file);
    vi.mocked(transport.postRemoteCommunityEntry)
      .mockRejectedValueOnce(new Error('Lost response'))
      .mockResolvedValue(entry);
    const { result } = renderHook(() => useRemoteCommunityDrafts(options(receipt)), { wrapper });
    act(() => {
      result.current.setText('hello');
      result.current.attachments.add([new File(['data'], 'notes.txt')]);
    });
    act(() => result.current.send('root'));
    await waitFor(() => expect(result.current.deliveries[0]?.status).toBe('failed'));
    const key = result.current.deliveries[0]!.key;
    act(() => result.current.retry(key));
    await waitFor(() => expect(receipt).toHaveBeenCalledWith(entry));
    expect(transport.uploadRemoteCommunityAttachment).toHaveBeenCalledTimes(1);
    expect(transport.postRemoteCommunityEntry).toHaveBeenNthCalledWith(1, 'a', 'same', {
      text: 'hello',
      parentEntryId: 'root',
      attachmentIds: ['file-id'],
      idempotencyKey: key,
    });
    expect(vi.mocked(transport.postRemoteCommunityEntry).mock.calls[1]).toEqual(
      vi.mocked(transport.postRemoteCommunityEntry).mock.calls[0]
    );
    expect(result.current.deliveries).toEqual([]);
  });

  it('an owner-origin echo confirms a row even if the HTTP response later fails', async () => {
    const { transport, receipt, wrapper } = harness();
    let reject!: (error: Error) => void;
    vi.mocked(transport.postRemoteCommunityEntry).mockReturnValue(
      new Promise((_, fail) => {
        reject = fail;
      })
    );
    const { result, rerender } = renderHook(
      ({ entries }) => useRemoteCommunityDrafts(options(receipt, { entries })),
      {
        wrapper,
        initialProps: { entries: [] as RemoteCommunityEntry[] },
      }
    );
    act(() => result.current.setText('hello'));
    act(() => result.current.send());
    const key = result.current.deliveries[0]!.key;
    rerender({ entries: [{ ...entry, originIdempotencyKey: key }] });
    await waitFor(() => expect(result.current.deliveries).toEqual([]));
    await act(async () => reject(new Error('Lost response')));
    expect(result.current.deliveries).toEqual([]);
    expect(receipt).not.toHaveBeenCalled();
  });

  it('access lost during upload prevents a subsequent post and leaves an honest retry row', async () => {
    const { transport, receipt, wrapper } = harness();
    let resolve!: (value: typeof file) => void;
    vi.mocked(transport.uploadRemoteCommunityAttachment).mockReturnValue(
      new Promise((done) => {
        resolve = done;
      })
    );
    const { result, rerender } = renderHook(
      ({ allowed }) => useRemoteCommunityDrafts(options(receipt, { canSend: allowed })),
      {
        wrapper,
        initialProps: { allowed: true },
      }
    );
    act(() => result.current.attachments.add([new File(['data'], 'notes.txt')]));
    act(() => result.current.send());
    rerender({ allowed: false });
    await act(async () => resolve(file));
    expect(transport.postRemoteCommunityEntry).not.toHaveBeenCalled();
    expect(result.current.deliveries[0]?.status).toBe('failed');
    expect(result.current.deliveries[0]?.text).toBe('notes.txt');
  });

  it('keeps channel and thread drafts separate while preserving their pending deliveries', () => {
    const { transport, receipt, wrapper } = harness();
    vi.mocked(transport.postRemoteCommunityEntry).mockReturnValue(new Promise(() => {}));
    const { result, rerender } = renderHook(
      ({ key }) =>
        useRemoteCommunityDrafts(
          options(receipt, { threadId: key === 'channel' ? undefined : key })
        ),
      {
        wrapper,
        initialProps: { key: 'channel' },
      }
    );
    act(() => result.current.setText('channel draft'));
    rerender({ key: 'thread-one' });
    expect(result.current.text).toBe('');
    act(() => result.current.setText('thread reply'));
    act(() => result.current.send('thread-one'));
    rerender({ key: 'channel' });
    expect(result.current.text).toBe('channel draft');
    expect(result.current.deliveries[0]?.parentEntryId).toBe('thread-one');
  });

  it('a double retry never posts concurrently and file count is bounded', async () => {
    const { transport, receipt, wrapper } = harness();
    vi.mocked(transport.postRemoteCommunityEntry)
      .mockRejectedValueOnce(new Error('retry'))
      .mockReturnValue(new Promise(() => {}));
    const { result } = renderHook(() => useRemoteCommunityDrafts(options(receipt)), { wrapper });
    act(() =>
      result.current.attachments.add(Array.from({ length: 9 }, () => new File(['x'], 'x.txt')))
    );
    expect(result.current.attachments.staged).toHaveLength(0);
    expect(result.current.error).toContain('eight');
    act(() => result.current.setText('hello'));
    act(() => result.current.send());
    await waitFor(() => expect(result.current.deliveries[0]?.status).toBe('failed'));
    const key = result.current.deliveries[0]!.key;
    act(() => {
      result.current.retry(key);
      result.current.retry(key);
    });
    expect(transport.postRemoteCommunityEntry).toHaveBeenCalledTimes(2);
  });

  it('hides another owner’s draft immediately and discards its late receipt', async () => {
    const { transport, receipt, wrapper } = harness();
    let resolve!: (value: RemoteCommunityEntry) => void;
    vi.mocked(transport.postRemoteCommunityEntry).mockReturnValue(
      new Promise((done) => {
        resolve = done;
      })
    );
    const { result, rerender } = renderHook(
      ({ owner }) => useRemoteCommunityDrafts(options(receipt, { owner })),
      { wrapper, initialProps: { owner: 'owner-a' } }
    );
    act(() => result.current.setText('owner a private draft'));
    act(() => result.current.send());

    rerender({ owner: 'owner-b' });
    expect(result.current.text).toBe('');
    expect(result.current.deliveries).toEqual([]);
    act(() => result.current.setText('owner b draft'));
    await act(async () => resolve(entry));

    expect(receipt).not.toHaveBeenCalled();
    expect(result.current.text).toBe('owner b draft');
    expect(result.current.deliveries).toEqual([]);
  });

  it('does not insert a late receipt into a newer route epoch for the same owner and room', async () => {
    const { transport, receipt, wrapper } = harness();
    let resolve!: (value: RemoteCommunityEntry) => void;
    vi.mocked(transport.postRemoteCommunityEntry).mockReturnValue(
      new Promise((done) => {
        resolve = done;
      })
    );
    const { result, rerender } = renderHook(
      ({ context }) => useRemoteCommunityDrafts(options(receipt, { contextKey: context })),
      { wrapper, initialProps: { context: 'epoch-1' } }
    );
    act(() => result.current.setText('first epoch'));
    act(() => result.current.send());

    rerender({ context: 'epoch-3' });
    expect(result.current.text).toBe('');
    expect(result.current.deliveries).toEqual([]);
    act(() => result.current.setText('final epoch'));
    await act(async () => resolve(entry));

    expect(receipt).not.toHaveBeenCalled();
    expect(result.current.text).toBe('final epoch');
    expect(result.current.deliveries).toEqual([]);
  });

  it('brings an unsent draft back when the composer returns after A→B→A', () => {
    const { receipt, wrapper } = harness();
    const file = new File(['data'], 'notes.txt');
    const alpha = renderHook(() => useRemoteCommunityDrafts(options(receipt)), { wrapper });
    act(() => {
      alpha.result.current.setText('half a thought for Alpha');
      alpha.result.current.attachments.add([file]);
    });
    alpha.unmount();

    // Beta shares the room id; it must not see Alpha's words.
    const beta = renderHook(
      () => useRemoteCommunityDrafts(options(receipt, { ref: 'b', draft: at({ ref: 'b' }) })),
      { wrapper }
    );
    expect(beta.result.current.text).toBe('');
    expect(beta.result.current.attachments.staged).toEqual([]);
    beta.unmount();

    const back = renderHook(() => useRemoteCommunityDrafts(options(receipt)), { wrapper });
    expect(back.result.current.text).toBe('half a thought for Alpha');
    expect(back.result.current.attachments.staged.map((item) => item.file)).toEqual([file]);
  });

  it('clears the held draft on send, and a second quick send posts nothing', () => {
    const { transport, receipt, wrapper } = harness();
    vi.mocked(transport.postRemoteCommunityEntry).mockReturnValue(new Promise(() => {}));
    const { result, unmount } = renderHook(() => useRemoteCommunityDrafts(options(receipt)), {
      wrapper,
    });
    act(() => result.current.setText('once'));
    act(() => {
      result.current.send();
      result.current.send();
    });
    expect(transport.postRemoteCommunityEntry).toHaveBeenCalledTimes(1);
    expect(result.current.text).toBe('');
    unmount();
    const back = renderHook(() => useRemoteCommunityDrafts(options(receipt)), { wrapper });
    expect(back.result.current.text).toBe('');
  });

  it('holds nothing while the owner is unconfirmed', () => {
    const { receipt, wrapper } = harness();
    const { result } = renderHook(
      () => useRemoteCommunityDrafts(options(receipt, { draft: null })),
      { wrapper }
    );
    act(() => result.current.setText('typed before the owner resolved'));
    expect(result.current.text).toBe('');
    expect(useCommunityDraftStore.getState().drafts).toEqual({});
  });
});
