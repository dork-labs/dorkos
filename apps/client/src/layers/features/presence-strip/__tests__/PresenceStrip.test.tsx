/**
 * The strip itself: what it draws for a row, and what it offers to do with one.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { PresenceStrip } from '../ui/PresenceStrip';
import type { PresenceRow } from '../lib/presence-rows';

/**
 * Clicks a chip the way these tests mean it: the action only, no hover on the
 * way in.
 *
 * Every chip is a Radix `HoverCard` trigger, and `userEvent.click` opens with a
 * `pointerenter` (plus a `focus`) before it presses. Each of those arms the
 * card's 300ms open-delay `setTimeout`, and Radix overwrites its own timer ref
 * on the second without clearing the first — so one open timer is orphaned,
 * and unmount cleanup cancels only the latest ref, never it. On the real clock
 * that orphan fires 300ms later, after this file's jsdom `window` is torn down,
 * and `setOpen(true)` reaches into the gone `window`: an unhandled
 * `ReferenceError: window is not defined` that Vitest blames on the whole run
 * and that reddened unrelated PRs intermittently (DOR-1116). `fireEvent.click`
 * dispatches the bare click these cases actually assert on — following on
 * press — so the hover card's timer is never armed and nothing is left ticking
 * past teardown.
 */
function clickChip(button: HTMLElement): void {
  fireEvent.click(button);
}

/** A row as `buildPresenceRows` produces one, overridable per case. */
function row(overrides: Partial<PresenceRow> = {}): PresenceRow {
  return {
    id: 'room:room-1:author-1',
    name: 'tangerines',
    handle: 'tangerines',
    face: { kind: 'agent', color: '#6366f1', emoji: '🍊', fallback: 'T' },
    binding: 'replying in #release-train',
    state: 'working',
    since: '2026-08-08T00:00:00.000Z',
    roomTitle: '#release-train',
    runtime: 'claude-code',
    line: 'tangerines · replying in #release-train',
    detail: 'replying in #release-train',
    profileMemberId: '01JTANGERINESMANIFESTUL',
    follow: { kind: 'room', roomId: 'room-1' },
    ...overrides,
  };
}

describe('PresenceStrip', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('draws nothing at all when nobody is working', () => {
    // Not "nobody is working" in words, and not an empty box: the strip stands
    // down entirely and the header collapses around it. Red the moment this
    // grows a quiet-state line of its own.
    const { container } = render(<PresenceStrip rows={[]} onFollow={vi.fn()} />);

    expect(container).toBeEmptyDOMElement();
  });

  it('names the agent and what it is bound to', () => {
    render(<PresenceStrip rows={[row()]} onFollow={vi.fn()} />);

    expect(screen.getByText('tangerines')).toBeInTheDocument();
    expect(screen.getByText('· replying in #release-train')).toBeInTheDocument();
  });

  it('says only the name when nothing can say where', () => {
    render(
      <PresenceStrip
        rows={[row({ binding: null, detail: null, line: 'tangerines' })]}
        onFollow={vi.fn()}
      />
    );

    expect(screen.getByRole('button', { name: 'Watch tangerines' })).toBeInTheDocument();
    // No separator, no stand-in clause — nothing after the name at all.
    expect(screen.queryByText(/·/)).not.toBeInTheDocument();
  });

  it('offers one thing per row, and that thing is watching', () => {
    // The etiquette rule, asserted as an absence: no stop, no take-over, no
    // reassign. One button per agent, and it opens a window.
    render(<PresenceStrip rows={[row()]} onFollow={vi.fn()} />);

    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toHaveAccessibleName('Watch tangerines — replying in #release-train');
  });

  it('follows a room claim into its room', () => {
    const onFollow = vi.fn();
    render(<PresenceStrip rows={[row()]} onFollow={onFollow} />);

    clickChip(screen.getByRole('button'));

    expect(onFollow).toHaveBeenCalledWith({ kind: 'room', roomId: 'room-1' });
  });

  it('follows a session claim into that session, in the directory it runs in', () => {
    const onFollow = vi.fn();
    render(
      <PresenceStrip
        rows={[
          row({
            id: 'session:sess-1',
            name: 'DorkBot',
            binding: 'working in a session',
            detail: 'working in a session',
            line: 'DorkBot · working in a session',
            follow: { kind: 'session', sessionId: 'sess-1', cwd: '/code/dorkbot' },
          }),
        ]}
        onFollow={onFollow}
      />
    );

    clickChip(screen.getByRole('button'));

    expect(onFollow).toHaveBeenCalledWith({
      kind: 'session',
      sessionId: 'sess-1',
      cwd: '/code/dorkbot',
    });
  });

  it('draws a row per agent when several are working', () => {
    render(
      <PresenceStrip
        rows={[row(), row({ id: 'session:sess-1', name: 'DorkBot' })]}
        onFollow={vi.fn()}
      />
    );

    expect(screen.getAllByRole('button')).toHaveLength(2);
  });

  it('names the list it is, so a reader knows what they have arrived at', () => {
    render(<PresenceStrip rows={[row()]} onFollow={vi.fn()} />);

    expect(screen.getByRole('list', { name: 'Working right now' })).toBeInTheDocument();
  });
});

describe('PresenceStrip — staying one line tall', () => {
  afterEach(cleanup);

  /** A busy fleet: twelve agents working at once. */
  function twelveRows(): PresenceRow[] {
    return Array.from({ length: 12 }, (_, index) =>
      row({ id: `room:room-1:author-${index}`, name: `agent-${index}` })
    );
  }

  it('draws five agents and counts the rest', () => {
    // Twelve chips wrapped to four lines of pinned chrome at 375px — every one
    // of them taken from the feed underneath. Red if the cap goes away or the
    // remainder stops being counted.
    render(<PresenceStrip rows={twelveRows()} onFollow={vi.fn()} />);

    expect(screen.getAllByRole('button')).toHaveLength(5);
    expect(screen.getByText('agent-4')).toBeInTheDocument();
    expect(screen.queryByText('agent-5')).not.toBeInTheDocument();
  });

  it('says how many it is not showing, out loud', () => {
    render(<PresenceStrip rows={twelveRows()} onFollow={vi.fn()} />);

    expect(screen.getByText('+7 more')).toBeInTheDocument();
    expect(screen.getByRole('listitem', { name: '7 more agents are working' })).toBeInTheDocument();
  });

  it('counts one remaining agent in the singular', () => {
    render(<PresenceStrip rows={twelveRows().slice(0, 6)} onFollow={vi.fn()} />);

    expect(screen.getByRole('listitem', { name: '1 more agent is working' })).toBeInTheDocument();
  });

  it('does not count when everybody fits', () => {
    render(<PresenceStrip rows={twelveRows().slice(0, 5)} onFollow={vi.fn()} />);

    expect(screen.queryByText(/more/)).not.toBeInTheDocument();
  });

  it('never wraps — the one line is structural, not a matter of how many fit', () => {
    // jsdom lays nothing out, so this pins the CLASS CONTRACT rather than a
    // measured height: `flex-wrap` is what made the header four lines tall, and
    // its absence plus `overflow-hidden` is what keeps the strip to one.
    render(<PresenceStrip rows={twelveRows()} onFollow={vi.fn()} />);

    const list = screen.getByRole('list', { name: 'Working right now' });
    expect(list.className).not.toMatch(/flex-wrap/);
    expect(list.className).toContain('overflow-hidden');
  });
});

describe('PresenceStrip — reachable on a touch screen', () => {
  afterEach(cleanup);

  it('carries the anisotropic touch target, anchored to the chip itself', () => {
    // A 28px chip is under the 44px minimum. jsdom reports every element as
    // 0 × 0, so this pins the class contract the browser turns into a target:
    // `relative` (without it the `::after` anchors to some ancestor and the
    // target lands elsewhere), the growth itself, and the `md:` opt-out.
    //
    // The insets are deliberately unequal: the house `-inset-3` would grow each
    // chip 12px sideways and overlap its neighbour's target at this spacing,
    // handing taps to the wrong agent. Red if anyone "simplifies" it back.
    render(<PresenceStrip rows={[row()]} onFollow={vi.fn()} />);

    const { className } = screen.getByRole('button');
    expect(className).toContain('relative');
    expect(className).toContain('after:absolute');
    expect(className).toContain('after:-inset-y-2.5');
    expect(className).toContain('after:-inset-x-1');
    expect(className).toContain('md:after:hidden');
  });

  it('keeps enough space between chips that the targets cannot overlap', () => {
    render(<PresenceStrip rows={[row(), row({ id: 'b', name: 'DorkBot' })]} onFollow={vi.fn()} />);

    // `gap-x-2` (8px) against `after:-inset-x-1` (4px a side) leaves the two
    // targets meeting exactly at the midpoint and never crossing it.
    expect(screen.getByRole('list').className).toContain('gap-x-2');
  });
});
