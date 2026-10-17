/**
 * @vitest-environment jsdom
 *
 * The doc comment hooks keep a doc's cached threads current without a refetch:
 * a write's returned thread replaces its old copy, and moved anchors land in
 * the cache before the save answers (DOR-2983).
 */
import { describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import type { DocCommentThread, DocCommentThreadList } from '@dorkos/shared/doc-comments';
import { TransportProvider } from '@/layers/shared/model';
import {
  docCommentKeys,
  useDocCommentThreads,
  useReplyDocComment,
  useUpdateDocCommentAnchors,
} from '../index';

const DOC = { cwd: '/work', path: 'plan.md' };

const THREAD: DocCommentThread = {
  id: 't1',
  path: 'plan.md',
  anchor: { v: 1, quote: 'Friday', start: 1, end: 7 },
  resolved: false,
  resolvedAt: null,
  resolvedBy: null,
  createdAt: '2026-10-17T10:00:00.000Z',
  updatedAt: '2026-10-17T10:00:00.000Z',
  comments: [],
};

function setup(transportOverrides = {}) {
  const transport = createMockTransport({
    listDocCommentThreads: vi.fn().mockResolvedValue({ threads: [THREAD] }),
    ...transportOverrides,
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <TransportProvider transport={transport}>
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    </TransportProvider>
  );
  return { transport, client, wrapper };
}

describe('doc comment hooks', () => {
  it('reads a doc’s threads, and nothing without a doc', async () => {
    const { transport, wrapper } = setup();
    const { result } = renderHook(() => useDocCommentThreads(DOC), { wrapper });
    await waitFor(() => expect(result.current.data).toEqual([THREAD]));
    renderHook(() => useDocCommentThreads(null), { wrapper });
    expect(transport.listDocCommentThreads).toHaveBeenCalledTimes(1);
  });

  it('puts a reply’s returned thread in the cache', async () => {
    const replied = { ...THREAD, updatedAt: '2026-10-17T11:00:00.000Z' };
    const { client, wrapper } = setup({
      replyDocComment: vi.fn().mockResolvedValue({ thread: replied, unreached: [] }),
    });
    client.setQueryData<DocCommentThreadList>(docCommentKeys.threads(DOC), { threads: [THREAD] });
    const { result } = renderHook(() => useReplyDocComment(DOC), { wrapper });
    await act(() => result.current.mutateAsync({ threadId: 't1', body: 'Yes' }));
    expect(client.getQueryData(docCommentKeys.threads(DOC))).toEqual({ threads: [replied] });
  });

  it('moves anchors in the cache before the save answers', async () => {
    const { client, transport, wrapper } = setup({
      updateDocCommentAnchors: vi.fn(() => new Promise(() => undefined)),
    });
    client.setQueryData<DocCommentThreadList>(docCommentKeys.threads(DOC), { threads: [THREAD] });
    const { result } = renderHook(() => useUpdateDocCommentAnchors(DOC), { wrapper });
    const moved = { v: 1, quote: 'Friday', start: 4, end: 10 };
    act(() => result.current.mutate([{ id: 't1', anchor: moved }]));
    await waitFor(() =>
      expect(client.getQueryData<DocCommentThreadList>(docCommentKeys.threads(DOC))).toEqual({
        threads: [{ ...THREAD, anchor: moved }],
      })
    );
    expect(transport.updateDocCommentAnchors).toHaveBeenCalledWith({
      ...DOC,
      updates: [{ id: 't1', anchor: moved }],
    });
  });
});
