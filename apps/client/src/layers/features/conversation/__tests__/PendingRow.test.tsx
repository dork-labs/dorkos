// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import type { Transport } from '@dorkos/shared/transport';
import {
  PENDING_SLOW_MS,
  roomKeys,
  usePendingPostStore,
  type PendingPost,
  type RoomEntry,
} from '@/layers/entities/room';
import { TransportProvider } from '@/layers/shared/model';
import { PendingRow } from '../ui/rows/PendingRow';

const ROOM = 'room-1';
const VIEWER = 'author-you';

function post(overrides: Partial<PendingPost> = {}): PendingPost {
  return {
    clientId: 'c1',
    roomId: ROOM,
    threadRootId: null,
    text: 'is the build ok?',
    attachmentNames: [],
    attachmentIds: [],
    status: 'sending',
    entryId: null,
    // Freshly sent by default: a row only grows controls once it has been in
    // flight past `PENDING_SLOW_MS`, so a fixture pinned at 0 would make every
    // test in this file the slow case without saying so.
    at: Date.now(),
    ...overrides,
  };
}

/** One entry already in the room's history, as the retry check reads it. */
function landed(overrides: { authorId: string; text: string }): RoomEntry {
  return {
    roomId: ROOM,
    seq: 9,
    id: 'entry-landed',
    authorId: overrides.authorId,
    kind: 'post',
    body: { text: overrides.text },
    mentions: [],
    sessionId: null,
    cascadeRoot: 'entry-landed',
    cascadeDepth: 0,
    parentEntryId: null,
    threadRootEntryId: null,
    signature: null,
    createdAt: new Date().toISOString(),
  };
}

function renderRow(
  pending: PendingPost,
  transport: Transport = createMockTransport(),
  queryClient: QueryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
) {
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <TransportProvider transport={transport}>{children}</TransportProvider>
      </QueryClientProvider>
    );
  }
  render(<PendingRow post={pending} viewerAuthorId={VIEWER} />, { wrapper: Wrapper });
}

beforeEach(() => {
  usePendingPostStore.setState({ posts: [post()] });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('PendingRow', () => {
  it('keeps the words on screen while they are in the air', () => {
    renderRow(post());

    expect(screen.getByTestId('room-pending')).toHaveTextContent('is the build ok?');
    expect(screen.getByTestId('room-pending')).toHaveTextContent('Sending');
  });

  it('says a refused message is still here, and offers the two ways out', () => {
    renderRow(post({ status: 'failed' }));

    const row = screen.getByTestId('room-pending');
    expect(row).toHaveAttribute('data-status', 'failed');
    // The words above all — this is the only place they still exist.
    expect(row).toHaveTextContent('is the build ok?');
    expect(row).toHaveTextContent('Not sent');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Discard' })).toBeInTheDocument();
  });

  it('sends the same message again under the same id', async () => {
    const transport = createMockTransport();
    transport.postToRoom = vi
      .fn()
      .mockResolvedValue({ accepted: true, entryId: 'entry-a', seq: 9 });
    renderRow(post({ status: 'failed' }), transport);

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    await waitFor(() =>
      expect(transport.postToRoom).toHaveBeenCalledWith(ROOM, {
        text: 'is the build ok?',
      })
    );
    // Same client id, so the row already on screen moves back into flight
    // rather than a second copy of the sentence appearing under the first.
    await waitFor(() => {
      const held = usePendingPostStore.getState().posts;
      expect(held).toHaveLength(1);
      expect(held[0]).toMatchObject({ clientId: 'c1', status: 'sending', entryId: 'entry-a' });
    });
  });

  it('re-sends a thread reply into its own thread', async () => {
    const transport = createMockTransport();
    transport.replyInThread = vi
      .fn()
      .mockResolvedValue({ accepted: true, entryId: 'entry-a', seq: 9 });
    usePendingPostStore.setState({ posts: [post({ threadRootId: 'root-1', status: 'failed' })] });
    renderRow(post({ threadRootId: 'root-1', status: 'failed' }), transport);

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    // Not `postToRoom`: a reply that retried into the room would put a private
    // aside in front of everyone.
    await waitFor(() =>
      expect(transport.replyInThread).toHaveBeenCalledWith(ROOM, {
        rootEntryId: 'root-1',
        text: 'is the build ok?',
      })
    );
    expect(transport.postToRoom).not.toHaveBeenCalled();
  });

  it('offers no way out while a send is simply in flight', () => {
    // Nothing to decide yet, and a Discard under every message anybody sends is
    // clutter over a state that normally lasts a moment.
    renderRow(post());

    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.getByTestId('room-pending')).toHaveTextContent('Sending');
  });

  it('grows a way out once a send has been in flight too long', () => {
    // A row with no way to dismiss it is a row that can be stuck on screen for
    // the rest of the session — which is exactly what happened when an entry
    // reached the screen by a path that did not retire it.
    renderRow(post({ at: Date.now() - PENDING_SLOW_MS - 1 }));

    const row = screen.getByTestId('room-pending');
    expect(row).toHaveTextContent('Still sending');
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(usePendingPostStore.getState().posts).toHaveLength(0);
  });

  it('does not send twice when the message already landed', () => {
    // A request that times out AFTER the server committed it looks exactly like
    // one that never arrived. Retrying then posts the message twice and spends a
    // second agent turn on it. Until the send carries an idempotency key the
    // server dedupes on (DOR-786), looking first is the mitigation.
    const transport = createMockTransport();
    transport.postToRoom = vi.fn();
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    queryClient.setQueryData<RoomEntry[]>(roomKeys.entries(ROOM), [
      landed({ authorId: VIEWER, text: 'is the build ok?' }),
    ]);
    renderRow(post({ status: 'failed' }), transport, queryClient);

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    expect(transport.postToRoom).not.toHaveBeenCalled();
    // And the row goes, because the message it was holding is on screen above it.
    expect(usePendingPostStore.getState().posts).toHaveLength(0);
  });

  it('does send again when the same words above it are somebody else’s', async () => {
    // "ok" is the most repeated sentence in any room and half of them are not
    // yours. Matching on text alone would swallow your message.
    const transport = createMockTransport();
    transport.postToRoom = vi
      .fn()
      .mockResolvedValue({ accepted: true, entryId: 'entry-a', seq: 9 });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    queryClient.setQueryData<RoomEntry[]>(roomKeys.entries(ROOM), [
      landed({ authorId: 'someone-else', text: 'is the build ok?' }),
    ]);
    renderRow(post({ status: 'failed' }), transport, queryClient);

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    await waitFor(() =>
      expect(transport.postToRoom).toHaveBeenCalledWith(ROOM, { text: 'is the build ok?' })
    );
  });

  it('says out loud that a refusal might have gone through anyway', () => {
    // The copy is the mitigation's other half: "not sent" on its own is a claim
    // this client cannot make.
    renderRow(post({ status: 'failed' }));

    expect(screen.getByTestId('room-pending')).toHaveTextContent(
      'Not sent — or it went through and the confirmation got lost.'
    );
  });

  it('throws the words away only when somebody asks it to', () => {
    renderRow(post({ status: 'failed' }));

    expect(usePendingPostStore.getState().posts).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(usePendingPostStore.getState().posts).toHaveLength(0);
  });
});

describe('PendingRow — the files in the message', () => {
  it('names them, inert: no link and no thumbnail', () => {
    // There is no entry yet, so there is nothing to link to and nothing to draw
    // a thumbnail from. The chips exist to say the files are still here.
    renderRow(post({ attachmentNames: ['screenshot.png', 'server.log'] }));
    const row = screen.getByTestId('room-pending');

    expect(row).toHaveTextContent('screenshot.png');
    expect(row).toHaveTextContent('server.log');
    expect(row.querySelector('a[href]')).toBeNull();
    expect(row.querySelector('img')).toBeNull();
  });

  it('draws exactly what it drew before for a message with no files', () => {
    // The no-regression pin: attach is additive, and somebody who never touches
    // a file must see the row they had yesterday.
    renderRow(post({ attachmentNames: [] }));
    const row = screen.getByTestId('room-pending');

    expect(row).toHaveTextContent('is the build ok?');
    expect(row).toHaveTextContent('Sending');
    expect(row.querySelector('ul')).toBeNull();
  });

  it('re-sends the files with the words when a refused message is tried again', async () => {
    const transport = createMockTransport();
    transport.postToRoom = vi
      .fn()
      .mockResolvedValue({ accepted: true, entryId: 'entry-1', seq: 1 });
    const refused = post({
      status: 'failed',
      attachmentNames: ['screenshot.png'],
      attachmentIds: ['att-1'],
    });
    usePendingPostStore.setState({ posts: [refused] });
    renderRow(refused, transport);

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    // The same ids: nothing bound them, so the second attempt costs no bytes
    // and the message arrives whole rather than stripped of what it was about.
    await waitFor(() => expect(transport.postToRoom).toHaveBeenCalledTimes(1));
    expect(transport.postToRoom).toHaveBeenCalledWith(ROOM, {
      text: 'is the build ok?',
      attachmentIds: ['att-1'],
    });
    // And the row keeps showing them while it is back in the air.
    expect(usePendingPostStore.getState().posts[0]!.attachmentNames).toEqual(['screenshot.png']);
  });
});
