// @vitest-environment jsdom
/**
 * A room notice that says "Open Ana's session" links to that session
 * (DOR-2077, reported as FB-27).
 *
 * The line used to be a sentence with no way to do what it said. The link's
 * target comes from the room's session bindings, keyed by the notice's
 * `subjectAuthorId`, and a click re-reads them before it goes anywhere, because
 * a room rebinds an agent's session after every turn (DOR-1974).
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import type { Transport } from '@dorkos/shared/transport';
import type { RoomEntry, RoomEntryBody } from '@dorkos/shared/room-schemas';
import { TransportProvider } from '@/layers/shared/model';
import { TooltipProvider } from '@/layers/shared/ui';
import { Conversation } from '@/layers/features/conversation';
import { RoomMessage } from '../ui/RoomMessage';
import { ROOM_CAPABILITIES } from '../model/room-capabilities';

const navigate = vi.fn();

// The one thing this file asserts about navigation is WHERE a click goes, so the
// router is reduced to the function that is handed the destination.
vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>();
  return { ...actual, useNavigate: () => navigate };
});

// Mounted with no router: the author face's profile link is stubbed, as in
// `RoomMessage.test.tsx`, which explains why.
vi.mock('@/layers/shared/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/shared/model')>();
  return {
    ...actual,
    useProfileDeepLink: () => ({ isOpen: false, memberId: null, open: vi.fn(), close: vi.fn() }),
  };
});

/** A roster member for this file, by author id and display name. */
function agentAuthor(id: string, displayName: string) {
  return [
    id,
    { id, kind: 'agent' as const, displayName, handle: id, origin: 'local' as const },
  ] as const;
}

const AUTHORS = new Map([
  // Names that start the way the phrase does, or contain it (review of DOR-2077).
  agentAuthor('oi', 'Open Interpreter'),
  agentAuthor('ksb', "Kai's session bot"),
  [
    'kai',
    {
      id: 'kai',
      kind: 'agent' as const,
      displayName: 'Kai',
      handle: 'kai',
      origin: 'local' as const,
    },
  ],
]);

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
  navigate.mockReset();
});

function notice(body: RoomEntryBody): RoomEntry {
  return {
    roomId: 'room-1',
    seq: 1,
    id: 'entry-1',
    authorId: 'system',
    kind: 'notice',
    body,
    mentions: [],
    sessionId: null,
    cascadeRoot: 'entry-1',
    cascadeDepth: 0,
    parentEntryId: null,
    threadRootEntryId: null,
    signature: null,
    createdAt: '2026-09-25T10:00:00.000Z',
  };
}

const TURN_FAILED: RoomEntryBody = {
  text: "Kai ran into a problem and could not answer here. Open Kai's session to see what went wrong.",
  notice: 'turn_failed',
  subjectAuthorId: 'kai',
};

function renderNotice(target: RoomEntry, transport: Transport) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <RoomMessage
      roomId="room-1"
      entry={target}
      author={{ id: 'system', kind: 'agent', displayName: 'DorkOS', color: '#888' }}
      authorRef={undefined}
      authors={AUTHORS}
      viewerAuthorId="author-you"
      authorNames={new Map([['kai', 'Kai']])}
      reactionFrequents={[]}
      grouping={{ position: 'only' }}
    />,
    {
      wrapper: ({ children }) => (
        <QueryClientProvider client={queryClient}>
          <TransportProvider transport={transport}>
            <TooltipProvider>
              <Conversation.Root surface="room" capabilities={ROOM_CAPABILITIES} anchor="rail">
                {children}
              </Conversation.Root>
            </TooltipProvider>
          </TransportProvider>
        </QueryClientProvider>
      ),
    }
  );
}

function transportWith(...bindings: Array<{ authorId: string; sessionId: string }[]>) {
  const transport = createMockTransport();
  const listRoomSessions = vi.mocked(transport.listRoomSessions);
  for (const answer of bindings) listRoomSessions.mockResolvedValueOnce({ bindings: answer });
  return transport;
}

describe('RoomMessage — a notice that sends you to a session links to it', () => {
  it('links a failed turn to the session its agent works in here', async () => {
    const transport = transportWith([{ authorId: 'kai', sessionId: 'sess-kai' }]);
    renderNotice(notice(TURN_FAILED), transport);

    const link = await screen.findByTestId('room-notice-session-link');
    // The path AND the id: an id without `/session` in front of it is the
    // other half of what DOR-2077 was filed about.
    expect(link).toHaveAttribute('href', '/session?session=sess-kai');
    // The notice's own words are the link, so the line says it once.
    expect(link).toHaveTextContent("Open Kai's session");
    expect(screen.getByTestId('room-notice').textContent).toBe(TURN_FAILED.text);
    expect(transport.listRoomSessions).toHaveBeenCalledWith('room-1');
  });

  it('links an agent that is waiting for an answer, which is answered in its session', async () => {
    const transport = transportWith([{ authorId: 'kai', sessionId: 'sess-kai' }]);
    renderNotice(
      notice({
        text: "Kai has a question for you before it can carry on. Open Kai's session to answer. It will wait, but not forever.",
        notice: 'awaiting_approval',
        subjectAuthorId: 'kai',
        waitingKind: 'question',
      }),
      transport
    );

    expect(await screen.findByTestId('room-notice-session-link')).toHaveAttribute(
      'href',
      '/session?session=sess-kai'
    );
  });

  it('opens the session the room has bound NOW, not the one it had when the row drew', async () => {
    // DOR-1974: the room rebinds after every turn, and a stale id reads as an
    // empty conversation. The second answer is the one the click must use.
    const transport = transportWith(
      [{ authorId: 'kai', sessionId: 'sess-old' }],
      [{ authorId: 'kai', sessionId: 'sess-new' }]
    );
    renderNotice(notice(TURN_FAILED), transport);

    fireEvent.click(await screen.findByTestId('room-notice-session-link'));

    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith({ to: '/session', search: { session: 'sess-new' } })
    );
  });

  it('goes nowhere when the room has let the session go since the row drew', async () => {
    // Following the old id lands on "Session not found" (review of DOR-2077).
    const transport = transportWith([{ authorId: 'kai', sessionId: 'sess-old' }], []);
    renderNotice(notice(TURN_FAILED), transport);

    fireEvent.click(await screen.findByTestId('room-notice-session-link'));

    // The fresh read refilled the cache, so the row redraws as a plain sentence.
    await waitFor(() =>
      expect(screen.queryByTestId('room-notice-session-link')).not.toBeInTheDocument()
    );
    expect(screen.getByTestId('room-notice').textContent).toBe(TURN_FAILED.text);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('still opens the session on screen when the fresh read fails', async () => {
    // A failed read learned nothing new, so the id the row shows is the best answer.
    const transport = transportWith([{ authorId: 'kai', sessionId: 'sess-kai' }]);
    vi.mocked(transport.listRoomSessions).mockRejectedValueOnce(new Error('offline'));
    renderNotice(notice(TURN_FAILED), transport);

    fireEvent.click(await screen.findByTestId('room-notice-session-link'));

    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith({ to: '/session', search: { session: 'sess-kai' } })
    );
  });

  it('adds the link after a line that does not name the session in the usual words', async () => {
    // A notice written before the phrase was a rule still gets its way there.
    const transport = transportWith([{ authorId: 'kai', sessionId: 'sess-kai' }]);
    renderNotice(
      notice({ text: 'Kai ran into a problem.', notice: 'turn_failed', subjectAuthorId: 'kai' }),
      transport
    );

    expect(await screen.findByTestId('room-notice-session-link')).toHaveTextContent('Open session');
  });

  it.each([
    ['oi', 'Open Interpreter'],
    ['ksb', "Kai's session bot"],
  ])('links only the instruction for an agent named %s → %s', async (authorId, name) => {
    // The notice starts with the name, so a pattern that looks for "Open …'s
    // session" from the front underlines most of the sentence for these two.
    const text = `${name} ran into a problem and could not answer here. Open ${name}'s session to see what went wrong.`;
    const transport = transportWith([{ authorId, sessionId: 'sess-x' }]);
    renderNotice(notice({ text, notice: 'turn_failed', subjectAuthorId: authorId }), transport);

    expect(await screen.findByTestId('room-notice-session-link')).toHaveTextContent(
      new RegExp(`^Open ${name}'s session$`)
    );
    expect(screen.getByTestId('room-notice').textContent).toBe(text);
  });

  it('leaves a new-tab click to the browser', async () => {
    const transport = transportWith([{ authorId: 'kai', sessionId: 'sess-kai' }]);
    renderNotice(notice(TURN_FAILED), transport);

    const link = await screen.findByTestId('room-notice-session-link');
    const event = new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true });
    link.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('draws no link when the room has no session for that agent — never one that goes nowhere', async () => {
    const transport = transportWith([{ authorId: 'somebody-else', sessionId: 'sess-other' }]);
    renderNotice(notice(TURN_FAILED), transport);

    await waitFor(() => expect(transport.listRoomSessions).toHaveBeenCalled());
    expect(screen.getByTestId('room-notice')).toBeInTheDocument();
    expect(screen.queryByTestId('room-notice-session-link')).not.toBeInTheDocument();
  });

  it('asks nothing for a notice that does not send anybody to a session', () => {
    const transport = transportWith([{ authorId: 'kai', sessionId: 'sess-kai' }]);
    renderNotice(
      notice({
        text: "Kai isn't set up on this machine any more, so it can't answer here.",
        notice: 'agent_gone',
        subjectAuthorId: 'kai',
      }),
      transport
    );

    expect(screen.queryByTestId('room-notice-session-link')).not.toBeInTheDocument();
    // An ordinary room open must not buy a bindings read (`useRoomSessions`).
    expect(transport.listRoomSessions).not.toHaveBeenCalled();
  });
});
