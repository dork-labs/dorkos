// @vitest-environment jsdom
/**
 * Room switching, asserted at the page — the only level that can see it.
 *
 * `RoomComposer` in isolation always looks correct: it is mounted once per
 * test, with one room. The bug these cover is that the PAGE re-renders the same
 * composer instance for a different room, so a draft (and an in-flight latch)
 * outlive the conversation they belong to. Nothing inside the component can
 * observe that; only mounting the page and changing its search param can.
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import type { Transport } from '@dorkos/shared/transport';
import type { PostToRoomResponse, RoomEvent, RoomWithRoster } from '@dorkos/shared/room-schemas';
import { createQueryClientConfig } from '@/layers/shared/lib';
import { TransportProvider } from '@/layers/shared/model';
import { TooltipProvider } from '@/layers/shared/ui';
import { ChannelsPage } from '../ui/ChannelsPage';

const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }));
vi.mock('sonner', () => ({ toast: { error: toastError } }));

/** The `?id=` the page reads, swapped between renders to change rooms. */
let openRoomId = 'room-1';
vi.mock('@tanstack/react-router', () => ({
  useSearch: () => ({ id: openRoomId, thread: undefined }),
  useNavigate: () => () => {},
}));

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

afterEach(() => {
  cleanup();
  toastError.mockClear();
  openRoomId = 'room-1';
});

function roomWith(id: string, slug: string): RoomWithRoster {
  return {
    id,
    kind: 'channel',
    parentId: null,
    slug,
    title: `#${slug}`,
    topic: null,
    workspaceId: null,
    rootEntryId: null,
    archived: false,
    createdAt: '2026-07-26T09:00:00.000Z',
    lastActivityAt: '2026-07-26T10:00:00.000Z',
    members: [],
  };
}

/** A live but silent room stream, so the page is not busy reconnecting. */
function staysOpen(signal: AbortSignal): AsyncIterable<RoomEvent> {
  return (async function* () {
    await new Promise<void>((resolve) => {
      if (signal.aborted) return resolve();
      signal.addEventListener('abort', () => resolve(), { once: true });
    });
  })();
}

function renderPage(overrides: Partial<Transport> = {}) {
  const transport = createMockTransport({
    getRoom: vi.fn((id: string) =>
      Promise.resolve(roomWith(id, id === 'room-1' ? 'dm' : 'random'))
    ),
    subscribeRoom: vi.fn((_id: string, _cursor: number, signal: AbortSignal) => staysOpen(signal)),
    ...overrides,
  });
  const config = createQueryClientConfig();
  const queryClient = new QueryClient({
    ...config,
    defaultOptions: {
      ...config.defaultOptions,
      queries: { ...config.defaultOptions?.queries, retry: false },
      mutations: { retry: false },
    },
  });
  const { rerender } = render(
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>
        <TooltipProvider>
          <ChannelsPage />
        </TooltipProvider>
      </TransportProvider>
    </QueryClientProvider>
  );

  /** Point the page at another room and wait for its composer. */
  const openRoom = async (id: string) => {
    openRoomId = id;
    rerender(
      <QueryClientProvider client={queryClient}>
        <TransportProvider transport={transport}>
          <TooltipProvider>
            <ChannelsPage />
          </TooltipProvider>
        </TransportProvider>
      </QueryClientProvider>
    );
    await screen.findByRole('combobox');
    return screen.getByRole('combobox') as HTMLTextAreaElement;
  };

  return { transport, openRoom };
}

describe('ChannelsPage room switching', () => {
  it('leaves a half-typed message behind in the room it was typed in', async () => {
    const { transport, openRoom } = renderPage();

    // Visit both rooms first, so the second switch finds room-2 cached and
    // takes NONE of the loading early-returns. That is the whole condition for
    // the bug: an early return would unmount the composer and hide it.
    await openRoom('room-1');
    await openRoom('room-2');
    const dmField = await openRoom('room-1');

    fireEvent.change(dmField, { target: { value: 'something private' } });
    expect(dmField.value).toBe('something private');

    const channelField = await openRoom('room-2');

    expect(channelField.value).toBe('');
    fireEvent.keyDown(channelField, { key: 'Enter' });
    await waitFor(() => expect(transport.postToRoom).toHaveBeenCalledTimes(0));
  });

  it('does not let a post in one room latch the composer shut in another', async () => {
    // The first room's post never settles, so its latch is still raised when
    // the reader moves on.
    const { transport, openRoom } = renderPage({
      postToRoom: vi.fn(() => new Promise<PostToRoomResponse>(() => {})),
    });

    await openRoom('room-1');
    await openRoom('room-2');
    const dmField = await openRoom('room-1');

    fireEvent.change(dmField, { target: { value: 'still sending' } });
    fireEvent.keyDown(dmField, { key: 'Enter' });
    await waitFor(() => expect(transport.postToRoom).toHaveBeenCalledTimes(1));

    const channelField = await openRoom('room-2');
    fireEvent.change(channelField, { target: { value: 'still sending' } });
    fireEvent.keyDown(channelField, { key: 'Enter' });

    // Same words, different room: it has to go. A shared latch would drop this
    // one on the floor — no send, no clear, no toast.
    await waitFor(() => expect(transport.postToRoom).toHaveBeenCalledTimes(2));
    expect(transport.postToRoom).toHaveBeenNthCalledWith(2, 'room-2', { text: 'still sending' });
  });

  it('sends to the room on screen, addressed by that room', async () => {
    const { transport, openRoom } = renderPage();

    await openRoom('room-1');
    const channelField = await openRoom('room-2');

    fireEvent.change(channelField, { target: { value: 'hello #random' } });
    fireEvent.keyDown(channelField, { key: 'Enter' });

    await waitFor(() => expect(transport.postToRoom).toHaveBeenCalledTimes(1));
    expect(transport.postToRoom).toHaveBeenCalledWith('room-2', { text: 'hello #random' });
  });
});
