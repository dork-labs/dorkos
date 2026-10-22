/**
 * What a held turn may read unasked (DOR-3204, Security S1–S3): only inside its folders with
 * symlinks followed, and only through a plain read-only command that hides no path and writes
 * nothing.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fileReadStaysInside, isPlainReadCommand } from '../held-turn-reads.js';

let folder: string;
let outside: string;

beforeAll(() => {
  folder = fs.mkdtempSync(path.join(os.tmpdir(), 'held-reads-'));
  outside = fs.mkdtempSync(path.join(os.tmpdir(), 'held-outside-'));
  fs.writeFileSync(path.join(outside, 'secret'), 'x');
  fs.mkdirSync(path.join(folder, 'src'));
  fs.writeFileSync(path.join(folder, 'README.md'), 'x');
  // A cloned repo can carry a symlink like this one.
  fs.symlinkSync(outside, path.join(folder, 'away'));
});

afterAll(() => {
  fs.rmSync(folder, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

const reads = (tool: string, input: Record<string, unknown>) =>
  fileReadStaysInside(tool, input, folder, [folder]);
const plain = (command: string) => isPlainReadCommand(command, folder, [folder]);

describe('a file tool’s read', () => {
  it('stays inside when its path does, a file not made yet included', () => {
    expect(reads('Read', { file_path: path.join(folder, 'README.md') })).toBe(true);
    expect(reads('Read', { file_path: 'src/not-yet.ts' })).toBe(true);
    expect(reads('Glob', { pattern: 'src/**/*.ts' })).toBe(true);
  });

  it('leaves through a symlink inside the folder', () => {
    expect(reads('Read', { file_path: 'away/secret' })).toBe(false);
    expect(reads('Read', { file_path: path.join(folder, 'away', 'secret') })).toBe(false);
    expect(reads('Grep', { pattern: 'x', path: 'away' })).toBe(false);
    expect(reads('Glob', { pattern: 'away/**' })).toBe(false);
  });
});

describe('a plain read-only command', () => {
  it('runs unasked inside the folder', () => {
    for (const command of ['ls -la src', 'cat README.md', 'grep -rn todo src', 'git status']) {
      expect(plain(command), command).toBe(true);
    }
  });

  it('is not one when it reads through a symlink, or follows them', () => {
    for (const command of [
      'cat away/secret',
      'ls away',
      'grep -R x .',
      'grep -rS x .',
      'find -L . -name x',
      'find . -follow',
      'ls -L away',
      'du -L .',
      'stat -L away',
    ]) {
      expect(plain(command), command).toBe(false);
    }
  });

  it('is not one when an option hides an absolute or home path', () => {
    for (const command of [
      'grep -r --exclude-from=/etc/passwd x',
      'grep -f/etc/passwd x',
      'grep --file=/etc/passwd x',
      'cat /etc/passwd',
      `cat ${path.join(outside, 'secret')}`,
    ]) {
      expect(plain(command), command).toBe(false);
    }
  });

  it('is not one for a command that writes', () => {
    for (const command of [
      'tree -o .claude/settings.local.json',
      'file -C -m x',
      'tree',
      'file x',
    ]) {
      expect(plain(command), command).toBe(false);
    }
  });
});
