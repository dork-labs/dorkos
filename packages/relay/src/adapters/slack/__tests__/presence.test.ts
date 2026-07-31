import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { WebClient } from '@slack/web-api';
import {
  createSlackPresenceState,
  queuePendingReaction,
  dropPendingReaction,
  markAssistantThread,
  isAssistantThread,
  claimPresence,
  releasePresence,
  clearAllPresence,
  PRESENCE_EMOJI,
  WORKING_STATUS,
  PENDING_REACTION_TTL_MS,
  PRESENCE_REFRESH_MS,
  SETTLED_GRACE_MS,
  ABANDONED_BINDING_TTL_MS,
} from '../presence.js';
import type { SlackPresenceState, PresenceContext } from '../presence.js';

const reactionsAdd = vi.fn().mockResolvedValue({ ok: true });
const reactionsRemove = vi.fn().mockResolvedValue({ ok: true });
const setStatus = vi.fn().mockResolvedValue({ ok: true });

/** Minimal WebClient double — only the three calls presence makes. */
function mockClient(): WebClient {
  return {
    reactions: { add: reactionsAdd, remove: reactionsRemove },
    assistant: { threads: { setStatus } },
  } as unknown as WebClient;
}

describe('slack presence', () => {
  let state: SlackPresenceState;
  let ctx: PresenceContext;

  beforeEach(() => {
    vi.clearAllMocks();
    state = createSlackPresenceState();
    ctx = {
      client: mockClient(),
      channelId: 'D123',
      threadTs: '1234.0001',
      streamKeyTs: '1234.0001',
      typingIndicator: 'reaction',
      state,
    };
  });

  afterEach(() => {
    clearAllPresence(state);
    vi.useRealTimers();
  });

  describe('the queue of trigger messages', () => {
    it('keeps arrival order', () => {
      queuePendingReaction(state, 'D123', 'a');
      queuePendingReaction(state, 'D123', 'b');
      expect(state.pendingReactions.get('D123')?.map((e) => e.ts)).toEqual(['a', 'b']);
    });

    it('forgets entries older than the TTL instead of growing forever', () => {
      vi.useFakeTimers();
      queuePendingReaction(state, 'D123', 'stale');
      vi.advanceTimersByTime(PENDING_REACTION_TTL_MS + 1_000);
      queuePendingReaction(state, 'D123', 'fresh');

      expect(state.pendingReactions.get('D123')?.map((e) => e.ts)).toEqual(['fresh']);
    });

    it('drops a named entry and clears the empty channel key', () => {
      queuePendingReaction(state, 'D123', 'a');
      dropPendingReaction(state, 'D123', 'a');
      expect(state.pendingReactions.has('D123')).toBe(false);
    });
  });

  describe('the assistant surface', () => {
    it('remembers a thread it saw start, and nothing else', () => {
      markAssistantThread(state, 'D123', '1234.0001');
      expect(isAssistantThread(state, 'D123', '1234.0001')).toBe(true);
      expect(isAssistantThread(state, 'D123', '9999.0001')).toBe(false);
      expect(isAssistantThread(state, 'D123', undefined)).toBe(false);
    });
  });

  describe('claim and release', () => {
    it('shows nothing at all when the indicator is off', () => {
      queuePendingReaction(state, 'D123', '1234.0001');
      claimPresence({ ...ctx, typingIndicator: 'none' });

      expect(reactionsAdd).not.toHaveBeenCalled();
      expect(state.active.size).toBe(0);
    });

    it('releases without a held claim without touching Slack', () => {
      releasePresence(ctx, 'terminal');
      expect(reactionsRemove).not.toHaveBeenCalled();
    });

    it('holds one claim per turn, and lets go of it exactly once', () => {
      queuePendingReaction(state, 'D123', '1234.0001');
      claimPresence(ctx);
      claimPresence(ctx);
      expect(state.active.size).toBe(1);
      expect(reactionsAdd).toHaveBeenCalledTimes(1);

      releasePresence(ctx, 'terminal');
      releasePresence(ctx, 'terminal');
      expect(reactionsRemove).toHaveBeenCalledTimes(1);
      expect(state.active.size).toBe(0);
    });

    it('stops every timer when the adapter stops, so nothing outlives it', () => {
      vi.useFakeTimers();
      markAssistantThread(state, 'D123', '1234.0001');
      claimPresence(ctx);
      expect(setStatus).toHaveBeenCalledWith({
        channel_id: 'D123',
        thread_ts: '1234.0001',
        status: WORKING_STATUS,
      });

      clearAllPresence(state);
      setStatus.mockClear();
      vi.advanceTimersByTime(PRESENCE_REFRESH_MS * 5);

      expect(setStatus).not.toHaveBeenCalled();
      expect(state.pendingReactions.size).toBe(0);
      expect(state.assistantThreads.size).toBe(0);
    });

    it('takes down what is on screen when the adapter stops, if it still can', () => {
      queuePendingReaction(state, 'D123', '1234.0001');
      claimPresence(ctx);

      clearAllPresence(state, ctx.client);

      expect(reactionsRemove).toHaveBeenCalledWith({
        channel: 'D123',
        name: PRESENCE_EMOJI,
        timestamp: '1234.0001',
      });
      expect(state.bindings.size).toBe(0);
    });

    it('never sends a Slack call it cannot make (no client)', () => {
      queuePendingReaction(state, 'D123', '1234.0001');
      claimPresence({ ...ctx, client: null });
      expect(reactionsAdd).not.toHaveBeenCalled();
      expect(state.active.size).toBe(0);
    });

    it('survives a Slack reaction failure', async () => {
      reactionsAdd.mockRejectedValueOnce(new Error('no_permission'));
      const warn = vi.fn();
      queuePendingReaction(state, 'D123', '1234.0001');

      claimPresence({ ...ctx, logger: { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() } });
      await new Promise((r) => setTimeout(r, 10));

      expect(warn).toHaveBeenCalledWith(expect.stringContaining('failed to add reaction'));
      expect(state.active.size).toBe(1);
    });

    it('uses the eyes emoji, the "seen, on it" convention', () => {
      expect(PRESENCE_EMOJI).toBe('eyes');
    });
  });

  describe('a turn that pauses to ask a question', () => {
    it('keeps the message it is answering across the pause', () => {
      queuePendingReaction(state, 'D123', 'asker');
      queuePendingReaction(state, 'D123', 'someone-else');

      claimPresence(ctx);
      expect(reactionsAdd).toHaveBeenCalledWith({
        channel: 'D123',
        name: PRESENCE_EMOJI,
        timestamp: 'asker',
      });

      // Waiting on a person is not working — the mark comes off...
      releasePresence(ctx, 'paused');
      expect(reactionsRemove).toHaveBeenLastCalledWith({
        channel: 'D123',
        name: PRESENCE_EMOJI,
        timestamp: 'asker',
      });

      // ...and the resume marks the SAME message, not the next person's.
      claimPresence(ctx);
      expect(reactionsAdd).toHaveBeenLastCalledWith({
        channel: 'D123',
        name: PRESENCE_EMOJI,
        timestamp: 'asker',
      });
      expect(state.pendingReactions.get('D123')?.map((e) => e.ts)).toEqual(['someone-else']);

      releasePresence(ctx, 'terminal');
      expect(reactionsRemove).toHaveBeenLastCalledWith({
        channel: 'D123',
        name: PRESENCE_EMOJI,
        timestamp: 'asker',
      });
      // The asker's message ends clean, and nobody else was ever touched.
      const touched = [...reactionsAdd.mock.calls, ...reactionsRemove.mock.calls].map(
        (c) => c[0].timestamp
      );
      expect(new Set(touched)).toEqual(new Set(['asker']));
    });

    it('refuses a straggling event after the turn has ended', () => {
      queuePendingReaction(state, 'D123', 'asker');
      claimPresence(ctx);
      releasePresence(ctx, 'terminal');
      queuePendingReaction(state, 'D123', 'next-person');
      reactionsAdd.mockClear();

      // A late event from the finished turn must not take the next message.
      claimPresence(ctx);
      expect(reactionsAdd).not.toHaveBeenCalled();
      expect(state.pendingReactions.get('D123')?.map((e) => e.ts)).toEqual(['next-person']);
    });

    it('draws the line at five seconds, not merely somewhere', () => {
      vi.useFakeTimers();
      // Pinned, not just referenced: the boundary below moves with the constant,
      // so widening the grace has to fail something.
      expect(SETTLED_GRACE_MS).toBe(5_000);
      queuePendingReaction(state, 'D123', 'first');
      claimPresence(ctx);
      releasePresence(ctx, 'terminal');
      queuePendingReaction(state, 'D123', 'second');
      reactionsAdd.mockClear();

      // Just inside the grace: this is the finished turn still talking.
      vi.advanceTimersByTime(SETTLED_GRACE_MS - 100);
      claimPresence(ctx);
      expect(reactionsAdd).not.toHaveBeenCalled();

      // Just outside it: this is a person asking something new.
      vi.advanceTimersByTime(200);
      claimPresence(ctx);
      expect(reactionsAdd).toHaveBeenCalledWith({
        channel: 'D123',
        name: PRESENCE_EMOJI,
        timestamp: 'second',
      });
    });

    it('lets go of a binding whose question was never answered', () => {
      vi.useFakeTimers();
      queuePendingReaction(state, 'D123', 'asker');
      claimPresence(ctx);
      // The turn stops to ask something, and nobody ever replies.
      releasePresence(ctx, 'paused');
      expect(state.bindings.size).toBe(1);

      vi.advanceTimersByTime(ABANDONED_BINDING_TTL_MS + 1_000);
      // Any later claim sweeps it: an abandoned turn is not held for the life
      // of the process.
      queuePendingReaction(state, 'D999', 'unrelated');
      claimPresence({ ...ctx, channelId: 'D999', threadTs: '77.1', streamKeyTs: '77.1' });

      expect(state.bindings.has('D123:1234.0001')).toBe(false);
    });

    it('treats a later question on the same thread as a new turn', () => {
      vi.useFakeTimers();
      queuePendingReaction(state, 'D123', 'first');
      claimPresence(ctx);
      releasePresence(ctx, 'terminal');

      // Two turns in one Slack thread share a stream key — a person's follow-up
      // is a new turn, not an echo of the one that just ended.
      vi.advanceTimersByTime(30_000);
      queuePendingReaction(state, 'D123', 'second');
      claimPresence(ctx);

      expect(reactionsAdd).toHaveBeenLastCalledWith({
        channel: 'D123',
        name: PRESENCE_EMOJI,
        timestamp: 'second',
      });
    });
  });

  describe('the assistant surface and the shared queue', () => {
    it('drains its own trigger message, so later turns are not offset by one', () => {
      markAssistantThread(state, 'D123', '1234.0001');
      queuePendingReaction(state, 'D123', 'panel-question');
      queuePendingReaction(state, 'D123', 'channel-question');

      claimPresence(ctx);
      expect(setStatus).toHaveBeenCalled();
      expect(reactionsAdd).not.toHaveBeenCalled();
      // The panel turn's own message left the queue with it.
      expect(state.pendingReactions.get('D123')?.map((e) => e.ts)).toEqual(['channel-question']);

      releasePresence(ctx, 'terminal');
      claimPresence({ ...ctx, threadTs: '5555.0001', streamKeyTs: '5555.0001' });
      expect(reactionsAdd).toHaveBeenCalledWith({
        channel: 'D123',
        name: PRESENCE_EMOJI,
        timestamp: 'channel-question',
      });
    });
  });

  describe('the queue at claim time', () => {
    it('skips a message too old to be what this turn is answering', () => {
      vi.useFakeTimers();
      queuePendingReaction(state, 'D123', 'ancient');
      vi.advanceTimersByTime(PENDING_REACTION_TTL_MS + 1_000);

      // Nothing new queued, so the sweep on the way in never ran.
      claimPresence(ctx);

      expect(reactionsAdd).not.toHaveBeenCalled();
      expect(state.pendingReactions.has('D123')).toBe(false);
    });
  });
});
