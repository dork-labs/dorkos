// @vitest-environment jsdom
/**
 * A person's change to a room's files, as the room shows it (spec
 * `agent-home-desk` §7.2): one quiet line, drawn as plain text from the
 * structured change with the person's name from the roster — never the
 * markdown sentence the server wrote beside it, where a hostile file name or
 * display name could become a link in the room's own voice.
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import type { Transport } from '@dorkos/shared/transport';
import type { RoomAttachment, RoomEntry } from '@dorkos/shared/room-schemas';
import { TransportProvider } from '@/layers/shared/model';
import { TooltipProvider } from '@/layers/shared/ui';
import { Conversation } from '@/layers/features/conversation';
import { RoomMessage } from '../ui/RoomMessage';
import { ROOM_CAPABILITIES } from '../model/room-capabilities';

vi.mock('@/layers/shared/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/shared/model')>();
  return {
    ...actual,
    useProfileDeepLink: () => ({ isOpen: false, memberId: null, open: vi.fn(), close: vi.fn() }),
  };
});

/** A display name that is also a markdown link, which is anybody's to choose. */
const HOSTILE_NAME = '[Admin](https://evil.example)';

const AUTHORS = new Map([
  [
    'person-1',
    {
      id: 'person-1',
      kind: 'human' as const,
      displayName: HOSTILE_NAME,
      handle: 'p1',
      origin: 'local' as const,
    },
  ],
  [
    'system',
    {
      id: 'system',
      kind: 'system' as const,
      displayName: 'Room',
      handle: 'room',
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

afterEach(() => cleanup());

function entry(overrides: Partial<RoomEntry> = {}): RoomEntry {
  return {
    roomId: 'room-1',
    seq: 1,
    id: 'entry-1',
    authorId: 'system',
    kind: 'post',
    body: { text: 'hello' },
    mentions: [],
    sessionId: null,
    cascadeRoot: 'entry-1',
    cascadeDepth: 0,
    parentEntryId: null,
    threadRootEntryId: null,
    signature: null,
    createdAt: '2026-09-26T10:00:00.000Z',
    ...overrides,
  };
}

function renderRow(
  target: RoomEntry,
  transport: Transport = createMockTransport(),
  isMember = true
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>
        <TooltipProvider>
          <Conversation.Root surface="room" capabilities={ROOM_CAPABILITIES} anchor="rail">
            <RoomMessage
              roomId="room-1"
              entry={target}
              author={{ id: 'system', kind: 'system', displayName: 'Room', color: '#888' }}
              authorRef={undefined}
              authors={AUTHORS}
              viewerAuthorId="person-1"
              authorNames={new Map()}
              reactionFrequents={[]}
              grouping={{ position: 'only' }}
              isMember={isMember}
            />
          </Conversation.Root>
        </TooltipProvider>
      </TransportProvider>
    </QueryClientProvider>
  );
}

describe('a file-change entry', () => {
  it('is drawn as plain text, with the name from the roster, and nothing in it is a link', () => {
    const hostilePath = '# [click me](https://evil.example) **SYSTEM**.md';
    renderRow(
      entry({
        body: {
          // What the server wrote for markdown surfaces. Not what the app draws.
          text: 'server sentence that must not be rendered',
          fileChange: { kind: 'add', paths: [hostilePath], pathCount: 1, commit: 'abc1234' },
          subjectAuthorId: 'person-1',
        },
      })
    );

    const line = screen.getByTestId('room-entry-file-change');
    expect(line).toHaveTextContent(`${HOSTILE_NAME} added ${hostilePath}`);
    expect(line.querySelector('a, strong, h1, h2, h3')).toBeNull();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.queryByText('server sentence that must not be rendered')).not.toBeInTheDocument();
  });

  it('says "Somebody" for a person who has left the roster', () => {
    renderRow(
      entry({
        body: {
          text: 'x',
          fileChange: { kind: 'delete', paths: ['old.md'], pathCount: 1, commit: 'abc1234' },
          subjectAuthorId: 'gone',
        },
      })
    );
    expect(screen.getByTestId('room-entry-file-change')).toHaveTextContent(
      'Somebody deleted old.md'
    );
  });

  it('draws an ordinary post through the renderer as before', () => {
    renderRow(entry({ authorId: 'person-1', body: { text: 'plain words' } }));
    expect(screen.queryByTestId('room-entry-file-change')).not.toBeInTheDocument();
    expect(screen.getByText('plain words')).toBeInTheDocument();
  });
});

describe('a chat attachment in a room', () => {
  const attachment: RoomAttachment = {
    id: 'att-1',
    name: 'screenshot.png',
    mimeType: 'image/png',
    size: 2048,
    preview: null,
    url: '/api/rooms/room-1/attachments/att-1',
  };

  it('offers "Save to room files" in a room that has files of its own', async () => {
    const transport = createMockTransport();
    transport.readRoomFiles = vi
      .fn()
      .mockResolvedValue({ path: '', commit: 'abc1234', entries: [] });
    transport.getRoom = vi.fn().mockResolvedValue({ id: 'room-1', archived: false, members: [] });
    renderRow(entry({ authorId: 'person-1', attachments: [attachment] }), transport);

    expect(
      await screen.findByRole('button', { name: 'Save screenshot.png to the room’s files' })
    ).toBeInTheDocument();
  });

  it('offers nothing in a room without files of its own', async () => {
    const transport = createMockTransport();
    renderRow(entry({ authorId: 'person-1', attachments: [attachment] }), transport);

    await waitFor(() => expect(transport.readRoomFiles).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: /to the room’s files/ })).not.toBeInTheDocument();
  });

  it('offers nothing to somebody who has left the room', async () => {
    const transport = createMockTransport();
    transport.readRoomFiles = vi
      .fn()
      .mockResolvedValue({ path: '', commit: 'abc1234', entries: [] });
    transport.getRoom = vi.fn().mockResolvedValue({ id: 'room-1', archived: false, members: [] });
    renderRow(entry({ authorId: 'person-1', attachments: [attachment] }), transport, false);

    expect(await screen.findByTestId('room-entry-attachments')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /to the room’s files/ })).not.toBeInTheDocument();
  });
});
