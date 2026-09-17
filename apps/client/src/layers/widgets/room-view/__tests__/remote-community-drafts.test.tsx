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
import { useRemoteCommunityDrafts } from '../model/use-remote-community-drafts';

afterEach(cleanup);
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
    const { result } = renderHook(() => useRemoteCommunityDrafts('a', 'same', true, [], receipt), {
      wrapper,
    });
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
      ({ entries }) => useRemoteCommunityDrafts('a', 'same', true, entries, receipt),
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
      ({ allowed }) => useRemoteCommunityDrafts('a', 'same', allowed, [], receipt),
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
      ({ key }) => useRemoteCommunityDrafts('a', 'same', true, [], receipt, key),
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
    const { result } = renderHook(() => useRemoteCommunityDrafts('a', 'same', true, [], receipt), {
      wrapper,
    });
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
});
