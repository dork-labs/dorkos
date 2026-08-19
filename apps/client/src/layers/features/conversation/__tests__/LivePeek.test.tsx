// @vitest-environment jsdom
/**
 * The peek's own contract, at the component rather than through a host.
 *
 * Everything here is about the two stops and the difference between them: a
 * row's Stop ends ONE agent's turn and leaves the rest of the room working, the
 * footer's ends everything and says how many that is. The peek used to offer a
 * row Stop only when exactly one agent was working, because the row button was
 * secretly the room-wide halt; `specs/room-per-agent-stop` is what made a real
 * per-row stop honest, and most of this file would pass against that old gate
 * without these cases.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import { LivePeek, type LivePeekRow } from '../ui/LivePeek';

const STARTED = '2026-08-18T10:00:00.000Z';

/** One working row, with only what the peek reads off one. */
function row(authorId: string, displayName: string): LivePeekRow {
  return {
    authorId,
    author: { id: authorId, kind: 'agent', displayName, emoji: null, color: null },
    state: 'working',
    since: STARTED,
    replyingTo: null,
    sessionId: null,
  } as unknown as LivePeekRow;
}

const ROWS = [row('kai', 'Kai'), row('ana', 'Ana'), row('sam', 'Sam')];

afterEach(() => {
  cleanup();
});

describe('LivePeek', () => {
  it('gives every working agent its own Stop, each named for its own agent', () => {
    // Red against the old `rows.length === 1` gate, which drew no row button at
    // all here — the case the whole feature exists for.
    render(<LivePeek rows={ROWS} onStopAgent={vi.fn()} onStopAll={vi.fn()} />);

    expect(screen.getAllByTestId('live-peek-stop')).toHaveLength(3);
    // The visible word is the same on all three, so the accessible name is the
    // only thing that can say which agent a button stops.
    for (const name of ['Stop Kai', 'Stop Ana', 'Stop Sam']) {
      expect(screen.getByRole('button', { name })).toHaveTextContent('Stop');
    }
  });

  it("presses with THAT row's author id", () => {
    // Red if the handler closes over the wrong row, which a `.map` makes easy
    // and which no snapshot would catch.
    const onStopAgent = vi.fn();
    render(<LivePeek rows={ROWS} onStopAgent={onStopAgent} />);

    fireEvent.click(screen.getByRole('button', { name: 'Stop Ana' }));

    expect(onStopAgent).toHaveBeenCalledWith('ana');
    expect(onStopAgent).toHaveBeenCalledTimes(1);
  });

  it('disables only the row whose stop is in flight', () => {
    // Red if one shared `stopping` flag is reused for the rows: pressing Stop on
    // one agent would grey out the buttons for the two that are still going.
    render(<LivePeek rows={ROWS} onStopAgent={vi.fn()} stoppingAgents={new Set(['ana'])} />);

    expect(screen.getByRole('button', { name: 'Stop Ana' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Stop Kai' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Stop Sam' })).toBeEnabled();
  });

  it('leaves the row stops alone while the ROOM-wide stop is in flight', () => {
    // The two flags mean different things: `stopping` is the footer's, and a
    // room-wide stop in flight is not a reason a row button should look pressed.
    render(<LivePeek rows={ROWS} onStopAgent={vi.fn()} onStopAll={vi.fn()} stopping />);

    expect(screen.getByTestId('live-peek-stop-all')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Stop Kai' })).toBeEnabled();
  });

  it('draws no footer for a single agent, because there is nothing else to stop', () => {
    render(<LivePeek rows={[ROWS[0]]} onStopAgent={vi.fn()} onStopAll={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'Stop Kai' })).toBeInTheDocument();
    expect(screen.queryByTestId('live-peek-stop-all')).toBeNull();
  });

  it('counts what the footer will take down', () => {
    render(<LivePeek rows={ROWS} onStopAgent={vi.fn()} onStopAll={vi.fn()} />);

    const footer = screen.getByTestId('live-peek-stop-all');
    expect(footer).toHaveTextContent('Stop everything in this room');
    expect(footer).toHaveTextContent('Stops all 3');
  });

  it('draws no row stop at all on a surface that has none behind it', () => {
    // Absent, never disabled: a control that cannot do anything is a promise the
    // product is not keeping. The session peek is that surface — its composer
    // already has a stop.
    render(<LivePeek rows={ROWS} onStopAll={vi.fn()} />);

    expect(screen.queryByTestId('live-peek-stop')).toBeNull();
    for (const listRow of screen.getAllByTestId('live-peek-row')) {
      expect(within(listRow).queryByRole('button', { name: /^Stop/u })).toBeNull();
    }
    // The footer is still there: stopping everything is still on offer.
    expect(screen.getByTestId('live-peek-stop-all')).toBeInTheDocument();
  });
});
