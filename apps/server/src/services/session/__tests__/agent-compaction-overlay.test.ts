/**
 * Putting "asked by the agent" back on a reopened conversation (DOR-2732).
 */
import { describe, it, expect } from 'vitest';
import type { HistoryMessage } from '@dorkos/shared/types';
import { applyAgentCompactions } from '../overlays/agent-compaction-overlay.js';
import type { RecordedAgentCompaction } from '../session-event-store.js';

/** A recorded agent-requested boundary written at `createdAt`. */
function row(seq: number, createdAt: string, contextPercent = 89): RecordedAgentCompaction {
  return {
    event: {
      type: 'compact_boundary',
      seq,
      trigger: 'manual',
      preTokens: 178_000,
      requestedBy: 'agent',
      contextPercent,
    } as RecordedAgentCompaction['event'],
    createdAt,
  };
}

const user = (id: string, timestamp: string): HistoryMessage => ({
  id,
  role: 'user',
  content: id,
  timestamp,
});
const compaction = (id: string, meta?: HistoryMessage['compactMetadata']): HistoryMessage => ({
  id,
  role: 'user',
  content: 'This session is being continued…',
  messageType: 'compaction',
  ...(meta ? { compactMetadata: meta } : {}),
});

describe('applyAgentCompactions', () => {
  it('returns history untouched when the agent never asked', () => {
    const messages = [user('m1', '2026-10-06T10:00:00.000Z')];
    expect(applyAgentCompactions(messages, [])).toBe(messages);
  });

  it('tags the compaction the agent asked for, keeping the transcript’s own figures', () => {
    const messages = [
      user('m1', '2026-10-06T10:00:00.000Z'),
      compaction('c-person', { trigger: 'manual', preTokens: 90_000 }),
      user('m2', '2026-10-06T11:00:00.000Z'),
      compaction('c-agent', { trigger: 'manual', preTokens: 178_500 }),
      user('m3', '2026-10-06T11:10:00.000Z'),
    ];

    const result = applyAgentCompactions(messages, [row(40, '2026-10-06T11:05:00.000Z')]);

    expect(result.map((m) => m.id)).toEqual(['m1', 'c-person', 'm2', 'c-agent', 'm3']);
    expect(result[1]!.compactMetadata?.requestedBy).toBeUndefined();
    expect(result[3]!.compactMetadata).toEqual({
      trigger: 'manual',
      preTokens: 178_500,
      requestedBy: 'agent',
      contextPercent: 89,
    });
  });

  it('draws a compaction row of its own where the history has none to tag', () => {
    const messages = [
      user('m1', '2026-10-06T10:00:00.000Z'),
      user('m2', '2026-10-06T12:00:00.000Z'),
    ];

    const result = applyAgentCompactions(messages, [row(7, '2026-10-06T11:00:00.000Z', 91)]);

    expect(result.map((m) => m.id)).toEqual(['m1', 'agent-compaction-7', 'm2']);
    expect(result[1]).toMatchObject({
      messageType: 'compaction',
      compactMetadata: { requestedBy: 'agent', contextPercent: 91 },
    });
  });
});
