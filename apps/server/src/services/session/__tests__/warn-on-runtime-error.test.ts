import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { StreamEvent } from '@dorkos/shared/types';

vi.mock('../../../lib/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
  logError: vi.fn(() => ({})),
}));

import { logger } from '../../../lib/logger.js';
import { warnOnRuntimeError } from '../turn-stream/tap-each-event.js';

describe('warnOnRuntimeError (DOR-3167)', () => {
  beforeEach(() => vi.mocked(logger.warn).mockClear());

  it('logs a refusal with the session and the runtime', () => {
    const refusal = {
      type: 'error',
      data: { message: 'Model refused.', code: 'turn_failed', category: 'model_unavailable' },
    } as StreamEvent;

    warnOnRuntimeError(refusal, 's1', 'codex');

    expect(logger.warn).toHaveBeenCalledWith(
      '[turn] the runtime reported an error',
      expect.objectContaining({
        sessionId: 's1',
        runtime: 'codex',
        code: 'turn_failed',
        category: 'model_unavailable',
        message: 'Model refused.',
      })
    );
  });

  it('says nothing for any other event', () => {
    warnOnRuntimeError({ type: 'done', data: { sessionId: 's1' } } as StreamEvent, 's1', 'codex');

    expect(logger.warn).not.toHaveBeenCalled();
  });
});
