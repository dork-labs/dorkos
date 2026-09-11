/** Windows removal races re-check the current occupant before doing any more work. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { project } from '../../engine.js';
import { applyPlan } from '../apply.js';
import { applyGlobalPlan } from '../global-apply.js';
import { setDirSymlinkProbe } from '../windows-links.js';
import { writeFileAt, writeJsonAt } from '../../__tests__/journeys/stage.js';

vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>();
  return { ...fs, rmSync: vi.fn(fs.rmSync) };
});
const { rmSync: remove } = await vi.importActual<typeof import('node:fs')>('node:fs');
const platform = process.platform;
let root: string;
let target: string;
let source: string;
let plan: ReturnType<typeof project>;

beforeEach(() => {
  vi.mocked(rmSync).mockReset().mockImplementation(remove);
  root = mkdtempSync(join(tmpdir(), 'symlink-removal-race-'));
  writeJsonAt(join(root, '.agents/harness.manifest.json'), {
    version: 1,
    harnesses: ['claude-code'],
  });
  writeFileAt(
    join(root, '.agents/skills/research/SKILL.md'),
    '---\nname: research\ndescription: Research\n---\n'
  );
  plan = project(root);
  source = join(root, '.agents/skills/research');
  target = join(root, '.claude/skills/research');
  mkdirSync(join(root, '.claude/skills'), { recursive: true });
  mkdirSync(join(root, 'old'));
  symlinkSync(join(root, 'old'), target, 'junction');
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  setDirSymlinkProbe(() => true);
  vi.spyOn(Atomics, 'wait').mockReturnValue('timed-out');
});
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  setDirSymlinkProbe(undefined);
  vi.restoreAllMocks();
  remove(root, { recursive: true, force: true });
});

/** Inject a removal error only at the raced target. */
function failRemoval(change: () => void, code = 'EPERM'): void {
  vi.mocked(rmSync).mockImplementationOnce((path, options) => {
    expect(path).toBe(target);
    expect(options).toEqual({ force: true });
    change();
    throw Object.assign(new Error(code), { code });
  });
}

describe.each(['project', 'global'] as const)('%s Windows managed-link removal races', (tier) => {
  const apply = () =>
    tier === 'project'
      ? applyPlan(root, plan)
      : applyGlobalPlan(
          {
            ...plan,
            enumeratedPackages: [],
            actions: plan.actions
              .filter((a) => a.kind === 'symlink')
              .map((a) => ({
                ...a,
                scope: 'global' as const,
                source: join(root, a.source!),
                target: join(root, a.target!),
              })),
          },
          { dorkHome: root, claudeSkillsDir: dirname(target) }
        );
  it('accepts the correct link completed by another writer without removing it', () => {
    failRemoval(() => {
      remove(target);
      symlinkSync(relative(dirname(target), source), target, 'dir');
    });
    expect(apply().conflicts).toEqual([]);
    expect(realpathSync(target)).toBe(realpathSync(source));
    expect(rmSync).toHaveBeenCalledTimes(1);
  });

  it('repairs the path when the other writer removed it', () => {
    failRemoval(() => remove(target));
    expect(apply().conflicts).toEqual([]);
    expect(realpathSync(target)).toBe(realpathSync(source));
  });

  it.each(['file', 'directory'])('preserves a real %s appearing after the error', (kind) => {
    failRemoval(() => {
      remove(target);
      if (kind === 'directory') mkdirSync(target);
      writeFileSync(kind === 'file' ? target : join(target, 'keep'), 'user data');
    });
    expect(
      apply().conflicts.some(
        (x) => x.target === (tier === 'project' ? '.claude/skills/research' : target)
      )
    ).toBe(true);
    expect(readFileSync(kind === 'file' ? target : join(target, 'keep'), 'utf8')).toBe('user data');
    expect(rmSync).toHaveBeenCalledTimes(1);
  });

  it('retries a transient sharing failure while the stale link remains', () => {
    failRemoval(() => {});
    expect(apply().conflicts).toEqual([]);
    expect(realpathSync(target)).toBe(realpathSync(source));
    expect(rmSync).toHaveBeenCalledTimes(2);
  });

  it('surfaces persistent permission failure after a finite retry budget', () => {
    vi.mocked(rmSync).mockImplementation(() => {
      throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
    });
    expect(() => apply()).toThrow('EPERM');
    expect(rmSync).toHaveBeenCalledTimes(65);
    expect(Atomics.wait).toHaveBeenCalledTimes(64);
    expect(realpathSync(target)).toBe(realpathSync(join(root, 'old')));
  });

  it.each(['EACCES', 'EIO'])('does not retry %s', (code) => {
    failRemoval(() => {}, code);
    expect(() => apply()).toThrow(code);
    expect(rmSync).toHaveBeenCalledTimes(1);
    expect(Atomics.wait).not.toHaveBeenCalled();
  });

  it('does not apply Windows sharing retries on POSIX', () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    failRemoval(() => {});
    expect(() => apply()).toThrow('EPERM');
    expect(rmSync).toHaveBeenCalledTimes(1);
  });
});
