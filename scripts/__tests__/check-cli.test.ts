/**
 * `pnpm check` (DOR-4947): the ladder names commands that exist, each local rung
 * runs as typed, and the old verify names are gone with no alias.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { LADDER, ladderText, plan, readRequiredChecks } from '../check/cli.ts';

const ROOT = path.resolve(import.meta.dirname, '../..');
const read = (file: string) => readFileSync(path.join(ROOT, file), 'utf8');

describe('pnpm check', () => {
  it('climbs edit, commit, push, preopen, verify, pr, queue, and runs only the local rungs', () => {
    expect(LADDER.map((stage) => stage.name)).toEqual([
      'edit',
      'commit',
      'push',
      'preopen',
      'verify',
      'pr',
      'queue',
    ]);
    expect(LADDER.filter((stage) => !stage.command).map((stage) => stage.name)).toEqual([
      'pr',
      'queue',
    ]);
  });

  it('points each local rung at a command this checkout has', () => {
    const lefthook = read('lefthook.yml');
    const verifyCli = read('scripts/verify-proof/cli.ts');
    for (const { name, command } of LADDER) {
      if (!command) continue;
      const [tool, ...args] = command;
      if (tool === 'bash') expect(existsSync(path.join(ROOT, args[0]!)), name).toBe(true);
      else if (args.includes('lefthook'))
        expect(lefthook).toMatch(new RegExp(`^${args.at(-1)}:`, 'm'));
      else expect(verifyCli).toContain(`command === '${args.at(-1)}'`);
    }
  });

  it('prints every required check, and refuses what it cannot run', () => {
    const required = readRequiredChecks(ROOT);
    expect(required.length).toBeGreaterThan(5);
    const text = ladderText(required);
    for (const check of required) expect(text).toContain(check);

    expect(plan([])).toEqual({ kind: 'ladder' });
    expect(plan(['verify'])).toMatchObject({ kind: 'run', stage: { name: 'verify' } });
    expect(plan(['verify', '--force'])).toMatchObject({ kind: 'refuse', code: 2 });
    expect(plan(['queue'])).toMatchObject({ kind: 'refuse', code: 2 });
    expect(plan(['nope'])).toMatchObject({ kind: 'refuse', code: 2 });
  });

  it('replaced the four verify scripts outright (ADR 261123-170832: no aliases)', () => {
    const scripts = (JSON.parse(read('package.json')) as { scripts: Record<string, string> })
      .scripts;
    expect(scripts.check).toBe('node scripts/check/cli.ts');
    expect(Object.keys(scripts).filter((name) => /^verify(:|$)/.test(name))).toEqual([]);
  });
});
