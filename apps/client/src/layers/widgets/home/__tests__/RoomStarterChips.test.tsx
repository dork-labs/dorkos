// @vitest-environment jsdom
/**
 * Day one in #team is a conversation waiting to start (team-room-home spec
 * D3.6).
 *
 * The one behaviour worth pinning: a chip WRITES, and does not send. Everything
 * else about the chips is the shared chip component's, proven where it lives.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { useComposerFocusStore, useRoomDraftStore } from '@/layers/entities/room';
import { HOME_STARTER_CHIPS } from '../lib/starter-chips';
import { RoomStarterChips } from '../ui/RoomStarterChips';

const ROOM_ID = 'team-room';

beforeEach(() => {
  useRoomDraftStore.setState({ drafts: {} });
  useComposerFocusStore.setState({ focusRequests: {} });
});

afterEach(() => {
  cleanup();
});

describe('RoomStarterChips', () => {
  it('offers the openers as chips', () => {
    render(<RoomStarterChips roomId={ROOM_ID} />);

    // Read off the registry, so the copy can be rewritten without rewriting the
    // test — and so a chip silently dropped from the row fails here.
    for (const line of HOME_STARTER_CHIPS) {
      expect(screen.getByRole('button', { name: line })).toBeInTheDocument();
    }
  });

  it('names the row for what it is, not for a conversation that has not happened', () => {
    render(<RoomStarterChips roomId={ROOM_ID} />);

    expect(screen.getByRole('group', { name: 'Ways to start' })).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: /follow-up/i })).toBeNull();
  });

  it('writes the pressed line into the room composer, and does not send it', async () => {
    render(<RoomStarterChips roomId={ROOM_ID} />);
    const line = HOME_STARTER_CHIPS[0]!;

    await userEvent.click(screen.getByRole('button', { name: line }));

    // In the box, under this room's own draft key — not a thread's.
    expect(useRoomDraftStore.getState().drafts[ROOM_ID]).toBe(line);
    // And the caret follows it there, so the next keystroke edits the line.
    expect(useComposerFocusStore.getState().focusRequests[ROOM_ID]).toBe(1);
  });

  it('replaces the draft when a second opener is pressed, rather than stacking them', async () => {
    render(<RoomStarterChips roomId={ROOM_ID} />);

    await userEvent.click(screen.getByRole('button', { name: HOME_STARTER_CHIPS[0]! }));
    await userEvent.click(screen.getByRole('button', { name: HOME_STARTER_CHIPS[1]! }));

    expect(useRoomDraftStore.getState().drafts[ROOM_ID]).toBe(HOME_STARTER_CHIPS[1]);
  });
});
