/**
 * The 500-line ratchet (DOR-2822). The pure halves are tested directly; the
 * planted-file cases run the real script against a throwaway git repo with
 * its own ESLint config, so the gate is seen failing, not just reasoned about.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASELINE_PATH, compare, lowered, raisedAgainst } from '../check-max-lines.js';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'check-max-lines.ts');

describe('compare', () => {
  it('passes a tree that matches its baseline', () => {
    expect(compare({ 'a.ts': 600 }, { 'a.ts': 600 })).toEqual([]);
  });

  it('flags growth, a new file over the limit, and a stale entry', () => {
    const findings = compare(
      { 'a.ts': 610, 'b.ts': 501, 'c.ts': 550 },
      {
        'a.ts': 600,
        'c.ts': 700,
        'gone.ts': 900,
      }
    );
    expect(findings.map((f) => `${f.kind} ${f.file}`).sort()).toEqual([
      'grew a.ts',
      'new b.ts',
      'stale c.ts',
      'stale gone.ts',
    ]);
  });
});

describe('lowered', () => {
  it('lowers, removes, and never raises or adds', () => {
    expect(
      lowered(
        { 'a.ts': 550, 'b.ts': 900, 'new.ts': 700 },
        { 'a.ts': 600, 'b.ts': 800, 'c.ts': 700 }
      )
    ).toEqual({ 'a.ts': 550, 'b.ts': 800 });
  });
});

describe('raisedAgainst', () => {
  it('refuses a raised entry and a hand-added one', () => {
    const findings = raisedAgainst({ 'a.ts': 650, 'b.ts': 520 }, { 'a.ts': 600 });
    expect(findings.map((f) => `${f.file} ${f.baseline ?? '-'}`)).toEqual(['a.ts 600', 'b.ts -']);
  });

  it('lets a file git saw renamed carry its entry, no larger', () => {
    const renames = new Map([['new/a.ts', 'old/a.ts']]);
    expect(raisedAgainst({ 'new/a.ts': 600 }, { 'old/a.ts': 600 }, renames)).toEqual([]);
    expect(raisedAgainst({ 'new/a.ts': 601 }, { 'old/a.ts': 600 }, renames)).toHaveLength(1);
  });

  it('gives a removed entry no credit to an unrelated new file', () => {
    expect(raisedAgainst({ 'unrelated.ts': 690 }, { 'other.ts': 700 })).toHaveLength(1);
  });
});

describe('lowered with renames', () => {
  it("carries a renamed file's entry to its new path", () => {
    const renames = new Map([['src/moved.ts', 'src/big.ts']]);
    expect(lowered({ 'src/moved.ts': 590 }, { 'src/big.ts': 600 }, renames)).toEqual({
      'src/moved.ts': 590,
    });
  });
});

describe('the script, on a planted tree', () => {
  let root: string;

  /** A file of `n` counted lines; blank lines and comments added so they must not count. */
  const source = (n: number) =>
    `// a comment the rule skips\n\n${Array.from({ length: n }, (_, i) => `export const v${i} = ${i};`).join('\n')}\n`;

  const run = (...args: string[]) =>
    spawnSync(process.execPath, [SCRIPT, '--root', root, ...args], {
      encoding: 'utf8',
    });

  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });

  const plant = (file: string, n: number) => {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), source(n));
    git('add', file);
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'max-lines-'));
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'test');
    writeFileSync(
      join(root, 'eslint.config.mjs'),
      `export default [{ files: ['**/*.ts'], rules: { 'max-lines': ['warn', { max: 500, skipBlankLines: true, skipComments: true }] } }];\n`
    );
    mkdirSync(join(root, 'scripts', 'max-lines'), { recursive: true });
    plant('src/big.ts', 600);
    plant('src/small.ts', 100);
    expect(run('--init').status).toBe(0);
    git('add', '-A');
    git('commit', '-qm', 'base');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('records only files over the limit, counted the way max-lines counts', () => {
    const baseline = JSON.parse(readFileSync(join(root, BASELINE_PATH), 'utf8'));
    expect(baseline.files).toEqual({ 'src/big.ts': 600 });
    expect(run().status).toBe(0);
  });

  it('fails when a baselined file grows', () => {
    plant('src/big.ts', 601);
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('src/big.ts: grew to 601 lines (baseline 600)');
  });

  it('fails when a new file passes 500', () => {
    plant('src/new.ts', 501);
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('src/new.ts: 501 lines, over the 500-line limit');
  });

  it('fails on a shrink until --update lowers the baseline, and then passes', () => {
    plant('src/big.ts', 550);
    expect(run().status).toBe(1);
    expect(run('--update').status).toBe(0);
    expect(JSON.parse(readFileSync(join(root, BASELINE_PATH), 'utf8')).files).toEqual({
      'src/big.ts': 550,
    });
    expect(run().status).toBe(0);
  });

  it('drops a file from the baseline once it is under the limit', () => {
    plant('src/big.ts', 400);
    expect(run('--update').status).toBe(0);
    expect(JSON.parse(readFileSync(join(root, BASELINE_PATH), 'utf8')).files).toEqual({});
  });

  it('refuses a baseline raised by hand against the base', () => {
    plant('src/big.ts', 650);
    const path = join(root, BASELINE_PATH);
    const baseline = JSON.parse(readFileSync(path, 'utf8'));
    baseline.files['src/big.ts'] = 650;
    writeFileSync(path, JSON.stringify(baseline));
    expect(run().status).toBe(0);
    const result = run('--base', 'HEAD');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('baseline raised from 600 to 650');
  });

  it('ignores an eslint-disable comment, so it is no way out', () => {
    writeFileSync(join(root, 'src/new.ts'), `/* eslint-disable max-lines */\n${source(520)}`);
    git('add', 'src/new.ts');
    expect(run().status).toBe(1);
  });

  it('leaves test files out, as the ticket keeps them exempt', () => {
    plant('src/__tests__/huge.test.ts', 900);
    plant('src/thing.spec.ts', 900);
    expect(run().status).toBe(0);
  });

  it('leaves out a file its config switches max-lines off for', () => {
    writeFileSync(
      join(root, 'eslint.config.mjs'),
      `export default [{ files: ['**/*.ts'], rules: { 'max-lines': ['warn', { max: 500, skipBlankLines: true, skipComments: true }] } }, { files: ['src/gen/**'], rules: { 'max-lines': 'off' } }];\n`
    );
    plant('src/gen/registry.ts', 900);
    expect(run().status).toBe(0);
  });

  it('measures a package whose package.json declares no module type', () => {
    // apps/desktop is shaped like this; a loader that misreads its config
    // used to make every file there look ignored.
    mkdirSync(join(root, 'pkg'), { recursive: true });
    writeFileSync(join(root, 'pkg', 'package.json'), '{ "name": "pkg" }\n');
    writeFileSync(
      join(root, 'pkg', 'eslint.config.js'),
      `export default [{ files: ['**/*.ts'], rules: { 'max-lines': ['warn', { max: 500, skipBlankLines: true, skipComments: true }] } }];\n`
    );
    plant('pkg/src/long.ts', 520);
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('pkg/src/long.ts: 520 lines');
  });

  it('exits 2 when a file is held to options it cannot count the same way', () => {
    writeFileSync(
      join(root, 'eslint.config.mjs'),
      `export default [{ files: ['**/*.ts'], rules: { 'max-lines': ['warn', { max: 500 }] } }];\n`
    );
    expect(run().status).toBe(2);
  });

  it("carries a moved file's entry through --update, and --base accepts it", () => {
    git('mv', 'src/big.ts', 'src/moved.ts');
    expect(run().status).toBe(1);
    expect(run('--update', '--base', 'HEAD').status).toBe(0);
    expect(JSON.parse(readFileSync(join(root, BASELINE_PATH), 'utf8')).files).toEqual({
      'src/moved.ts': 600,
    });
    expect(run('--base', 'HEAD').status).toBe(0);
  });

  it('carries the entry even after a plain mv and an --update that dropped it', () => {
    renameSync(join(root, 'src/big.ts'), join(root, 'src/moved.ts'));
    expect(run('--update', '--base', 'HEAD').status).toBe(1); // the moved file is new, for now
    git('add', '-A');
    expect(run('--update', '--base', 'HEAD').status).toBe(0);
    expect(JSON.parse(readFileSync(join(root, BASELINE_PATH), 'utf8')).files).toEqual({
      'src/moved.ts': 600,
    });
  });

  it('holds a folder named tests outside apps/e2e like any other', () => {
    plant('src/tests/big.ts', 900);
    expect(run().status).toBe(1);
  });

  it('exits 2, never 0, on a --base it cannot resolve', () => {
    expect(run('--base', 'deadbeef').status).toBe(2);
  });

  it('exits 2, never 0, when it cannot read the baseline', () => {
    writeFileSync(join(root, BASELINE_PATH), 'not json');
    expect(run().status).toBe(2);
  });
});
