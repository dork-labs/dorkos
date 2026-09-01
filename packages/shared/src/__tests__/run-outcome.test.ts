import { describe, expect, it } from 'vitest';
import type { StreamEvent } from '../schemas.js';
import { createRunOutcomeTracker } from '../run-outcome.js';

/** Feed a whole stream to a fresh tracker and settle it, the way a run does. */
function settle(events: StreamEvent[]): string | null {
  const tracker = createRunOutcomeTracker();
  for (const event of events) tracker.observe(event);
  return tracker.settle();
}

const text = (t: string): StreamEvent => ({ type: 'text_delta', data: { text: t } });
const done = (): StreamEvent => ({ type: 'done', data: { sessionId: 's1' } });
const status = (terminalReason?: string): StreamEvent => ({
  type: 'session_status',
  data: { sessionId: 's1', ...(terminalReason ? { terminalReason } : {}) },
});
const error = (data: {
  message: string;
  category?: 'auth_error' | 'execution_error' | 'max_turns';
}): StreamEvent => ({ type: 'error', data });

describe('createRunOutcomeTracker', () => {
  describe('a turn that settled to an error', () => {
    it('fails when the runtime named no reason and the stream just ended (OpenCode shape)', () => {
      expect(settle([text('working'), error({ message: 'Provider refused the request' })])).toBe(
        'Provider refused the request'
      );
    });

    it('fails when the runtime closed with the turn-failure reason (Codex shape)', () => {
      expect(
        settle([
          status('error'),
          error({ message: 'thread crashed', category: 'execution_error' }),
          done(),
        ])
      ).toBe('thread crashed');
    });

    it('fails when the SDK named its OWN failure reason beside the error (Claude Code shape)', () => {
      // The exact regression: `deriveTurnEndLifecycle` treats only
      // `terminalReason: 'error'` as terminal, so a reason the SDK picked for
      // itself would otherwise absolve a turn that plainly failed.
      expect(
        settle([
          status('model_error'),
          error({ message: 'the model errored', category: 'execution_error' }),
          done(),
        ])
      ).toBe('the model errored');
    });

    it('says something readable when the reason says error but no frame named one', () => {
      expect(settle([status('error'), done()])).toBe('Run stopped with an error');
    });
  });

  describe('a turn that did NOT settle to an error', () => {
    it('is clean when nothing went wrong', () => {
      expect(settle([text('all good'), status('completed'), done()])).toBeNull();
    });

    it('is clean when the stream simply ended with no terminal event at all', () => {
      expect(settle([text('all good')])).toBeNull();
    });

    it('is clean when a mid-turn error was RECOVERED and the turn completed', () => {
      expect(
        settle([
          error({ message: 'a tool blew up', category: 'execution_error' }),
          text('recovered, carried on'),
          status('completed'),
          done(),
        ])
      ).toBeNull();
    });

    it('is clean when the turn was cut short — a stop is not a failure', () => {
      for (const reason of ['interrupted', 'aborted_streaming', 'aborted_tools']) {
        expect(settle([error({ message: 'aborted' }), status(reason), done()])).toBeNull();
      }
    });
  });

  describe('a stream carrying more than one turn window', () => {
    it('forgets a closed window failure when the runtime picks the work back up and finishes', () => {
      expect(
        settle([
          error({ message: 'first window died' }),
          done(),
          // The runtime woke itself up (DOR-1100) and did the work.
          text('second window'),
          status('completed'),
          done(),
        ])
      ).toBeNull();
    });

    it('reports the LAST window failing even after a clean earlier one', () => {
      expect(
        settle([
          text('first window'),
          status('completed'),
          done(),
          text('second window'),
          error({ message: 'second window died' }),
          done(),
        ])
      ).toBe('second window died');
    });
  });

  describe('what a person reads', () => {
    it('leads an expired sign-in with what to do about it', () => {
      expect(
        settle([error({ message: 'API Error: 401 Unauthorized', category: 'auth_error' })])
      ).toBe('Sign in again: API Error: 401 Unauthorized');
    });

    it('passes an ordinary failure through in the words the runtime used', () => {
      expect(settle([error({ message: 'ENOENT: no such file' })])).toBe('ENOENT: no such file');
    });
  });

  it('answers the same thing however many times it is asked', () => {
    const tracker = createRunOutcomeTracker();
    tracker.observe(error({ message: 'boom' }));
    expect(tracker.settle()).toBe('boom');
    expect(tracker.settle()).toBe('boom');
  });
});
