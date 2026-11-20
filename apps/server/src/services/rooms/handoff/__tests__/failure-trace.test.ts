import { afterEach, describe, expect, it, vi } from 'vitest';
import { logger } from '../../../../lib/logger.js';
import { logHandoffFailure, type HandoffTrace } from '../failure-trace.js';
const trace: HandoffTrace = {
  handoffId: 'handoff-fixture',
  roomId: 'room-fixture',
  authorId: 'author-fixture',
  dispatchId: 'dispatch-fixture',
  attempt: 0,
  oldSessionId: 'seat-fixture',
};
afterEach(() => vi.restoreAllMocks());
describe('handoff trace severity', () => {
  it('records an ordinary refusal at debug without warning or quoting the draft', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const debug = vi.spyOn(logger, 'debug').mockImplementation(() => {});
    logHandoffFailure(trace, { outcome: 'quiet', text: 'The room already heard this.' });
    expect(warn).not.toHaveBeenCalled();
    expect(debug).toHaveBeenCalledWith(
      '[rooms] handoff did not post',
      expect.objectContaining({ handoffId: trace.handoffId, typedCause: 'declined' })
    );
    expect(JSON.stringify(debug.mock.calls)).not.toContain('The room already heard this.');
  });
  it('keeps a structured warning for an actual failed turn without forwarding its diagnostic', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    logHandoffFailure(trace, {
      outcome: 'failed',
      text: null,
      failure: { code: 'exception', detail: 'fabricated private diagnostic' },
    });
    expect(warn).toHaveBeenCalledWith(
      '[rooms] handoff did not post',
      expect.objectContaining({ handoffId: trace.handoffId, typedCause: 'exception' })
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain('fabricated private diagnostic');
  });
  it.each(['gone', 'left', 'unavailable', 'runtime-gone', 'paused'] as const)(
    'keeps an operational %s refusal at warning without requiring failure fields',
    (outcome) => {
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      const debug = vi.spyOn(logger, 'debug').mockImplementation(() => {});
      logHandoffFailure(trace, { outcome, text: null });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(debug).not.toHaveBeenCalled();
    }
  );
  it('does not quiet a protected refusal even when its outcome says quiet', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    logHandoffFailure(trace, {
      outcome: 'quiet',
      text: null,
      failure: { refusal: 'pending-interaction', detail: 'Fixture interaction is still pending.' },
    });
    expect(warn).toHaveBeenCalledTimes(1);
  });
  it('keeps a deliberate acknowledgment without a draft at debug', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const debug = vi.spyOn(logger, 'debug').mockImplementation(() => {});
    logHandoffFailure(trace, { outcome: 'answered', text: 'Already acknowledged.' });
    expect(warn).not.toHaveBeenCalled();
    expect(debug).toHaveBeenCalledTimes(1);
  });
  it('preserves the warning when no turn result is available', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    logHandoffFailure(trace, null);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
