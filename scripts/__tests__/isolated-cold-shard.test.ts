import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  bothPhases,
  commands,
  mergeReports,
  native,
  serverSelected,
  validateCold,
} from '../run-isolated-cold-shard.ts';

function report(name: string | null, failed = false) {
  return {
    numTotalTestSuites: name ? 1 : 0,
    numPassedTestSuites: name && !failed ? 1 : 0,
    numFailedTestSuites: failed ? 1 : 0,
    numPendingTestSuites: 0,
    numTotalTests: name ? 33 : 0,
    numPassedTests: name && !failed ? 33 : 0,
    numFailedTests: failed ? 33 : 0,
    numPendingTests: 0,
    numTodoTests: 0,
    startTime: 1,
    success: !failed,
    snapshot: { added: 0, failure: false, filesRemoved: [] },
    testResults: name
      ? [
          {
            name,
            status: failed ? 'failed' : 'passed',
            assertionResults: Array.from({ length: 33 }, (_, index) => ({
              title: `real operational assertion ${index}`,
              status: failed ? 'failed' : 'passed',
              failureMessages: failed ? ['original failure'] : [],
            })),
          },
        ]
      : [],
  };
}

describe('isolated cold whole-file phase', () => {
  it('awaits a genuine child close before the next phase can observe its final write', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'cold-phase-await-'));
    const child = path.join(directory, 'child.cjs');
    writeFileSync(
      child,
      "setTimeout(() => { require('node:fs').writeFileSync('closed.txt', 'ordinary closed'); process.exitCode = 7; }, 20);\n"
    );
    try {
      const result = await bothPhases(
        async (phase) => {
          if (phase === 'ordinary') return native([process.execPath, child], directory);
          expect(readFileSync(path.join(directory, 'closed.txt'), 'utf8')).toBe('ordinary closed');
          return 9;
        },
        () => true
      );
      expect(result).toEqual({ ordinary: 7, cold: 9, exitCode: 7 });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it('waits for ordinary completion, runs cold after failure, and retains the first failure', async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const phases: string[] = [];
    const result = bothPhases(
      async (phase) => {
        phases.push(`${phase}:start`);
        if (phase === 'ordinary') await pending;
        phases.push(`${phase}:closed`);
        return phase === 'ordinary' ? 7 : 9;
      },
      () => true
    );
    await Promise.resolve();
    expect(phases).toEqual(['ordinary:start']);
    release();
    expect(await result).toEqual({ ordinary: 7, cold: 9, exitCode: 7 });
    expect(phases).toEqual(['ordinary:start', 'ordinary:closed', 'cold:start', 'cold:closed']);
  });

  it('fails unknown affected selection without expanding cold work or losing the ordinary failure', async () => {
    const phases: string[] = [];
    const result = await bothPhases(
      async (phase) => {
        phases.push(phase);
        return 7;
      },
      () => null
    );
    expect(result).toEqual({ ordinary: 7, cold: null, exitCode: 86 });
    expect(phases).toEqual(['ordinary']);
  });

  it('waits for spawn-error close and keeps it as the first failure', async () => {
    const result = await bothPhases(
      async (phase) =>
        phase === 'ordinary'
          ? native([path.join(tmpdir(), 'definitely-absent-cold-phase-executable')], tmpdir())
          : 9,
      () => true
    );
    expect(result).toEqual({ ordinary: 1, cold: 9, exitCode: 1 });
  });

  it('fails on a cold-only failure and avoids expanding an unaffected server task', async () => {
    expect(
      await bothPhases(
        async (phase) => (phase === 'cold' ? 3 : 0),
        () => true
      )
    ).toEqual({ ordinary: 0, cold: 3, exitCode: 3 });
    const seen: string[] = [];
    expect(
      await bothPhases(
        async (phase) => {
          seen.push(phase);
          return 0;
        },
        () => false
      )
    ).toEqual({ ordinary: 0, cold: null, exitCode: 0 });
    expect(seen).toEqual(['ordinary']);
    expect(serverSelected({ tasks: [{ task: 'test', taskId: '@dorkos/client#test' }] })).toBe(
      false
    );
    expect(serverSelected({ tasks: [{ task: 'test', taskId: '@dorkos/server#test' }] })).toBe(true);
    expect(() => serverSelected({})).toThrow('task selection');
    expect(() => serverSelected({ tasks: [{}] })).toThrow('malformed');
    expect(() =>
      serverSelected({
        tasks: [
          { task: 'test', taskId: '@dorkos/server#test' },
          { task: 'test', taskId: '@dorkos/server#test' },
        ],
      })
    ).toThrow('duplicate');
  });

  it('retains event-specific retry/reporters and original eight-shard worker defaults', () => {
    const pr = commands([
      'pnpm',
      'exec',
      'turbo',
      'test',
      '--affected',
      '--continue',
      '--concurrency=1',
      '--log-order=stream',
      '--',
      '--run',
      '--shard=1/8',
      '--passWithNoTests',
    ]);
    expect(pr.ordinary).toContain('--affected');
    expect(pr.cold).not.toContain('--affected');
    expect(pr.cold.some((arg) => arg.startsWith('--retry'))).toBe(false);
    expect(
      pr.cold.some((arg) => arg.startsWith('--maxWorkers') || arg.startsWith('--testTimeout'))
    ).toBe(false);
    const queue = commands([
      'pnpm',
      'exec',
      'turbo',
      'test',
      '--summarize',
      '--continue',
      '--concurrency=1',
      '--',
      '--run',
      '--shard=8/8',
      '--retry=1',
      '--passWithNoTests',
      '--reporter=default',
      '--reporter=json',
      '--outputFile.json=vitest-shard-report.json',
      '--reporter=../../scripts/vitest-flake-reporter.ts',
    ]);
    expect(queue.cold).toContain('--retry=1');
    expect(queue.cold).toContain('--reporter=../../scripts/vitest-flake-reporter.ts');
    expect(queue.cold).toContain('--outputFile.json=vitest-cold-shard-report.json');
    expect(() =>
      commands(['pnpm', 'exec', 'turbo', 'test', '--', '--run', '--shard=1/4', '--passWithNoTests'])
    ).toThrow('eight-way');
  });

  it('retains genuine failing assertion metadata in a disjoint merged report', () => {
    const a = report('/repo/apps/server/src/ordinary.test.ts');
    const b = report('/repo/apps/server/src/cold.test.ts', true);
    const merged = mergeReports(a, b);
    expect(merged.numTotalTests).toBe(66);
    expect(merged.numPassedTests).toBe(33);
    expect(merged.numFailedTests).toBe(33);
    expect(merged.success).toBe(false);
    expect(merged.testResults).toEqual([...a.testResults, ...b.testResults]);
    expect(merged.testResults[1].assertionResults[0].failureMessages).toEqual(['original failure']);
    expect(() => mergeReports(a, a)).toThrow('duplicate');
    expect(() => mergeReports(a, { ...b, testResults: undefined })).toThrow('real phase');
    expect(() => mergeReports(a, { ...b, numTotalTests: -1 })).toThrow('invalid');
  });

  it('refuses missing cold collection and an empty owner report even with passWithNoTests', () => {
    validateCold(report('/repo/cold.test.ts'), 1, '/repo/cold.test.ts');
    validateCold(report(null), 8, '/repo/cold.test.ts');
    const skipped = report('/repo/cold.test.ts');
    const coldFile = skipped.testResults[0];
    if (!coldFile) throw new Error('missing cold fixture file');
    coldFile.assertionResults.forEach((assertion) => {
      assertion.status = 'skipped';
    });
    expect(() => validateCold(skipped, 1, '/repo/cold.test.ts')).toThrow('original assertions');
    expect(() =>
      validateCold({ ...report('/repo/cold.test.ts'), numPassedTests: 0 }, 1, '/repo/cold.test.ts')
    ).toThrow('status accounting');
    expect(() => validateCold(report(null), 1, '/repo/cold.test.ts')).toThrow('singleton shard');
    expect(() => validateCold(report('/repo/cold.test.ts'), 8, '/repo/cold.test.ts')).toThrow(
      'singleton shard'
    );
    expect(() => validateCold({ testResults: ['/wrong'] }, 1, '/repo/cold.test.ts')).toThrow();
  });
});
