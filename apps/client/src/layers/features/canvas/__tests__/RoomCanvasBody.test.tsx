/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport, mockCanvasDocument } from '@dorkos/test-utils';
import type { CanvasDocument, RoomWithRoster } from '@dorkos/shared/room-schemas';
import type { Transport } from '@dorkos/shared/transport';
import { TransportProvider, useAppStore } from '@/layers/shared/model';
import { CanvasContent, BrowserContent } from '../index';

vi.mock('streamdown', () => ({
  Streamdown: ({ children }: { children: string }) => (
    <div data-testid="streamdown">{children}</div>
  ),
}));
vi.mock('streamdown/styles.css', () => ({}));
vi.mock('../ui/BlintzCanvas', () => ({
  BlintzCanvas: ({ value, editable }: { value: string; editable: boolean }) => (
    <div data-testid="blintz-canvas" data-editable={editable}>
      {value}
    </div>
  ),
}));

const ROOM = 'room-1';
const VIEWER = 'author-you';
const ANA = 'author-ana';

/** A roster with the reader and one agent in it, so a tab can draw a face. */
const ROSTER = {
  id: ROOM,
  viewerAuthorId: VIEWER,
  members: [
    {
      author: { id: VIEWER, kind: 'human', displayName: 'You', handle: 'you' },
      origin: { kind: 'local' },
    },
    {
      author: { id: ANA, kind: 'agent', displayName: 'Ana', handle: 'ana' },
      origin: { kind: 'local' },
    },
  ],
} as unknown as RoomWithRoster;

let transport: Transport;
let queryClient: QueryClient;

/** Put one document on the room's table, exactly as a `canvas` frame would. */
function seed(overrides: Partial<CanvasDocument> = {}, change: 'opened' | 'updated' = 'opened') {
  const document = mockCanvasDocument({ roomId: ROOM, scope: `room:${ROOM}`, ...overrides });
  useAppStore
    .getState()
    .applyRoomCanvasFrame(
      ROOM,
      { type: 'canvas', documentId: document.id, document, change },
      VIEWER
    );
  return document;
}

function renderTab(which: 'canvas' | 'browser') {
  const Tab = which === 'browser' ? BrowserContent : CanvasContent;
  return render(
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>
        <Tab />
      </TransportProvider>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  transport = createMockTransport();
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // The roster read the tab's faces come from, seeded through the same key the
  // app writes it under.
  queryClient.setQueryData(['rooms', 'detail', ROOM], ROSTER);
  useAppStore.setState({
    roomCanvasDocuments: {},
    roomCanvasActive: {},
    roomCanvasUnread: {},
    roomCanvasEditing: {},
    roomCanvasLiveRoomId: ROOM,
  });
});

afterEach(() => {
  cleanup();
  useAppStore.setState({ roomCanvasLiveRoomId: null });
});

describe('the room canvas — two views over one table', () => {
  it('shows pages in the Browser tab and everything else in the Canvas tab', () => {
    seed({ id: 'note', title: 'Notes' });
    seed({
      id: 'app',
      title: 'The app',
      content: { type: 'mcp_app', serverName: 's', uri: 'ui://x' },
    });
    seed({ id: 'page', title: 'dorkos.ai', content: { type: 'url', url: 'https://dorkos.ai' } });

    renderTab('canvas');
    const canvasStrip = screen.getByRole('tablist', { name: 'Open canvas documents' });
    expect(canvasStrip).toHaveTextContent('Notes');
    expect(canvasStrip).toHaveTextContent('The app');
    expect(canvasStrip).not.toHaveTextContent('dorkos.ai');

    cleanup();
    renderTab('browser');
    const browserStrip = screen.getByRole('tablist', { name: 'Open browser pages' });
    expect(browserStrip).toHaveTextContent('dorkos.ai');
    expect(browserStrip).not.toHaveTextContent('Notes');
  });

  it('draws the face of whoever put a document there', () => {
    seed({ id: 'note', title: 'Notes', authorId: ANA });
    renderTab('canvas');

    // The identity kit's disc, with the author's letter in it.
    expect(screen.getByText('A')).toBeInTheDocument();
  });

  it('sorts a pinned document to the front of the strip', () => {
    seed({ id: 'first', title: 'First', openedAt: '2026-09-11T00:00:00.000Z' });
    seed({
      id: 'pinned',
      title: 'Pinned',
      pinned: true,
      openedAt: '2026-09-11T02:00:00.000Z',
    });

    renderTab('canvas');
    const tabs = screen.getAllByRole('tab').map((t) => t.textContent);
    expect(tabs[0]).toContain('Pinned');
  });

  it('marks a document another member opened unread, and clears it when the tab is looked at', () => {
    // Arrives while nobody is on the Canvas tab.
    useAppStore.getState().applyRoomCanvasFrame(
      ROOM,
      {
        type: 'canvas',
        documentId: 'theirs',
        document: mockCanvasDocument({ id: 'theirs', roomId: ROOM, authorId: ANA }),
        change: 'opened',
      },
      VIEWER
    );
    expect(useAppStore.getState().roomCanvasUnread[ROOM]?.canvas).toEqual(['theirs']);

    renderTab('canvas');

    expect(useAppStore.getState().roomCanvasUnread[ROOM]?.canvas).toEqual([]);
  });

  it('takes a document off the table for everybody when a tab is closed', async () => {
    seed({ id: 'note', title: 'Notes' });
    renderTab('canvas');

    fireEvent.click(screen.getByRole('button', { name: 'Close Notes' }));

    await waitFor(() => {
      expect(transport.closeRoomCanvasDocument).toHaveBeenCalledWith(ROOM, 'note');
    });
  });

  it('pins a document through the room rather than in this browser', async () => {
    seed({ id: 'note', title: 'Notes' });
    renderTab('canvas');

    fireEvent.click(screen.getByRole('button', { name: 'Pin Notes' }));

    await waitFor(() => {
      expect(transport.updateRoomCanvasDocument).toHaveBeenCalledWith(ROOM, 'note', {
        pinned: true,
      });
    });
  });

  it('never writes the table locally — the frame the server sends is what moves', () => {
    seed({ id: 'note', title: 'Notes' });
    renderTab('canvas');

    fireEvent.click(screen.getByRole('button', { name: 'Close Notes' }));

    // Still on screen: the close is a request, and the document leaves when the
    // `canvas` frame saying so arrives — for this viewer and every other one at
    // the same moment.
    expect(useAppStore.getState().roomCanvasDocuments[ROOM]).toHaveLength(1);
  });
});

describe('the room canvas — a document that names a file (§8.1)', () => {
  it('offers the room’s own file to the source editor', () => {
    seed({
      id: 'f',
      title: 'ROOM.md',
      content: { type: 'file', sourcePath: 'ROOM.md' },
      treeKind: 'room-main',
    });
    renderTab('canvas');

    expect(screen.getByRole('button', { name: 'Open file' })).toBeInTheDocument();
  });

  it('says where a file in another member’s copy is, and offers nothing', () => {
    seed({
      id: 'f',
      title: 'draft.ts',
      content: { type: 'file', sourcePath: 'draft.ts' },
      treeKind: 'worktree',
      sourceLabel: 'Ana’s copy · 3 ahead of main',
    });
    renderTab('canvas');

    expect(screen.getByText(/This file is in Ana’s project/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open file' })).not.toBeInTheDocument();
  });

  it('shows the line saying whose copy a document came out of', () => {
    seed({
      id: 'f',
      title: 'draft.ts',
      content: { type: 'file', sourcePath: 'draft.ts' },
      treeKind: 'worktree',
      sourceLabel: 'Ana’s copy · 3 ahead of main',
    });
    renderTab('canvas');

    expect(screen.getByText('Ana’s copy · 3 ahead of main')).toBeInTheDocument();
  });
});

describe('the room canvas — editing markdown the room owns (§10)', () => {
  it('holds the room’s edit lock while somebody is typing, and lets it go on save', async () => {
    seed({ id: 'note', title: 'Notes', content: { type: 'markdown', content: '# Notes' } });
    renderTab('canvas');

    fireEvent.click(screen.getByRole('button', { name: 'Edit this document' }));

    await waitFor(() => {
      expect(transport.setRoomCanvasEditing).toHaveBeenCalledWith(ROOM, 'note', true);
    });

    fireEvent.click(screen.getByRole('button', { name: 'Save for the room' }));

    await waitFor(() => {
      expect(transport.setRoomCanvasEditing).toHaveBeenCalledWith(ROOM, 'note', false);
    });
  });

  it('offers no pencil for markdown read out of a file — there is nowhere for a save to go', () => {
    seed({
      id: 'note',
      title: 'notes.md',
      content: { type: 'markdown', content: '# Notes', sourcePath: 'notes.md' },
      treeKind: 'worktree',
      sourceLabel: 'Ana’s copy',
    });
    renderTab('canvas');

    expect(screen.queryByRole('button', { name: 'Edit this document' })).not.toBeInTheDocument();
    expect(screen.getByTestId('blintz-canvas')).toHaveTextContent('# Notes');
  });
});
