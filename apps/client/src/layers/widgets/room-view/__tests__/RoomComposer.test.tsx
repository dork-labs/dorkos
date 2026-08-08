// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import type { Transport } from '@dorkos/shared/transport';
import { REACTION_FREQUENTS_DEFAULT } from '@dorkos/shared/room-schemas';
import type {
  PostToRoomResponse,
  RoomAttachment,
  RoomWithRoster,
} from '@dorkos/shared/room-schemas';
import { usePendingPostStore, useRoomDraftStore } from '@/layers/entities/room';
import { createQueryClientConfig } from '@/layers/shared/lib';
import { TransportProvider } from '@/layers/shared/model';
import { RoomComposer } from '../ui/RoomComposer';

const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }));
vi.mock('sonner', () => ({ toast: { error: toastError } }));

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
  // Drafts outlive components on purpose, which means they also outlive tests.
  useRoomDraftStore.setState({ drafts: {} });
  // Pending rows outlive their composer for the same reason drafts do — a
  // refusal has to find something still standing — so they outlive tests too.
  usePendingPostStore.setState({ posts: [] });
});

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
    members: [],
    viewerAuthorId: 'author-you',
    reactionFrequents: [...REACTION_FREQUENTS_DEFAULT],
    ...overrides,
  };
}

function renderComposer(transport: Transport, room: RoomWithRoster = roomWith()) {
  // The app's real cache configuration, retries off. A bare `new QueryClient()`
  // has no MutationCache — and the MutationCache is where a failed post's toast
  // now comes from, so a re-declared config would leave these assertions with
  // nothing to assert against.
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
  render(<RoomComposer room={room} />, { wrapper });
  // The shared composer names its textarea a combobox — it hosts the slash and
  // mention palettes in session chat, and the role does not vary by host.
  return screen.getByRole('combobox') as HTMLTextAreaElement;
}

/**
 * The composer's outermost element — its card.
 *
 * Found by walking down from the mount rather than by querying a class, so the
 * chrome assertions below are not handed the very thing they are checking.
 * Testing Library renders into a bare `<div>` appended to `<body>`, and the
 * composer is that div's only child.
 */
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

describe('RoomComposer', () => {
  it('posts the typed message on Enter', async () => {
    const transport = createMockTransport();
    const field = renderComposer(transport);

    type(field, 'ship it');
    fireEvent.keyDown(field, { key: 'Enter' });

    await waitFor(() => expect(transport.postToRoom).toHaveBeenCalledTimes(1));
    expect(transport.postToRoom).toHaveBeenCalledWith('room-1', { text: 'ship it' });
  });

  it('empties the field on Enter, without waiting for the server', async () => {
    // A post that never settles: anything asserted after it is true of the
    // round trip's MIDDLE, which is where a follow-up sentence gets typed.
    const transport = createMockTransport({ postToRoom: vi.fn(() => neverSettles()) });
    const field = renderComposer(transport);

    type(field, 'ship it');
    fireEvent.keyDown(field, { key: 'Enter' });

    expect(field.value).toBe('');
    await waitFor(() => expect(transport.postToRoom).toHaveBeenCalledTimes(1));
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

  it('sends a different second message rather than swallowing it', async () => {
    const transport = createMockTransport({ postToRoom: vi.fn(() => neverSettles()) });
    const field = renderComposer(transport);

    type(field, 'first');
    fireEvent.keyDown(field, { key: 'Enter' });
    type(field, 'second');
    fireEvent.keyDown(field, { key: 'Enter' });

    await waitFor(() => expect(transport.postToRoom).toHaveBeenCalledTimes(2));
    expect(transport.postToRoom).toHaveBeenNthCalledWith(1, 'room-1', { text: 'first' });
    expect(transport.postToRoom).toHaveBeenNthCalledWith(2, 'room-1', { text: 'second' });
  });

  it('sends the trimmed text, not the whitespace around it', async () => {
    const transport = createMockTransport();
    const field = renderComposer(transport);

    type(field, '  ship it  ');
    fireEvent.keyDown(field, { key: 'Enter' });

    await waitFor(() => expect(transport.postToRoom).toHaveBeenCalledTimes(1));
    expect(transport.postToRoom).toHaveBeenCalledWith('room-1', { text: 'ship it' });
  });

  it('does not post on Shift+Enter — that is a new line', async () => {
    const transport = createMockTransport();
    const field = renderComposer(transport);

    type(field, 'first line');
    fireEvent.keyDown(field, { key: 'Enter', shiftKey: true });

    await waitFor(() => expect(field.value).toBe('first line'));
    expect(transport.postToRoom).toHaveBeenCalledTimes(0);
  });

  it('does nothing at all on an empty field', async () => {
    const transport = createMockTransport();
    const field = renderComposer(transport);

    fireEvent.keyDown(field, { key: 'Enter' });

    await waitFor(() => expect(transport.postToRoom).toHaveBeenCalledTimes(0));
  });

  it('does nothing at all on whitespace alone', async () => {
    const transport = createMockTransport();
    const field = renderComposer(transport);

    type(field, '   \n  ');
    fireEvent.keyDown(field, { key: 'Enter' });

    await waitFor(() => expect(transport.postToRoom).toHaveBeenCalledTimes(0));
  });

  it('keeps every word when the post fails, and says why exactly once', async () => {
    const transport = createMockTransport({
      postToRoom: vi.fn().mockRejectedValue(new Error('This room is archived')),
    });
    const field = renderComposer(transport);

    type(field, 'the message I do not want to retype');
    fireEvent.keyDown(field, { key: 'Enter' });

    // The words are held by the failed row now, not pushed back into the box.
    // The box is where the NEXT sentence goes, and a refusal arriving into it
    // merges two sentences that both have a claim on it — see `usePostToRoom`.
    await waitFor(() => {
      const held = usePendingPostStore.getState().posts;
      expect(held).toHaveLength(1);
      expect(held[0]).toMatchObject({
        text: 'the message I do not want to retype',
        status: 'failed',
      });
    });
    expect(field.value).toBe('');
    // One toast, naming the action and carrying the server's own reason. It
    // comes from the shared MutationCache rather than from this component,
    // because this component is not always still here when a refusal lands.
    expect(toastError).toHaveBeenCalledTimes(1);
    // `expect.anything()` covers the shared "Report" action that cache adds;
    // its content is query-client.test.ts's subject, not this file's.
    expect(toastError).toHaveBeenCalledWith(
      "Couldn't send your message — This room is archived",
      expect.anything()
    );
  });

  it('sends the same words twice when that is what was asked for', async () => {
    // "ok", "+1", "ping" — the messages people genuinely repeat. A latch that
    // recognised a duplicate by comparing bodies dropped the second one
    // silently whenever the first was still in flight.
    const transport = createMockTransport({ postToRoom: vi.fn(() => neverSettles()) });
    const field = renderComposer(transport);

    type(field, 'ok');
    fireEvent.keyDown(field, { key: 'Enter' });
    type(field, 'ok');
    fireEvent.keyDown(field, { key: 'Enter' });

    await waitFor(() => expect(transport.postToRoom).toHaveBeenCalledTimes(2));
    expect(transport.postToRoom).toHaveBeenNthCalledWith(1, 'room-1', { text: 'ok' });
    expect(transport.postToRoom).toHaveBeenNthCalledWith(2, 'room-1', { text: 'ok' });
    expect(field.value).toBe('');
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
    // Wait for the request to actually leave: `mutate` runs its mutationFn in a
    // microtask, so `refuse` is still the placeholder until this resolves and
    // rejecting early would reject nothing at all.
    await waitFor(() => expect(transport.postToRoom).toHaveBeenCalledTimes(1));

    type(field, 'the one typed while waiting');
    refuse(new Error('offline'));

    // Both sentences survive, in one place each. The old shape merged the
    // refused one into the box on top of the half-typed one — two sentences
    // with a claim on one field, and a reader who then pressed Enter sent both
    // at once as a single message.
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
      screen.getByText('This conversation is archived. You can read it, but not add to it.')
    ).toBeInTheDocument();

    type(field, 'anyone still here?');
    fireEvent.keyDown(field, { key: 'Enter' });

    await waitFor(() => expect(transport.postToRoom).toHaveBeenCalledTimes(0));
  });

  it('sends one message for two Enters that land before React re-renders', async () => {
    const transport = createMockTransport({ postToRoom: vi.fn(() => neverSettles()) });
    const field = renderComposer(transport);

    type(field, 'ship it');
    // Both keydowns inside ONE act scope, which is the race this guards: React
    // batches, so no render happens between them and both handlers close over
    // the same pre-send text. Only a live read of the draft store tells them
    // apart. Two separate `fireEvent` calls each flush a render, so the second
    // would find an empty field and prove nothing.
    await act(async () => {
      field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });

    expect(transport.postToRoom).toHaveBeenCalledTimes(1);
    expect(transport.postToRoom).toHaveBeenCalledWith('room-1', { text: 'ship it' });
  });
});

describe('RoomComposer — clearing a draft you can see coming', () => {
  it('shows the armed readout on the first Escape over a draft', async () => {
    // The double-Escape wipe has always worked here; what was missing is the
    // half that makes it a shortcut rather than a trap. A reader with a draft
    // in a thread pressed Escape expecting the panel to close, nothing on
    // screen said what had happened, and two taps later the draft was gone.
    const field = renderComposer(createMockTransport());
    type(field, 'half a thought');

    expect(screen.queryByTestId('clear-armed-hint')).not.toBeInTheDocument();
    fireEvent.keyDown(field, { key: 'Escape' });

    expect(await screen.findByTestId('clear-armed-hint')).toHaveTextContent(
      'Press Esc again to clear'
    );
  });

  it('offers the labelled button the readout is only defensible beside', () => {
    // The hint is hidden from assistive tech, so `Composer.Input` refuses to raise
    // it at all unless a labelled equivalent is reachable — otherwise it hands
    // sighted people a destructive shortcut and nobody else.
    const field = renderComposer(createMockTransport());
    type(field, 'half a thought');

    expect(screen.getByRole('button', { name: /clear/i })).toBeEnabled();
  });

  it('raises nothing over an empty box, so Escape still reaches the thread panel', () => {
    // The panel closes on an Escape nothing else claimed. Arming over an empty
    // composer would consume the key and leave a thread that cannot be closed
    // from its own box.
    const field = renderComposer(createMockTransport());

    fireEvent.keyDown(field, { key: 'Escape' });

    expect(screen.queryByTestId('clear-armed-hint')).not.toBeInTheDocument();
  });
});

describe('RoomComposer — the card it now sits in', () => {
  // The one deliberate visual change in the composer-parity spec, stated
  // positively rather than as a deleted assertion. The serialized before/after
  // proof lives in `RoomComposer-chrome-delta.test.tsx`; this block is the
  // same delta in words, beside the behavior it must not disturb.

  it('is the floating card chat sits in, not a strip ruled off by a border', () => {
    renderComposer(createMockTransport());
    const classes = composerCard().className.split(/\s+/);

    expect(classes).toEqual(
      expect.arrayContaining(['bg-surface', 'rounded-xl', 'border', 'p-2', 'm-2', 'relative'])
    );
    // The room's own chrome is deleted, not merged: `border-t` drew the rule
    // the card replaces, and `p-3` was the padding the lane used to inset for.
    expect(classes).not.toContain('border-t');
    expect(classes).not.toContain('p-3');
  });

  it('aligns its overlay lane to the card, now that the card supplies the inset', () => {
    renderComposer(createMockTransport());
    const lane = composerCard().querySelector('.bottom-full')!;

    expect(lane.className.split(/\s+/).sort()).toEqual([
      'absolute',
      'bottom-full',
      'left-0',
      'mb-2',
      'right-0',
    ]);
  });

  it('takes files: the paperclip, the drop target, and the input behind both', () => {
    // The positive counterpart of the assertion DOR-946 shipped, which pinned
    // every one of these as absent while attach was still reserved. Rooms now
    // pass `onFilesDropped`, and `Composer.Root` mounts the whole dropzone —
    // hidden input, drop target, and all — off that one prop.
    renderComposer(createMockTransport());
    const card = composerCard();

    expect(card.querySelector('input[type="file"]')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Attach file' })).toBeInTheDocument();
    expect(card.getAttribute('role')).toBe('presentation');
  });

  it('keeps the mention picker above the clear-armed hint in the lane', () => {
    // Both can be on screen at once: a bare Escape arms the clear, and typing
    // `@` inside the arming window opens the picker over a still-armed draft.
    // Source order is the lane's whole stacking rule, so the hint must stay
    // last — otherwise the pill lands across the picker a reader is choosing
    // from.
    const field = renderComposer(createMockTransport());

    type(field, 'hey');
    fireEvent.keyDown(field, { key: 'Escape' });
    type(field, 'hey @');
    fireEvent.select(field, { target: { selectionStart: 5 } });

    const lane = composerCard().querySelector('.bottom-full')!;
    const picker = screen.getByRole('listbox');
    const hint = screen.getByTestId('clear-armed-hint');

    expect(lane.contains(picker)).toBe(true);
    expect(lane.contains(hint)).toBe(true);
    expect(picker.compareDocumentPosition(hint) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe('RoomComposer — attaching a file', () => {
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

  it('takes files from the paperclip and from a drop, into the same bar', async () => {
    const transport = createMockTransport();
    renderComposer(transport);
    const [dropzone, paperclip] = fileInputs();

    choose(paperclip!, [NOTES]);
    await waitFor(() => expect(screen.getByText('notes.txt')).toBeInTheDocument());

    // The dropzone's input is what a drop and a paste both arrive through, so
    // the two affordances are proven to share one handler and one bar.
    choose(dropzone!, [LOG]);
    await waitFor(() => expect(screen.getByText('server.log')).toBeInTheDocument());
    expect(screen.getByText('notes.txt')).toBeInTheDocument();
  });

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

  it('puts the file names on the pending row, from the keystroke', async () => {
    // The words already survive the round trip in a pending row. Without this
    // the files vanish from the bar on Enter and do not reappear until the room
    // echoes the entry back.
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

    await waitFor(() => expect(usePendingPostStore.getState().posts).toHaveLength(1));
    const [held] = usePendingPostStore.getState().posts;
    expect(held!.attachmentNames).toEqual(['notes.txt', 'server.log']);
    // And the ids too, so trying again re-sends the whole message.
    expect(held!.attachmentIds).toEqual(['att-1', 'att-2']);
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
