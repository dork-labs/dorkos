// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { ThreadSummary } from '@dorkos/shared/room-schemas';
import { SIDEBAR_PREFS_DEFAULTS } from '@dorkos/shared/config-schema';
import type { SidebarPrefs } from '@dorkos/shared/config-schema';
import { ThreadsSection } from '../ui/rooms/ThreadsSection';

const mockUpdate = vi.fn<(updater: (prev: SidebarPrefs) => unknown) => void>();
let mockCollapsed = false;

vi.mock('@/layers/entities/config', async () => {
  const actual = await vi.importActual<typeof import('@/layers/entities/config')>(
    '@/layers/entities/config'
  );
  return {
    ...actual,
    useSidebarPrefs: () => ({
      ...SIDEBAR_PREFS_DEFAULTS,
      sections: { threads: { collapsed: mockCollapsed } },
    }),
    useUpdateSidebarPrefs: () => ({
      update: mockUpdate,
      updateAsync: vi.fn(),
      isPending: false,
      isError: false,
    }),
  };
});

function thread(overrides: Partial<ThreadSummary> = {}): ThreadSummary {
  return {
    roomId: 'room-1',
    roomKind: 'channel',
    roomSlug: 'general',
    roomTitle: '#general',
    rootEntryId: 'entry-1',
    rootAuthorId: 'author-1',
    rootPreview: 'Deploy is red again',
    replyCount: 3,
    unreadCount: 0,
    lastActivityAt: '2026-07-30T12:00:00.000Z',
    ...overrides,
  };
}

function renderSection(props: Partial<Parameters<typeof ThreadsSection>[0]> = {}) {
  return render(
    <ThreadsSection
      threads={[thread()]}
      error={null}
      activeThreadId={null}
      onSelectThread={vi.fn()}
      {...props}
    />
  );
}

describe('ThreadsSection', () => {
  beforeEach(() => {
    mockCollapsed = false;
    mockUpdate.mockClear();
  });
  afterEach(cleanup);

  it('names the thread by its opening message and says where it lives', () => {
    renderSection();
    expect(screen.getByText('Deploy is red again')).toBeInTheDocument();
    expect(screen.getByText('#general · 3 replies')).toBeInTheDocument();
  });

  it('says "1 reply" rather than "1 replies"', () => {
    renderSection({ threads: [thread({ replyCount: 1 })] });
    expect(screen.getByText('#general · 1 reply')).toBeInTheDocument();
  });

  it('draws a DM thread under the conversation’s own name, with no # in front', () => {
    // `roomKind: 'dm'` + `roomSlug: null` + the title is exactly what the
    // aggregation emits for a direct message — pinned server-side by "names a
    // DM thread by the conversation" in `thread-list.test.ts`, so this fixture
    // is the real contract rather than a shape invented here. A DM has no slug,
    // so a row that reached for one would draw a bare `#`.
    renderSection({
      threads: [thread({ roomKind: 'dm', roomSlug: null, roomTitle: 'Ana' })],
    });
    expect(screen.getByText('Ana · 3 replies')).toBeInTheDocument();
    expect(screen.queryByText(/#/)).not.toBeInTheDocument();
  });

  it('badges unread replies without naming the thread twice', () => {
    renderSection({ threads: [thread({ unreadCount: 2 })] });
    const badge = screen.getByLabelText('2 unread');
    expect(badge).toHaveTextContent('2');
    // The row's accessible name is built from its parts; the badge contributes
    // the count and nothing else.
    expect(badge).not.toHaveTextContent('Deploy');
  });

  it('draws no badge when the reader is caught up', () => {
    renderSection();
    expect(screen.queryByLabelText(/unread/)).not.toBeInTheDocument();
  });

  it('hands the whole thread back when a row is clicked', () => {
    const onSelectThread = vi.fn();
    const only = thread();
    renderSection({ threads: [only], onSelectThread });
    fireEvent.click(screen.getByText('Deploy is red again'));
    expect(onSelectThread).toHaveBeenCalledWith(only);
  });

  it('marks the thread on screen as current', () => {
    renderSection({ activeThreadId: 'entry-1' });
    expect(screen.getByRole('button', { name: /Deploy is red again/ })).toHaveAttribute(
      'aria-current',
      'page'
    );
  });

  it('renders nothing at all when the reader is in no threads', () => {
    const { container } = renderSection({ threads: [] });
    // Not an empty state: a thread is something that happens to you, so an
    // invitation to make one would be an instruction nobody can follow.
    expect(container).toBeEmptyDOMElement();
  });

  it('says the threads are still there when the list could not be read', () => {
    renderSection({ threads: [], error: new Error('offline') });
    expect(screen.getByText(/Couldn't load your threads/)).toBeInTheDocument();
  });

  it('collapses to its header, and persists the choice', () => {
    renderSection();
    fireEvent.click(screen.getByRole('button', { name: 'Threads' }));
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(mockUpdate.mock.calls[0]![0](SIDEBAR_PREFS_DEFAULTS)).toEqual({
      ...SIDEBAR_PREFS_DEFAULTS,
      sections: { threads: { collapsed: true } },
    });
  });

  it('hides its rows while collapsed', () => {
    mockCollapsed = true;
    renderSection();
    expect(screen.getByRole('button', { name: 'Threads' })).toHaveAttribute(
      'aria-expanded',
      'false'
    );
    expect(screen.queryByText('Deploy is red again')).not.toBeInTheDocument();
  });

  it('falls back to a name for a root that carried no text', () => {
    renderSection({ threads: [thread({ rootPreview: '   ' })] });
    expect(screen.getByText('Untitled thread')).toBeInTheDocument();
  });
});
