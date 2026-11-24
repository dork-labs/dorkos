/** Shared harness for the ChannelsPage test files. */
import { vi, beforeAll, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils/mock-factories';
import type { Transport } from '@dorkos/shared/transport';
import {
  REACTION_FREQUENTS_DEFAULT,
  type RoomEvent,
  type RoomWithRoster,
} from '@dorkos/shared/room-schemas';
import {
  usePendingPostStore,
  useRoomDraftStore,
  useRoomFollowStore,
  useRoomOpenThreadStore,
} from '@/layers/entities/room';
import { createQueryClientConfig } from '@/layers/shared/lib';
import { EventStreamProvider, TransportProvider, useAppStore } from '@/layers/shared/model';
import { TooltipProvider } from '@/layers/shared/ui';
import { useRoomPanelFocusStore } from '@/layers/features/room-management';
import { ChannelsPage } from '../../ui/ChannelsPage';
import { route } from './channels-page.route';

/**
 * Install the viewport stub and the per-test reset of every store that
 * outlives an unmounted page (drafts, pending rows, open threads, follows).
 */
export function installChannelsPageHarness(): void {
  beforeAll(() => {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        // A phone is a viewport AND a coarse pointer: the composer's autofocus
        // is gated on `useIsTouchOnly`.
        matches:
          route.phone && (query.includes('max-width') || query.includes('(pointer: coarse)')),
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
    useRoomPanelFocusStore.setState({ request: null });
    useAppStore.setState({ rightPanelOpen: false, activeRightPanelTab: null });
    route.roomId = 'room-1';
    route.entrySeq = undefined;
    route.phone = false;
    useRoomOpenThreadStore.setState({ open: {} });
    useRoomDraftStore.setState({ drafts: {} });
    usePendingPostStore.setState({ posts: [] });
    useRoomFollowStore.setState({ intent: {}, claims: {}, positions: {} });
  });
}

/** A channel whose roster holds only the viewer. */
export function roomWith(id: string, slug: string): RoomWithRoster {
  return {
    id,
    kind: 'channel',
    slug,
    title: `#${slug}`,
    topic: null,
    archived: false,
    ambientMaxEntries: 30,
    createdAt: '2026-07-26T09:00:00.000Z',
    lastActivityAt: '2026-07-26T10:00:00.000Z',
    // The viewer themselves, on the roster — `ChannelComposer` now reads
    // membership to decide whether to offer a live composer at all
    // (DOR-1233), and every test below assumes one.
    members: [
      {
        roomId: id,
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
    reactionFrequents: [...REACTION_FREQUENTS_DEFAULT],
  };
}

/** A live but silent room stream, so the page is not busy reconnecting. */
export function staysOpen(signal: AbortSignal): AsyncIterable<RoomEvent> {
  return (async function* () {
    await new Promise<void>((resolve) => {
      if (signal.aborted) return resolve();
      signal.addEventListener('abort', () => resolve(), { once: true });
    });
  })();
}

/** Mount the page on a mock transport; `openRoom` swaps the `?id=` it reads. */
export function renderPage(overrides: Partial<Transport> = {}) {
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
      <EventStreamProvider>
        <TransportProvider transport={transport}>
          <TooltipProvider>
            <ChannelsPage />
          </TooltipProvider>
        </TransportProvider>
      </EventStreamProvider>
    </QueryClientProvider>
  );

  /** Point the page at another room and wait for its composer. */
  const openRoom = async (id: string) => {
    route.roomId = id;
    rerender(
      <QueryClientProvider client={queryClient}>
        <EventStreamProvider>
          <TransportProvider transport={transport}>
            <TooltipProvider>
              <ChannelsPage />
            </TooltipProvider>
          </TransportProvider>
        </EventStreamProvider>
      </QueryClientProvider>
    );
    await screen.findByRole('combobox');
    return screen.getByRole('combobox') as HTMLTextAreaElement;
  };

  return { transport, openRoom };
}
