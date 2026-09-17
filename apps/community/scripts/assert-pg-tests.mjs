import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { argv, stdout } from 'node:process';
import { fileURLToPath, URL } from 'node:url';

/**
 * The only conformance assertions this browser-approved Community protocol
 * cannot express. The fixture must exercise every other branch using real
 * HTTP and Postgres setup; titles are scoped so a future skipped assertion
 * cannot hide behind a broad capability exemption.
 */
export const permittedSkips = new Map([
  [
    '__tests__/remote-adapter-conformance.integration.test.ts',
    new Set([
      'C1e agent-only room visibility (this backend lacks acting or admin)',
      'C16 machine-managed zero-setup connect (this backend declares a different credential model)',
      "C17 'not-admitted' branch (browser-approved grants are issued only to an active admitted member)",
      'C19 member-not-found refusal (this backend has no addressing override)',
    ]),
  ],
]);

/** Validate that every real Postgres fixture ran and only declared model gaps skipped. */
export function assertPgReport(report, expected) {
  if (!Array.isArray(report.testResults))
    throw new Error('Real Postgres report has no test results');
  if (!expected.length) throw new Error('No real Postgres test files exist');

  const expectedSet = new Set(expected);
  const filesBySuffix = new Map();
  for (const file of report.testResults) {
    const suffix = expected.find((candidate) => file.name.endsWith(candidate));
    if (!suffix) throw new Error(`Unexpected real Postgres fixture in report: ${file.name}`);
    if (filesBySuffix.has(suffix))
      throw new Error(`Real Postgres fixture ran more than once: ${suffix}`);
    filesBySuffix.set(suffix, file);
  }
  if (filesBySuffix.size !== expectedSet.size) {
    const missing = expected.filter((suffix) => !filesBySuffix.has(suffix));
    throw new Error(`Real Postgres fixture missing from report: ${missing.join(', ')}`);
  }

  let passed = 0;
  let inapplicable = 0;
  for (const suffix of expected) {
    const file = filesBySuffix.get(suffix);
    const assertions = file.assertionResults;
    if (!Array.isArray(assertions) || assertions.length === 0)
      throw new Error(`Real Postgres fixture did not execute assertions: ${suffix}`);

    let filePassed = 0;
    const allowed = permittedSkips.get(suffix) ?? new Set();
    for (const assertion of assertions) {
      if (assertion.status === 'passed') {
        passed += 1;
        filePassed += 1;
        continue;
      }
      if (assertion.status === 'skipped' && allowed.has(assertion.title)) {
        inapplicable += 1;
        continue;
      }
      throw new Error(
        `Real Postgres assertion did not pass in ${suffix}: ${assertion.title} (${assertion.status})`
      );
    }
    if (filePassed === 0)
      throw new Error(
        `Real Postgres fixture only declared exclusions and executed no passing assertion: ${suffix}`
      );
  }
  return { passed, inapplicable, files: expected.length };
}

function expectedFixtures() {
  return readdirSync(new URL('../src/', import.meta.url), { recursive: true }).filter((name) =>
    name.endsWith('.integration.test.ts')
  );
}

function main() {
  const report = JSON.parse(
    readFileSync(new URL('../vitest-pg-report.json', import.meta.url), 'utf8')
  );
  const result = assertPgReport(report, expectedFixtures());
  stdout.write(
    `community-pg: ${result.passed} passed real PostgreSQL assertions; ${result.inapplicable} declared inapplicable across ${result.files} fixtures.\n`
  );
}

if (argv[1] && fileURLToPath(import.meta.url) === resolve(argv[1])) main();
