// @vitest-environment jsdom
/**
 * A moment in the feed — the milestone line, drawn through the row every other
 * entry goes through (team-room-home spec D5.1).
 *
 * Rendered via `RoomMessage` rather than the moment row directly, because the
 * claim under test is that the feed's OWN dispatch reaches it: a moment is a
 * post, so a client that only checked `entry.kind` would draw it as an ordinary
 * message and the milestone would read as somebody talking.
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import type { RoomEntry, RoomMoment } from '@dorkos/shared/room-schemas';
import { TransportProvider } from '@/layers/shared/model';
import { TooltipProvider } from '@/layers/shared/ui';
import { RoomMessage } from '../ui/RoomMessage';
import { toMessageAuthor, type RosterAuthor } from '../lib/room-timeline';
import { ConversationRoot } from '@/layers/features/conversation';
import { ROOM_CAPABILITIES } from '../model/room-capabilities';

// The row reads route state to decide where its author face leads
// (`useProfileDeepLink`), and this file mounts it with no router. Where that
// link goes has its own file — `RoomMessage.click-to-profile.test.tsx`, which
// mounts a real router and asserts the id that travels.
vi.mock('@/layers/shared/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/shared/model')>();
  return {
    ...actual,
    useProfileDeepLink: () => ({ isOpen: false, memberId: null, open: vi.fn(), close: vi.fn() }),
  };
});

/** The room's roster: the system voice that wrote it, and the agent it is about. */
const AUTHORS = new Map<string, RosterAuthor>([
  [
    'system',
    { id: 'system', kind: 'system', displayName: 'DorkOS', handle: 'dorkos', origin: 'local' },
  ],
  [
    'tangerines',
    {
      id: 'tangerines',
      kind: 'agent',
      displayName: 'tangerines',
      handle: 'tangerines',
      color: '#c2410c',
      origin: 'local',
    },
  ],
]);

/** DorkOS marking an agent's arrival, off that agent's own record. */
const JOINED: RoomMoment = {
  kind: 'joined_team',
  source: { kind: 'agent', ref: '/agents/tangerines', observedAt: '2026-08-08T09:00:00.000Z' },
  mintedByAgentRef: null,
};

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
});

afterEach(cleanup);

function entry(overrides: Partial<RoomEntry> = {}): RoomEntry {
  return {
    roomId: 'room-1',
    seq: 4,
    id: 'entry-4',
    authorId: 'system',
    kind: 'post',
    body: { text: 'tangerines joined your team', moment: JOINED, subjectAuthorId: 'tangerines' },
    mentions: [],
    sessionId: null,
    cascadeRoot: 'entry-4',
    cascadeDepth: 3,
    parentEntryId: null,
    threadRootEntryId: null,
    signature: null,
    createdAt: '2026-08-08T09:00:00.000Z',
    ...overrides,
  };
}

function renderRow(target: RoomEntry = entry()) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <RoomMessage
      roomId="room-1"
      entry={target}
      // Resolved off the roster exactly as `RoomTimeline` resolves it, so the
      // fixture cannot disagree with the feed about who wrote the entry.
      author={toMessageAuthor(target.authorId, AUTHORS)}
      authorRef={AUTHORS.get(target.authorId)}
      authors={AUTHORS}
      viewerAuthorId="author-you"
      authorNames={new Map()}
      reactionFrequents={[]}
      grouping={{ position: 'only' }}
      feedPosition={{ index: 4, total: 9 }}
    />,
    {
      wrapper: ({ children }) => (
        <QueryClientProvider client={queryClient}>
          <TransportProvider transport={createMockTransport()}>
            <TooltipProvider>
              {/* The same conversation the room mounts (`RoomSurface`): its rows read
                  capabilities from it, so a bench without one is testing a component
                  in a state the app never puts it in. */}
              <ConversationRoot surface="room" capabilities={ROOM_CAPABILITIES} anchor="rail">
                {children}
              </ConversationRoot>
            </TooltipProvider>
          </TransportProvider>
        </QueryClientProvider>
      ),
    }
  );
}

describe('a moment in the room feed', () => {
  it('draws a moment instead of an ordinary message, and says which kind it is', () => {
    renderRow();

    const moment = screen.getByTestId('room-moment');
    expect(moment).toHaveTextContent('tangerines joined your team');
    expect(moment).toHaveAttribute('data-moment', 'joined_team');
    // Not the message grid, and not the notice line either.
    expect(screen.queryByTestId('room-entry')).not.toBeInTheDocument();
    expect(screen.queryByTestId('room-notice')).not.toBeInTheDocument();
  });

  it('names itself as a moment, so it is not heard as somebody talking', () => {
    renderRow();

    // The whole difference a screen reader gets: the row still reads its own
    // words, and says up front that this line is a milestone rather than a
    // message somebody wrote.
    expect(screen.getByTestId('room-moment')).toHaveAccessibleName(
      'Moment: tangerines joined your team'
    );
  });

  it('carries the family mark as decoration, never as a second sentence', () => {
    renderRow();

    const mark = screen.getByTestId('room-moment-mark');
    expect(mark).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByTestId('room-moment')).toHaveTextContent('tangerines joined your team');
  });

  it('draws the identity the moment is ABOUT, not the voice that wrote it', () => {
    // "tangerines joined your team" is written by DorkOS and is about
    // tangerines. Drawing the system's own face beside it would make the
    // milestone look like a system message rather than a member's arrival.
    renderRow();

    expect(screen.getByTestId('room-moment-identity')).toHaveTextContent('tangerines');
  });

  it('falls back to its author when the moment names nobody', () => {
    // An agent-minted moment is about its author, and carries no subject —
    // `RoomService.postMoment` refuses one on that path.
    renderRow(
      entry({
        authorId: 'tangerines',
        body: {
          text: 'that was our hundredth session together',
          moment: {
            kind: 'agent_minted',
            source: { kind: 'session', ref: '01JZ', observedAt: '2026-08-08T09:00:00.000Z' },
            mintedByAgentRef: 'ref-tangerines',
          },
        },
      })
    );

    expect(screen.getByTestId('room-moment-identity')).toHaveTextContent('tangerines');
    expect(screen.getByTestId('room-moment')).toHaveAttribute('data-moment', 'agent_minted');
  });

  it('offers nothing to press — a milestone is news, not a message', () => {
    // No toolbar, no reaction rail: the row states something that happened, and
    // there is nobody to answer.
    renderRow();

    expect(screen.queryByTestId('entry-actions')).not.toBeInTheDocument();
  });

  it('still draws a moment whose kind this client has never heard of', () => {
    // The server mints the kinds; a client a release behind must not render a
    // blank line where a milestone should be.
    renderRow(
      entry({
        body: {
          text: 'your agents worked every day this week',
          moment: { ...JOINED, kind: 'some_kind_shipped_later' as RoomMoment['kind'] },
        },
      })
    );

    expect(screen.getByTestId('room-moment')).toHaveTextContent(
      'your agents worked every day this week'
    );
  });
});
