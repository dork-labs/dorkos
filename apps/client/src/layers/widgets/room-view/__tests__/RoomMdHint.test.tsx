// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { mockCanvasDocument } from '@dorkos/test-utils';
import type { CanvasDocument } from '@dorkos/shared/room-schemas';
import { useAppStore } from '@/layers/shared/model';
import { RoomMdHint } from '../ui/empty-state/RoomMdHint';

const ROOM = 'room-1';

/** One document on `ROOM`'s canvas. */
function doc(overrides: Partial<CanvasDocument> = {}): CanvasDocument {
  return mockCanvasDocument({ roomId: ROOM, scope: `room:${ROOM}`, ...overrides });
}

/** The ROOM.md the server pins when a channel gets its files. */
const roomMd = (overrides: Partial<CanvasDocument> = {}) =>
  doc({
    id: 'room-md',
    pinned: true,
    content: { type: 'file', sourcePath: 'ROOM.md' },
    ...overrides,
  });

function table(documents: CanvasDocument[]) {
  useAppStore.setState({
    roomCanvasDocuments: { [ROOM]: documents },
    roomCanvasActive: { [ROOM]: { canvas: documents[0]?.id ?? null, browser: null } },
  });
}

beforeEach(() => {
  useAppStore.setState({
    roomCanvasDocuments: {},
    roomCanvasActive: {},
    activeRightPanelTab: 'room',
    rightPanelOpen: false,
  });
});
afterEach(cleanup);

describe('RoomMdHint (DOR-3477)', () => {
  it('says the channel has a ROOM.md, with Open, when one is pinned', () => {
    table([roomMd()]);
    render(<RoomMdHint roomId={ROOM} />);

    expect(screen.getByText(/This channel has a ROOM\.md for its goal and rules\./)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Open' })).toBeVisible();
  });

  it('says nothing for a room with no ROOM.md on its canvas', () => {
    table([doc({ id: 'plan', content: { type: 'markdown', content: '# Plan' } })]);
    const { container } = render(<RoomMdHint roomId={ROOM} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('says nothing for a ROOM.md somebody put down by hand, unpinned', () => {
    table([roomMd({ pinned: false })]);
    const { container } = render(<RoomMdHint roomId={ROOM} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('opens the canvas on ROOM.md when pressed, as a remembered pick', () => {
    // Another document sorts after the pin but is the active one, so Open has
    // to choose ROOM.md itself rather than show whatever was last on top.
    table([doc({ id: 'plan', content: { type: 'markdown', content: '# Plan' } }), roomMd()]);
    useAppStore.setState({ roomCanvasActive: { [ROOM]: { canvas: 'plan', browser: null } } });
    render(<RoomMdHint roomId={ROOM} />);

    fireEvent.click(screen.getByRole('button', { name: 'Open' }));

    const state = useAppStore.getState();
    expect(state.roomCanvasActive[ROOM]?.canvas).toBe('room-md');
    expect(state.activeRightPanelTab).toBe('canvas');
    expect(state.rightPanelOpen).toBe(true);
  });
});
