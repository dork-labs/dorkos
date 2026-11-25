import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createSlackPresenceState,
  queuePendingReaction,
  markAssistantThread,
  clearAllPresence,
  PRESENCE_EMOJI,
  WORKING_STATUS,
  WORKING_LATE_STATUS,
  PRESENCE_LATE_MS,
  PRESENCE_REFRESH_MS,
  PRESENCE_INACTIVITY_MS,
} from '../presence.js';
import type { SlackPresenceState } from '../presence.js';
import {
  createEnvelope,
  deliver,
  env,
  h,
  mockReactionsAdd,
  mockReactionsRemove,
  mockSetStatus,
  resetOutboundHarness,
} from './outbound.fixtures.js';

describe('deliverMessage', () => {
  beforeEach(() => {
    resetOutboundHarness();
  });

  describe('working presence — :eyes: at claim', () => {
    let presence: SlackPresenceState;

    beforeEach(() => {
      presence = createSlackPresenceState();
    });

    afterEach(() => {
      clearAllPresence(presence);
    });

    /** A runtime stream event for a turn in flight. */
    function turnEvent(
      ts: string,
      type = 'text_delta',
      data: Record<string, unknown> = { text: 'x' }
    ) {
      return env({
        type,
        data,
        platformData: { ts },
      });
    }

    /** Deliver one envelope with presence wired in. */
    function deliverWith(
      envelope: ReturnType<typeof createEnvelope>,
      typingIndicator: 'none' | 'reaction' = 'reaction'
    ) {
      return deliver(envelope, { typingIndicator, presence });
    }

    it('adds :eyes: to the trigger message when the turn claims it, not when the message arrives', async () => {
      queuePendingReaction(presence, 'D123', '1234.0001');

      // The message has arrived and is queued — nothing is shown yet.
      expect(mockReactionsAdd).not.toHaveBeenCalled();

      await deliverWith(turnEvent('1234.0001'));

      expect(mockReactionsAdd).toHaveBeenCalledTimes(1);
      expect(mockReactionsAdd).toHaveBeenCalledWith({
        channel: 'D123',
        name: PRESENCE_EMOJI,
        timestamp: '1234.0001',
      });
    });

    it.each([
      ['done', {}],
      ['error', { message: 'failed' }],
    ] as const)('removes the reaction at %s', async (terminal, data) => {
      queuePendingReaction(presence, 'D123', '1234.0001');
      await deliverWith(turnEvent('1234.0001'));
      await deliverWith(turnEvent('1234.0001', terminal, data));

      expect(mockReactionsRemove).toHaveBeenCalledWith({
        channel: 'D123',
        name: PRESENCE_EMOJI,
        timestamp: '1234.0001',
      });
    });

    it('an approval pause gives the mark back to the same message, never the next one', async () => {
      queuePendingReaction(presence, 'D123', '1234.0001');
      queuePendingReaction(presence, 'D123', '1234.0002');

      await deliverWith(turnEvent('1234.0001'));
      await deliverWith(
        turnEvent('1234.0001', 'approval_required', {
          toolCallId: 'tc-1',
          toolName: 'Bash',
          input: 'ls',
        })
      );
      // The turn resumes after the person answers.
      await deliverWith(turnEvent('1234.0001'));
      await deliverWith(turnEvent('1234.0001', 'done', {}));

      const touched = [...mockReactionsAdd.mock.calls, ...mockReactionsRemove.mock.calls].map(
        (c) => c[0].timestamp
      );
      // The asker's message was marked, unmarked, re-marked and cleaned up...
      expect(touched).toEqual(['1234.0001', '1234.0001', '1234.0001', '1234.0001']);
      // ...and nobody else's message was touched, or lost its place in the queue.
      expect(presence.pendingReactions.get('D123')?.map((e) => e.ts)).toEqual(['1234.0002']);
    });

    it('two interleaved turns remove the reaction from the right message (FIFO)', async () => {
      queuePendingReaction(presence, 'D123', '1234.0001');
      queuePendingReaction(presence, 'D123', '1234.0002');

      // Both turns start before either finishes.
      await deliverWith(turnEvent('1234.0001'));
      await deliverWith(turnEvent('1234.0002'));

      expect(mockReactionsAdd.mock.calls.map((c) => c[0].timestamp)).toEqual([
        '1234.0001',
        '1234.0002',
      ]);

      // The second turn finishes first — its own message loses the reaction.
      await deliverWith(turnEvent('1234.0002', 'done', {}));
      expect(mockReactionsRemove).toHaveBeenCalledTimes(1);
      expect(mockReactionsRemove).toHaveBeenLastCalledWith({
        channel: 'D123',
        name: PRESENCE_EMOJI,
        timestamp: '1234.0002',
      });

      await deliverWith(turnEvent('1234.0001', 'done', {}));
      expect(mockReactionsRemove).toHaveBeenLastCalledWith({
        channel: 'D123',
        name: PRESENCE_EMOJI,
        timestamp: '1234.0001',
      });
    });

    describe('assistant split panel — status, not reaction', () => {
      it('sets a working status at claim and clears it at the terminal', async () => {
        markAssistantThread(presence, 'D123', '1234.0001');
        queuePendingReaction(presence, 'D123', '1234.0001');

        await deliverWith(turnEvent('1234.0001'));
        expect(mockSetStatus).toHaveBeenCalledWith({
          channel_id: 'D123',
          thread_ts: '1234.0001',
          status: WORKING_STATUS,
        });
        // The status IS the indicator here — no emoji on top of it.
        expect(mockReactionsAdd).not.toHaveBeenCalled();

        await deliverWith(turnEvent('1234.0001', 'done', {}));
        expect(mockSetStatus).toHaveBeenLastCalledWith({
          channel_id: 'D123',
          thread_ts: '1234.0001',
          status: '',
        });
      });

      it('says it is running long exactly once, and says nothing after the terminal', async () => {
        vi.useFakeTimers();
        try {
          markAssistantThread(presence, 'D123', '1234.0001');
          await deliverWith(turnEvent('1234.0001'));
          expect(mockSetStatus).toHaveBeenCalledWith({
            channel_id: 'D123',
            thread_ts: '1234.0001',
            status: WORKING_STATUS,
          });

          // The turn keeps reporting in, so it is never released as stalled.
          for (
            let elapsed = 0;
            elapsed < PRESENCE_LATE_MS + PRESENCE_REFRESH_MS;
            elapsed += 10_000
          ) {
            h.now += 10_000;
            await vi.advanceTimersByTimeAsync(10_000);
            await deliverWith(turnEvent('1234.0001'));
          }

          const statuses = mockSetStatus.mock.calls.map((c) => c[0].status as string);
          const firstLate = statuses.indexOf(WORKING_LATE_STATUS);
          expect(firstLate).toBeGreaterThan(0);
          // Once it has run long it never goes back to claiming it is on pace.
          expect(statuses.slice(firstLate)).not.toContain(WORKING_STATUS);

          await deliverWith(turnEvent('1234.0001', 'done', {}));
          expect(mockSetStatus).toHaveBeenLastCalledWith({
            channel_id: 'D123',
            thread_ts: '1234.0001',
            status: '',
          });

          const callsAtTerminal = mockSetStatus.mock.calls.length;
          h.now += PRESENCE_REFRESH_MS * 4 + PRESENCE_LATE_MS;
          await vi.advanceTimersByTimeAsync(PRESENCE_REFRESH_MS * 4 + PRESENCE_LATE_MS);
          expect(mockSetStatus).toHaveBeenCalledTimes(callsAtTerminal);
        } finally {
          vi.useRealTimers();
        }
      });
    });

    it('releases a claim whose stream goes dark, so nothing lingers', async () => {
      vi.useFakeTimers();
      try {
        queuePendingReaction(presence, 'D123', '1234.0001');
        await deliverWith(turnEvent('1234.0001'));
        expect(mockReactionsRemove).not.toHaveBeenCalled();

        // No further events: the stream has stalled without a terminal.
        h.now += PRESENCE_INACTIVITY_MS + PRESENCE_REFRESH_MS;
        await vi.advanceTimersByTimeAsync(PRESENCE_REFRESH_MS * 2);

        expect(mockReactionsRemove).toHaveBeenCalledWith({
          channel: 'D123',
          name: PRESENCE_EMOJI,
          timestamp: '1234.0001',
        });
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
