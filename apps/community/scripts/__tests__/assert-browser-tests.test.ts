import { describe, expect, it } from 'vitest';
import type { JSONReport } from '@playwright/test/reporter';
import { assertBrowserTests } from '../assert-browser-tests.js';

function fixture(): JSONReport {
  return {
    config: { shard: null },
    errors: [],
    stats: { expected: 2, unexpected: 0, skipped: 0, flaky: 0 },
    suites: ['pairing.spec.ts', 'community.spec.ts'].map((file) => ({
      file,
      specs: [
        {
          file,
          ok: true,
          tests: [
            {
              expectedStatus: 'passed',
              status: 'expected',
              results: [{ status: 'passed' }],
            },
          ],
        },
      ],
    })),
  } as unknown as JSONReport;
}
const files = ['pairing.spec.ts', 'community.spec.ts'];

describe('community browser execution proof', () => {
  it('counts a complete successful run', () => {
    expect(assertBrowserTests(fixture(), files)).toBe(2);
  });
  it('rejects a green report that omitted a spec', () => {
    const report = fixture();
    report.suites.pop();
    report.stats.expected = 1;
    expect(() => assertBrowserTests(report, files)).toThrow('every community spec');
  });
  it('rejects skipped and expected-failure tests even if the runner calls them successful', () => {
    for (const status of ['skipped', 'failed'] as const) {
      const report = fixture();
      report.suites[0].specs[0].tests[0].expectedStatus = status;
      report.suites[0].specs[0].tests[0].results[0].status = status;
      expect(() => assertBrowserTests(report, files)).toThrow('pass once');
    }
  });
  it('rejects a failure hidden by a passing retry', () => {
    const report = fixture();
    const test = report.suites[0].specs[0].tests[0];
    test.results.unshift({ ...test.results[0], status: 'failed' });
    expect(() => assertBrowserTests(report, files)).toThrow('pass once');
  });
  it('rejects a partial shard and an empty spec census', () => {
    const report = fixture();
    report.config.shard = { current: 1, total: 2 };
    expect(() => assertBrowserTests(report, files)).toThrow('complete');
    expect(() => assertBrowserTests(fixture(), [])).toThrow('complete');
  });
});
