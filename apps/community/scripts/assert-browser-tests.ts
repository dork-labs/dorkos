import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { JSONReport, JSONReportSuite } from '@playwright/test/reporter';

/** Refuse partial, skipped, or failed community browser runs against the on-disk spec census. */
export function assertBrowserTests(report: JSONReport, expectedFiles: string[]): number {
  if (!expectedFiles.length || report.errors.length || report.config.shard) {
    throw new Error('Community browser tests require one complete, error-free run.');
  }
  if (report.stats.unexpected || report.stats.skipped || report.stats.flaky) {
    throw new Error('Every community browser test must pass without skips or retries.');
  }
  const counts = new Map<string, number>();
  const visit = (suites: JSONReportSuite[]) => {
    for (const suite of suites) {
      for (const spec of suite.specs) {
        if (!spec.ok || !spec.tests.length) throw new Error(`No passing test in ${spec.file}`);
        for (const test of spec.tests) {
          if (
            test.expectedStatus !== 'passed' ||
            test.status !== 'expected' ||
            test.results.length !== 1 ||
            test.results[0].status !== 'passed'
          ) {
            throw new Error(`Browser test did not pass once in ${spec.file}`);
          }
          const file = spec.file.replaceAll('\\', '/');
          counts.set(file, (counts.get(file) ?? 0) + 1);
        }
      }
      visit(suite.suites ?? []);
    }
  };
  visit(report.suites);
  if (counts.size !== expectedFiles.length || expectedFiles.some((file) => !counts.has(file))) {
    throw new Error('Browser report does not cover every community spec file.');
  }
  const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
  if (!total || total !== report.stats.expected)
    throw new Error('Browser test count is inconsistent.');
  return total;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const expected = readdirSync(new URL('../browser-tests/', import.meta.url), {
    recursive: true,
    encoding: 'utf8',
  })
    .filter((name) => name.endsWith('.spec.ts'))
    .map((name) => name.replaceAll('\\', '/'));
  const report = JSON.parse(
    readFileSync(new URL('../browser-report.json', import.meta.url), 'utf8')
  ) as JSONReport;
  const count = assertBrowserTests(report, expected);
  process.stdout.write(
    `community-browser: ${count} tests passed across ${expected.length} files.\n`
  );
}
