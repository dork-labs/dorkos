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
      '../outside/secret.md',
      'a/../../b.md',
      'a\u0000.md',
    ]) {
      expect(() => normalizeDocPath(bad), bad).toThrow(DocPathError);
    }
  });
});

describe('resolveDocSpace and docKey', () => {
  it('names the same doc the same way, and different docs differently', async () => {
    const one = await resolveDocSpace(space);
    const two = await resolveDocSpace(`${space}/`);
    expect(one).toEqual(two);
    expect(one.root).toBe(space);
    expect(docKey(one, 'plans/launch.md')).toBe(docKey(two, './plans/launch.md'));
    expect(docKey(one, 'plans/launch.md')).not.toBe(docKey(one, 'plans/other.md'));
    expect(docKey(one, 'plans/launch.md')).toMatch(/^[0-9a-f]{32}$/);
  });

  it('refuses a space outside the directory boundary', async () => {
    await expect(resolveDocSpace(outside)).rejects.toThrow(/outside directory boundary/);
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
