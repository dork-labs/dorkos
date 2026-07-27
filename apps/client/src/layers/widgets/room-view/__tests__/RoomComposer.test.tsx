// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import type { Transport } from '@dorkos/shared/transport';
import type { PostToRoomResponse, RoomWithRoster } from '@dorkos/shared/room-schemas';
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
});

function roomWith(overrides: Partial<RoomWithRoster> = {}): RoomWithRoster {
  return {
    id: 'room-1',
    kind: 'channel',
    parentId: null,
    slug: 'general',
    title: '#general',
    topic: null,
    workspaceId: null,
    rootEntryId: null,
    archived: false,
    createdAt: '2026-07-26T09:00:00.000Z',
    lastActivityAt: '2026-07-26T10:00:00.000Z',
    members: [],
    ...overrides,
  };
}

function renderComposer(transport: Transport, room: RoomWithRoster = roomWith()) {
  // The app's real cache configuration, retries off. A bare `new QueryClient()`
  // has no MutationCache, so the global error toast this surface deliberately
  // suppresses would not exist to be asserted about — the test would pass
  // whether or not the suppression was there.
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

  it('gives every word back when the post fails, and says why exactly once', async () => {
    const transport = createMockTransport({
      postToRoom: vi.fn().mockRejectedValue(new Error('This room is archived')),
    });
    const field = renderComposer(transport);

    type(field, 'the message I do not want to retype');
    fireEvent.keyDown(field, { key: 'Enter' });

    await waitFor(() => expect(field.value).toBe('the message I do not want to retype'));
    // One toast, carrying the server's sentence. The QueryClient here is the
    // app's real one, whose MutationCache toasts every unsuppressed failure —
    // so a missing `suppressErrorToast` shows up as a second, generic toast
    // landing FIRST and burying the reason.
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(toastError).toHaveBeenCalledWith('This room is archived');
  });

  it('puts a refused message back above a follow-up instead of destroying one', async () => {
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

    await waitFor(() => expect(field.value).toBe('the refused one\nthe one typed while waiting'));
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
    // batches, so no render happens between them and BOTH handlers read the
    // pre-send `text`. Two separate `fireEvent` calls each flush a render, so
    // the second would find an empty field and prove nothing about the latch.
    await act(async () => {
      field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });

    expect(transport.postToRoom).toHaveBeenCalledTimes(1);
    expect(transport.postToRoom).toHaveBeenCalledWith('room-1', { text: 'ship it' });
  });
});
