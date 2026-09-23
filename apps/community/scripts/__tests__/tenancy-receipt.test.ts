import { describe, expect, it } from 'vitest';
import {
  assertProofsPassed,
  playwrightResults,
  runnerFor,
  titleMatches,
  vitestResults,
  type ReceiptEntry,
} from '../tenancy-receipt.js';

const file = 'apps/community/src/__tests__/example.integration.test.ts';
const entries: ReceiptEntry[] = [
  { id: 'M1', requirement: 'x', proofs: [{ file, title: 'proves the row' }] },
];

function pgReport(assertions: [string, string][]) {
  return {
    testResults: [
      {
        name: `/checkout/${file}`,
        assertionResults: assertions.map(([title, status]) => ({ title, status })),
      },
    ],
  };
}

describe('runnerFor', () => {
  it('refuses files no receipt runner executes', () => {
    expect(runnerFor(file)).toBe('pg');
    expect(runnerFor('apps/community/browser-tests/switching.spec.ts')).toBe('browser');
    expect(runnerFor('apps/server/src/a/__tests__/b.test.ts')).toBe('unit');
    for (const outside of [
      'apps/community/src/__tests__/attachments.s3.test.ts',
      'apps/community/acceptance/driver.spec.ts',
      'packages/shared/src/__tests__/x.test.ts',
      'apps/community/src/__tests__/tenancy-test-harness.ts',
    ]) {
      expect(() => runnerFor(outside), outside).toThrow(/No receipt runner/);
    }
  });
});

describe('assertProofsPassed', () => {
  it('accepts a cited test the report shows as passed', () => {
    expect(
      assertProofsPassed(entries, 'pg', vitestResults(pgReport([['proves the row', 'passed']])))
    ).toBe(1);
  });

  it('refuses a test inside a skipped block', () => {
    expect(() =>
      assertProofsPassed(entries, 'pg', vitestResults(pgReport([['proves the row', 'skipped']])))
    ).toThrow(/did not pass/);
  });

  it('refuses a test that never ran: commented out or behind a false condition', () => {
    expect(() =>
      assertProofsPassed(entries, 'pg', vitestResults(pgReport([['another test', 'passed']])))
    ).toThrow(/did not run/);
  });

  it('refuses a same-titled test from a different file', () => {
    const other = {
      testResults: [
        {
          name: '/checkout/apps/community/src/__tests__/other.integration.test.ts',
          assertionResults: [{ title: 'proves the row', status: 'passed' }],
        },
      ],
    };
    expect(() => assertProofsPassed(entries, 'pg', vitestResults(other))).toThrow(/did not run/);
  });

  it('expands a template title and requires every expansion to pass', () => {
    const template: ReceiptEntry[] = [
      { id: 'M3', requirement: 'x', proofs: [{ file, title: 'serializes ${mutation} order' }] },
    ];
    expect(titleMatches('serializes ${mutation} order', 'serializes reissue order')).toBe(true);
    expect(titleMatches('serializes ${mutation} order', 'serializes order')).toBe(false);
    expect(
      assertProofsPassed(
        template,
        'pg',
        vitestResults(
          pgReport([
            ['serializes reissue order', 'passed'],
            ['serializes revoke order', 'passed'],
          ])
        )
      )
    ).toBe(1);
    expect(() =>
      assertProofsPassed(
        template,
        'pg',
        vitestResults(
          pgReport([
            ['serializes reissue order', 'passed'],
            ['serializes revoke order', 'skipped'],
          ])
        )
      )
    ).toThrow(/did not pass/);
  });

  it('reads Playwright specs, including nested suites, and refuses a retried pass', () => {
    const browserEntries: ReceiptEntry[] = [
      {
        id: 'M11',
        requirement: 'x',
        proofs: [{ file: 'apps/community/browser-tests/switching.spec.ts', title: 'switches' }],
      },
    ];
    const report = (results: { status: string }[]) => ({
      suites: [
        {
          file: 'switching.spec.ts',
          specs: [],
          suites: [
            {
              file: 'switching.spec.ts',
              specs: [
                {
                  title: 'switches',
                  file: 'switching.spec.ts',
                  tests: [{ status: results.length > 1 ? 'flaky' : 'expected', results }],
                },
              ],
            },
          ],
        },
      ],
    });
    expect(
      assertProofsPassed(
        browserEntries,
        'browser',
        playwrightResults(report([{ status: 'passed' }]))
      )
    ).toBe(1);
    expect(() =>
      assertProofsPassed(
        browserEntries,
        'browser',
        playwrightResults(report([{ status: 'failed' }, { status: 'passed' }]))
      )
    ).toThrow(/did not pass/);
  });
});
