import { describe, expect, it } from 'vitest';
import type { StreamEvent } from '../schemas.js';
import { createRunOutcomeTracker, isUnrequestedAbortFailure } from '../run-outcome.js';

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
  code?: string;
  category?: 'auth_error' | 'execution_error' | 'max_turns';
}): StreamEvent => ({ type: 'error', data });
/**
 * A terminal status carrying the runtime's own stop record beside the reason —
 * the claude-code shape once a runtime can say whether anyone ASKED for the
 * abort it is reporting.
 */
const abortStatus = (terminalReason: string, stopWasRequested: boolean): StreamEvent => ({
  type: 'session_status',
  data: { sessionId: 's1', terminalReason, stopWasRequested },
});

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

    it('is clean when the abort was one somebody ASKED for', () => {
      // The signal present and true: a person pressed Stop, the run is recorded
      // `cancelled` by its caller, and it must never also read as failed — even
      // though the stream carried an error frame on the way out.
      for (const reason of ['interrupted', 'aborted_streaming', 'aborted_tools']) {
        expect(
          settle([error({ message: 'aborted' }), abortStatus(reason, true), done()])
        ).toBeNull();
      }
    });

    it('is clean when an unrequested abort carried NOTHING to report', () => {
      // Both halves are required. A shutdown mid-turn is an abort nobody asked
      // for, but with no error frame there is no failure to tell anyone about —
      // the turn was cut short, which is what `cancelled` already says.
      expect(settle([text('working'), abortStatus('aborted_streaming', false), done()])).toBeNull();
    });

    it('is clean when an unrequested abort carried only a SURVIVABLE frame', () => {
      // A `hook_failure` never reaches the latch, so the unrequested abort has
      // no fatal frame to promote and stays a stop.
      expect(
        settle([
          error({ message: 'Hook "notify" failed (Stop)', code: 'hook_failure' }),
          abortStatus('aborted_streaming', false),
          done(),
        ])
      ).toBeNull();
    });
  });

  // The refusal case DOR-1320's review proved and DOR-1676 documented as a known
  // hole in both settlement readers: an API refusal aborts the main turn
  // controller directly, so the turn ends `aborted_streaming` while DorkOS never
  // asked for a stop. Read on shape alone, a run that BROKE at 3am was filed as
  // one somebody called off, and the refusal text went with it.
  describe('an abort NOBODY asked for', () => {
    it('fails the run and keeps the failure text', () => {
      for (const reason of ['interrupted', 'aborted_streaming', 'aborted_tools']) {
        expect(
          settle([
            text('starting'),
            error({ message: 'Claude refused to continue', category: 'execution_error' }),
            abortStatus(reason, false),
            done(),
          ])
        ).toBe('Claude refused to continue');
      }
    });

    it('still leads with the sign-in instruction when the refusal was a dead credential', () => {
      expect(
        settle([
          error({ message: '401 Unauthorized', category: 'auth_error' }),
          abortStatus('aborted_streaming', false),
          done(),
        ])
      ).toBe('Sign in again: 401 Unauthorized');
    });

    it('does not inherit an earlier stop record across a reopened window', () => {
      // Built to actually discriminate. The second window must end on an ABORT
      // that names NO record of its own: only then does a stale `false` from the
      // first window change the answer, flipping a second abort nobody can speak
      // for into a reported failure. Closing window two with `completed` would
      // have proved nothing, because an absolving reason answers `null` whatever
      // the record says.
      //
      // What clears it is the PAIR-LATCH, not the reopen: the record is only
      // ever read beside a reason, and setting a reason rewrites the record in
      // the same statement. See the tracker's reset block for why it therefore
      // needs no reset of its own while the session normalizer's twin does.
      expect(
        settle([
          error({ message: 'refused' }),
          abortStatus('aborted_streaming', false),
          done(),
          text('picking it back up'),
          error({ message: 'a second, unattributable abort' }),
          status('aborted_streaming'),
          done(),
        ])
      ).toBeNull();
    });

    it('does not inherit an earlier ENDING stop record within one window', () => {
      // Reason and record are latched as a pair, so a later reason arriving with
      // no record of its own clears the record rather than keeping the old one.
      // Degrading to "unknown intent" is the safe direction.
      expect(
        settle([
          error({ message: 'refused' }),
          abortStatus('aborted_streaming', false),
          status('aborted_tools'),
          done(),
        ])
      ).toBeNull();
    });
  });

  describe('isUnrequestedAbortFailure', () => {
    it('accuses only on a POSITIVE denial paired with a fatal frame', () => {
      expect(isUnrequestedAbortFailure(false, true)).toBe(true);
      expect(isUnrequestedAbortFailure(false, false)).toBe(false);
      expect(isUnrequestedAbortFailure(true, true)).toBe(false);
      expect(isUnrequestedAbortFailure(true, false)).toBe(false);
    });

    it('never accuses on an ABSENT signal, however bad the frame', () => {
      // The degradation pin. Codex, OpenCode and every turn recorded before the
      // field existed report no stop record; reading silence as "nobody asked"
      // would turn every operator Stop on those runtimes into a crash.
      expect(isUnrequestedAbortFailure(undefined, true)).toBe(false);
      expect(isUnrequestedAbortFailure(undefined, false)).toBe(false);
    });

    it('is clean when the only error came from an operator hook, not the turn', () => {
      // `hook_failure` is the runtime escalating a non-zero exit from the
      // operator's own Stop/SubagentStop/SessionStart hook. The turn then ends
      // normally carrying the whole answer, so failing the run for it would ping
      // the operator (`run.completed` is `relay: 'always'` on a failure) about a
      // run that did exactly what it was asked.
      expect(
        settle([
          text('the whole answer'),
          error({ message: 'Hook "notify" failed (Stop)', code: 'hook_failure' }),
          done(),
        ])
      ).toBeNull();
    });

    it('is clean when the turn deferred a tool or went to the background', () => {
      // All three ride SDKResultSuccess: the turn handed work off and will be
      // back for it, so a recovered error before the hand-off is not a failure.
      for (const reason of ['tool_deferred', 'tool_deferred_unavailable', 'background_requested']) {
        expect(
          settle([
            error({ message: 'a tool blew up' }),
            text('handing off'),
            status(reason),
            done(),
          ])
        ).toBeNull();
      }
    });

    it('still fails when a hook failure sits beside a REAL error', () => {
      // The denylist drops the survivable frame; it does not absolve the window.
      expect(
        settle([
          error({ message: 'Hook "notify" failed (Stop)', code: 'hook_failure' }),
          error({ message: 'API Error: 500 upstream' }),
          done(),
        ])
      ).toBe('API Error: 500 upstream');
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

    it('DROPS an error that arrives after the last window closed, mirroring feedProjector', () => {
      // Pinning current intent, not asserting it is the only defensible answer.
      // An `error` does not reopen a window (only content events do), so this
      // frame belongs to no window and settles nothing — exactly what the
      // session normalizer does with it. If a runtime is ever seen reporting a
      // real turn failure this way, this test is the one to revisit.
      expect(
        settle([
          text('all done'),
          status('completed'),
          done(),
          error({ message: 'arrived too late to belong to anything' }),
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
