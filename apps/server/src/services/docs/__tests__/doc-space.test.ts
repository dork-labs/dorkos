import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { initBoundary } from '../../../lib/boundary.js';
import {
  DocPathError,
  docKey,
  normalizeDocPath,
  resolveDocFile,
  resolveDocSpace,
} from '../doc-space.js';

let base: string;
let space: string;
let outside: string;

beforeEach(async () => {
  base = realpathSync(mkdtempSync(path.join(tmpdir(), 'doc-space-')));
  space = path.join(base, 'space');
  outside = path.join(base, 'outside');
  mkdirSync(path.join(space, 'plans'), { recursive: true });
  mkdirSync(outside);
  writeFileSync(path.join(space, 'plans', 'launch.md'), '# Launch\n');
  writeFileSync(path.join(outside, 'secret.md'), '# Secret\n');
  await initBoundary(space);
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('normalizeDocPath', () => {
  it('spells one doc one way', () => {
    expect(normalizeDocPath('plans/./launch.md')).toBe('plans/launch.md');
    expect(normalizeDocPath('plans\\launch.md')).toBe('plans/launch.md');
    expect(normalizeDocPath('plans/x/../launch.md')).toBe('plans/launch.md');
  });

  it('refuses paths that are empty, absolute or leave the space', () => {
    for (const bad of [
      '',
      '.',
      '/etc/passwd',
      'C:/x.md',
      'C:x.md',
      '../outside/secret.md',
      'a/../../b.md',
      'a\u0000.md',
    ]) {
      expect(() => normalizeDocPath(bad), bad).toThrow(DocPathError);
    }
  });
});

describe('resolveDocSpace', () => {
  it('names one folder one way', async () => {
    const one = await resolveDocSpace(space);
    expect(await resolveDocSpace(`${space}/`)).toEqual(one);
    expect(one.root).toBe(space);
    expect(one.key).toMatch(/^[0-9a-f]{32}$/);
  });

  it('refuses a relative path, a file, a missing folder and a folder outside the boundary', async () => {
    await expect(resolveDocSpace('space')).rejects.toThrow(DocPathError);
    await expect(resolveDocSpace(path.join(space, 'plans', 'launch.md'))).rejects.toThrow(
      DocPathError
    );
    await expect(resolveDocSpace(path.join(space, 'missing'))).rejects.toThrow(DocPathError);
    await expect(resolveDocSpace(outside)).rejects.toThrow(/outside directory boundary/);
  });
});

describe('docKey', () => {
  it('gives one file one key however it is reached', async () => {
    symlinkSync(path.join(space, 'plans'), path.join(space, 'alias'));
    const root = await resolveDocSpace(space);
    const plans = await resolveDocSpace(path.join(space, 'plans'));
    const key = await docKey(root, 'plans/launch.md');
    expect(key).toMatch(/^[0-9a-f]{32}$/);
    expect(await docKey(root, './plans/x/../launch.md')).toBe(key);
    expect(await docKey(root, 'alias/launch.md')).toBe(key);
    expect(await docKey(plans, 'launch.md')).toBe(key);
  });

  it.runIf(process.platform === 'darwin')(
    'gives case variants one key on a case-insensitive disk',
    async () => {
      const root = await resolveDocSpace(space);
      expect(await docKey(root, 'Plans/Launch.md')).toBe(await docKey(root, 'plans/launch.md'));
    }
  );

  it('gives different files different keys', async () => {
    const root = await resolveDocSpace(space);
    expect(await docKey(root, 'plans/other.md')).not.toBe(await docKey(root, 'plans/launch.md'));
  });
});

describe('resolveDocFile', () => {
  it('finds a doc inside its space', async () => {
    const s = await resolveDocSpace(space);
    await expect(resolveDocFile(s, 'plans/launch.md')).resolves.toBe(
      path.join(space, 'plans', 'launch.md')
    );
  });

  it('refuses a symlink that leads out of the space', async () => {
    symlinkSync(outside, path.join(space, 'escape'));
    const s = await resolveDocSpace(space);
    await expect(resolveDocFile(s, 'escape/secret.md')).rejects.toThrow(
      /outside directory boundary/
    );
  });
});
