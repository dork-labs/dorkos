// @vitest-environment jsdom
/**
 * The room composer's chrome, serialized — the pre-migration record.
 *
 * Rooms are the ONE surface whose DOM legitimately changes in this spec, so the
 * proof here is not an empty diff. It is a diff that a person read and agreed
 * to. That only works if the "before" side is a real recording of the composer
 * as it shipped, which is what this file is (spec `composer-parity`, task 3.2).
 *
 * The intended delta, in full — everything else must diff empty:
 * - the root's class set swaps `relative border-t p-3` for Root's card chrome
 *   (`bg-surface rounded-xl border p-2 m-2 relative`);
 * - the overlay lane's offsets go from `right-3 left-3` to `right-0 left-0`.
 *
 * The chrome the migration replaces is also asserted positively below, in
 * words, so the swap reads as a before/after pair rather than as a deleted
 * assertion. `RoomComposer.test.tsx` keeps every behavioral claim; nothing here
 * duplicates one.
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import type { Transport } from '@dorkos/shared/transport';
import { REACTION_FREQUENTS_DEFAULT } from '@dorkos/shared/room-schemas';
import type { AuthorRef, RoomRosterEntry, RoomWithRoster } from '@dorkos/shared/room-schemas';
import { useRoomDraftStore } from '@/layers/entities/room';
import { createQueryClientConfig } from '@/layers/shared/lib';
import { TransportProvider } from '@/layers/shared/model';
import { serializeDom, matchDomBaseline, formatDomDiff } from '@/test-helpers/dom-parity';
import { RoomComposer } from '../ui/RoomComposer';

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));

/** A desktop: a real pointer, so Enter posts rather than inserting a newline. */
beforeAll(() => {
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = vi.fn();
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
  useRoomDraftStore.setState({ drafts: {} });
});

function member(author: AuthorRef): RoomRosterEntry {
  return {
    roomId: 'room-1',
    authorId: author.id,
    responseMode: 'mention-only',
    joinedAt: '2026-07-26T09:00:00.000Z',
    lastReadSeq: 0,
    author,
    origin: 'local',
  };
}

const MEMBERS: RoomRosterEntry[] = [
  member({ id: 'you', kind: 'human', displayName: 'You', handle: 'You' }),
  member({ id: 'ana', kind: 'agent', displayName: 'Ana Reyes', handle: 'ana' }),
];

function roomWith(overrides: Partial<RoomWithRoster> = {}): RoomWithRoster {
  return {
    id: 'room-1',
    kind: 'channel',
    slug: 'general',
    title: '#general',
    topic: null,
    workspaceId: null,
    archived: false,
    createdAt: '2026-07-26T09:00:00.000Z',
    lastActivityAt: '2026-07-26T10:00:00.000Z',
    members: MEMBERS,
    viewerAuthorId: 'you',
    reactionFrequents: [...REACTION_FREQUENTS_DEFAULT],
    ...overrides,
  };
}

/** Mount the composer under the app's real cache configuration, retries off. */
function renderComposer(
  room: RoomWithRoster = roomWith(),
  transport: Transport = createMockTransport()
) {
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
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
  return render(<RoomComposer room={room} />, { wrapper });
}

/** Type into the composer the way a person does — one controlled change. */
function type(field: HTMLTextAreaElement, text: string) {
  fireEvent.change(field, { target: { value: text } });
}

describe('RoomComposer — the chrome this migration is allowed to change', () => {
  it('is a bordered strip today, not a floating card', () => {
    const { container } = renderComposer();
    const root = container.firstElementChild!;

    // The "before" half of the delta, in words. After task 3.1 these flip to
    // `bg-surface rounded-xl border p-2 m-2 relative`.
    expect(root.className.split(/\s+/).sort()).toEqual(['border-t', 'p-3', 'relative']);
    expect(root.className).not.toContain('rounded-xl');
    expect(root.className).not.toContain('bg-surface');
    expect(root.className).not.toContain('m-2');
  });

  it('insets its overlay lane by 3 today', () => {
    const { container } = renderComposer();
    const lane = container.querySelector('.bottom-full')!;

    // The "before" half: after 3.1 these become `right-0 left-0`, matching
    // chat's lane, because the card's own padding now provides the inset.
    expect(lane.className.split(/\s+/).sort()).toEqual([
      'absolute',
      'bottom-full',
      'left-3',
      'mb-2',
      'right-3',
    ]);
  });

  it('renders no attach affordance — the seam stays unwired until DOR-947', () => {
    // A negative recorded on purpose: adopting Root must not hand rooms an
    // upload path as a side effect. Chat's Root mounts a dropzone because chat
    // passes `onFilesDropped`; rooms pass none.
    const { container } = renderComposer();

    expect(container.querySelector('input[type="file"]')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Attach file' })).toBeNull();
    expect(container.querySelector('[role="presentation"]')).toBeNull();
  });
});

describe('RoomComposer — serialized-DOM parity (pre-migration baselines)', () => {
  it('idle — the resting composer', () => {
    const { container } = renderComposer();

    expect(screen.getByRole('combobox')).toHaveAttribute('aria-label', 'Message #general…');

    const diff = matchDomBaseline(import.meta.url, 'room-composer.idle', serializeDom(container));
    expect(formatDomDiff(diff)).toBe('');
  });

  it('archived — the composer that says why it cannot be used', () => {
    const { container } = renderComposer(roomWith({ archived: true }));

    expect(
      screen.getByText('This conversation is archived. You can read it, but not add to it.')
    ).toBeInTheDocument();

    const diff = matchDomBaseline(
      import.meta.url,
      'room-composer.archived',
      serializeDom(container)
    );
    expect(formatDomDiff(diff)).toBe('');
  });

  it('mention picker open — the lane carrying the palette', () => {
    const { container } = renderComposer();
    const field = screen.getByRole('combobox') as HTMLTextAreaElement;

    type(field, 'hey @');
    fireEvent.select(field, { target: { selectionStart: 5 } });

    const lane = container.querySelector('.bottom-full')!;
    expect(lane.querySelector('[role="listbox"]')).not.toBeNull();

    const diff = matchDomBaseline(
      import.meta.url,
      'room-composer.mention-open',
      serializeDom(container)
    );
    expect(formatDomDiff(diff)).toBe('');
  });

  it('clear armed — the lane carrying the hint', () => {
    // The picker and the hint cannot be on screen together: Escape with a
    // palette open dismisses the palette and deliberately does NOT arm. So the
    // lane's two occupants get one baseline each, and the migration has to
    // reproduce both.
    const { container } = renderComposer();
    const field = screen.getByRole('combobox') as HTMLTextAreaElement;

    type(field, 'a draft worth keeping');
    fireEvent.keyDown(field, { key: 'Escape' });

    const lane = container.querySelector('.bottom-full')!;
    expect(lane.contains(screen.getByTestId('clear-armed-hint'))).toBe(true);

    const diff = matchDomBaseline(
      import.meta.url,
      'room-composer.clear-armed',
      serializeDom(container)
    );
    expect(formatDomDiff(diff)).toBe('');
  });
});
