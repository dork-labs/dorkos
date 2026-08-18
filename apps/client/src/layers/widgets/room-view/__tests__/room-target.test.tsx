// @vitest-environment jsdom
/**
 * The room's `ConversationTarget`, and the one thing about it that is not about
 * sending: it has to hold still.
 *
 * The target is what `Conversation.Root` publishes as its context value, so a
 * target that is a new object every render re-renders the whole transcript —
 * every row, once per arriving message, which is exactly the cost virtualizing
 * the list was paid to remove. Two of this hook's own inputs churn by
 * construction (`useRoomAttachments` returns a fresh literal, and each
 * `useMutation` mints a fresh result), so holding still is a property this file
 * has to assert rather than assume.
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { renderHook, cleanup } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import type { RoomWithRoster } from '@/layers/entities/room';
import { createQueryClientConfig } from '@/layers/shared/lib';
import { TransportProvider } from '@/layers/shared/model';
import { useRoomTarget } from '../model/room-target';

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));

afterEach(cleanup);

/** A channel this viewer is on the roster of, so the composer is live. */
const ROOM: RoomWithRoster = {
  id: 'room-1',
  kind: 'channel',
  slug: 'general',
  title: '#general',
  topic: null,
  workspaceId: null,
  archived: false,
  ambientMaxEntries: 30,
  createdAt: '2026-07-26T09:00:00.000Z',
  lastActivityAt: '2026-07-26T10:00:00.000Z',
  members: [
    {
      roomId: 'room-1',
      authorId: 'author-you',
      responseMode: 'always',
      joinedAt: '2026-07-26T09:00:00.000Z',
      joinedSeq: 0,
      lastReadSeq: 0,
      author: { id: 'author-you', kind: 'human', displayName: 'You', handle: null },
      origin: 'local',
    },
  ],
  viewerAuthorId: 'author-you',
  reactionFrequents: [],
};

/** Mount the hook under the app's real cache configuration, retries off. */
function renderTarget(room: RoomWithRoster) {
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
      <TransportProvider transport={createMockTransport()}>{children}</TransportProvider>
    </QueryClientProvider>
  );
  return renderHook((props: RoomWithRoster) => useRoomTarget({ room: props }), {
    wrapper,
    initialProps: room,
  });
}

describe('useRoomTarget', () => {
  it('hands back the same target when nothing about the room changed', () => {
    // **Seeded defect:** depend on `attachments`, `post` or `reply` directly in
    // the memo — each is a fresh object every render — and this is a new target
    // on every commit, which is a full transcript re-render per arrival. Run and
    // red.
    const { result, rerender } = renderTarget(ROOM);
    const first = result.current.target;

    rerender(ROOM);

    expect(result.current.target).toBe(first);
    expect(result.current.target.attachments).toBe(first.attachments);
  });

  it('changes identity when the room does', () => {
    // A memo that never changes is the other way to pass the case above, and it
    // would leave an archived room looking live.
    const { result, rerender } = renderTarget(ROOM);
    const first = result.current.target;

    rerender({ ...ROOM, archived: true });

    expect(result.current.target).not.toBe(first);
    expect(result.current.target.canSend).toBe(false);
  });
});
