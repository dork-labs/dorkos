/**
 * @vitest-environment jsdom
 */
/**
 * The peek showcase demonstrates the peek that ships, Stops included.
 *
 * `every-showcase-mounts.test.tsx` proves the section renders without throwing,
 * and that is exactly the failure this file is NOT about. The one measured here
 * is quieter: a demo whose label promises a button, rendered without the prop
 * that draws it, so the panel looks fine and shows nothing. It happened the day
 * the row Stop stopped being the room-wide halt (DOR-1352) — the labels were
 * rewritten and the props were not, leaving a section headed "Stop on its row"
 * with no Stop on any row.
 *
 * @module dev/__tests__/live-peek-showcase
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { LivePeekShowcase } from '../showcases/LiveLaneShowcases';

afterEach(() => cleanup());

describe('LivePeekShowcase', () => {
  it('draws a Stop on every working row it promises one on', () => {
    render(<LivePeekShowcase />);

    // Five demos offer a per-agent stop — one row, three rows, three rows with
    // one stop in flight, and the two mixed working/waiting pairs — so eleven
    // row buttons in total. A demo that lost its `onStopAgent` shows up here as
    // a smaller number, which is the defect this file exists for.
    expect(screen.getAllByTestId('live-peek-stop')).toHaveLength(11);
    // And each one names its own agent, which is the whole reason a row button
    // is honest with several on screen.
    expect(screen.getAllByRole('button', { name: 'Stop DorkBot' })).toHaveLength(5);
    expect(screen.getAllByRole('button', { name: 'Stop Release Bot' })).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: 'Stop Kai' })).toHaveLength(2);
    // Including the HELD row, which is the amendment `specs/room-per-agent-stop`
    // §5.2 makes to DOR-1345: a waiting agent can be stopped waiting for.
    expect(screen.getAllByRole('button', { name: 'Stop Mio Clicker PM' })).toHaveLength(2);
  });

  it('shows the in-flight state on one row only, so the demo says what the product does', () => {
    render(<LivePeekShowcase />);

    // Exactly one button in the whole section is disabled: Release Bot's, in the
    // third demo. If a single shared flag ever came back, this would be three.
    const disabled = screen
      .getAllByTestId('live-peek-stop')
      .filter((button) => button.hasAttribute('disabled'));
    expect(disabled).toHaveLength(1);
    expect(disabled[0]).toHaveAccessibleName('Stop Release Bot');
  });

  it('offers the room-wide footer only where there is more than one agent', () => {
    render(<LivePeekShowcase />);

    // Four of the six demos draw more than one row; the single-agent one and the
    // session one draw no footer, because a footer that stops "all 1" is a
    // second button for the verb the row already has. The count is every row,
    // held ones included, which the room-wide halt really does stop.
    const footers = screen.getAllByTestId('live-peek-stop-all');
    expect(footers).toHaveLength(4);
    expect(footers.filter((f) => f.textContent?.includes('Stops all 3'))).toHaveLength(2);
    expect(footers.filter((f) => f.textContent?.includes('Stops all 2'))).toHaveLength(2);
  });

  it('draws no row Stop at all on the session demo', () => {
    // Absent, never disabled. The session composer already has a stop.
    render(<LivePeekShowcase />);

    // Six demos, and only five of them offer a row stop — the sixth is the
    // session's, whose single row contributes no button to the eleven above.
    expect(screen.getAllByTestId('live-peek-row')).toHaveLength(12);
    expect(screen.getAllByTestId('live-peek-stop')).toHaveLength(11);
  });
});
