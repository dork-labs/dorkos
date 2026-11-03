// @vitest-environment jsdom
/**
 * A to-do's card in a room (DOR-3088): drawn only from DorkOS's own post. The room's own voice is
 * on neither its roster nor its former authors, so a row with no author record is that voice, and
 * a `todo` on a member's entry draws its text and nothing more.
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import type { Transport } from '@dorkos/shared/transport';
import type { RoomEntry } from '@dorkos/shared/room-schemas';
import { TransportProvider } from '@/layers/shared/model';
import { TooltipProvider } from '@/layers/shared/ui';
import { Conversation } from '@/layers/features/conversation';
import { RoomMessage } from '../ui/RoomMessage';
import { ROOM_CAPABILITIES } from '../model/room-capabilities';

// Mounted with no router: the author face's profile link is stubbed, as in
// `RoomMessage.test.tsx`, which explains why.
vi.mock('@/layers/shared/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/shared/model')>();
  return {
    ...actual,
    useProfileDeepLink: () => ({ isOpen: false, memberId: null, open: vi.fn(), close: vi.fn() }),
  };
});

const ANA = {
  id: 'ana',
  kind: 'agent' as const,
  displayName: 'Ana',
  handle: 'ana',
  origin: 'local' as const,
};
const AUTHORS = new Map([['ana', ANA]]);

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

afterEach(cleanup);

function post(authorId: string): RoomEntry {
  return {
    roomId: 'dm-1',
    seq: 1,
    id: 'entry-1',
    authorId,
    kind: 'post',
    body: { text: 'New to-do', todo: { todoId: 'todo-1' } },
    mentions: [],
    sessionId: null,
    cascadeRoot: 'entry-1',
    cascadeDepth: 0,
    parentEntryId: null,
    threadRootEntryId: null,
    signature: null,
    createdAt: '2026-11-03T10:00:00.000Z',
  };
}

function renderRow(entry: RoomEntry, transport: Transport) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <RoomMessage
      roomId="dm-1"
      entry={entry}
      author={{ id: entry.authorId, kind: 'agent', displayName: 'DorkOS', color: '#888' }}
      authorRef={AUTHORS.get(entry.authorId)}
      authors={AUTHORS}
      viewerAuthorId="author-you"
      authorNames={new Map([['ana', 'Ana']])}
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

describe('RoomMessage — a to-do card', () => {
  it("draws the card from DorkOS's own post", async () => {
    const transport = createMockTransport();
    vi.mocked(transport.getTodo).mockRejectedValue(new Error('not found'));
    renderRow(post('system'), transport);

    expect(await screen.findByText('This to-do is unavailable.')).toBeInTheDocument();
    expect(transport.getTodo).toHaveBeenCalledWith('todo-1');
  });

  it("draws only the text of a member's post that carries a to-do", () => {
    const transport = createMockTransport();
    renderRow(post('ana'), transport);

    expect(screen.getByText('New to-do')).toBeInTheDocument();
    expect(transport.getTodo).not.toHaveBeenCalled();
  });
});
