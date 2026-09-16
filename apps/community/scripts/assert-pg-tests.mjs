import { readFileSync, readdirSync } from 'node:fs';
import { stdout } from 'node:process';
import { URL } from 'node:url';

const report = JSON.parse(
  readFileSync(new URL('../vitest-pg-report.json', import.meta.url), 'utf8')
);
const expected = readdirSync(new URL('../src/', import.meta.url), { recursive: true }).filter(
  (name) => name.endsWith('.integration.test.ts')
);
if (!expected.length) throw new Error('No real Postgres test files exist');
for (const suffix of expected) {
  const file = report.testResults.find((item) => item.name.endsWith(suffix));
  if (
    !file ||
    !file.assertionResults.length ||
    file.assertionResults.some((test) => test.status !== 'passed')
  )
    throw new Error(`Real Postgres suite did not execute and pass every case in ${suffix}`);
}
const cases = report.testResults.flatMap((file) => file.assertionResults);
if (
  report.testResults.length !== expected.length ||
  cases.some((test) => test.status !== 'passed')
) {
  throw new Error(
    `Real Postgres suite executed ${cases.length} tests; all expected cases must pass`
  );
}
stdout.write(
  `community-pg: ${cases.length} real Postgres assertions executed in ${report.testResults.length} files.\n`
);
