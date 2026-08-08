// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, cleanup, fireEvent } from '@testing-library/react';
import type { RoomRosterEntry, RoomSignalEvent } from '@dorkos/shared/room-schemas';
import { PRESENCE_TICK_MS, useRoomPresenceStore } from '@/layers/entities/room';
import { RoomPresenceLine } from '../ui/RoomPresenceLine';

const ROOM = 'room-1';
const STARTED = '2026-07-30T10:00:00.000Z';

/** A roster entry for an agent, which is all this line reads off a member. */
function member(id: string, displayName: string): RoomRosterEntry {
  return {
    roomId: ROOM,
    authorId: id,
    responseMode: 'engaged',
    joinedAt: STARTED,
    joinedSeq: 0,
    lastReadSeq: 0,
    author: { id, kind: 'agent', displayName, handle: null },
    origin: 'local',
  };
}

const ROSTER = [
  member('kai', 'Kai'),
  member('ana', 'Ana'),
  member('sam', 'Sam'),
  member('rae', 'Rae'),
];

/**
 * Put one live claim in the store, the way the stream would.
 *
 * Set the clock BEFORE calling this, not after: `lastSeenAt` is read from the
 * clock as it stands, and a claim whose last publish is older than the TTL is
 * one this line is right to have forgotten. Age comes from `since`, which is
 * what the server sends and what the elapsed time is derived from.
 */
function working(
  authorId: string,
  state: 'working' | 'working_late' = 'working',
  since = STARTED,
  entryId = `trigger-${authorId}`
): void {
  const event: RoomSignalEvent = {
    type: 'signal',
    signal: 'progress',
    authorId,
    at: since,
    state,
    entryId,
    since,
  };
  useRoomPresenceStore.getState().observe(ROOM, event);
}

/** The line's text, with the separators normalised to single spaces. */
function line(): string {
  return screen.getByTestId('room-presence').textContent!.replace(/\s+/g, ' ').trim();
}

beforeEach(() => {
  useRoomPresenceStore.setState({ rooms: {} });
  vi.useFakeTimers();
  vi.setSystemTime(new Date(STARTED));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('RoomPresenceLine', () => {
  it('draws nothing at all when nobody is working', () => {
    render(<RoomPresenceLine roomId={ROOM} members={ROSTER} />);

    // Not an empty box, not a placeholder: no reserved space under the composer.
    expect(screen.queryByTestId('room-presence')).toBeNull();
    // The announcer is the one thing that stays, and `sr-only` takes no room.
    const announcer = screen.getByRole('status');
    expect(announcer).toBeEmptyDOMElement();
    expect(announcer).toHaveClass('sr-only');
  });

  it('names one agent and how long it has been on it', () => {
    vi.setSystemTime(new Date('2026-07-30T10:00:42.000Z'));
    working('kai');

    render(<RoomPresenceLine roomId={ROOM} members={ROSTER} />);

    expect(line()).toBe('Kai is working on it · 42s');
  });

  it('says so when a turn has outrun the room’s wait', () => {
    vi.setSystemTime(new Date('2026-07-30T10:12:00.000Z'));
    working('kai', 'working_late');

    render(<RoomPresenceLine roomId={ROOM} members={ROSTER} />);

    expect(line()).toBe('Kai is still working — this is taking longer than usual · 12m');
  });

  it('names two, and counts from the one that started first', () => {
    vi.setSystemTime(new Date('2026-07-30T10:00:42.000Z'));
    working('kai', 'working', '2026-07-30T10:00:00.000Z');
    working('ana', 'working', '2026-07-30T10:00:30.000Z');

    render(<RoomPresenceLine roomId={ROOM} members={ROSTER} />);

    expect(line()).toBe('Kai and Ana are working on it · 42s');
  });

  it('names three', () => {
    vi.setSystemTime(new Date('2026-07-30T10:00:42.000Z'));
    working('kai', 'working', '2026-07-30T10:00:00.000Z');
    working('ana', 'working', '2026-07-30T10:00:10.000Z');
    working('sam', 'working', '2026-07-30T10:00:20.000Z');

    render(<RoomPresenceLine roomId={ROOM} members={ROSTER} />);

    expect(line()).toBe('Kai, Ana and Sam are working on it · 42s');
  });

  it('says a long wait is a long wait with more than one agent on it', () => {
    // The defect this pins: the taking-longer wording was the single-agent case
    // only, so a second agent picking something up silently withdrew the one
    // statement a waiting person can act on.
    vi.setSystemTime(new Date('2026-07-30T10:12:00.000Z'));
    working('kai', 'working_late', '2026-07-30T10:00:00.000Z');
    working('ana', 'working_late', '2026-07-30T10:00:30.000Z');

    render(<RoomPresenceLine roomId={ROOM} members={ROSTER} />);

    expect(line()).toBe('Kai and Ana are still working — this is taking longer than usual · 12m');
    expect(screen.getByRole('status').textContent).toBe(
      'Kai and Ana are still working — this is taking longer than usual'
    );
  });

  it('counts past three, and hands the names over on a tap', () => {
    vi.setSystemTime(new Date('2026-07-30T10:00:40.000Z'));
    working('kai', 'working', '2026-07-30T10:00:00.000Z');
    working('ana', 'working', '2026-07-30T10:00:10.000Z');
    working('sam', 'working', '2026-07-30T10:00:20.000Z');
    working('rae', 'working', '2026-07-30T10:00:30.000Z');

    render(<RoomPresenceLine roomId={ROOM} members={ROSTER} />);

    const toggle = screen.getByRole('button', { name: '4 agents are working on it' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('list')).toBeNull();

    fireEvent.click(toggle);

    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    // Each on its own clock, not the aggregate's — Rae started thirty seconds
    // after Kai and the list has to say so.
    expect(screen.getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      'Kai · 40s',
      'Ana · 30s',
      'Sam · 20s',
      'Rae · 10s',
    ]);
  });

  it('carries the long wait into the count, and into the row it belongs to', () => {
    // Past the naming limit the line used to drop state twice over — the count
    // never said anything was slow, and the list behind it printed four
    // identical-looking rows. The list is exactly where a person goes to find
    // out which agent to chase.
    vi.setSystemTime(new Date('2026-07-30T10:20:00.000Z'));
    working('kai', 'working_late', '2026-07-30T10:00:00.000Z');
    working('ana', 'working', '2026-07-30T10:19:00.000Z');
    working('sam', 'working', '2026-07-30T10:19:20.000Z');
    working('rae', 'working', '2026-07-30T10:19:40.000Z');

    render(<RoomPresenceLine roomId={ROOM} members={ROSTER} />);

    const toggle = screen.getByRole('button', {
      name: '4 agents are still working — this is taking longer than usual',
    });
    fireEvent.click(toggle);

    expect(screen.getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      'Kai · 20m · taking longer than usual',
      'Ana · 1m',
      'Sam · 40s',
      'Rae · 20s',
    ]);
  });

  it('renders an agent once however many claims it holds, at the older one', () => {
    vi.setSystemTime(new Date('2026-07-30T10:12:00.000Z'));
    working('kai', 'working', '2026-07-30T10:00:30.000Z', 'trigger-a');
    working('kai', 'working_late', '2026-07-30T10:00:00.000Z', 'trigger-b');

    render(<RoomPresenceLine roomId={ROOM} members={ROSTER} />);

    expect(line()).toBe('Kai is still working — this is taking longer than usual · 12m');
  });

  it('counts up on its own, with nothing arriving', async () => {
    working('kai');

    render(<RoomPresenceLine roomId={ROOM} members={ROSTER} />);
    expect(line()).toBe('Kai is working on it · 0s');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * PRESENCE_TICK_MS);
    });

    expect(line()).toBe('Kai is working on it · 5s');
  });

  it('announces the sentence, and never the number that ticks', async () => {
    // The announcer is mounted before anything is working, so the sentence lands
    // as a CHANGE to a region assistive technology is already watching — a live
    // region that appears with its text already in it is the case that goes
    // unannounced.
    render(<RoomPresenceLine roomId={ROOM} members={ROSTER} />);
    const announcer = screen.getByRole('status');
    expect(announcer).toBeEmptyDOMElement();

    vi.setSystemTime(new Date('2026-07-30T10:00:42.000Z'));
    act(() => working('kai', 'working', STARTED));

    // The sentence, and only the sentence. The elapsed time is on screen beside
    // it — an announcer that carried it would re-read itself every second.
    expect(announcer).toHaveTextContent('Kai is working on it');
    expect(announcer.textContent).toBe('Kai is working on it');
    expect(line()).toBe('Kai is working on it · 42s');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3 * PRESENCE_TICK_MS);
    });

    // Three seconds of ticking on screen, nothing new said out loud.
    expect(announcer.textContent).toBe('Kai is working on it');
    expect(line()).toBe('Kai is working on it · 45s');
  });

  it('forgets that the names were open once there are few enough to just print', () => {
    vi.setSystemTime(new Date('2026-07-30T10:00:40.000Z'));
    working('kai', 'working', '2026-07-30T10:00:00.000Z');
    working('ana', 'working', '2026-07-30T10:00:10.000Z');
    working('sam', 'working', '2026-07-30T10:00:20.000Z');
    working('rae', 'working', '2026-07-30T10:00:30.000Z');

    render(<RoomPresenceLine roomId={ROOM} members={ROSTER} />);
    fireEvent.click(screen.getByRole('button', { name: '4 agents are working on it' }));
    expect(screen.getAllByRole('listitem')).toHaveLength(4);

    // Down to three: the button goes, and so does the choice made about it.
    act(() => useRoomPresenceStore.getState().clearAuthor(ROOM, 'rae'));
    expect(line()).toBe('Kai, Ana and Sam are working on it · 40s');

    // Back to four. The list stays shut until it is asked for again.
    act(() => working('rae', 'working', '2026-07-30T10:00:30.000Z'));
    expect(screen.getByRole('button', { name: '4 agents are working on it' })).toHaveAttribute(
      'aria-expanded',
      'false'
    );
    expect(screen.queryByRole('listitem')).toBeNull();
  });

  it('counts an agent the roster has not caught up with, without naming it', () => {
    working('newcomer');

    render(<RoomPresenceLine roomId={ROOM} members={ROSTER} />);

    expect(line()).toBe('An agent is working on it · 0s');
  });
});
