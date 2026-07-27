// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import type { Transport } from '@dorkos/shared/transport';
import type { RoomWithRoster } from '@dorkos/shared/room-schemas';
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
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
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

  it('clears the field once the post is accepted', async () => {
    const transport = createMockTransport();
    const field = renderComposer(transport);

    type(field, 'ship it');
    fireEvent.keyDown(field, { key: 'Enter' });

    await waitFor(() => expect(field.value).toBe(''));
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

  it('keeps every word when the post fails, and says why', async () => {
    const transport = createMockTransport({
      postToRoom: vi.fn().mockRejectedValue(new Error('This room is archived')),
    });
    const field = renderComposer(transport);

    type(field, 'the message I do not want to retype');
    fireEvent.keyDown(field, { key: 'Enter' });

    await waitFor(() => expect(toastError).toHaveBeenCalledWith('This room is archived'));
    expect(field.value).toBe('the message I do not want to retype');
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

  it('sends one message per Enter, not one per keypress, while a post is in flight', async () => {
    let accept: (value: { accepted: true; entryId: string; seq: number }) => void = () => {};
    const transport = createMockTransport({
      postToRoom: vi.fn(
        () =>
          new Promise<{ accepted: true; entryId: string; seq: number }>((resolve) => {
            accept = resolve;
          })
      ),
    });
    const field = renderComposer(transport);

    type(field, 'ship it');
    fireEvent.keyDown(field, { key: 'Enter' });
    fireEvent.keyDown(field, { key: 'Enter' });

    await waitFor(() => expect(transport.postToRoom).toHaveBeenCalledTimes(1));
    accept({ accepted: true, entryId: 'entry-1', seq: 7 });
    await waitFor(() => expect(field.value).toBe(''));
  });
});
