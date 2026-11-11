import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compare, lower, normalizeReport, parseBaseline, readKnip } from '../knip/ratchet.ts';

const report = (name = 'unused', line = 1) => ({
  issues: [{ file: 'packages/example/src/index.ts', exports: [{ name, line, col: 1 }] }],
});

describe('the CLI on a real temporary git baseline', () => {
  let root: string;
  let reportFile: string;
  const script = fileURLToPath(new URL('../check-knip.ts', import.meta.url));
  const baselineFile = () => join(root, 'scripts/knip/baseline.json');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [script, '--root', root, '--report', reportFile, ...args], {
      encoding: 'utf8',
      // eslint-disable-next-line no-restricted-syntax -- Exercise local saved reports on CI too.
      env: { ...process.env, CI: '' },
    });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'knip-ratchet-'));
    mkdirSync(join(root, 'scripts/knip'), { recursive: true });
    reportFile = join(root, 'report.json');
    writeFileSync(reportFile, JSON.stringify(report()));
    git('init', '-q');
    git(
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      '-c',
      'core.hooksPath=/dev/null',
      'commit',
      '--no-gpg-sign',
      '--allow-empty',
      '-qm',
      'initial'
    );
    const initialized = run('--init');
    expect(initialized.status, initialized.stderr).toBe(0);
    git('add', '.');
    git(
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      '-c',
      'core.hooksPath=/dev/null',
      'commit',
      '--no-gpg-sign',
      '-qm',
      'baseline'
    );
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('passes matching debt, records a reduction, and rejects reintroducing the removed finding', () => {
    expect(run('--base', 'HEAD').status).toBe(0);
    writeFileSync(reportFile, '{"issues":[]}');
    expect(run('--base', 'HEAD').status).toBe(1);
    expect(run('--update', '--base', 'HEAD').status).toBe(0);
    expect(parseBaseline(readFileSync(baselineFile(), 'utf8')).issues).toEqual({});
    writeFileSync(reportFile, JSON.stringify(report()));
    expect(run('--base', 'HEAD').status).toBe(1);
  });

  it('refuses a hand-raised baseline before update can launder it', () => {
    const raised = normalizeReport({ issues: [...report().issues, ...report('brand-new').issues] });
    writeFileSync(baselineFile(), JSON.stringify({ version: 1, issues: raised }));
    const result = run('--update', '--base', 'HEAD');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('baseline increased');
  });

  it('cannot reset an existing baseline and refuses missing evidence or an invalid base', () => {
    expect(run('--init').status).toBe(2);
    expect(run('--base', 'missing-commit').status).toBe(2);
    writeFileSync(reportFile, 'not json');
    expect(run().status).toBe(2);
  });
});

describe('the production knip ratchet', () => {
  it('rejects a different finding even when the total issue count stays the same', () => {
    const baseline = normalizeReport(report('old'));
    const current = normalizeReport(report('new'));
    expect(compare(current, baseline).some((f) => f.kind === 'new')).toBe(true);
    expect(compare(current, baseline).some((f) => f.kind === 'stale')).toBe(true);
  });

  it('keeps identities stable when lines move and distinguishes namespaces and issue kinds', () => {
    expect(normalizeReport(report('unused', 90))).toEqual(normalizeReport(report('unused', 1)));
    const counts = normalizeReport({
      issues: [
        {
          file: 'src/example.ts',
          enumMembers: [
            { name: 'same', namespace: 'First' },
            { name: 'same', namespace: 'Second' },
          ],
          exports: [{ name: 'same' }],
        },
      ],
    });
    expect(Object.keys(counts)).toHaveLength(3);
  });

  it('requires shrinking findings to lower the baseline and never buys room for new findings', () => {
    const baseline = normalizeReport(report());
    expect(compare({}, baseline).map((f) => f.kind)).toEqual(['stale']);
    expect(lower({}, baseline)).toEqual({});
    expect(lower(normalizeReport(report('other')), baseline)).toEqual({});
    expect(compare(normalizeReport(report('other')), {}).map((f) => f.kind)).toEqual(['new']);
  });

  it('does not let a repeated finding grow, even when its name stays the same', () => {
    const single = normalizeReport(report());
    const doubled = normalizeReport({
      issues: [
        {
          file: 'packages/example/src/index.ts',
          exports: [{ name: 'unused' }, { name: 'unused' }],
        },
      ],
    });
    expect(compare(doubled, single).map((f) => f.kind)).toEqual(['grew']);
    expect(lower(doubled, single)).toEqual(single);
  });

  it('keeps grouped duplicate findings stable when source positions or order change', () => {
    const one = normalizeReport({
      issues: [
        {
          file: 'src/index.ts',
          duplicates: [
            [
              { name: 'a', line: 1 },
              { name: 'b', line: 2 },
            ],
          ],
        },
      ],
    });
    const two = normalizeReport({
      issues: [
        {
          file: 'src/index.ts',
          duplicates: [
            [
              { name: 'b', line: 40 },
              { name: 'a', line: 30 },
            ],
          ],
        },
      ],
    });
    expect(Object.keys(one)).toHaveLength(1);
    expect(two).toEqual(one);
  });

  it.each([
    {},
    { issues: null },
    { issues: [{ file: 'x.ts', exports: [null] }] },
    { issues: [{ file: 'x.ts', futureIssue: [] }] },
  ])('refuses incomplete or changed report formats: %j', (doc) =>
    expect(() => normalizeReport(doc)).toThrow()
  );

  it.each([
    {},
    { version: 1, issues: { finding: -1 } },
    { version: 2, issues: {} },
    { version: 1, issues: [] },
  ])('refuses an invalid baseline: %j', (doc) =>
    expect(() => parseBaseline(JSON.stringify(doc))).toThrow()
  );

  it('accepts knip exit 1 only when a complete findings report explains it', () => {
    const counts = readKnip('/repo', () => ({
      status: 1,
      stdout: JSON.stringify(report()),
      stderr: '',
    }));
    expect(Object.keys(counts)).toHaveLength(1);
    expect(() =>
      readKnip('/repo', () => ({ status: 1, stdout: '{"issues":[]}', stderr: 'failed config' }))
    ).toThrow();
  });

  it('refuses tool failures and signals even when stdout looks like a clean report', () => {
    expect(() =>
      readKnip('/repo', () => ({
        status: 2,
        stdout: '{"issues":[]}',
        stderr: 'configuration error',
      }))
    ).toThrow();
    expect(() =>
      readKnip('/repo', () => ({ status: null, stdout: '{"issues":[]}', stderr: '' }))
    ).toThrow();
  });
});
