/** The undelivered-report helper raises a content-free Inbox card (DOR-3561). */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REPORT_UNDELIVERED_ENTRIES } from '../report-undelivered-notice.js';
import { notifyUndeliveredReport, type UndeliveredReportDeps } from '../report-undelivered.js';

const REPORT = {
  sessionId: 'spin-off-1',
  parentSessionId: 'parent-1',
  reason: 'finished',
} as const;

/** Fakes for every lookup, each test overriding what it is about. */
function deps(over: Partial<UndeliveredReportDeps> = {}) {
  const notify = vi.fn().mockResolvedValue({ notification: null, deduped: true });
  const all: UndeliveredReportDeps = {
    titleOf: async () => 'Research follow-up',
    agentPathOf: async () => '/agents/research',
    agentIdOf: () => 'agent-1',
    notify: notify as unknown as UndeliveredReportDeps['notify'],
    ...over,
  };
  return { all, notify };
}

describe('notifyUndeliveredReport', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-13T17:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('raises one card with the chat title and no report text', async () => {
    const { all, notify } = deps();
    await notifyUndeliveredReport(REPORT, all);

    expect(notify).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalledWith('report.undelivered', {
      sessionId: 'spin-off-1',
      parentSessionId: 'parent-1',
      sessionLabel: 'Research follow-up',
      agentId: 'agent-1',
      reason: 'finished',
      at: '2026-11-13T17:00:00.000Z',
    });
    expect(notify.mock.calls[0]![1]).not.toHaveProperty('text');
  });

  it('uses the spin-off fallback when the chat has no title', async () => {
    const { all, notify } = deps({ titleOf: async () => null });
    await notifyUndeliveredReport(REPORT, all);

    expect(notify).toHaveBeenCalledWith(
      'report.undelivered',
      expect.objectContaining({ sessionLabel: 'A spin-off chat' })
    );
  });

  it('still raises the card without an agent when lookup fails', async () => {
    const { all, notify } = deps({
      agentIdOf: () => {
        throw new Error('lookup unavailable');
      },
    });
    await notifyUndeliveredReport(REPORT, all);

    expect(notify).toHaveBeenCalledOnce();
    expect(notify.mock.calls[0]![1]).not.toHaveProperty('agentId');
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

it('keeps the terminal cursor retryable when notification storage returns no receipt', async () => {
  const { all, notify } = deps();
  notify.mockResolvedValue({ notification: null, deduped: false });
  await expect(notifyUndeliveredReport(REPORT, all)).rejects.toThrow('notification');
});

it('deduplicates a recovered notice by report identity and never claims ambiguous delivery was absent', async () => {
  const { all, notify } = deps();
  const report = {
    ...REPORT,
    reportId: 'durable-report',
    at: '2026-11-20T12:00:00.000Z',
    deliveryUnknown: true,
  };
  await notifyUndeliveredReport(report, all);
  const payload = notify.mock.calls[0]![1];
  const entry = REPORT_UNDELIVERED_ENTRIES['report.undelivered'];
  expect(entry.dedupeKey?.(payload)).toBe('report-undelivered:durable-report');
  expect(entry.title(payload)).toContain('needs checking');
  expect(entry.body?.(payload)).toContain('couldn’t be confirmed');
  expect(payload.at).toBe(report.at);
});

it('names a recovery save problem without claiming the live report was lost', async () => {
  const { all, notify } = deps();
  await notifyUndeliveredReport({ ...REPORT, recoveryUnavailable: true }, all);
  const payload = notify.mock.calls[0]![1];
  const entry = REPORT_UNDELIVERED_ENTRIES['report.undelivered'];
  expect(entry.title(payload)).toBe('Report recovery unavailable');
  expect(entry.body?.(payload)).toBe(
    'This report can’t resume after a restart. Open the chat to check it.'
  );
});
