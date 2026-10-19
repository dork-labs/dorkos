import { describe, expect, it } from 'vitest';
import { assertPgReport, permittedSkips } from './assert-pg-tests.mjs';

const remoteFixture = '__tests__/remote-adapter-conformance.integration.test.ts';
const ordinaryFixture = '__tests__/foundation.integration.test.ts';
const allowedTitle = [...permittedSkips.get(remoteFixture)][0];

function report(files) {
  return {
    testResults: files.map(([name, assertions]) => ({
      name,
      assertionResults: assertions.map(([title, status]) => ({ title, status })),
    })),
  };
}

describe('assertPgReport', () => {
  it('fails when an expected integration fixture is missing', () => {
    expect(() =>
      assertPgReport(report([[ordinaryFixture, [['foundation case', 'passed']]]]), [
        ordinaryFixture,
        remoteFixture,
      ])
    ).toThrow(/missing from report/);
  });

  it('fails an unexpected skipped assertion', () => {
    expect(() =>
      assertPgReport(
        report([
          [
            remoteFixture,
            [
              ['new skipped case', 'skipped'],
              ['executed', 'passed'],
            ],
          ],
        ]),
        [remoteFixture]
      )
    ).toThrow(/did not pass/);
  });

  it('fails an otherwise allowed title in a different fixture', () => {
    expect(() =>
      assertPgReport(
        report([
          [
            ordinaryFixture,
            [
              [allowedTitle, 'skipped'],
              ['executed', 'passed'],
            ],
          ],
        ]),
        [ordinaryFixture]
      )
    ).toThrow(/did not pass/);
  });

  it('fails a fixture that declares exclusions but executes no passing assertions', () => {
    expect(() =>
      assertPgReport(
        report([
          [
            remoteFixture,
            [...permittedSkips.get(remoteFixture)].map((title) => [title, 'skipped']),
          ],
        ]),
        [remoteFixture]
      )
    ).toThrow(/only declared exclusions/);
  });
});
