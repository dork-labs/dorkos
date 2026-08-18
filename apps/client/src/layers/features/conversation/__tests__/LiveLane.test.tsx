// @vitest-environment jsdom
/**
 * The lane's own contract, at the component rather than through a host.
 *
 * Two of these are the popover-reset invariant, and they exist because the
 * component's state and the popover's lifetime disagreed: `peekOpen` is local,
 * the popover UNMOUNTS when the rung stops being `presence`, and Radix fires no
 * `onOpenChange` for an unmount. Both consequences were reproduced in a real
 * cockpit before they were written down here.
 *
 * Seeded defect for both: delete the `useEffect` that closes the peek when
 * `offersPeek` falls → the re-open case and the focus case go red together.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import type { LaneState } from '../model/lane-state';
import { LiveLane } from '../ui/LiveLane';

/** One agent working, as `deriveLaneState` reports it. */
const WORKING: LaneState = {
  kind: 'presence',
  sentence: 'Kai is working on it',
  authorIds: ['kai'],
  since: '2026-08-18T10:00:00.000Z',
  late: false,
};

/** The peek's stand-in: what it draws is `LivePeek`'s business, not this file's. */
const PEEK = <div data-testid="peek-body">who is working</div>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-08-18T10:00:20.000Z'));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('LiveLane', () => {
  it('holds its height and says nothing when there is nothing to say', () => {
    render(<LiveLane state={{ kind: 'empty' }} />);

    const lane = document.querySelector('[data-slot="live-lane"]')!;
    expect(lane).toHaveClass('h-6');
    // The announcer is mounted before it has anything to carry — a live region
    // that arrives with its text already in it is the case assistive technology
    // does not announce.
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
    // And nothing in a quiet lane is reachable by Tab.
    expect(lane.querySelector('button')).toBeNull();
  });

  it('names its live region for the surface it speaks for', () => {
    const { rerender } = render(<LiveLane state={{ kind: 'empty' }} />);
    expect(screen.getByTestId('room-presence-announcer')).toBeInTheDocument();

    rerender(<LiveLane state={{ kind: 'empty' }} scope="thread" />);
    expect(screen.getByTestId('thread-presence-announcer')).toBeInTheDocument();

    // The session's lane used to draw the ROOM's name on `/session`, where there
    // is no room and never any presence. A wrong name is worse than a generic one.
    rerender(<LiveLane state={{ kind: 'empty' }} scope="session" />);
    expect(screen.getByTestId('session-lane-announcer')).toBeInTheDocument();
    expect(screen.queryByTestId('room-presence-announcer')).toBeNull();
  });

  it('closes the peek when its trigger stops existing, and tells the host', () => {
    // The defect, reproduced three times in a real cockpit: the rung leaves
    // `presence` when the work ends, the popover unmounts, Radix says nothing,
    // and the NEXT claim mounts the peek already open over the composer.
    const onPeekOpenChange = vi.fn();
    const { rerender } = render(
      <LiveLane state={WORKING} peek={PEEK} onPeekOpenChange={onPeekOpenChange} />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Show who is working' }));
    expect(screen.getByTestId('peek-body')).toBeInTheDocument();
    expect(onPeekOpenChange).toHaveBeenLastCalledWith(true);

    rerender(
      <LiveLane state={{ kind: 'empty' }} peek={PEEK} onPeekOpenChange={onPeekOpenChange} />
    );

    // The host hears it, which is what stops `useRoomSessions` staying enabled
    // for the life of the view.
    expect(onPeekOpenChange).toHaveBeenLastCalledWith(false);

    rerender(<LiveLane state={WORKING} peek={PEEK} onPeekOpenChange={onPeekOpenChange} />);
    expect(screen.queryByTestId('peek-body')).toBeNull();
    expect(screen.getByRole('button', { name: 'Show who is working' })).toBeInTheDocument();
  });

  it('hands the caret back rather than dropping it on the document', () => {
    // Radix returns focus to a trigger it CLOSED and has nothing to return to
    // when the trigger is removed under the reader — so the caret landed on
    // `<body>` and Tab restarted at the top of the page. The lane's own root is
    // always mounted and sits one Tab from the composer.
    const { rerender } = render(<LiveLane state={WORKING} peek={PEEK} />);
    const trigger = screen.getByRole('button', { name: 'Show who is working' });
    trigger.focus();
    fireEvent.click(trigger);

    rerender(<LiveLane state={{ kind: 'empty' }} peek={PEEK} />);

    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).toBe(document.querySelector('[data-slot="live-lane"]'));
  });

  it('leaves the caret alone when the reader was never inside the peek', () => {
    // The other half of the rule: a peek closing while somebody types into the
    // composer must not pull the caret out of it.
    const elsewhere = document.createElement('input');
    document.body.append(elsewhere);
    const { rerender } = render(<LiveLane state={WORKING} peek={PEEK} />);
    fireEvent.click(screen.getByRole('button', { name: 'Show who is working' }));
    elsewhere.focus();

    rerender(<LiveLane state={{ kind: 'empty' }} peek={PEEK} />);

    expect(document.activeElement).toBe(elsewhere);
    elsewhere.remove();
  });

  it('offers no trigger at all when the host has no peek to open', () => {
    render(<LiveLane state={WORKING} />);

    expect(screen.queryByRole('button', { name: 'Show who is working' })).toBeNull();
    expect(screen.getByTestId('room-presence')).toHaveTextContent('Kai is working on it');
  });

  it('draws the reduced-motion branch off rather than shorter', () => {
    // Mirrored onto the DOM because the harness strips motion props: this is the
    // only way a test can see which branch a lane took.
    const { rerender } = render(<LiveLane state={WORKING} reducedMotionOverride />);
    expect(document.querySelector('[data-slot="live-lane"]')).toHaveAttribute(
      'data-lane-motion',
      'off'
    );

    rerender(<LiveLane state={WORKING} reducedMotionOverride={false} />);
    expect(document.querySelector('[data-slot="live-lane"]')).toHaveAttribute(
      'data-lane-motion',
      'on'
    );
  });

  it('fits the stalled sentence on a phone without losing what it can do', () => {
    // At 375px the full sentence truncated at "New messages aren't coming thr…",
    // which drops the half a person can act on and leaves it behind a `title` no
    // finger can open. Two spellings, one per width — and the announcer keeps the
    // full one, so nothing is lost to a reader who cannot see the line.
    render(<LiveLane state={{ kind: 'stalled' }} onRetry={vi.fn()} />);

    const narrow = screen.getByText('Reconnecting — you can still send');
    expect(narrow).toHaveClass('sm:hidden');
    // The announcer carries the same words, so the visible one is found by its
    // own class rather than by text.
    const wide = document.querySelector('[data-testid="room-stalled"] span.hidden')!;
    expect(wide).toHaveClass('sm:inline');
    expect(wide.textContent).toContain("New messages aren't coming through right now");
    expect(screen.getByRole('status').textContent).toContain(
      "New messages aren't coming through right now"
    );
    expect(screen.getByRole('button', { name: 'Reconnect' })).toBeInTheDocument();
  });
});
