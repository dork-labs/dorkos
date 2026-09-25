/**
 * Saved copies are kept to read, never to run (DOR-2340): an update clears
 * their execute bits, and a saved folder goes under `.dork/saved`, where no
 * skill or command loader looks.
 *
 * @vitest-environment node
 */
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { carryPersonFiles, lateWritePass } from '../../carry-over.js';
import { computeInstalledFiles } from '../../installed-files.js';
import { isPathProgram } from '../../package-programs.js';
import { freeSavedName, makeInert, savedFolderCandidates } from '../saved-copies.js';

let base: string;
let live: string;
let staged: string;

const identity = { name: 'pkg', type: 'plugin' as const };

/** Write `files` (path → content, `+x` suffix on the path marks it executable) under `root`. */
async function writeTree(root: string, files: Record<string, string>): Promise<void> {
  for (const [spec, content] of Object.entries(files)) {
    const executable = spec.endsWith('+x');
    const rel = executable ? spec.slice(0, -2) : spec;
    const abs = path.join(root, ...rel.split('/'));
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content);
    await chmod(abs, executable ? 0o755 : 0o644);
  }
}

/** Whether any execute bit is set on the file at `rel` under `root`. */
async function runnable(root: string, rel: string): Promise<boolean> {
  return ((await stat(path.join(root, ...rel.split('/')))).mode & 0o111) !== 0;
}

beforeEach(async () => {
  base = await mkdtemp(path.join(tmpdir(), 'saved-copies-'));
  live = path.join(base, 'live');
  staged = path.join(base, 'staged');
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

/** Record `live` as the old version, then carry into `staged` as the new one. */
async function update(
  oldFiles: Record<string, string>,
  edits: Record<string, string>,
  newFiles: Record<string, string>,
  userEditable: string[] = []
) {
  await writeTree(live, oldFiles);
  const rOld = await computeInstalledFiles(live, { identity, userEditable, npmRan: false });
  await writeTree(live, edits);
  await writeTree(staged, newFiles);
  const rNew = await computeInstalledFiles(staged, { identity, userEditable, npmRan: false });
  return carryPersonFiles({ liveRoot: live, stagingDir: staged, rOld, oldHasIdentity: true, rNew });
}

// POSIX modes; Windows has no execute bits to clear.
describe.skipIf(process.platform === 'win32')('saved copies are not runnable', () => {
  it('clears the execute bits of an edited program saved aside from bin/', async () => {
    const { plan } = await update(
      { 'bin/tool+x': '#!/bin/sh\necho v1\n' },
      { 'bin/tool+x': '#!/bin/sh\necho mine\n' },
      { 'bin/tool+x': '#!/bin/sh\necho v2\n' }
    );
    expect(plan.actions).toContainEqual({
      kind: 'carry-as',
      path: 'bin/tool',
      savedAs: 'bin/tool.dork-old',
    });
    expect(await runnable(staged, 'bin/tool.dork-old')).toBe(false);
    // The new version's own program is untouched.
    expect(await runnable(staged, 'bin/tool')).toBe(true);
  });

  it('clears the execute bits of a new default saved as .dork-new', async () => {
    const { plan } = await update(
      { 'bin/tool+x': 'v1' },
      { 'bin/tool+x': 'mine' },
      { 'bin/tool+x': 'v2' },
      ['bin/**']
    );
    expect(plan.actions).toContainEqual({
      kind: 'save-new-as',
      path: 'bin/tool',
      savedAs: 'bin/tool.dork-new',
    });
    expect(await runnable(staged, 'bin/tool.dork-new')).toBe(false);
    // The person's kept program still runs: it is theirs, not a saved copy.
    expect(await runnable(staged, 'bin/tool')).toBe(true);
  });

  it('saves a folder under .dork/saved, where no loader looks, with nothing runnable', async () => {
    // The person's own skill folder; the new version ships a file at its path.
    const { plan } = await update(
      { 'README.md': 'r' },
      { 'skills/mine/SKILL.md': 'mine', 'skills/mine/run.sh+x': 'x' },
      { 'README.md': 'r', skills: 'a file now' }
    );
    expect(plan.actions).toContainEqual({
      kind: 'carry-dir-as',
      path: 'skills',
      savedAs: '.dork/saved/skills.dork-old',
    });
    const saved = '.dork/saved/skills.dork-old/mine';
    expect((await stat(path.join(staged, saved, 'SKILL.md'))).isFile()).toBe(true);
    expect(await runnable(staged, `${saved}/run.sh`)).toBe(false);
  });

  it('saves late writes under a blocked folder into one saved folder, not runnable', async () => {
    await writeTree(live, { 'a/x.sh+x': 'x' });
    const backup = live;
    const target = staged;
    await writeTree(target, { a: 'a file now' });
    const notices = await lateWritePass({
      backupRoot: backup,
      targetRoot: target,
      snapshot: { source: new Map(), clones: new Map() },
      ownedPaths: [],
    });
    expect(notices).toEqual([
      { path: 'a/x.sh', outcome: 'late-write', savedAs: '.dork/saved/a.dork-old/x.sh' },
    ]);
    expect(await runnable(target, '.dork/saved/a.dork-old/x.sh')).toBe(false);
  });
});

describe('saved folder names', () => {
  it('flattens the path one level under .dork/saved, then numbers it', () => {
    const names = savedFolderCandidates('.claude/skills/mine');
    expect(names.next().value).toBe('.dork/saved/.claude__skills__mine.dork-old');
    expect(names.next().value).toBe('.dork/saved/.claude__skills__mine.dork-old.2');
  });

  it('keeps a name that is already a saved copy', () => {
    expect(savedFolderCandidates('skills/x.dork-old').next().value).toBe(
      '.dork/saved/skills__x.dork-old'
    );
  });

  it('picks a folder name for a folder and a file name for a file', async () => {
    await writeTree(live, {
      'skills/mine/SKILL.md': 's',
      'a.md': 'a',
      '.dork/saved/skills__mine.dork-old/x': 'x',
    });
    expect(await freeSavedName(live, 'skills/mine')).toBe('.dork/saved/skills__mine.dork-old.2');
    expect(await freeSavedName(live, 'a.md')).toBe('a.md.dork-old');
  });
});

describe.skipIf(process.platform === 'win32')('makeInert', () => {
  it('clears execute bits through a folder and leaves folders openable', async () => {
    await writeTree(live, { 'd/e/run+x': 'x', 'd/plain': 'p' });
    await makeInert(path.join(live, 'd'));
    expect(await runnable(live, 'd/e/run')).toBe(false);
    expect(await runnable(live, 'd/e')).toBe(true);
  });
});

describe('what counts as a program on PATH', () => {
  // Purpose: Windows reports no execute bits, so the decision there follows
  // what Git Bash runs: a program extension, or a `#!`/`MZ` header.
  it.each([
    ['tool.exe', 'anything', true],
    ['TOOL.CMD', 'anything', true],
    ['script', '#!/bin/sh\n', true],
    ['binary', 'MZ\u0090\u0000', true],
    ['notes.txt', 'plain', false],
    ['empty', '', false],
  ])('on Windows, %s is a program: %s', async (name, content, expected) => {
    await writeTree(live, { [`bin/${name}`]: content });
    expect(await isPathProgram(path.join(live, 'bin', name), 'win32')).toBe(expected);
  });

  it.skipIf(process.platform === 'win32')('on POSIX, only an execute bit makes one', async () => {
    await writeTree(live, { 'bin/run+x': 'x', 'bin/script': '#!/bin/sh\n' });
    expect(await isPathProgram(path.join(live, 'bin', 'run'), 'linux')).toBe(true);
    expect(await isPathProgram(path.join(live, 'bin', 'script'), 'linux')).toBe(false);
  });
});
