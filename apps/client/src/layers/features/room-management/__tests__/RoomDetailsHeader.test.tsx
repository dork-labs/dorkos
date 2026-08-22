// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { act, render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import type { Transport } from '@dorkos/shared/transport';
import { TransportProvider } from '@/layers/shared/model';
import type { RoomDetailsRoom } from '../model/room-details';
import { RoomDetailsHeader } from '../ui/RoomDetailsHeader';

/**
 * What is NOT asserted here, and why.
 *
 * The header pins itself left at every width — a name you press to edit must not
 * slide sideways as its own text changes. That is a painted position, and jsdom
 * reports every element as 0 × 0, so there is nothing here that can tell a
 * centred line from a left-aligned one. Asserting the class name instead would
 * pin the implementation and still not check the outcome. Verified in a browser
 * at 390px.
 */
const CHANNEL: RoomDetailsRoom = {
  id: 'room-1',
  kind: 'channel',
  slug: 'general',
  title: 'General',
  topic: null,
  archived: false,
  createdAt: '2026-07-26T10:00:00.000Z',
};

function renderHeader(overrides: Partial<RoomDetailsRoom> = {}, transport?: Transport) {
  const port = transport ?? createMockTransport();
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={port}>{children}</TransportProvider>
    </QueryClientProvider>
  );
  render(
    <RoomDetailsHeader
      room={{ ...CHANNEL, ...overrides }}
      participants={null}
      visuals={null}
      startTopicEditing={false}
    />,
    { wrapper }
  );
  return { transport: port };
}

/** The topic line as it reads before anybody presses it. */
function topicLine(): HTMLElement {
  return screen.getByRole('button', { name: /^Topic:/ });
}

/** Press the topic line and hand back the editor it becomes. */
function openTopic(): HTMLElement {
  fireEvent.click(topicLine());
  return screen.getByRole('textbox', { name: 'Topic' });
}

/**
 * Prove a write did NOT happen, by making one that must.
 *
 * `mutate` only schedules its `mutationFn`, so `not.toHaveBeenCalled()` on the
 * line after a keystroke is true whatever the component did — it wins a race
 * rather than checking anything, and it stays green with the guard it is
 * supposed to be defending removed. Committing a real edit afterwards and
 * insisting the port saw exactly one call is what turns the absence into a
 * decision: an unwanted write makes that count two.
 */
async function expectNothingElseWrote(transport: Transport): Promise<void> {
  fireEvent.change(openTopic(), { target: { value: 'Clicker planning' } });
  fireEvent.keyDown(screen.getByRole('textbox', { name: 'Topic' }), { key: 'Enter' });

  await waitFor(() =>
    expect(transport.updateRoom).toHaveBeenCalledWith('room-1', { topic: 'Clicker planning' })
  );
  expect(transport.updateRoom).toHaveBeenCalledTimes(1);
}

afterEach(cleanup);

describe('RoomDetailsHeader', () => {
  it('names the line by what pressing it does', async () => {
    // The visible name is a BUTTON, and a button's name has to say what
    // pressing it does rather than repeat the room. The surface itself is named
    // one level up — by the panel's own "Room" tab since phase R2, which is why
    // the sr-only dialog title this header used to carry is gone rather than
    // moved. Red if the line's accessible name ever becomes just the room.
    renderHeader();

    expect(await screen.findByRole('button', { name: /^Room name/ })).toBeInTheDocument();
  });

  it('offers a channel a topic and a direct message none', () => {
    renderHeader();
    expect(topicLine()).toBeInTheDocument();

    cleanup();
    // A DM is about who is in it, not about a subject — it has no topic and no
    // slug (spec `rooms` §14.4). Red if the kind check is dropped: the sheet
    // would offer to write a field the room has no meaning for.
    renderHeader({ kind: 'dm', slug: null, title: 'Ana' });
    expect(screen.queryByRole('button', { name: /^Topic:/ })).not.toBeInTheDocument();
  });

  it('invites a topic rather than leaving a gap when there is none', () => {
    // A channel is anchored to a topic. Red if the empty state goes back to
    // blank space — there would be nothing on screen saying the line exists.
    renderHeader();

    expect(topicLine()).toHaveTextContent('Add a topic');
  });

  it('writes the topic on Enter', async () => {
    const { transport } = renderHeader({ topic: 'Old topic' });

    const input = openTopic();
    expect(input).toHaveValue('Old topic');
    fireEvent.change(input, { target: { value: 'Clicker planning' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() =>
      expect(transport.updateRoom).toHaveBeenCalledWith('room-1', { topic: 'Clicker planning' })
    );
  });

  it('removes the topic rather than storing an empty one', async () => {
    // The column is nullable and `""` is a topic — the room header would then
    // draw a blank line under the name forever. Red if the clear writes `''`.
    const { transport } = renderHeader({ topic: 'Old topic' });

    const input = openTopic();
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() =>
      expect(transport.updateRoom).toHaveBeenCalledWith('room-1', { topic: null })
    );
  });

  it('writes nothing on Escape, and puts the line back', async () => {
    const { transport } = renderHeader({ topic: 'Old topic' });

    const input = openTopic();
    fireEvent.change(input, { target: { value: 'Discarded' } });
    fireEvent.keyDown(input, { key: 'Escape' });

    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(topicLine()).toHaveTextContent('Old topic');
    await expectNothingElseWrote(transport);
  });

  it('writes once for a double Enter and the blur that follows it', async () => {
    // Enter commits, the field goes away, and its blur handler commits too —
    // so one keystroke used to write twice and an impatient double-Enter three
    // times. Red the moment `committedRef` stops gating.
    //
    // All three events go out inside ONE `act`, which is the only way to
    // reproduce it: React has not re-rendered between them, so the field is
    // still mounted and still listening. Separate `fireEvent` calls each flush,
    // and the second would land on a node React has already detached — the
    // guard would look unnecessary because nothing ever reached it twice.
    const { transport } = renderHeader({ topic: 'Old topic' });

    const input = openTopic();
    fireEvent.change(input, { target: { value: 'Clicker planning' } });
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      // React listens for `focusout`, not `blur`, which does not bubble.
      input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });

    await waitFor(() => expect(transport.updateRoom).toHaveBeenCalled());
    expect(transport.updateRoom).toHaveBeenCalledTimes(1);
  });

  it('writes nothing when the text comes back unchanged', async () => {
    const { transport } = renderHeader({ topic: 'Old topic' });

    fireEvent.keyDown(openTopic(), { key: 'Enter' });

    await expectNothingElseWrote(transport);
  });

  it('renames the room from the header', async () => {
    // The line shows the stored `title`, not the `#slug` the sidebar draws:
    // this is the field that edits it, and a control showing `general` while
    // its editor holds `General` is lying about its own value.
    const { transport } = renderHeader();

    const line = screen.getByRole('button', { name: /^Room name:/ });
    expect(line).toHaveTextContent('General');
    fireEvent.click(line);
    const input = screen.getByRole('textbox', { name: 'Room name' });
    fireEvent.change(input, { target: { value: 'Backend' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() =>
      expect(transport.updateRoom).toHaveBeenCalledWith('room-1', { title: 'Backend' })
    );
  });

  it('refuses to rename a room to nothing', async () => {
    // A room with no name is not a room, so an empty name is a cancel rather
    // than a write — the opposite of the topic, which can genuinely be removed.
    const { transport } = renderHeader();

    fireEvent.click(screen.getByRole('button', { name: /^Room name:/ }));
    const input = screen.getByRole('textbox', { name: 'Room name' });
    fireEvent.change(input, { target: { value: '  ' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await expectNothingElseWrote(transport);
  });

  it('says a room is archived only when it is', () => {
    renderHeader();
    expect(screen.queryByText('Archived')).not.toBeInTheDocument();

    cleanup();
    renderHeader({ archived: true });
    expect(screen.getByText('Archived')).toBeInTheDocument();
  });

  it('hands the keyboard back to the line the editor replaced', async () => {
    // The editor unmounts under the cursor; without handing focus back a
    // keyboard reader is dropped to <body> and has to Tab in from the top of
    // the page to reach the line they just edited.
    renderHeader({ topic: 'Old topic' });

    fireEvent.keyDown(openTopic(), { key: 'Escape' });

    await waitFor(() => expect(topicLine()).toHaveFocus());
  });

  describe('the platform-title subtitle (chats-as-channels spec §3.4, DOR-879)', () => {
    it('shows what the chat is called on Telegram once a rename has let it diverge', () => {
      // `room-service.ts:317-321`: a platform title change never renames the
      // room, and a room rename never touches the bridge's recorded platform
      // title either — so once the two differ, only this line says so.
      renderHeader({
        title: 'Backend',
        bridge: { visibility: 'partial', platformTitle: 'Ops Team' },
      });

      expect(screen.getByText('Telegram calls this chat “Ops Team”')).toBeInTheDocument();
    });

    it('says nothing while the room title and the platform title still agree', () => {
      // Redundant, not honest: repeating the room's own name back at it right
      // under the field that already shows it is noise, not a safeguard.
      renderHeader({
        title: 'Ops Team',
        bridge: { visibility: 'partial', platformTitle: 'Ops Team' },
      });

      expect(screen.queryByText(/Telegram calls this chat/)).not.toBeInTheDocument();
    });

    it('says nothing for an unbridged room', () => {
      renderHeader({ title: 'General' });
      expect(screen.queryByText(/Telegram calls this chat/)).not.toBeInTheDocument();
    });

    it('says nothing for a bridged direct message — a DM has no platform-side chat title', () => {
      renderHeader({
        kind: 'dm',
        slug: null,
        title: 'Ana',
        bridge: { visibility: null, platformTitle: null },
      });

      expect(screen.queryByText(/Telegram calls this chat/)).not.toBeInTheDocument();
    });
  });
});
