/**
 * The ratchet registry (scripts/ratchets/registry.ts) and `pnpm ratchet` (DOR-4948).
 *
 * The registry is only worth having if it is complete: a baseline nobody lists
 * is a ratchet `pnpm ratchet`, CI and pre-push never run. So every baseline
 * file in the tree must be listed, and every listed file must exist.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { failing, parseOptions, selected, summaryLine, type Outcome } from '../ratchets/ratchet.ts';
import { RATCHETS, registryProblems, type Ratchet } from '../ratchets/registry.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('the registry', () => {
  it('lists every baseline in the repo, and every file it lists exists', () => {
    expect(registryProblems(ROOT, RATCHETS)).toEqual([]);
  });

  it('runs each ratchet with the command `pnpm check:<name>` runs', () => {
    const scripts = (
      JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
        scripts: Record<string, string>;
      }
    ).scripts;
    for (const r of RATCHETS) expect(scripts[`check:${r.name}`], r.name).toBe(`node ${r.script}`);
  });

  it('gives each ratchet a role and a ticket or "none yet", never a date', () => {
    for (const r of RATCHETS) {
      expect(r.owner, r.name).toMatch(/\S/);
      expect(r.takenDownBy, r.name).toMatch(/^(DOR-\d+|none yet)$/);
    }
  });
});

describe('registryProblems', () => {
  let root = '';
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const tree = (files: string[]) => {
    root = mkdtempSync(join(tmpdir(), 'ratchets-'));
    for (const file of files) {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(join(root, file), '{}\n');
    }
  };
  const one: Ratchet = {
    name: 'sample',
    script: 'scripts/check-sample.ts',
    baselines: ['scripts/sample/baseline.json'],
    owner: 'qa',
    takenDownBy: 'none yet',
    prePush: true,
  };

  it('fails on a baseline no ratchet lists, in either folder and either naming', () => {
    tree([
      one.script,
      ...one.baselines,
      'scripts/other/test-baseline.json',
      'apps/server/eslint-rules/wall.baseline.json',
      'scripts/other/not-a-ratchet.json',
    ]);
    expect(registryProblems(root, [one])).toEqual([
      'apps/server/eslint-rules/wall.baseline.json is a baseline no ratchet in scripts/ratchets/registry.ts lists',
      'scripts/other/test-baseline.json is a baseline no ratchet in scripts/ratchets/registry.ts lists',
    ]);
  });

  it('fails on a listed baseline or script that is not there', () => {
    tree([]);
    expect(registryProblems(root, [one])).toEqual([
      'sample names scripts/check-sample.ts, which is not there',
      'sample names scripts/sample/baseline.json, which is not there',
    ]);
  });
});

describe('pnpm ratchet', () => {
  const outcome = (ratchet: Ratchet, code: number, output: string): Outcome => ({
    ratchet,
    code,
    output,
  });
  const knip = RATCHETS.find((r) => r.name === 'knip') as Ratchet;
  const maxLines = RATCHETS.find((r) => r.name === 'max-lines') as Ratchet;

  it('fails on a failing ratchet, never on an advisory one', () => {
    expect(failing([outcome(knip, 2, 'knip: cannot measure\n')])).toEqual([]);
    expect(failing([outcome(maxLines, 1, 'max-lines: 1 problem(s):\n')]).length).toBe(1);
  });

  it("sums a run up by the ratchet's own verdict line, past its notes", () => {
    const notes = 'max-lines: 1 note(s), not failures:\n  a.ts: down to 3\n';
    expect(summaryLine(outcome(maxLines, 0, `${notes}max-lines: clean. 3 over\n`))).toBe(
      'max-lines: clean. 3 over'
    );
    expect(summaryLine(outcome(maxLines, 1, `${notes}max-lines: 2 problem(s):\n  x\n`))).toBe(
      'max-lines: 2 problem(s):'
    );
  });

  it('at pre-push runs only the ratchets marked for it, and never knip', () => {
    const names = selected(parseOptions(['--pre-push'], {})).map((r) => r.name);
    expect(names).toEqual(RATCHETS.filter((r) => r.prePush).map((r) => r.name));
    expect(names).not.toContain('knip');
  });

  it('refuses --update under CI, before running anything', () => {
    const run = spawnSync(
      process.execPath,
      [join(ROOT, 'scripts/ratchets/ratchet.ts'), '--update'],
      {
        encoding: 'utf8',
        // eslint-disable-next-line no-restricted-syntax -- The child's environment, with CI set.
        env: { ...process.env, CI: 'true' },
      }
    );
    expect(run.status).toBe(2);
    expect(run.stderr).toMatch(/--update is refused under CI/);
  });
});
