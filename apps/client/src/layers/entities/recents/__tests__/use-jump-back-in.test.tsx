// @vitest-environment jsdom
/**
 * The hook half of "Jump back in": that it really reads the two shipped
 * queries, merges what they answer, and settles on an empty list rather than
 * loading forever when a person has nothing yet.
 *
 * The merge/order/dedupe/cap rules themselves are asserted against the pure
 * function in `jump-back-in.test.ts` — this file only proves the wiring.
 */
import type { ReactNode } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, waitFor, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport, createMockSession } from '@dorkos/test-utils';
import type { Transport } from '@dorkos/shared/transport';
import type { RoomSummary } from '@dorkos/shared/room-schemas';
import { TransportProvider } from '@/layers/shared/model';
import { useJumpBackIn } from '../model/use-jump-back-in';

function wrapperFor(transport: Transport) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
}

const channel = (id: string, slug: string, lastActivityAt: string): RoomSummary => ({
  id,
  kind: 'channel',
  slug,
  title: slug,
  topic: null,
  archived: false,
  ambientMaxEntries: 30,
  // Deliberately EARLIER than `lastActivityAt`: a room whose two timestamps are
  // equal has never been used and the model drops it (see `isJumpBackInRoom`).
  createdAt: '2026-07-01T00:00:00.000Z',
  lastActivityAt,
  unreadCount: 0,
  participants: null,
});

afterEach(cleanup);

describe('useJumpBackIn', () => {
  it('merges what the two shipped queries answer, most recent first', async () => {
    const transport = createMockTransport({
      listRecentSessions: vi.fn().mockResolvedValue({
        sessions: [
          createMockSession({
            id: 's1',
            title: 'Fix the bug',
            updatedAt: '2026-08-01T09:00:00.000Z',
          }),
        ],
        agentActivity: {},
        warnings: [],
      }),
      listRooms: vi.fn().mockResolvedValue([channel('c1', 'general', '2026-08-01T12:00:00.000Z')]),
    });

    const { result } = renderHook(() => useJumpBackIn(), { wrapper: wrapperFor(transport) });

    await waitFor(() => expect(result.current.items).toHaveLength(2));
    expect(result.current.items.map((i) => `${i.kind}:${i.id}`)).toEqual([
      'channel:c1',
      'session:s1',
    ]);
    expect(result.current.isLoading).toBe(false);
  });

  it('settles on an empty list — never a spinner that never resolves', async () => {
    const { result } = renderHook(() => useJumpBackIn(), {
      wrapper: wrapperFor(createMockTransport()),
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.items).toEqual([]);
    expect(result.current.automated).toEqual([]);
  });

  it('carries the fan-out warnings through for the caller to log', async () => {
    const transport = createMockTransport({
      listRecentSessions: vi.fn().mockResolvedValue({
        sessions: [],
        agentActivity: {},
        warnings: [{ runtime: 'codex', message: 'codex is not signed in' }],
      }),
    });

    const { result } = renderHook(() => useJumpBackIn(), { wrapper: wrapperFor(transport) });

    await waitFor(() => expect(result.current.warnings).toHaveLength(1));
    expect(result.current.warnings[0]!.runtime).toBe('codex');
  });

  it('asks for a wider session window than the row cap, so runs cannot starve the list', async () => {
    const listRecentSessions = vi
      .fn()
      .mockResolvedValue({ sessions: [], agentActivity: {}, warnings: [] });
    const transport = createMockTransport({ listRecentSessions });

    const { result } = renderHook(() => useJumpBackIn({ limit: 8 }), {
      wrapper: wrapperFor(transport),
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    // 8 rows, 24 sessions asked for: every room turn and scheduled run inside
    // the window is dropped from the rows, so a window the size of the cap
    // shows nothing at all on a busy install.
    expect(listRecentSessions).toHaveBeenCalledWith(24);
  });

  it('drops a muted room from the list entirely', async () => {
    const transport = createMockTransport({
      listRooms: vi
        .fn()
        .mockResolvedValue([
          channel('c1', 'general', '2026-08-01T12:00:00.000Z'),
          channel('c2', 'noisy', '2026-08-01T13:00:00.000Z'),
        ]),
    });

    const { result } = renderHook(() => useJumpBackIn({ mutedRoomIds: new Set(['c2']) }), {
      wrapper: wrapperFor(transport),
    });

    await waitFor(() => expect(result.current.items).toHaveLength(1));
    expect(result.current.items[0]!.id).toBe('c1');
  });

  it('honours a caller-supplied cap', async () => {
    const transport = createMockTransport({
      listRecentSessions: vi.fn().mockResolvedValue({
        sessions: [
          createMockSession({ id: 's1', updatedAt: '2026-08-01T09:00:00.000Z' }),
          createMockSession({ id: 's2', updatedAt: '2026-08-01T10:00:00.000Z' }),
        ],
        agentActivity: {},
        warnings: [],
      }),
    });

    const { result } = renderHook(() => useJumpBackIn({ limit: 1 }), {
      wrapper: wrapperFor(transport),
    });

    await waitFor(() => expect(result.current.items).toHaveLength(1));
    expect(result.current.items[0]!.id).toBe('s2');
  });
});
