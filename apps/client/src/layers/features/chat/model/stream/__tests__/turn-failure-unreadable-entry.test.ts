import { describe, it, expect } from 'vitest';
import { UNREADABLE_ENTRY_ERROR_CODE } from '@dorkos/shared/run-outcome';
import type { MessagePart } from '@dorkos/shared/types';
import type { ChatMessage } from '../../chat-types';
import { shouldShowTurnFailedNotice } from '../turn-failure';

function msg(role: 'user' | 'assistant', parts: MessagePart[] = []): ChatMessage {
  return {
    id: `${role}-${parts.length}`,
    role,
    content: '',
    parts,
    timestamp: '2026-09-15T00:00:00Z',
  };
}

describe('shouldShowTurnFailedNotice with unreadable-entry notes (DOR-2078)', () => {
  it('still shows the notice when the only error part in the failed turn is a placeholder', () => {
    // Real failure mode: a placeholder for an old damaged message counted as the
    // failure's own affordance, so a turn that really failed showed no notice.
    const note: MessagePart = {
      type: 'error',
      message: 'This part of the conversation couldn’t be shown.',
      code: UNREADABLE_ENTRY_ERROR_CODE,
    };

    expect(shouldShowTurnFailedNotice('error', null, [msg('user'), msg('assistant', [note])])).toBe(
      true
    );
  });

  it('still defers to a real inline error part', () => {
    const real: MessagePart = { type: 'error', message: 'boom', category: 'execution_error' };

    expect(shouldShowTurnFailedNotice('error', null, [msg('user'), msg('assistant', [real])])).toBe(
      false
    );
  });
});
