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
import { carryPersonFiles, lateWritePass } from '../../records/carry-over.js';
import { computeInstalledFiles } from '../../records/installed-files.js';
import { isPathProgram, readPackagePrograms } from '../../declarations/package-programs.js';
import { readPackageSkills } from '../../declarations/package-skills.js';
import { listSkillDirs } from '@dorkos/harness/scan';
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
  it('moves an edited program saved aside from bin/ off the PATH, not runnable', async () => {
    const { plan } = await update(
      { 'bin/tool+x': '#!/bin/sh\necho v1\n' },
      { 'bin/tool+x': '#!/bin/sh\necho mine\n' },
      { 'bin/tool+x': '#!/bin/sh\necho v2\n' }
    );
    // Git Bash on Windows runs a #! file in bin/ whatever its mode, so a saved
    // program leaves bin/ altogether.
    expect(plan.actions).toContainEqual({
      kind: 'carry-as',
      path: 'bin/tool',
      savedAs: '.dork/saved/bin__tool.dork-old',
    });
    expect(await runnable(staged, '.dork/saved/bin__tool.dork-old')).toBe(false);
    // The new version's own program is untouched.
    expect(await runnable(staged, 'bin/tool')).toBe(true);
  });

  it('clears the execute bits of a new default saved as .dork-new', async () => {
    const { plan } = await update(
      { 'tools/tool+x': 'v1' },
      { 'tools/tool+x': 'mine' },
      { 'tools/tool+x': 'v2' },
      ['tools/**']
    );
    expect(plan.actions).toContainEqual({
      kind: 'save-new-as',
      path: 'tools/tool',
      savedAs: 'tools/tool.dork-new',
    });
    expect(await runnable(staged, 'tools/tool.dork-new')).toBe(false);
    // The person's kept program still runs: it is theirs, not a saved copy.
    expect(await runnable(staged, 'tools/tool')).toBe(true);
  });

  it('saves any other file beside itself', async () => {
    const { plan } = await update(
      { 'skills/a/SKILL.md': 'v1' },
      { 'skills/a/SKILL.md': 'mine' },
      { 'skills/a/SKILL.md': 'v2' }
    );
    expect(plan.actions).toContainEqual({
      kind: 'carry-as',
      path: 'skills/a/SKILL.md',
      savedAs: 'skills/a/SKILL.md.dork-old',
    });
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

// The permanent reproduction of DOR-2340
// (research/20260926-marketplace-retained-copy-reproduction.md), as a
// regression test: every case it records now comes out inert.
describe.skipIf(process.platform === 'win32')('the recorded DOR-2340 reproduction', () => {
  it('leaves no saved copy runnable, on the PATH, discovered or disclosed', async () => {
    await writeTree(live, {
      'bin/tool+x': '#!/bin/sh\nprintf original',
      'settings/command+x': '#!/bin/sh\nprintf settings',
    });
    const rOld = await computeInstalledFiles(live, {
      identity,
      userEditable: ['settings/command'],
      npmRan: false,
    });
    await writeTree(live, {
      'bin/tool+x': '#!/bin/sh\nprintf edited-copy',
      'settings/command+x': '#!/bin/sh\nprintf my-settings',
      'skills/x/SKILL.md': '---\nname: x\ndescription: fixture\nallowed-tools: Bash\n---\nFixture',
    });
    await writeTree(staged, {
      'bin/tool+x': '#!/bin/sh\nprintf new',
      'settings/command+x': '#!/bin/sh\nprintf new-settings',
      'skills/x': 'new package file blocks old folder',
    });
    const rNew = await computeInstalledFiles(staged, {
      identity,
      userEditable: ['settings/command'],
      npmRan: false,
    });
    const { plan } = await carryPersonFiles({
      liveRoot: live,
      stagingDir: staged,
      rOld,
      rNew,
      oldHasIdentity: true,
    });

    // carry-as and save-new-as kept 0755; now neither copy can run.
    const savedTool = plan.actions.find((a) => a.kind === 'carry-as' && a.path === 'bin/tool');
    expect(savedTool).toMatchObject({ savedAs: '.dork/saved/bin__tool.dork-old' });
    expect(await runnable(staged, '.dork/saved/bin__tool.dork-old')).toBe(false);
    expect(await runnable(staged, 'settings/command.dork-new')).toBe(false);
    // Nothing saved is left in bin/, and only the real program is disclosed.
    expect((await readPackagePrograms(staged, undefined)).executables).toEqual(['tool']);
    // carry-dir-as left skills/x.dork-old/SKILL.md discoverable; now neither
    // Harness Sync nor the disclosure reader finds the saved skill.
    expect(
      listSkillDirs(path.join(staged, 'skills'), 'skills', { followSymlinks: false }).skills
    ).toEqual([]);
    const skills = await readPackageSkills(staged, undefined);
    expect(skills.skillTools.map((s) => s.source)).toEqual([]);
    expect(
      (await stat(path.join(staged, '.dork/saved/skills__x.dork-old/SKILL.md'))).isFile()
    ).toBe(true);
  });
});

// The record's `savedCopies` mark says a root holds no runnable or loadable
// saved copy (DOR-2340): true of anything this version writes, but an update
// carries an unmigrated root's old copies over as they are.
describe('the saved-copies mark on a record', () => {
  it('is set on a record made from a tree this version wrote', async () => {
    await writeTree(live, { 'a.md': 'a' });
    expect(
      (await computeInstalledFiles(live, { identity, userEditable: [], npmRan: false })).savedCopies
    ).toBe(1);
  });

  it('survives an update only from a record that had it', async () => {
    await writeTree(live, { 'a.md': 'a' });
    const marked = await computeInstalledFiles(live, { identity, userEditable: [], npmRan: false });
    const { savedCopies: _mark, ...unmarked } = marked;
    await writeTree(staged, { 'a.md': 'a2' });
    for (const [rOld, expected] of [
      [marked, 1],
      [unmarked, undefined],
    ] as const) {
      const rNew = await computeInstalledFiles(staged, {
        identity,
        userEditable: [],
        npmRan: false,
      });
      await carryPersonFiles({
        liveRoot: live,
        stagingDir: staged,
        rOld,
        oldHasIdentity: true,
        rNew,
      });
      expect(rNew.savedCopies).toBe(expected);
    }
  });
});
