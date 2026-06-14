import { describe, it, expect } from 'vitest';
import type { HistoryMessage } from '@dorkos/shared/types';
import { mapHistoryMessage } from '../stream-history-helpers';

describe('mapHistoryMessage', () => {
  it('carries compaction metadata through to the ChatMessage (DOR-118)', () => {
    // Regression: the mapper previously copied messageType but dropped
    // compactMetadata, so the durable compaction row rendered with no token
    // count or trigger even though the transcript recorded them.
    const history: HistoryMessage = {
      id: 'c1',
      role: 'user',
      content: 'This session is being continued from a previous conversation...',
      messageType: 'compaction',
      compactMetadata: { trigger: 'manual', preTokens: 50115, postTokens: 1677, durationMs: 35623 },
    };
    const mapped = mapHistoryMessage(history);
    expect(mapped.messageType).toBe('compaction');
    expect(mapped.compactMetadata).toEqual({
      trigger: 'manual',
      preTokens: 50115,
      postTokens: 1677,
      durationMs: 35623,
    });
  });

  it('leaves compactMetadata undefined for ordinary messages', () => {
    const mapped = mapHistoryMessage({ id: 'u1', role: 'user', content: 'hello' });
    expect(mapped.compactMetadata).toBeUndefined();
  });
});
