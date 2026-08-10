// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { createMockSession } from '@dorkos/test-utils';
import type { RoomSummary } from '@dorkos/shared/room-schemas';
import type { Session } from '@dorkos/shared/types';
import { mergeJumpBackIn } from '@/layers/entities/recents';
import { TooltipProvider } from '@/layers/shared/ui';
import { SIDEBAR_PREFS_DEFAULTS } from '@dorkos/shared/config-schema';
import { JumpBackInSection } from '../ui/JumpBackInSection';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('@/layers/entities/config', async () => {
  const actual = await vi.importActual<typeof import('@/layers/entities/config')>(
    '@/layers/entities/config'
  );
  return {
    ...actual,
    useSidebarPrefs: () => SIDEBAR_PREFS_DEFAULTS,
    useUpdateSidebarPrefs: () => ({
      update: vi.fn(),
      updateAsync: vi.fn(),
      isPending: false,
      isError: false,
    }),
  };
});

beforeAll(() => {
  global.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
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

afterEach(cleanup);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function room(overrides: Partial<RoomSummary> & Pick<RoomSummary, 'id' | 'kind'>): RoomSummary {
  return {
    slug: null,
    title: 'Untitled',
    topic: null,
    workspaceId: null,
    archived: false,
    ambientMaxEntries: 30,
    // Earlier than `lastActivityAt`: equal timestamps mean a room nobody has
    // said anything in yet, which the model drops.
    createdAt: '2026-07-01T00:00:00.000Z',
    lastActivityAt: '2026-08-01T00:00:00.000Z',
    unreadCount: 0,
    participants: null,
    ...overrides,
  };
}

const channel = (id: string, slug: string, overrides: Partial<RoomSummary> = {}) =>
  room({ id, kind: 'channel', slug, title: slug, ...overrides });

const dm = (id: string, title: string, overrides: Partial<RoomSummary> = {}) =>
  room({ id, kind: 'dm', title, ...overrides });

function Wrapper({ children }: { children: React.ReactNode }) {
  return <TooltipProvider>{children}</TooltipProvider>;
}

/**
 * Render the section over the REAL merge, so the rows under test are the rows
 * the app would build from these sessions and rooms rather than a hand-written
 * list that cannot disagree with it.
 */
function renderSection({
  sessions = [],
  rooms = [],
  mutedRoomIds,
  ...overrides
}: {
  sessions?: Session[];
  rooms?: RoomSummary[];
  mutedRoomIds?: ReadonlySet<string>;
} & Partial<Parameters<typeof JumpBackInSection>[0]> = {}) {
  const model = mergeJumpBackIn({ sessions, rooms, mutedRoomIds });
  return render(
    <JumpBackInSection
      items={model.items}
      automated={model.automated}
      isLoading={false}
      agents={{}}
      displayNames={{}}
      visualOf={() => ({ kind: 'sigil' })}
      onSelectSession={vi.fn()}
      onSelectRoom={vi.fn()}
      onNewSession={vi.fn()}
      {...overrides}
    />,
    { wrapper: Wrapper }
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('JumpBackInSection', () => {
  it('renders sessions, direct messages and channels together, newest first', () => {
    renderSection({
      sessions: [
        createMockSession({
          id: 's1',
          title: 'Fix the bug',
          updatedAt: '2026-08-01T09:00:00.000Z',
        }),
      ],
      rooms: [
        channel('c1', 'general', { lastActivityAt: '2026-08-01T12:00:00.000Z' }),
        dm('d1', 'Ana', { lastActivityAt: '2026-08-01T10:00:00.000Z' }),
      ],
    });

    expect(screen.getByText('Jump back in')).toBeInTheDocument();
    const text = document.body.textContent ?? '';
    expect(text.indexOf('general')).toBeLessThan(text.indexOf('Ana'));
    expect(text.indexOf('Ana')).toBeLessThan(text.indexOf('Fix the bug'));
  });

  it('draws a channel with its `#` mark and speaks its full name once', () => {
    renderSection({ rooms: [channel('c1', 'general')] });

    // The visible name carries no `#` (the mark draws it); the spoken name does.
    expect(screen.getByText('general')).toBeInTheDocument();
    expect(screen.getByText('#general')).toHaveClass('sr-only');
    expect(document.querySelector('[data-slot="room-avatar"]')).not.toBeNull();
  });

  it('opens a room when its row is clicked, and never a session', () => {
    const onSelectRoom = vi.fn();
    const onSelectSession = vi.fn();
    const general = channel('c1', 'general');
    renderSection({ rooms: [general], onSelectRoom, onSelectSession });

    fireEvent.click(screen.getByText('general'));

    expect(onSelectRoom).toHaveBeenCalledWith(general);
    expect(onSelectSession).not.toHaveBeenCalled();
  });

  it('resumes a session when its row is clicked, and never a room', () => {
    const onSelectRoom = vi.fn();
    const onSelectSession = vi.fn();
    const session = createMockSession({ id: 's1', title: 'Fix the bug' });
    renderSection({ sessions: [session], onSelectSession, onSelectRoom });

    fireEvent.click(screen.getByText('Fix the bug'));

    expect(onSelectSession).toHaveBeenCalledWith(session);
    expect(onSelectRoom).not.toHaveBeenCalled();
  });

  it('says under a room what last happened in it', () => {
    renderSection({
      rooms: [
        channel('c1', 'busy', { unreadCount: 3, lastActivityAt: '2026-08-01T12:00:00.000Z' }),
        channel('c2', 'quiet', { topic: 'Release planning' }),
      ],
    });

    expect(screen.getByText('3 new messages')).toBeInTheDocument();
    expect(screen.getByText('Release planning')).toBeInTheDocument();
  });

  it('says under a session what was last said in it', () => {
    renderSection({
      sessions: [createMockSession({ id: 's1', lastMessagePreview: 'Deploy is green' })],
    });
    expect(screen.getByText('Deploy is green')).toBeInTheDocument();
  });

  it('keeps automated runs out of the list, behind a reveal that expands on click', () => {
    renderSection({
      sessions: [
        createMockSession({ id: 'u1', title: 'User session' }),
        createMockSession({
          id: 'c1',
          title: 'Telegram run',
          origin: 'channel',
          originLabel: 'Telegram',
        }),
      ],
    });

    expect(screen.getByText('User session')).toBeInTheDocument();
    expect(screen.queryByText('Telegram run')).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('+ 1 automated'));
    expect(screen.getByText('Telegram run')).toBeInTheDocument();
    // The origin still rides along, so an automated row says where it came from.
    expect(screen.getByLabelText('Origin: Telegram')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Hide'));
    expect(screen.queryByText('Telegram run')).not.toBeInTheDocument();
  });

  it('draws no reveal row when nothing was started for you', () => {
    renderSection({ sessions: [createMockSession({ id: 'u1', title: 'User session' })] });
    expect(screen.queryByText(/automated/)).not.toBeInTheDocument();
  });

  it('caps the list at 8 rows', () => {
    renderSection({
      rooms: Array.from({ length: 12 }, (_, i) =>
        channel(`c${i}`, `room-${i}`, {
          lastActivityAt: `2026-08-01T${String(i).padStart(2, '0')}:00:00.000Z`,
        })
      ),
    });

    expect(screen.getByText('room-11')).toBeInTheDocument();
    expect(screen.getByText('room-4')).toBeInTheDocument();
    expect(screen.queryByText('room-3')).not.toBeInTheDocument();
  });

  it('draws nothing at all when there is nothing to jump back into', () => {
    const { container } = renderSection();
    expect(container).toBeEmptyDOMElement();
  });

  it('shows skeletons while the first answer is on its way', () => {
    renderSection({ isLoading: true });
    expect(document.querySelectorAll('[data-slot="sidebar-menu-skeleton"]')).toHaveLength(3);
  });

  // --- Which row is the one you are already looking at ---

  it('marks the room on screen as the current page, and no other row', () => {
    renderSection({
      rooms: [
        channel('c1', 'general', { lastActivityAt: '2026-08-01T12:00:00.000Z' }),
        channel('c2', 'random', { lastActivityAt: '2026-08-01T11:00:00.000Z' }),
      ],
      activeRoomId: 'c2',
    });

    const current = screen.getAllByRole('button').filter((b) => b.getAttribute('aria-current'));
    expect(current).toHaveLength(1);
    expect(current[0]).toHaveTextContent('random');
  });

  it('marks the session on screen as the current page', () => {
    renderSection({
      sessions: [
        createMockSession({
          id: 's1',
          title: 'Fix the bug',
          updatedAt: '2026-08-01T12:00:00.000Z',
        }),
        createMockSession({ id: 's2', title: 'Other work', updatedAt: '2026-08-01T11:00:00.000Z' }),
      ],
      activeSessionId: 's2',
    });

    const current = screen.getAllByRole('button').filter((b) => b.getAttribute('aria-current'));
    expect(current).toHaveLength(1);
    expect(current[0]).toHaveTextContent('Other work');
  });

  it('marks nothing when the reader is somewhere else entirely', () => {
    renderSection({ rooms: [channel('c1', 'general')] });
    expect(
      screen.getAllByRole('button').filter((b) => b.getAttribute('aria-current'))
    ).toHaveLength(0);
  });

  // --- Rooms that do not belong here ---

  it('leaves a muted room out of the list', () => {
    renderSection({
      rooms: [channel('c1', 'general'), channel('c2', 'noisy')],
      mutedRoomIds: new Set(['c2']),
    });
    expect(screen.getByText('general')).toBeInTheDocument();
    expect(screen.queryByText('noisy')).not.toBeInTheDocument();
  });

  it('renders no timestamp at all for an unreadable one, rather than "Invalid Date"', () => {
    renderSection({
      sessions: [createMockSession({ id: 's1', title: 'Fix the bug', updatedAt: 'not-a-date' })],
    });
    expect(screen.getByText('Fix the bug')).toBeInTheDocument();
    expect(screen.queryByText(/Invalid Date/)).not.toBeInTheDocument();
  });

  it('starts a session from the header menu', () => {
    const onNewSession = vi.fn();
    renderSection({ rooms: [channel('c1', 'general')], onNewSession });

    // Radix opens on pointerdown, not on click.
    fireEvent.pointerDown(screen.getByLabelText('Jump back in section actions'));
    fireEvent.click(within(screen.getByRole('menu')).getByText('New session'));

    expect(onNewSession).toHaveBeenCalledOnce();
  });
});
