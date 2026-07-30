// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import type { Transport } from '@dorkos/shared/transport';
import type { PostToRoomResponse, RoomEntry, RoomWithRoster } from '@dorkos/shared/room-schemas';
import { useRoomDraftStore, useRoomReplyTargetStore } from '@/layers/entities/room';
import { createQueryClientConfig } from '@/layers/shared/lib';
import { TransportProvider } from '@/layers/shared/model';
import { RoomComposer } from '../ui/RoomComposer';

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));

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
  // Both stores outlive components on purpose, which means they also outlive
  // tests — a target left behind would aim the next test's first Enter.
  useRoomDraftStore.setState({ drafts: {} });
  useRoomReplyTargetStore.setState({ targets: {}, focusRequests: {} });
});

const ROOM_ID = 'room-1';
const ROOT_ID = 'entry-root';
/** A second thread in the same room, for the reader who moves on mid-flight. */
const OTHER_ROOT = 'entry-other-root';

function room(): RoomWithRoster {
  return {
    id: ROOM_ID,
    kind: 'channel',
    slug: 'general',
    title: '#general',
    topic: null,
    workspaceId: null,
    archived: false,
    createdAt: '2026-07-26T09:00:00.000Z',
    lastActivityAt: '2026-07-26T10:00:00.000Z',
    members: [
      {
        roomId: ROOM_ID,
        authorId: 'ana',
        author: { id: 'ana', kind: 'agent', displayName: 'Ana', mentionHandle: 'ana' },
        responseMode: 'mention-only',
        lastReadSeq: 0,
        joinedAt: '2026-07-26T09:00:00.000Z',
      },
    ],
    viewerAuthorId: 'author-you',
  };
}

function rootEntry(): RoomEntry {
  return {
    roomId: ROOM_ID,
    seq: 1,
    id: ROOT_ID,
    authorId: 'ana',
    kind: 'post',
    body: { text: 'why is the build slow?' },
    mentions: [],
    sessionId: null,
    cascadeRoot: ROOT_ID,
    cascadeDepth: 0,
    parentEntryId: null,
    threadRootEntryId: null,
    signature: null,
    createdAt: '2026-07-26T10:00:00.000Z',
  };
}

function renderComposer(transport: Transport) {
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
  render(<RoomComposer room={room()} />, { wrapper });
  return screen.getByRole('combobox') as HTMLTextAreaElement;
}

/** Type into the composer the way a person does — one controlled change. */
function type(field: HTMLTextAreaElement, text: string) {
  fireEvent.change(field, { target: { value: text } });
}

/** Aim this room's composer at the thread heading `ROOT_ID`. */
function aimAtThread() {
  useRoomReplyTargetStore.getState().replyTo(ROOM_ID, ROOT_ID);
}

describe('RoomComposer — which destination Enter uses', () => {
  it('addresses the room when nothing has aimed it at a thread', async () => {
    const transport = createMockTransport();
    const field = renderComposer(transport);

    type(field, 'ship it');
    fireEvent.keyDown(field, { key: 'Enter' });

    await waitFor(() => expect(transport.postToRoom).toHaveBeenCalledTimes(1));
    expect(transport.replyInThread).not.toHaveBeenCalled();
  });

  it('sends into the thread it is aimed at, through the thread route', async () => {
    const transport = createMockTransport();
    const field = renderComposer(transport);
    aimAtThread();

    type(field, 'the cache is cold');
    fireEvent.keyDown(field, { key: 'Enter' });

    await waitFor(() => expect(transport.replyInThread).toHaveBeenCalledTimes(1));
    expect(transport.replyInThread).toHaveBeenCalledWith(ROOM_ID, {
      rootEntryId: ROOT_ID,
      text: 'the cache is cold',
    });
    // Not both. A reply that also landed in the room's own flow would be the
    // same sentence said twice, to two different audiences.
    expect(transport.postToRoom).not.toHaveBeenCalled();
  });

  it('stays aimed at the thread after a reply lands', async () => {
    // An answer inside a thread is usually followed by another one. Re-aiming
    // between every sentence would make a thread the most expensive place in
    // the room to hold a conversation.
    const transport = createMockTransport();
    const field = renderComposer(transport);
    aimAtThread();

    type(field, 'first');
    fireEvent.keyDown(field, { key: 'Enter' });
    await waitFor(() => expect(transport.replyInThread).toHaveBeenCalledTimes(1));

    type(field, 'second');
    fireEvent.keyDown(field, { key: 'Enter' });

    await waitFor(() => expect(transport.replyInThread).toHaveBeenCalledTimes(2));
    expect(transport.postToRoom).not.toHaveBeenCalled();
  });

  it('leaves the aim and the caret alone when the reader has moved to another thread', async () => {
    // A refusal lands after the send, and the composer need not have stood still.
    // Only one aim can be held, so taking it back would point the reader's next
    // sentence at a thread they had already left — the same silent misdelivery
    // the restore exists to prevent, in the other direction.
    let refuse!: (error: Error) => void;
    const transport = createMockTransport({
      replyInThread: vi.fn(
        () =>
          new Promise<PostToRoomResponse>((_resolve, reject) => {
            refuse = reject;
          })
      ),
    });
    const field = renderComposer(transport);
    aimAtThread();

    type(field, 'the cache is cold');
    fireEvent.keyDown(field, { key: 'Enter' });
    await waitFor(() => expect(transport.replyInThread).toHaveBeenCalledTimes(1));

    // Mid-flight, they give up on that thread and answer a different one.
    useRoomReplyTargetStore.getState().replyTo(ROOM_ID, OTHER_ROOT);
    const caretRequests = useRoomReplyTargetStore.getState().focusRequests[ROOM_ID];

    refuse(new Error('This room is archived'));

    // The words still come back — that half never had a reason to be withheld.
    await waitFor(() =>
      expect(useRoomDraftStore.getState().drafts[ROOM_ID]).toContain('the cache is cold')
    );
    expect(useRoomReplyTargetStore.getState().targets[ROOM_ID]).toBe(OTHER_ROOT);
    // And the caret stays where they put it: no focus request was raised.
    expect(useRoomReplyTargetStore.getState().focusRequests[ROOM_ID]).toBe(caretRequests);
  });

  it('gives back the aim when the reader had aimed at nothing', async () => {
    // Stopping the reply and then being refused still means the recovered words
    // were written for that thread, and the banner says so.
    const transport = createMockTransport({
      replyInThread: vi.fn().mockRejectedValue(new Error('This room is archived')),
    });
    const field = renderComposer(transport);
    aimAtThread();

    type(field, 'the cache is cold');
    fireEvent.keyDown(field, { key: 'Enter' });
    useRoomReplyTargetStore.getState().clear(ROOM_ID);

    await waitFor(() => expect(useRoomReplyTargetStore.getState().targets[ROOM_ID]).toBe(ROOT_ID));
  });

  it('gives back the words AND the aim when a reply is refused', async () => {
    // Restoring only the text would put the next Enter in the ROOM, silently.
    const transport = createMockTransport({
      replyInThread: vi.fn().mockRejectedValue(new Error('This room is archived')),
    });
    const field = renderComposer(transport);
    aimAtThread();

    type(field, 'the cache is cold');
    fireEvent.keyDown(field, { key: 'Enter' });

    await waitFor(() =>
      expect(useRoomDraftStore.getState().drafts[ROOM_ID]).toBe('the cache is cold')
    );
    expect(useRoomReplyTargetStore.getState().targets[ROOM_ID]).toBe(ROOT_ID);
  });
});

describe('RoomComposer — saying where the next sentence is going', () => {
  it('says nothing while the composer addresses the room', () => {
    renderComposer(createMockTransport());

    expect(screen.queryByTestId('room-reply-banner')).not.toBeInTheDocument();
  });

  it('names the person whose thread is open', async () => {
    const transport = createMockTransport({
      listRoomEntries: vi.fn().mockResolvedValue([rootEntry()]),
    });
    renderComposer(transport);
    aimAtThread();

    await waitFor(() =>
      expect(screen.getByTestId('room-reply-banner')).toHaveTextContent('Replying to Ana')
    );
  });

  it('still says a thread is open when the entry heading it is out of view', async () => {
    // The head can be older than the page loaded. Which thread it is may be
    // unknown; THAT one is open must never be.
    const transport = createMockTransport({ listRoomEntries: vi.fn().mockResolvedValue([]) });
    renderComposer(transport);
    aimAtThread();

    await waitFor(() =>
      expect(screen.getByTestId('room-reply-banner')).toHaveTextContent('Replying in a thread')
    );
  });

  it('moves the placeholder with the aim', async () => {
    const field = renderComposer(createMockTransport());
    expect(field).toHaveAttribute('placeholder', 'Message #general…');

    aimAtThread();

    await waitFor(() => expect(field).toHaveAttribute('placeholder', 'Reply in this thread…'));
  });

  it('goes back to addressing the room when the banner is dismissed', async () => {
    const transport = createMockTransport();
    const field = renderComposer(transport);
    aimAtThread();

    const stop = await screen.findByRole('button', { name: 'Stop replying in this thread' });
    fireEvent.click(stop);

    await waitFor(() => expect(screen.queryByTestId('room-reply-banner')).not.toBeInTheDocument());

    type(field, 'ship it');
    fireEvent.keyDown(field, { key: 'Enter' });

    await waitFor(() => expect(transport.postToRoom).toHaveBeenCalledTimes(1));
    expect(transport.replyInThread).not.toHaveBeenCalled();
  });
});
