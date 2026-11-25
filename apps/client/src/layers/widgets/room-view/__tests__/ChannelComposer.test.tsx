// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils/mock-factories';
import type { Transport } from '@dorkos/shared/transport';
import { REACTION_FREQUENTS_DEFAULT } from '@dorkos/shared/room-schemas';
import type {
  PostToRoomResponse,
  RoomAttachment,
  RoomWithRoster,
} from '@dorkos/shared/room-schemas';
import { useInteractionStore } from '@/layers/entities/interactions';
import { usePendingPostStore, useRoomDraftStore } from '@/layers/entities/room';
import { createQueryClientConfig } from '@/layers/shared/lib';
import { TransportProvider } from '@/layers/shared/model';
import { ChannelComposerBench } from '@/test-helpers/channel-composer';

const { toastError, toastSuccess } = vi.hoisted(() => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));
vi.mock('sonner', () => ({ toast: { error: toastError, success: toastSuccess } }));

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
  toastError.mockClear();
  toastSuccess.mockClear();
  // Drafts outlive components on purpose, which means they also outlive tests.
  useRoomDraftStore.setState({ drafts: {} });
  // Pending rows outlive their composer for the same reason drafts do — a
  // refusal has to find something still standing — so they outlive tests too.
  usePendingPostStore.setState({ posts: [] });
  useInteractionStore.getState().reset();
});

function roomWith(overrides: Partial<RoomWithRoster> = {}): RoomWithRoster {
  return {
    id: 'room-1',
    kind: 'channel',
    slug: 'general',
    title: '#general',
    topic: null,
    archived: false,
    ambientMaxEntries: 30,
    createdAt: '2026-07-26T09:00:00.000Z',
    lastActivityAt: '2026-07-26T10:00:00.000Z',
    // The viewer themselves, on the roster — the ordinary case every test in this file but the
    // "you left" block below is about.
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
    ...overrides,
  };
}

/** Mount the composer with the app's real cache configuration, retries off. */
function mountComposer(
  transport: Transport,
  room: RoomWithRoster = roomWith(),
  props: { offerJumpBackIn?: boolean; threadRootId?: string } = {}
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
  return render(<ChannelComposerBench room={room} {...props} />, { wrapper });
}

function renderComposer(
  transport: Transport,
  room: RoomWithRoster = roomWith(),
  props: { offerJumpBackIn?: boolean; threadRootId?: string } = {}
) {
  mountComposer(transport, room, props);
  // The shared composer names its textarea a combobox — it hosts the slash and
  // mention palettes in session chat, and the role does not vary by host.
  return screen.getByRole('combobox') as HTMLTextAreaElement;
}

/** The composer's outermost element — its card. */
function composerCard(): HTMLElement {
  return document.body.firstElementChild!.firstElementChild as HTMLElement;
}

/** A post that is still in the air — the state every mid-flight test asserts in. */
function neverSettles(): Promise<PostToRoomResponse> {
  return new Promise<PostToRoomResponse>(() => {});
}

/** Type into the composer the way a person does — one controlled change. */
function type(field: HTMLTextAreaElement, text: string) {
  fireEvent.change(field, { target: { value: text } });
}

describe('ChannelComposer — the post records the interaction (DOR-1156)', () => {
  it('records the room on Enter, and nothing before it', async () => {
    const transport = createMockTransport();
    const field = renderComposer(transport);

    type(field, 'ship it');
    // Typing is not writing-to. The record has to be the SEND, or a person who
    // opens a box and walks away has told Today they were in the room.
    expect(Object.keys(useInteractionStore.getState().opened)).toEqual([]);

    fireEvent.keyDown(field, { key: 'Enter' });

    await waitFor(() => expect(transport.postToRoom).toHaveBeenCalledTimes(1));
    expect(Object.keys(useInteractionStore.getState().opened)).toEqual(['room:room-1']);
  });
});

describe('ChannelComposer', () => {
  it('posts the typed message on Enter', async () => {
    const transport = createMockTransport();
    const field = renderComposer(transport);

    type(field, 'ship it');
    fireEvent.keyDown(field, { key: 'Enter' });

    await waitFor(() => expect(transport.postToRoom).toHaveBeenCalledTimes(1));
    expect(transport.postToRoom).toHaveBeenCalledWith('room-1', { text: 'ship it' });
  });

  it('keeps a sentence typed while the last one is still in flight', async () => {
    const transport = createMockTransport({ postToRoom: vi.fn(() => neverSettles()) });
    const field = renderComposer(transport);

    type(field, 'first');
    fireEvent.keyDown(field, { key: 'Enter' });
    type(field, 'second');

    // Nothing clears this: the field was emptied for the FIRST message before
    // the request left, so no late success callback can come back and wipe it.
    await waitFor(() => expect(transport.postToRoom).toHaveBeenCalledTimes(1));
    expect(field.value).toBe('second');
  });

  it('keeps every word when the post fails, and says why exactly once', async () => {
    const transport = createMockTransport({
      postToRoom: vi.fn().mockRejectedValue(new Error('This room is archived')),
    });
    const field = renderComposer(transport);

    type(field, 'the message I do not want to retype');
    fireEvent.keyDown(field, { key: 'Enter' });

    // A refusal may have landed, so its words stay in the failed row, which asks the person to
    // check first.
    await waitFor(() => {
      const held = usePendingPostStore.getState().posts;
      expect(held).toHaveLength(1);
      expect(held[0]).toMatchObject({
        text: 'the message I do not want to retype',
        status: 'failed',
      });
    });
    expect(field.value).toBe('');
    // One toast, naming the action and carrying the server's own reason.
    expect(toastError).toHaveBeenCalledTimes(1);
    // It offers Retry rather than only Report (DOR-3481).
    expect(toastError).toHaveBeenCalledWith(
      'Couldn’t send your message',
      expect.objectContaining({
        description: 'This room is archived',
        action: expect.objectContaining({ label: 'Retry' }),
      })
    );
  });

  it('leaves a follow-up being typed completely alone when the first is refused', async () => {
    let refuse: (err: Error) => void = () => {};
    const transport = createMockTransport({
      postToRoom: vi.fn(
        () =>
          new Promise<PostToRoomResponse>((_resolve, reject) => {
            refuse = reject;
          })
      ),
    });
    const field = renderComposer(transport);

    type(field, 'the refused one');
    fireEvent.keyDown(field, { key: 'Enter' });
    // Wait for the request to actually leave: `mutate` runs its mutationFn in a microtask, so
    // `refuse` is still the placeholder until this resolves and rejecting early would reject
    // nothing at all.
    await waitFor(() => expect(transport.postToRoom).toHaveBeenCalledTimes(1));

    type(field, 'the one typed while waiting');
    refuse(new Error('offline'));

    // Both sentences survive, in one place each.
    await waitFor(() =>
      expect(usePendingPostStore.getState().posts[0]).toMatchObject({
        text: 'the refused one',
        status: 'failed',
      })
    );
    expect(field.value).toBe('the one typed while waiting');
  });

  it('refuses to post into an archived room, and says so on screen', async () => {
    const transport = createMockTransport();
    const field = renderComposer(transport, roomWith({ archived: true }));

    expect(
      screen.getByText('This room is archived. You can read it, but not add to it.')
    ).toBeInTheDocument();

    type(field, 'anyone still here?');
    fireEvent.keyDown(field, { key: 'Enter' });

    await waitFor(() => expect(transport.postToRoom).toHaveBeenCalledTimes(0));
  });

  it('sends one message for two Enters that land before React re-renders', async () => {
    const transport = createMockTransport({ postToRoom: vi.fn(() => neverSettles()) });
    const field = renderComposer(transport);

    type(field, 'ship it');
    // Both keydowns inside ONE act scope, which is the race this guards: React batches, so no
    // render happens between them and both handlers close over the same pre-send text.
    await act(async () => {
      field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });

    expect(transport.postToRoom).toHaveBeenCalledTimes(1);
    expect(transport.postToRoom).toHaveBeenCalledWith('room-1', { text: 'ship it' });
  });

  it('retires the failed row when its words are sent again from the box', async () => {
    const transport = createMockTransport({
      postToRoom: vi
        .fn()
        .mockRejectedValueOnce(
          Object.assign(new TypeError('Failed to fetch'), { noResponse: true })
        )
        .mockReturnValue(neverSettles()),
    });
    const field = renderComposer(transport);

    type(field, 'try me again');
    fireEvent.keyDown(field, { key: 'Enter' });
    await waitFor(() => expect(field.value).toBe('try me again'));

    // Sending the words back from the box IS the retry: one row, not two.
    fireEvent.keyDown(field, { key: 'Enter' });

    await waitFor(() => expect(transport.postToRoom).toHaveBeenCalledTimes(2));
    const held = usePendingPostStore.getState().posts;
    expect(held).toHaveLength(1);
    expect(held[0]).toMatchObject({ text: 'try me again', status: 'sending' });
  });
});

describe('ChannelComposer — a room you are not in (DOR-1233)', () => {
  // A room the operator sees but is not a member of is real and reachable — she left it, or an
  // agent opened it without her (DOR-1611) — and posting into one was a DEFINITE server refusal
  // (`MEMBER_NOT_FOUND`) with no gate on it client-side at all, before this.
  function leftRoom(overrides: Partial<RoomWithRoster> = {}): RoomWithRoster {
    return roomWith({ members: [], ...overrides });
  }

  it('offers no composer at all — not even a disabled one', () => {
    mountComposer(createMockTransport(), leftRoom());

    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Attach file' })).not.toBeInTheDocument();
  });

  it('offers Join, which reaches the SAME wire route "Add agents" uses — named by the viewer', async () => {
    const transport = createMockTransport({
      addRoomMember: vi.fn().mockResolvedValue({
        roomId: 'room-1',
        authorId: 'author-you',
        responseMode: 'silent',
        joinedAt: '2026-07-26T09:00:00.000Z',
        joinedSeq: 0,
        lastReadSeq: 0,
        author: { id: 'author-you', kind: 'human', displayName: 'You', handle: null },
        origin: 'local',
      }),
    });
    mountComposer(transport, leftRoom());

    fireEvent.click(screen.getByRole('button', { name: 'Join' }));

    await waitFor(() =>
      expect(transport.addRoomMember).toHaveBeenCalledWith('room-1', { authorId: 'author-you' })
    );
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith('You joined #general'));
  });
});

describe('ChannelComposer — clearing a draft you can see coming', () => {
  it('shows the armed readout on the first Escape over a draft', async () => {
    // The double-Escape wipe has always worked here; what was missing is the half that makes it a
    // shortcut rather than a trap.
    const field = renderComposer(createMockTransport());
    type(field, 'half a thought');

    expect(screen.queryByTestId('clear-armed-hint')).not.toBeInTheDocument();
    fireEvent.keyDown(field, { key: 'Escape' });

    expect(await screen.findByTestId('clear-armed-hint')).toHaveTextContent(
      'Press Esc again to clear'
    );
  });
});

describe('ChannelComposer — attaching a file', () => {
  /** One stored attachment, as the room's upload route answers it. */
  function attachment(id: string, name: string): RoomAttachment {
    return {
      id,
      name,
      mimeType: 'text/plain',
      size: 4,
      preview: null,
      url: `/api/rooms/room-1/attachments/${id}`,
    };
  }

  /**
   * The two file inputs the card mounts, in document order: the dropzone's own
   * (which is what a drop or a paste goes through) and the paperclip's.
   */
  function fileInputs(): HTMLInputElement[] {
    return Array.from(composerCard().querySelectorAll('input[type="file"]'));
  }

  /** Choose files through one of them, the way the browser reports a pick. */
  function choose(input: HTMLInputElement, files: File[]) {
    fireEvent.change(input, { target: { files } });
  }

  const NOTES = new File(['abcd'], 'notes.txt', { type: 'text/plain' });
  const LOG = new File(['abcd'], 'server.log', { type: 'text/plain' });

  it('uploads the files, sends their ids with the message, and empties the bar', async () => {
    const transport = createMockTransport();
    vi.mocked(transport.uploadRoomAttachments).mockResolvedValue([
      attachment('att-1', 'notes.txt'),
      attachment('att-2', 'server.log'),
    ]);
    const field = renderComposer(transport);

    choose(fileInputs()[1]!, [NOTES, LOG]);
    await waitFor(() => expect(screen.getByText('server.log')).toBeInTheDocument());

    type(field, 'here they are');
    fireEvent.keyDown(field, { key: 'Enter' });

    await waitFor(() => expect(transport.postToRoom).toHaveBeenCalledTimes(1));
    expect(transport.postToRoom).toHaveBeenCalledWith('room-1', {
      text: 'here they are',
      attachmentIds: ['att-1', 'att-2'],
    });
    // The chips go once the ids are safely in the message, never before.
    await waitFor(() => expect(screen.queryByText('notes.txt')).toBeNull());
  });

  it('refuses a second Enter while the files are still going up', async () => {
    // The window: `pendingFiles` is cleared only once the ids are in a message, so a second Enter
    // during the upload would read the SAME files and send them again — a duplicate post, or a
    // 409 for ids the first send owns.
    const transport = createMockTransport();
    let release!: (value: RoomAttachment[]) => void;
    vi.mocked(transport.uploadRoomAttachments).mockReturnValue(
      new Promise<RoomAttachment[]>((resolve) => {
        release = resolve;
      })
    );
    const field = renderComposer(transport);

    choose(fileInputs()[1]!, [NOTES]);
    await waitFor(() => expect(screen.getByText('notes.txt')).toBeInTheDocument());

    type(field, 'first');
    fireEvent.keyDown(field, { key: 'Enter' });
    // The upload is now in flight and has not answered.
    await waitFor(() => expect(transport.uploadRoomAttachments).toHaveBeenCalledTimes(1));

    // A second sentence, sent before the first one's files have landed.
    type(field, 'second');
    fireEvent.keyDown(field, { key: 'Enter' });

    // Refused, and refused WITHOUT eating the words: no second upload, and the
    // sentence is still in the box for the person to send a moment later.
    expect(transport.uploadRoomAttachments).toHaveBeenCalledTimes(1);
    expect(field.value).toBe('second');

    release([attachment('att-1', 'notes.txt')]);
    await waitFor(() => expect(transport.postToRoom).toHaveBeenCalledTimes(1));
    expect(transport.postToRoom).toHaveBeenCalledWith('room-1', {
      text: 'first',
      attachmentIds: ['att-1'],
    });
  });

  it('gives the refused words back even when something has been typed since', async () => {
    // **Seeded defect:** put the draft back only into an EMPTY box — the old
    // rule — and a person who kept typing while the upload failed loses the
    // first sentence outright, with nothing on screen to say so. Run and red.
    const transport = createMockTransport();
    let refuse!: (error: Error) => void;
    vi.mocked(transport.uploadRoomAttachments).mockReturnValue(
      new Promise<RoomAttachment[]>((_resolve, reject) => {
        refuse = reject;
      })
    );
    const field = renderComposer(transport);

    choose(fileInputs()[1]!, [NOTES]);
    await waitFor(() => expect(screen.getByText('notes.txt')).toBeInTheDocument());

    type(field, 'here it is');
    fireEvent.keyDown(field, { key: 'Enter' });
    await waitFor(() => expect(transport.uploadRoomAttachments).toHaveBeenCalledTimes(1));

    type(field, 'and one more thing');
    refuse(new Error('Upload failed'));

    // Both sentences are in the box, in the order they were typed, and neither
    // was sent. Nothing went out, so nothing may quietly disappear either.
    await waitFor(() => expect(field.value).toBe('here it is\nand one more thing'));
    expect(transport.postToRoom).not.toHaveBeenCalled();
  });

  it('does not send while a file has failed, and says why', async () => {
    const transport = createMockTransport();
    vi.mocked(transport.uploadRoomAttachments).mockRejectedValue(new Error('Upload failed'));
    const field = renderComposer(transport);

    choose(fileInputs()[1]!, [NOTES]);
    await waitFor(() => expect(screen.getByText('notes.txt')).toBeInTheDocument());

    type(field, 'here it is');
    fireEvent.keyDown(field, { key: 'Enter' });

    await waitFor(() =>
      expect(
        screen.getByText('A file didn’t upload. Try it again or remove it, then send.')
      ).toBeInTheDocument()
    );
    // Nothing went out — not on that Enter, and not on a second one either.
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(transport.postToRoom).not.toHaveBeenCalled();
    // And the words came back, because no pending row was ever created to hold
    // them.
    await waitFor(() => expect(field.value).toBe('here it is'));
  });
});

describe('ChannelComposer — "Jump back in" is offered on one surface and read on one', () => {
  /** Every read the recents panel is built out of. */
  function recentsReads(transport: Transport) {
    return {
      recentSessions: vi.mocked(transport.listRecentSessions).mock.calls.length,
      rooms: vi.mocked(transport.listRooms).mock.calls.length,
      meshPaths: vi.mocked(transport.listMeshAgentPaths).mock.calls.length,
      resolveAgents: vi.mocked(transport.resolveAgents).mock.calls.length,
    };
  }

  it('reads them on the home surface, which is the one that offers the panel', async () => {
    const transport = createMockTransport();
    renderComposer(transport, roomWith(), { offerJumpBackIn: true });

    // The two that need nothing else to run. (`resolveAgents` waits on the
    // fleet, which this mock answers empty, and is not the claim here.)
    await waitFor(() => {
      const reads = recentsReads(transport);
      expect(reads.recentSessions).toBeGreaterThan(0);
      expect(reads.meshPaths).toBeGreaterThan(0);
    });
  });
});
