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
  validateRoom,
  validateCheckbox,
  ROOM_FILE,
  COLD_FILE,
  CHECKBOX_FILE,
} from '../run-isolated-cold-shard.ts';

function report(name: string | null, failed = false, count = 33) {
  return {
    numTotalTestSuites: name ? 1 : 0,
    numPassedTestSuites: name && !failed ? 1 : 0,
    numFailedTestSuites: failed ? 1 : 0,
    numPendingTestSuites: 0,
    numTotalTests: name ? count : 0,
    numPassedTests: name && !failed ? count : 0,
    numFailedTests: failed ? count : 0,
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
            assertionResults: Array.from({ length: count }, (_, index) => ({
              title: `real operational assertion ${index}`,
              status: failed ? 'failed' : 'passed',
              failureMessages: failed ? ['original failure'] : [],
            })),
          },
        ]
      : [],
  };
}

describe('isolated Room, cold and checkbox whole-file phases', () => {
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
          if (phase === 'room') {
            writeFileSync(
              child,
              "setTimeout(() => { require('node:fs').writeFileSync('room-closed.txt', 'Room closed'); process.exitCode = 9; }, 20);\n"
            );
            return native([process.execPath, child], directory);
          }
          expect(readFileSync(path.join(directory, 'room-closed.txt'), 'utf8')).toBe('Room closed');
          if (phase === 'cold') {
            writeFileSync(
              child,
              "setTimeout(() => { require('node:fs').writeFileSync('cold-closed.txt', 'cold closed'); process.exitCode = 11; }, 20);\n"
            );
            return native([process.execPath, child], directory);
          }
          expect(readFileSync(path.join(directory, 'cold-closed.txt'), 'utf8')).toBe('cold closed');
          return 13;
        },
        () => true
      );
      expect(result).toEqual({ ordinary: 7, room: 9, cold: 11, checkbox: 13, exitCode: 7 });
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
    expect(await result).toEqual({ ordinary: 7, room: 9, cold: 9, checkbox: 9, exitCode: 7 });
    expect(phases).toEqual([
      'ordinary:start',
      'ordinary:closed',
      'room:start',
      'room:closed',
      'cold:start',
      'cold:closed',
      'checkbox:start',
      'checkbox:closed',
    ]);
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
    expect(result).toEqual({ ordinary: 7, room: null, cold: null, checkbox: null, exitCode: 86 });
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
    expect(result).toEqual({ ordinary: 1, room: 9, cold: 9, checkbox: 9, exitCode: 1 });
  });

  it('fails on a cold-only failure and avoids expanding an unaffected server task', async () => {
    expect(
      await bothPhases(
        async (phase) => (phase === 'cold' ? 3 : 0),
        () => true
      )
    ).toEqual({ ordinary: 0, room: 0, cold: 3, checkbox: 0, exitCode: 3 });
    const seen: string[] = [];
    expect(
      await bothPhases(
        async (phase) => {
          seen.push(phase);
          return 0;
        },
        () => false
      )
    ).toEqual({ ordinary: 0, room: null, cold: null, checkbox: null, exitCode: 0 });
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
    expect(pr.room).not.toContain('--affected');
    expect(pr.ordinary).toContain(`--exclude=${ROOM_FILE}`);
    expect(pr.ordinary).toContain(`--exclude=${COLD_FILE}`);
    expect(pr.ordinary).toContain(`--exclude=${CHECKBOX_FILE}`);
    expect(pr.checkbox).toContain(CHECKBOX_FILE);
    expect(pr.checkbox).not.toContain('--affected');
    expect(pr.checkbox.some((arg) => /^(--retry|--maxWorkers|--testTimeout)/.test(arg))).toBe(
      false
    );
    expect(pr.room).toContain(ROOM_FILE);
    expect(pr.cold).toContain(COLD_FILE);
    expect(pr.room.some((arg) => /^(--retry|--maxWorkers|--testTimeout)/.test(arg))).toBe(false);
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
    expect(queue.room).toContain('--retry=1');
    expect(queue.room).toContain('--reporter=../../scripts/vitest-flake-reporter.ts');
    expect(queue.room).toContain('--outputFile.json=vitest-room-shard-report.json');
    expect(queue.cold).toContain('--retry=1');
    expect(queue.cold).toContain('--reporter=../../scripts/vitest-flake-reporter.ts');
    expect(queue.cold).toContain('--outputFile.json=vitest-cold-shard-report.json');
    expect(queue.checkbox).toContain('--retry=1');
    expect(queue.checkbox).toContain('--reporter=../../scripts/vitest-flake-reporter.ts');
    expect(queue.checkbox).toContain('--outputFile.json=vitest-checkbox-shard-report.json');
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

  it('runs cold after a Room failure and retains the Room first cause', async () => {
    const seen: string[] = [];
    const result = await bothPhases(
      async (phase) => {
        seen.push(phase);
        return phase === 'room' ? 5 : phase === 'cold' ? 9 : 0;
      },
      () => true
    );
    expect(seen).toEqual(['ordinary', 'room', 'cold', 'checkbox']);
    expect(result).toEqual({ ordinary: 0, room: 5, cold: 9, checkbox: 0, exitCode: 5 });
  });

  it('merges all three disjoint reports without discarding Room or cold failure metadata', () => {
    const ordinary = report('/repo/ordinary.test.ts');
    const room = report('/repo/room.test.ts', true, 1);
    const cold = report('/repo/cold.test.ts', true);
    const merged = mergeReports(mergeReports(ordinary, room), cold);
    expect(merged.numTotalTests).toBe(67);
    expect(merged.numPassedTests).toBe(33);
    expect(merged.numFailedTests).toBe(34);
    expect(merged.success).toBe(false);
    expect(merged.testResults).toEqual([
      ...ordinary.testResults,
      ...room.testResults,
      ...cold.testResults,
    ]);
    for (const file of merged.testResults.slice(1))
      expect(file.assertionResults[0].failureMessages).toEqual(['original failure']);
    expect(() => mergeReports(mergeReports(ordinary, room), room)).toThrow('duplicate');
    expect(() => mergeReports(ordinary, { ...room, testResults: undefined })).toThrow('real phase');
    expect(() => mergeReports(ordinary, { ...room, unknown: true })).toThrow('schema');
  });

  it('requires the single Room assertion to execute and refuses skipped or empty owner reports', () => {
    validateRoom(report('/repo/room.test.ts', false, 1), 1, '/repo/room.test.ts');
    validateRoom(report(null), 8, '/repo/room.test.ts');
    expect(() => validateRoom(report(null), 1, '/repo/room.test.ts')).toThrow('singleton shard');
    expect(() =>
      validateRoom(report('/repo/room.test.ts', false, 1), 8, '/repo/room.test.ts')
    ).toThrow('singleton shard');
    expect(() => validateRoom(report('/repo/room.test.ts'), 1, '/repo/room.test.ts')).toThrow(
      'original assertions'
    );
    const skipped = report('/repo/room.test.ts', false, 1);
    const file = skipped.testResults[0];
    if (!file) throw new Error('missing Room fixture file');
    const assertion = file.assertionResults[0];
    if (!assertion) throw new Error('missing Room fixture assertion');
    assertion.status = 'skipped';
    expect(() => validateRoom(skipped, 1, '/repo/room.test.ts')).toThrow('original assertions');
  });

  it('retains a checkbox-only failure after every earlier phase closes', async () => {
    const seen: string[] = [];
    const result = await bothPhases(
      async (phase) => {
        seen.push(phase);
        return phase === 'checkbox' ? 17 : 0;
      },
      () => true
    );
    expect(seen).toEqual(['ordinary', 'room', 'cold', 'checkbox']);
    expect(result).toEqual({ ordinary: 0, room: 0, cold: 0, checkbox: 17, exitCode: 17 });
  });

  it('retains all four disjoint report failures and rejects missing or duplicate checkbox metadata', () => {
    const ordinary = report('/repo/ordinary.test.ts');
    const room = report('/repo/room.test.ts', true, 1);
    const cold = report('/repo/cold.test.ts', true);
    const checkbox = report('/repo/checkbox.test.ts', true, 56);
    const firstThree = mergeReports(mergeReports(ordinary, room), cold);
    const merged = mergeReports(firstThree, checkbox);
    expect(merged.numTotalTests).toBe(123);
    expect(merged.numPassedTests).toBe(33);
    expect(merged.numFailedTests).toBe(90);
    expect(merged.success).toBe(false);
    expect(merged.testResults).toEqual([
      ...ordinary.testResults,
      ...room.testResults,
      ...cold.testResults,
      ...checkbox.testResults,
    ]);
    for (const file of merged.testResults.slice(1))
      expect(file.assertionResults[0].failureMessages).toEqual(['original failure']);
    expect(() => mergeReports(merged, checkbox)).toThrow('duplicate');
    expect(() => mergeReports(firstThree, { ...checkbox, testResults: undefined })).toThrow(
      'real phase'
    );
    expect(() => mergeReports(firstThree, { ...checkbox, numTotalTests: -1 })).toThrow('invalid');
    expect(() => mergeReports(firstThree, { ...checkbox, unknown: true })).toThrow('schema');
  });

  it('requires all 56 checkbox cases, including failures, and rejects skipped or empty owner reports', () => {
    validateCheckbox(report('/repo/checkbox.test.ts', false, 56), 1, '/repo/checkbox.test.ts');
    validateCheckbox(report('/repo/checkbox.test.ts', true, 56), 1, '/repo/checkbox.test.ts');
    validateCheckbox(report(null), 8, '/repo/checkbox.test.ts');
    expect(() => validateCheckbox(report(null), 1, '/repo/checkbox.test.ts')).toThrow(
      'singleton shard'
    );
    expect(() =>
      validateCheckbox(report('/repo/checkbox.test.ts', false, 56), 8, '/repo/checkbox.test.ts')
    ).toThrow('singleton shard');
    expect(() =>
      validateCheckbox(report('/repo/checkbox.test.ts'), 1, '/repo/checkbox.test.ts')
    ).toThrow('original assertions');
    const skipped = report('/repo/checkbox.test.ts', false, 56);
    const file = skipped.testResults[0];
    if (!file) throw new Error('missing checkbox fixture file');
    const assertion = file.assertionResults[0];
    if (!assertion) throw new Error('missing checkbox fixture assertion');
    assertion.status = 'skipped';
    expect(() => validateCheckbox(skipped, 1, '/repo/checkbox.test.ts')).toThrow(
      'original assertions'
    );
    expect(() =>
      validateCheckbox(
        { ...report('/repo/checkbox.test.ts', false, 56), numPassedTests: 0 },
        1,
        '/repo/checkbox.test.ts'
      )
    ).toThrow('status accounting');
  });
});
