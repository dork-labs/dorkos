/**
 * "Nothing is running" (DOR-3675): one fixed line, once per stall, when no agent chat has run for
 * 30 min while work is open; never while one runs, and never with nothing open.
 */
import { describe, expect, it } from 'vitest';
import {
  createIdleAlertWatch,
  IDLE_ALERT_AFTER_MS,
  idleAlertText,
  type IdleAlertDeps,
  type OpenWorkCounts,
} from '../idle-watch/idle-alert.js';

const MIN = 60_000;
const START = Date.parse('2026-11-02T08:00:00Z');

/** A watch over a settable clock, activity and open work; posts are recorded. */
function harness(open: OpenWorkCounts = { lanes: 6, promises: 2 }) {
  const state = {
    now: START,
    activity: undefined as IdleAlertDeps['chatActivity'] extends () => infer A ? A : never,
    open,
    enabled: true,
    room: 'room-dorkos' as string | null,
  };
  const posts: { roomId: string; text: string }[] = [];
  const watch = createIdleAlertWatch({
    enabled: () => state.enabled,
    chatActivity: () => state.activity,
    openWork: async () => state.open,
    targetRoom: () => state.room,
    postNotice: (roomId, text) => posts.push({ roomId, text }),
    now: () => state.now,
  });
  return { state, posts, watch };
}

describe('the "nothing is running" watch', () => {
  it('posts one fixed line, counts and minutes only, after 30 min with work open', async () => {
    const { state, posts, watch } = harness();
    state.now = START + 29 * MIN;
    await watch.check();
    expect(posts).toEqual([]);

    state.now = START + 42 * MIN;
    await watch.check();
    expect(posts).toEqual([
      {
        roomId: 'room-dorkos',
        text: 'No agent chat has run on this computer for 42 min. Open work: 6 chats started in the last 3 days, 2 open promises.',
      },
    ]);
  });

  it('posts once per stall: not again until a chat has run in between', async () => {
    const { state, posts, watch } = harness();
    state.now = START + 31 * MIN;
    await watch.check();
    state.now = START + 90 * MIN;
    await watch.check();
    expect(posts).toHaveLength(1);

    // A chat ran and ended between two looks: the stall is over, and a new one can post.
    state.activity = START + 95 * MIN;
    state.now = START + 100 * MIN;
    await watch.check();
    expect(posts).toHaveLength(1);
    state.now = START + 95 * MIN + IDLE_ALERT_AFTER_MS + MIN;
    await watch.check();
    expect(posts).toHaveLength(2);
  });

  it('never posts while a chat runs', async () => {
    const { state, posts, watch } = harness();
    state.activity = 'running';
    state.now = START + 5 * 60 * MIN;
    await watch.check();
    expect(posts).toEqual([]);
  });

  it('never posts with no open work', async () => {
    const { state, posts, watch } = harness({ lanes: 0, promises: 0 });
    state.now = START + 60 * MIN;
    await watch.check();
    expect(posts).toEqual([]);
  });

  it('says nothing while heartbeats are off, or with no room to post in', async () => {
    const off = harness();
    off.state.enabled = false;
    off.state.now = START + 60 * MIN;
    await off.watch.check();
    const roomless = harness();
    roomless.state.room = null;
    roomless.state.now = START + 60 * MIN;
    await roomless.watch.check();
    expect([off.posts, roomless.posts]).toEqual([[], []]);
  });

  it('starts its clock at its own start, never claiming idleness it did not see', async () => {
    const { state, posts, watch } = harness();
    state.activity = START - 10 * 60 * MIN;
    state.now = START + 20 * MIN;
    await watch.check();
    expect(posts).toEqual([]);
  });

  it('has one shape: counts and minutes, with singular words for one', () => {
    expect(idleAlertText(30 * MIN + 5000, { lanes: 1, promises: 1 })).toBe(
      'No agent chat has run on this computer for 30 min. Open work: 1 chat started in the last 3 days, 1 open promise.'
    );
  });
});
