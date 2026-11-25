/**
 * The bounds on how far one command line's paths are followed (DOR-5240): the walk a search that
 * follows links takes, wildcard patterns, and how many paths are looked up on disk. Past each bound
 * the command counts as reading outside words.
 *
 * @vitest-environment node
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_ENTRIES, MAX_FOLDERS } from '../outside-file-links.js';
import { commandReadsOutsideText } from '../shell-outside-text.js';
import { madeUpHome } from './made-up-home.js';

const TEMP = os.tmpdir();
const made: string[] = [];
const project = (name: string): string => {
  const dir = mkdtempSync(path.join(TEMP, `made-up-${name}-`));
  made.push(dir);
  return dir;
};
const marksIn = (dir: string, command: string) =>
  commandReadsOutsideText(command, { cwd: dir, agentHome: dir });

const { home: HOME, remove: removeHome } = madeUpHome(['Downloads']);
beforeEach(() => {
  vi.stubEnv('HOME', HOME);
  vi.stubEnv('DORK_HOME', '/made-up/dork-home');
});
afterEach(() => {
  vi.unstubAllEnvs();
});
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
  removeHome();
});

describe('the walk of a search that follows links', () => {
  it(`marks past ${MAX_FOLDERS} folders`, () => {
    const dir = project('many-folders');
    for (let at = 0; at <= MAX_FOLDERS; at += 1) mkdirSync(path.join(dir, `f${at}`));
    expect(marksIn(dir, 'grep -R invoice .')).toBe(true);
    expect(marksIn(dir, 'grep -r invoice .')).toBe(false);
  });

  it(`marks past ${MAX_ENTRIES} entries`, () => {
    const dir = project('many-files');
    for (let at = 0; at <= MAX_ENTRIES; at += 1) writeFileSync(path.join(dir, `f${at}`), '');
    expect(marksIn(dir, 'rg -L invoice')).toBe(true);
  });

  it('shares one allowance across every root of the line', () => {
    const dir = project('shared-walk');
    const roots = Array.from({ length: 20 }, (_, at) => `r${at}`);
    for (const root of roots) {
      mkdirSync(path.join(dir, root));
      for (let at = 0; at < 300; at += 1) writeFileSync(path.join(dir, root, `f${at}`), '');
    }
    expect(marksIn(dir, `grep -R invoice ${roots.slice(0, 2).join(' ')}`)).toBe(false);
    expect(marksIn(dir, `grep -R invoice ${roots.join(' ')}`)).toBe(true);
  });

  it('walks a folder once however many roots name it', () => {
    const dir = project('same-root');
    for (let at = 0; at < 300; at += 1) writeFileSync(path.join(dir, `f${at}`), '');
    mkdirSync(path.join(dir, 'a'));
    const roots = Array.from({ length: 40 }, (_, at) => (at % 2 ? '.' : './a/..')).join(' ');
    expect(marksIn(dir, `grep -R invoice ${roots}`)).toBe(false);
  });

  it('walks a folder that links back to itself once', () => {
    const dir = project('cycle');
    mkdirSync(path.join(dir, 'inner'));
    symlinkSync(dir, path.join(dir, 'inner', 'back'));
    expect(marksIn(dir, 'find -L . -name invoice.txt')).toBe(false);
  });
});

describe('wildcard patterns', () => {
  const place = { cwd: '/agents/wren', agentHome: '/agents/wren' };

  it('match folder names in either case', () => {
    expect(commandReadsOutsideText('cat ~/DOWN*/invoice.txt', place)).toBe(true);
    expect(commandReadsOutsideText('cat ~/dOwNlOaD?/invoice.txt', place)).toBe(true);
  });

  it('a pattern of very many parts marks', () => {
    expect(commandReadsOutsideText(`cat ~/${'a*/'.repeat(70)}x`, place)).toBe(true);
  });

  it('a very long wildcard part marks', () => {
    expect(commandReadsOutsideText(`cat ~/${'D'.repeat(1_100)}*/x`, place)).toBe(true);
  });

  it('a path named many times is looked up once', () => {
    expect(commandReadsOutsideText(`cat ${'./notes/a.md '.repeat(600)}`, place)).toBe(false);
  });

  it('a line naming more paths than are looked up marks', () => {
    const words = Array.from({ length: 600 }, (_, at) => `./notes/n${at}.md`).join(' ');
    expect(commandReadsOutsideText(`cat ${words}`, place)).toBe(true);
    expect(commandReadsOutsideText(`cat ${words.split(' ').slice(0, 20).join(' ')}`, place)).toBe(
      false
    );
  });
});
