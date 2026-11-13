/** The undelivered-report helper raises a content-free Inbox card. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../notifications/notification-service.js', () => ({ notify: vi.fn() }));
vi.mock('../../../core/runtime-registry.js', () => ({
  runtimeRegistry: { getSessionAgentPath: vi.fn() },
}));
vi.mock('../../../mesh/agent-path-lookup.js', () => ({ resolveAgentIdForPath: vi.fn() }));

import { resolveAgentIdForPath } from '../../../mesh/agent-path-lookup.js';
import { notify } from '../../../notifications/notification-service.js';
import { runtimeRegistry } from '../../../core/runtime-registry.js';
import { REPORT_UNDELIVERED_ENTRIES } from '../report-undelivered-notice.js';
import { notifyUndeliveredReport } from '../report-undelivered.js';

const chatTitleOf = vi.fn<(id: string) => Promise<string | null>>();

const REPORT = {
  sessionId: 'spin-off-1',
  parentSessionId: 'parent-1',
  reason: 'finished',
} as const;

describe('notifyUndeliveredReport', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-13T17:00:00.000Z'));
    chatTitleOf.mockResolvedValue('Research follow-up');
    vi.mocked(runtimeRegistry.getSessionAgentPath).mockResolvedValue('/agents/research');
    vi.mocked(resolveAgentIdForPath).mockReturnValue('agent-1');
    vi.mocked(notify).mockResolvedValue({ notification: null, deduped: false });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.resetAllMocks();
  });

  it('raises one card with the chat title and no report text', async () => {
    await notifyUndeliveredReport(REPORT, chatTitleOf);

    expect(notify).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalledWith('report.undelivered', {
      sessionId: 'spin-off-1',
      parentSessionId: 'parent-1',
      sessionLabel: 'Research follow-up',
      agentId: 'agent-1',
      reason: 'finished',
      at: '2026-11-13T17:00:00.000Z',
    });
    expect(vi.mocked(notify).mock.calls[0]![1]).not.toHaveProperty('text');
  });

  it('uses the spin-off fallback when the chat has no title', async () => {
    chatTitleOf.mockResolvedValue(null);

    await notifyUndeliveredReport(REPORT, chatTitleOf);

    expect(notify).toHaveBeenCalledWith(
      'report.undelivered',
      expect.objectContaining({ sessionLabel: 'A spin-off chat' })
    );
  });

  it('still raises the card without an agent when lookup fails', async () => {
    vi.mocked(resolveAgentIdForPath).mockImplementation(() => {
      throw new Error('lookup unavailable');
    });

    await notifyUndeliveredReport(REPORT, chatTitleOf);

    expect(notify).toHaveBeenCalledOnce();
    expect(vi.mocked(notify).mock.calls[0]![1]).not.toHaveProperty('agentId');
  });
});

it('writes the undelivered report card with its exact copy and action', () => {
  const entry = REPORT_UNDELIVERED_ENTRIES['report.undelivered'];
  const payload = {
    ...REPORT,
    sessionLabel: 'Weekly invoice cleanup for the north region',
    at: '2026-11-13T17:00:00.000Z',
  };

  expect(entry.title(payload)).toBe(
    "A report from Weekly invoice cleanup for the north region didn't arrive"
  );
  expect(entry.body?.(payload)).toBe(
    'It never reached the chat that started it. Open the chat to read it.'
  );
  expect(entry.actions?.(payload)).toEqual([
    { id: 'open-chat', label: 'Open chat', style: 'primary' },
  ]);
});
