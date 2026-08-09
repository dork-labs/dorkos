// @vitest-environment jsdom
/**
 * The popover's own rules, away from any composer: what caps the list, what
 * keeps a muted room out of it, and when it hands the keyboard to somebody
 * else.
 *
 * The keys and the focus that drive it are asserted through the real composer
 * in `app/__tests__/HomeRoomPage.test.tsx`
 * — this file is about the state machine underneath.
 */
import type { ReactNode } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, waitFor, act, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport, createMockSession } from '@dorkos/test-utils';
import type { Transport } from '@dorkos/shared/transport';
import type { RoomSummary } from '@dorkos/shared/room-schemas';
import { SIDEBAR_PREFS_DEFAULTS } from '@dorkos/shared/config-schema';
import { TransportProvider } from '@/layers/shared/model';
import { useJumpBackInPopover, JUMP_BACK_IN_POPOVER_ROWS } from '../model/use-jump-back-in-popover';

const mockNavigate = vi.fn();
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => mockNavigate }));

function wrapperFor(transport: Transport) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
}

const channel = (id: string, slug: string, minutesAgo: number): RoomSummary => ({
  id,
  kind: 'channel',
  slug,
  title: slug,
  topic: null,
  workspaceId: null,
  archived: false,
  ambientMaxEntries: 30,
  createdAt: '2026-07-01T00:00:00.000Z',
  lastActivityAt: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
  unreadCount: 0,
  participants: null,
});

/** Ten channels, newest first — more than the popover will ever draw. */
function transportWithTenChannels(muted: string[] = []): Transport {
  return createMockTransport({
    listRecentSessions: vi
      .fn()
      .mockResolvedValue({ sessions: [], agentActivity: {}, warnings: [] }),
    listRooms: vi
      .fn()
      .mockResolvedValue(
        Array.from({ length: 10 }, (_, i) => channel(`c${i}`, `room-${i}`, i + 1))
      ),
    getConfig: vi.fn().mockResolvedValue({
      ui: {
        sidebar: {
          ...SIDEBAR_PREFS_DEFAULTS,
          muted: muted.map((roomId) => ({ kind: 'room', roomId })),
        },
      },
    }),
  });
}

/** An event over the composer's own field, as React would report it. */
function composerEvent() {
  const field = document.createElement('textarea');
  field.setAttribute('role', 'combobox');
  return { target: field };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('useJumpBackInPopover', () => {
  it('draws at most six threads, however many there are', async () => {
    const { result } = renderHook(() => useJumpBackInPopover({ value: '' }), {
      wrapper: wrapperFor(transportWithTenChannels()),
    });

    await waitFor(() => expect(result.current.rows.length).toBeGreaterThan(0));

    expect(result.current.rows).toHaveLength(JUMP_BACK_IN_POPOVER_ROWS);
    expect(result.current.rows[0]!.id).toBe('c0');
  });

  it('leaves a muted room out — mute means stop pulling me back in', async () => {
    const { result } = renderHook(() => useJumpBackInPopover({ value: '' }), {
      wrapper: wrapperFor(transportWithTenChannels(['c0'])),
    });

    await waitFor(() => expect(result.current.rows.length).toBeGreaterThan(0));

    expect(result.current.rows.map((row) => row.id)).not.toContain('c0');
  });

  it('yields to the palette that already owns the keyboard', async () => {
    const { result, rerender } = renderHook(
      ({ yieldToPalette }: { yieldToPalette: boolean }) =>
        useJumpBackInPopover({ value: '', yieldToPalette }),
      { wrapper: wrapperFor(transportWithTenChannels()), initialProps: { yieldToPalette: false } }
    );

    await waitFor(() => expect(result.current.rows.length).toBeGreaterThan(0));
    act(() => result.current.handleFocus(composerEvent()));
    expect(result.current.isOpen).toBe(true);

    rerender({ yieldToPalette: true });

    // Down, and silent with it: no listbox id and no highlight to announce, so
    // the composer keeps pointing at the palette that is actually up.
    expect(result.current.isOpen).toBe(false);
    expect(result.current.listboxId).toBeUndefined();
    expect(result.current.activeDescendantId).toBeUndefined();

    // And the documented return path, which a Phase 2 host has to be able to
    // rely on: a palette that came up over an EMPTY box hands the field back
    // when it closes. (Reaching the `@` picker by typing latches this panel down
    // instead — that is the typed rule, asserted above, not this one.)
    rerender({ yieldToPalette: false });
    expect(result.current.isOpen).toBe(true);
  });

  // The panel's other trigger, and the one the surface actually depends on: the
  // composer already holds the caret there, so a click produces no focus event.
  it('opens on a press of the field, with no focus event in sight', async () => {
    const { result } = renderHook(() => useJumpBackInPopover({ value: '' }), {
      wrapper: wrapperFor(transportWithTenChannels()),
    });

    await waitFor(() => expect(result.current.rows.length).toBeGreaterThan(0));
    act(() => result.current.handlePointerDown(composerEvent()));

    expect(result.current.isOpen).toBe(true);
  });

  it('takes a press on anything but the field to mean nothing', async () => {
    const { result } = renderHook(() => useJumpBackInPopover({ value: '' }), {
      wrapper: wrapperFor(transportWithTenChannels()),
    });

    await waitFor(() => expect(result.current.rows.length).toBeGreaterThan(0));
    act(() => result.current.handlePointerDown({ target: document.createElement('button') }));

    expect(result.current.isOpen).toBe(false);
  });

  // A press is not a re-ask. Escape and typing both hold until the caret leaves,
  // so clicking in place cannot undo either.
  it('a press does not undo Escape', async () => {
    const { result } = renderHook(() => useJumpBackInPopover({ value: '' }), {
      wrapper: wrapperFor(transportWithTenChannels()),
    });

    await waitFor(() => expect(result.current.rows.length).toBeGreaterThan(0));
    act(() => result.current.handleFocus(composerEvent()));
    act(() => result.current.dismiss());
    act(() => result.current.handlePointerDown(composerEvent()));

    expect(result.current.isOpen).toBe(false);
  });

  it('stays down once something has been typed, even after the box is empty again', async () => {
    const { result, rerender } = renderHook(
      ({ value }: { value: string }) => useJumpBackInPopover({ value }),
      { wrapper: wrapperFor(transportWithTenChannels()), initialProps: { value: '' } }
    );

    await waitFor(() => expect(result.current.rows.length).toBeGreaterThan(0));
    act(() => result.current.handleFocus(composerEvent()));
    expect(result.current.isOpen).toBe(true);

    rerender({ value: 'h' });
    expect(result.current.isOpen).toBe(false);

    // Deleted again, still focused — and still down, because typing said what
    // this visit to the box is for.
    rerender({ value: '' });
    expect(result.current.isOpen).toBe(false);
    act(() => result.current.handlePointerDown(composerEvent()));
    expect(result.current.isOpen).toBe(false);

    // The caret leaving and coming back is what re-offers.
    act(() => result.current.handleBlur(composerEvent()));
    act(() => result.current.handleFocus(composerEvent()));
    expect(result.current.isOpen).toBe(true);
  });

  it('ignores focus that lands anywhere but the composer’s own field', async () => {
    const { result } = renderHook(() => useJumpBackInPopover({ value: '' }), {
      wrapper: wrapperFor(transportWithTenChannels()),
    });

    await waitFor(() => expect(result.current.rows.length).toBeGreaterThan(0));

    // The send button lives inside the same subtree the handlers watch.
    act(() => result.current.handleFocus({ target: document.createElement('button') }));

    expect(result.current.isOpen).toBe(false);
  });

  it('wraps the highlight at both ends', async () => {
    const { result } = renderHook(() => useJumpBackInPopover({ value: '' }), {
      wrapper: wrapperFor(transportWithTenChannels()),
    });

    await waitFor(() => expect(result.current.rows.length).toBeGreaterThan(0));
    act(() => result.current.handleFocus(composerEvent()));

    act(() => result.current.moveUp());
    expect(result.current.selectedIndex).toBe(JUMP_BACK_IN_POPOVER_ROWS - 1);

    act(() => result.current.moveDown());
    expect(result.current.selectedIndex).toBe(0);
  });

  it('closes for good on Escape, and comes back on the next focus', async () => {
    const { result } = renderHook(() => useJumpBackInPopover({ value: '' }), {
      wrapper: wrapperFor(transportWithTenChannels()),
    });

    await waitFor(() => expect(result.current.rows.length).toBeGreaterThan(0));
    act(() => result.current.handleFocus(composerEvent()));

    act(() => result.current.dismiss());
    expect(result.current.isOpen).toBe(false);
    expect(mockNavigate).not.toHaveBeenCalled();

    act(() => result.current.handleBlur(composerEvent()));
    act(() => result.current.handleFocus(composerEvent()));
    expect(result.current.isOpen).toBe(true);
  });

  it('takes the highlighted thread to its own route, and closes behind it', async () => {
    const { result } = renderHook(() => useJumpBackInPopover({ value: '' }), {
      wrapper: wrapperFor(transportWithTenChannels()),
    });

    await waitFor(() => expect(result.current.rows.length).toBeGreaterThan(0));
    act(() => result.current.handleFocus(composerEvent()));
    act(() => result.current.moveDown());
    act(() => result.current.selectHighlighted());

    expect(mockNavigate).toHaveBeenCalledWith({ to: '/channels', search: { id: 'c1' } });
    expect(result.current.isOpen).toBe(false);
  });

  it('opens a session at its own directory', async () => {
    const transport = createMockTransport({
      listRecentSessions: vi.fn().mockResolvedValue({
        sessions: [createMockSession({ id: 'sess-9', title: 'Ship it', cwd: '/code/api' })],
        agentActivity: {},
        warnings: [],
      }),
      listRooms: vi.fn().mockResolvedValue([]),
    });
    const { result } = renderHook(() => useJumpBackInPopover({ value: '' }), {
      wrapper: wrapperFor(transport),
    });

    await waitFor(() => expect(result.current.rows).toHaveLength(1));
    act(() => result.current.handleFocus(composerEvent()));
    act(() => result.current.selectHighlighted());

    expect(mockNavigate).toHaveBeenCalledWith({
      to: '/session',
      search: { dir: '/code/api', session: 'sess-9' },
    });
  });

  it('has nothing to open when the list is empty', async () => {
    const transport = createMockTransport();
    const { result } = renderHook(() => useJumpBackInPopover({ value: '' }), {
      wrapper: wrapperFor(transport),
    });

    await waitFor(() => expect(transport.listRooms).toHaveBeenCalled());
    act(() => result.current.handleFocus(composerEvent()));

    expect(result.current.isOpen).toBe(false);
    expect(result.current.hasRows).toBe(false);
    // Enter must fall through to the composer rather than being swallowed by a
    // panel that is not there.
    act(() => result.current.selectHighlighted());
    expect(mockNavigate).not.toHaveBeenCalled();
  });
});
