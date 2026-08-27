// @vitest-environment jsdom
/**
 * The composer must not end up behind a phone's keyboard.
 *
 * **What this file can and cannot settle.** jsdom reports every element as
 * 0 × 0 and has no `visualViewport` of its own, so nothing here proves anything
 * about where a composer LANDS on a real iPhone. What it does prove is the
 * wiring: that the page reads the visual viewport at all, that it insets by
 * what the viewport reports, and that it insets by nothing when there is no
 * keyboard. Whether the resulting layout is right on iOS Safari is a
 * real-device check, and it is still owed.
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, cleanup, act, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import {
  REACTION_FREQUENTS_DEFAULT,
  type RoomEvent,
  type RoomWithRoster,
} from '@dorkos/shared/room-schemas';
import { EventStreamProvider, TransportProvider } from '@/layers/shared/model';
import { TooltipProvider } from '@/layers/shared/ui';
import { ChannelsPage } from '../ui/ChannelsPage';

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));
vi.mock('@tanstack/react-router', () => ({
  useSearch: () => ({ id: 'room-1' }),
  useNavigate: () => () => {},
  // `useInPlaceNavigate` (the thread-URL sync) reads the current location.
  useRouter: () => ({ state: { location: { pathname: '/channels', search: { id: 'room-1' } } } }),
}));

const ROOM: RoomWithRoster = {
  id: 'room-1',
  kind: 'channel',
  slug: 'general',
  title: '#general',
  topic: null,
  archived: false,
  ambientMaxEntries: 30,
  createdAt: '2026-07-30T09:00:00.000Z',
  lastActivityAt: '2026-07-30T10:00:00.000Z',
  // The viewer themselves, on the roster — `ChannelComposer` now reads
  // membership before offering a live composer at all (DOR-1233).
  members: [
    {
      roomId: 'room-1',
      authorId: 'author-you',
      responseMode: 'always',
      joinedAt: '2026-07-30T09:00:00.000Z',
      joinedSeq: 0,
      lastReadSeq: 0,
      author: { id: 'author-you', kind: 'human', displayName: 'You', handle: null },
      origin: 'local',
    },
  ],
  viewerAuthorId: 'author-you',
  reactionFrequents: [...REACTION_FREQUENTS_DEFAULT],
};

/** A phone: `useIsMobile` reads matchMedia, and the inset is its branch only. */
beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: true,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
  Object.defineProperty(window, 'innerHeight', { writable: true, value: 800 });
});

/**
 * A visual viewport the test drives, standing in for the one iOS shrinks when
 * its keyboard opens.
 */
function installViewport(height: number) {
  const listeners = new Set<() => void>();
  const viewport = {
    height,
    offsetTop: 0,
    scale: 1,
    addEventListener: (_name: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_name: string, fn: () => void) => listeners.delete(fn),
  };
  Object.defineProperty(window, 'visualViewport', { writable: true, value: viewport });
  return {
    /** Open a keyboard `px` tall, the way `resize` reports one. */
    resizeTo(next: number) {
      viewport.height = next;
      for (const fn of [...listeners]) fn();
    },
  };
}

function renderPage() {
  const transport = createMockTransport({
    getRoom: vi.fn().mockResolvedValue(ROOM),
    listRoomEntries: vi.fn().mockResolvedValue([]),
    subscribeRoom: vi.fn((_id: string, _cursor: number, signal: AbortSignal) =>
      (async function* (): AsyncIterable<RoomEvent> {
        await new Promise<void>((resolve) => {
          if (signal.aborted) return resolve();
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
      })()
    ),
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
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
}

/** The phone's single full-screen surface, which is what carries the inset. */
function surface(): HTMLElement {
  return screen.getByTestId('room-surface');
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ChannelsPage on a phone', () => {
  it('holds the composer above the software keyboard', async () => {
    // `h-dvh` measures the LAYOUT viewport, which a keyboard does not touch —
    // so everything pinned to the bottom of this column sits behind the
    // keyboard the moment you tap to type. Only `visualViewport` knows.
    const viewport = installViewport(800);
    renderPage();
    await waitFor(() => expect(screen.getByTestId('room-surface')).toBeInTheDocument());

    act(() => viewport.resizeTo(500));

    await waitFor(() => expect(surface()).toHaveStyle({ paddingBottom: '300px' }));
  });

  it('costs nothing when there is no keyboard', async () => {
    const viewport = installViewport(800);
    renderPage();
    await waitFor(() => expect(screen.getByTestId('room-surface')).toBeInTheDocument());

    // Opened and closed again: the inset has to come back off, or the room
    // keeps a 300px blank strip under it for the rest of the session.
    act(() => viewport.resizeTo(500));
    await waitFor(() => expect(surface()).toHaveStyle({ paddingBottom: '300px' }));
    act(() => viewport.resizeTo(800));

    await waitFor(() => expect(surface()).toHaveStyle({ paddingBottom: '0px' }));
  });
});
