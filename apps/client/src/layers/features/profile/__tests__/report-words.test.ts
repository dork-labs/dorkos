/**
 * The next report, in words (spec `heartbeats` §9.3, §14).
 */
import { describe, expect, it } from 'vitest';
import { reportSentence } from '../lib/report-words';

const report = { cadence: 'daily' as const, to: 'owner', nextReportAt: null, items: 0 };

describe('reportSentence', () => {
  it('names the reader, the rhythm and the count', () => {
    expect(reportSentence({ ...report, items: 1 }, 'you')).toBe(
      'Reports to you each workday. 1 item so far.'
    );
    expect(reportSentence({ ...report, cadence: 'weekly', items: 4 }, 'Ana')).toBe(
      'Reports to Ana each week. 4 items so far.'
    );
    expect(reportSentence(report, 'you')).toBe(
      'Reports to you each workday. Nothing to report yet.'
    );
  });

  it('says plainly when the agent sends no reports', () => {
    expect(reportSentence({ ...report, cadence: 'off' }, 'you')).toBe('Sends no reports.');
  });
});
