import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { RoomPresenceAuthor } from '@/layers/entities/room';
import { memberSecondaryLine } from '../lib/member-line';

const JOINED = '2026-07-26T10:00:00.000Z';

// Pin "now" mid-afternoon, well clear of any local-midnight rollover, so
// every `Date.now() - Nm` timestamp below lands on the same calendar day
// regardless of the machine's timezone. See member-line.test.ts history for
// why: a wall-clock-relative assertion here is red for ~45 minutes after
// every local midnight.
const NOW = new Date('2026-07-26T15:00:00.000Z');

function claim(state: RoomPresenceAuthor['state'], elapsedMs: number): RoomPresenceAuthor {
  return { authorId: 'author-Ana', entryId: 'entry-1', state, since: JOINED, elapsedMs };
}

describe('memberSecondaryLine', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('says what the agent is doing now, over anything it did before', () => {
    // Red if the priority inverts: a row would report a message from Tuesday
    // while the agent is mid-turn in front of the reader.
    const line = memberSecondaryLine({
      presence: claim('working', 4_000),
      lastSpokeAt: new Date().toISOString(),
      joinedAt: JOINED,
    });

    // And it says how long, which the row used to withhold on this rung: a turn
    // four minutes in read exactly like one that started this second.
    expect(line).toBe('working now, 4s');
  });

  it('says how long a turn that has outrun the room has been going', () => {
    const line = memberSecondaryLine({
      presence: claim('working_late', 245_000),
      lastSpokeAt: null,
      joinedAt: JOINED,
    });

    expect(line).toBe('still working, 4m');
  });

  it('falls back to the last thing it said here', () => {
    const line = memberSecondaryLine({
      presence: null,
      lastSpokeAt: new Date(Date.now() - 45 * 60_000).toISOString(),
      joinedAt: JOINED,
    });

    expect(line).toBe('last spoke 45m ago');
  });

  it('never claims an agent has not spoken — it says when it joined', () => {
    // THE assertion of this module. The history reader returns only the
    // trailing page, so no evidence of a post is not evidence of silence: an
    // agent that spoke five hundred messages ago looks identical to one that
    // never has. Red the moment "hasn't spoken here yet" appears anywhere.
    const line = memberSecondaryLine({ presence: null, lastSpokeAt: null, joinedAt: JOINED });

    expect(line).toMatch(/^joined /);
    expect(line).not.toMatch(/spoken|never|yet/i);
  });

  it('says nothing about presence when there is no stream to be told on', () => {
    // Opening the sheet over a room that is not on screen means no
    // subscription, so nothing is known. That must read as the next true thing
    // rather than as "not working" — red if a null presence starts printing a
    // sentence of its own.
    const line = memberSecondaryLine({
      presence: null,
      lastSpokeAt: null,
      joinedAt: JOINED,
    });

    expect(line).not.toMatch(/working|idle|offline/i);
  });
});
