// @vitest-environment jsdom
/**
 * One rule, asked of both surfaces: a conversation's words go through its
 * `ConversationTarget`, and through nothing else.
 *
 * This is the contract P4 declared and only a room kept. A session's composer
 * had its own `handleSubmit` prop and its own queue seam, so the port's two
 * methods were real, tested and unreachable — a shape where "the composer sends
 * through the target" was true of one surface and false of the other, with
 * nothing in the suite able to tell (Known Issue 28, closed by DOR-1354).
 *
 * So it is asked here, of both, from the keyboard: type, press Enter, and see
 * which function the words arrive at. The target is a spy rather than either
 * surface's real one — what is under test is the CALL, not what a session or a
 * room does afterwards, and both of those have their own suites.
 *
 * Lives beside the two benches rather than inside either widget: no widget may
 * import another, and this case is about the pair.
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { createRef, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import { REACTION_FREQUENTS_DEFAULT, type RoomWithRoster } from '@dorkos/shared/room-schemas';

// The plain textarea, pinned. `ui.composer.richText` defaults on since
// 2026-08-12, and `user`/`fireEvent` typing puts no text into a
// `contenteditable` under jsdom — so without this every case below would press
// Enter on an empty draft and pass for a reason unrelated to the port.
vi.mock('@/layers/entities/config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/entities/config')>()),
  useComposerRichText: () => false,
}));

// The status line under a session's box reaches for the fleet; it is not the
// subject and it is already covered where it lives.
vi.mock('@/layers/features/chat/ui/status/ChatStatusSection', () => ({
  ChatStatusSection: () => <div data-testid="chat-status" />,
}));

// Two read-hooks that want a router this mount has no reason to stand up. The
// STORES stay real: the draft the field reports and the queue the composer
// reads both live in them, and faking those would decide the answer.
vi.mock('@/layers/entities/session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/entities/session')>()),
  useDirectoryState: () => [null, vi.fn()],
  useSessionRuntime: () => 'claude-code',
}));

import { createQueryClientConfig } from '@/layers/shared/lib';
import { TransportProvider } from '@/layers/shared/model';
import { useRoomDraftStore } from '@/layers/entities/room';
import { useInteractionStore } from '@/layers/entities/interactions';
import { useSessionChatStore, useSessionStreamStore } from '@/layers/entities/session';
import { Conversation } from '@/layers/features/conversation';
import type { ConversationTarget } from '@/layers/features/conversation';
import { SESSION_CAPABILITIES, SessionComposer } from '@/layers/widgets/session';
import { ChannelComposer, ROOM_CAPABILITIES, useRoomTarget } from '@/layers/widgets/room-view';

/** A desktop: a real pointer, so Enter sends rather than inserting a newline. */
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
  useRoomDraftStore.setState({ drafts: {} });
  useSessionChatStore.setState({ sessions: {} });
  useSessionStreamStore.setState({ sessions: {}, sessionAccessOrder: [] });
  useInteractionStore.getState().reset();
});

/** The room every case writes into: live, unarchived, viewer on the roster. */
const ROOM: RoomWithRoster = {
  id: 'room-1',
  kind: 'channel',
  slug: 'general',
  title: '#general',
  topic: null,
  workspaceId: null,
  archived: false,
  ambientMaxEntries: 30,
  createdAt: '2026-07-26T09:00:00.000Z',
  lastActivityAt: '2026-07-26T10:00:00.000Z',
  members: [
    {
      roomId: 'room-1',
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

/** A spy target: every method a surface could reach, and nothing behind them. */
function spyTarget(overrides: Partial<ConversationTarget> = {}) {
  const send = vi.fn(async () => {});
  const queue = vi.fn(async () => {});
  const target: ConversationTarget = {
    kind: 'session',
    id: 'session-1',
    placeholder: 'Message DorkBot…',
    canSend: true,
    send,
    queue,
    attachments: null,
    ...overrides,
  };
  return { target, send, queue };
}

/** The session composer's fixed props — none of them a send path. */
function sessionProps(status: 'idle' | 'streaming') {
  return {
    chatInputRef: createRef<null>(),
    input: '',
    autocomplete: {
      commands: { show: false, filtered: [], selectedIndex: -1 },
      files: { show: false, filtered: [], selectedIndex: -1 },
      handleInputChange: (next: string) =>
        useSessionChatStore.getState().updateSession('session-1', { input: next }),
      handleCommandSelect: vi.fn(),
      handleFileSelect: vi.fn(),
      handleArrowUp: vi.fn(),
      handleArrowDown: vi.fn(),
      handleKeyboardSelect: vi.fn(),
      handleCursorChange: vi.fn(),
      dismissPalettes: vi.fn(),
      isPaletteOpen: false,
      paletteHasResults: false,
      activeDescendantId: undefined,
      paletteListboxId: undefined,
    } as never,
    steerContent: vi.fn(async () => true),
    addContextContent: vi.fn(async () => true),
    tryNativeCommand: vi.fn(() => ({ handled: false }) as const),
    commandPending: false,
    status,
    stop: vi.fn(async () => ({ ok: true, cancelled: [] })),
    setInput: vi.fn(),
    sessionId: 'session-1',
    sessionStatus: null,
    waiting: [],
    interaction: {
      active: null,
      pendingApprovals: [],
      focusedOptionIndex: 0,
      onToolRef: vi.fn(),
      onToolDecided: vi.fn(),
    },
    sync: { connectionState: 'connected' as const },
  };
}

/**
 * A session's composer over a given target, driven by a controlled draft.
 *
 * The draft is held in the session chat store, which is where the real host
 * holds it, so what Enter sends is what the field last reported.
 */
function SessionHost({
  target,
  status,
}: {
  target: ConversationTarget;
  status: 'idle' | 'streaming';
}) {
  const input = useSessionChatStore((s) => s.sessions['session-1']?.input ?? '');
  return (
    <Conversation.Root surface="session" capabilities={SESSION_CAPABILITIES} target={target}>
      <SessionComposer {...sessionProps(status)} input={input} />
    </Conversation.Root>
  );
}

/**
 * A channel's composer over a given target.
 *
 * The staged files still come from the room's own hook — the chip bar is not
 * what is under test, and `ChannelComposer` requires one — while the TARGET is
 * the spy, which is the whole point.
 */
function RoomHost({ target }: { target: ConversationTarget }) {
  const { attachments } = useRoomTarget({ room: ROOM });
  return (
    <Conversation.Root
      surface="room"
      capabilities={ROOM_CAPABILITIES}
      target={target}
      anchor="rail"
    >
      <ChannelComposer room={ROOM} attachments={attachments} />
    </Conversation.Root>
  );
}

/** Mount a host with the app's real cache configuration and a mock transport. */
function mount(ui: ReactNode) {
  const config = createQueryClientConfig();
  const queryClient = new QueryClient({
    ...config,
    defaultOptions: {
      ...config.defaultOptions,
      queries: { ...config.defaultOptions?.queries, retry: false, gcTime: 0 },
      mutations: { ...config.defaultOptions?.mutations, retry: false },
    },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={createMockTransport()}>{ui}</TransportProvider>
    </QueryClientProvider>
  );
}

/** Type into the composer the way a person does — one controlled change. */
function type(text: string) {
  fireEvent.change(screen.getByRole('combobox'), { target: { value: text } });
}

/** The two surfaces that have a composer, each drawn over whatever target it is handed. */
const SURFACES: [string, (target: ConversationTarget) => ReactNode][] = [
  ['a session', (target) => <SessionHost target={target} status="idle" />],
  ['a channel', (target) => <RoomHost target={target} />],
];

describe('every surface sends through its ConversationTarget', () => {
  // **Seeded defect for both rows:** give either composer a send path that does
  // not end in `target.send` — a `handleSubmit` prop, a direct mutation — and
  // that row goes red while the other stays green, which is exactly the state
  // the port was in before DOR-1354.
  it.each(SURFACES)('Enter in %s carries the draft to target.send', async (_label, host) => {
    const { target, send } = spyTarget();
    mount(host(target));

    type('ship it');
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' });

    await waitFor(() => expect(send).toHaveBeenCalledExactlyOnceWith({ text: 'ship it' }));
  });

  it.each(SURFACES)('Shift+Enter in %s never reaches the target', (_label, host) => {
    // The newline case, asked of both for the same reason: a send path that
    // fires on any Enter at all would pass the case above and destroy a
    // multi-line message.
    const { target, send } = spyTarget();
    mount(host(target));

    type('first line');
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter', shiftKey: true });

    expect(send).not.toHaveBeenCalled();
  });

  it('Enter mid-turn carries a session’s draft to target.queue, never to send', async () => {
    // The half a room has no answer for: a session holds the words behind the
    // running turn, and it holds them through the port's `queue`.
    const { target, send, queue } = spyTarget();
    mount(<SessionHost target={target} status="streaming" />);

    type('and then the docs');
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' });

    await waitFor(() =>
      expect(queue).toHaveBeenCalledExactlyOnceWith({ text: 'and then the docs' })
    );
    expect(send).not.toHaveBeenCalled();
  });
});
