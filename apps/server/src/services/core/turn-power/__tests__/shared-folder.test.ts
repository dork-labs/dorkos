/**
 * The one folder a teammate's turn may read (DOR-2956): every read decided on the file's realpath
 * inside the shared folder's, with links, `..`, case and Unicode tricks refused, and `.git`,
 * `.dork`, `.env*` and files over 1 MB never read.
 *
 * @vitest-environment node
 */
import { mkdir, mkdtemp, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  isAlwaysLeftOut,
  listSharedFiles,
  searchSharedFiles,
  sharedFileVerdict,
  SHARED_FILE_MAX_BYTES,
} from '../shared-folder.js';

let base: string;
let shared: string;
let outside: string;

beforeEach(async () => {
  base = await realpath(await mkdtemp(path.join(tmpdir(), 'shared-folder-')));
  shared = path.join(base, 'acme');
  outside = path.join(base, 'private');
  await mkdir(path.join(shared, 'docs'), { recursive: true });
  await mkdir(path.join(shared, '.git'), { recursive: true });
  await mkdir(path.join(shared, '.dork'), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(shared, 'README.md'), 'Acme readme\nthe plan\n');
  await writeFile(path.join(shared, 'docs', 'plan.md'), 'The plan is shared.\n');
  await writeFile(path.join(shared, '.env'), 'SECRET=shared-env\n');
  await writeFile(path.join(shared, '.env.local'), 'SECRET=local\n');
  await writeFile(path.join(shared, '.git', 'config'), '[core] the plan\n');
  await writeFile(path.join(shared, '.dork', 'agent.json'), '{"the plan":1}');
  await writeFile(path.join(outside, 'secret.md'), 'the plan is private\n');
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

const ok = (verdict: Awaited<ReturnType<typeof sharedFileVerdict>>) => verdict.ok;

describe('reading one file', () => {
  it('allows a file inside the shared folder, by its realpath', async () => {
    const verdict = await sharedFileVerdict(shared, path.join(shared, 'docs', 'plan.md'));
    expect(verdict).toEqual({
      ok: true,
      realPath: path.join(shared, 'docs', 'plan.md'),
      relativePath: path.join('docs', 'plan.md'),
    });
  });

  it('reads nothing when the space shares no folder, or for a relative path', async () => {
    expect(ok(await sharedFileVerdict(null, path.join(shared, 'README.md')))).toBe(false);
    // Even one that would resolve inside it from where the server stands.
    const here = process.cwd();
    process.chdir(shared);
    try {
      expect(ok(await sharedFileVerdict(shared, 'README.md'))).toBe(false);
    } finally {
      process.chdir(here);
    }
    expect(ok(await sharedFileVerdict(shared, 42))).toBe(false);
  });

  it('refuses a file outside it, however the path is spelled', async () => {
    expect(ok(await sharedFileVerdict(shared, path.join(outside, 'secret.md')))).toBe(false);
    // `..` out of the folder.
    expect(ok(await sharedFileVerdict(shared, `${shared}/docs/../../private/secret.md`))).toBe(
      false
    );
    // The folder itself is not a file.
    expect(ok(await sharedFileVerdict(shared, shared))).toBe(false);
  });

  it('refuses a link inside the folder that points out of it', async () => {
    await symlink(path.join(outside, 'secret.md'), path.join(shared, 'looks-local.md'));
    await symlink(outside, path.join(shared, 'docs', 'private-dir'));
    expect(ok(await sharedFileVerdict(shared, path.join(shared, 'looks-local.md')))).toBe(false);
    expect(
      ok(await sharedFileVerdict(shared, path.join(shared, 'docs', 'private-dir', 'secret.md')))
    ).toBe(false);
  });

  it('follows a link that stays inside, and reads the file it names', async () => {
    await symlink(path.join(shared, 'docs', 'plan.md'), path.join(shared, 'plan-link.md'));
    const verdict = await sharedFileVerdict(shared, path.join(shared, 'plan-link.md'));
    expect(verdict.ok && verdict.realPath).toBe(path.join(shared, 'docs', 'plan.md'));
  });

  it('refuses a file swapped for a link out of the folder after it was allowed', async () => {
    const file = path.join(shared, 'docs', 'plan.md');
    expect(ok(await sharedFileVerdict(shared, file))).toBe(true);
    await unlink(file);
    await symlink(path.join(outside, 'secret.md'), file);
    expect(ok(await sharedFileVerdict(shared, file))).toBe(false);
  });

  it('never reads .env files, .git or .dork, whatever their case or form', async () => {
    for (const file of [
      '.env',
      '.env.local',
      path.join('.git', 'config'),
      path.join('.dork', 'agent.json'),
    ]) {
      expect(ok(await sharedFileVerdict(shared, path.join(shared, file)))).toBe(false);
    }
    // On a case-insensitive disk `.ENV` opens `.env`; on any disk it is refused.
    expect(ok(await sharedFileVerdict(shared, path.join(shared, '.ENV')))).toBe(false);
    // A link to a secret inside the folder is the secret.
    await symlink(path.join(shared, '.env'), path.join(shared, 'innocent.txt'));
    expect(ok(await sharedFileVerdict(shared, path.join(shared, 'innocent.txt')))).toBe(false);
    expect(isAlwaysLeftOut('.ENV')).toBe(true);
    expect(isAlwaysLeftOut('.Git')).toBe(true);
    expect(isAlwaysLeftOut('.DORK')).toBe(true);
    // Case folded, as a case-insensitive disk opens `.Env.Production` for `.env.production`.
    expect(isAlwaysLeftOut('.Env.Production')).toBe(true);
    expect(isAlwaysLeftOut('environment.md')).toBe(false);
  });

  it('never reads a file over 1 MB', async () => {
    const big = path.join(shared, 'big.log');
    await writeFile(big, Buffer.alloc(SHARED_FILE_MAX_BYTES + 1, 97));
    expect(ok(await sharedFileVerdict(shared, big))).toBe(false);
  });
});

describe('listing and searching', () => {
  it('lists only what may be read, never entering a linked folder or the left-out ones', async () => {
    await symlink(outside, path.join(shared, 'docs', 'private-dir'));
    // A link to a folder inside it is not entered either: no file is listed twice, no loop.
    await symlink(path.join(shared, 'docs'), path.join(shared, 'docs-link'));
    await symlink(path.join(outside, 'secret.md'), path.join(shared, 'looks-local.md'));
    const { files, truncated } = await listSharedFiles(shared);
    expect(files.map((file) => file.path).sort()).toEqual(
      ['README.md', path.join('docs', 'plan.md')].sort()
    );
    expect(truncated).toBe(false);
  });

  it('lists under a folder inside only, and nothing for a path that leaves it', async () => {
    expect((await listSharedFiles(shared, 'docs')).files.map((file) => file.path)).toEqual([
      path.join('docs', 'plan.md'),
    ]);
    expect((await listSharedFiles(shared, '../private')).files).toEqual([]);
    expect((await listSharedFiles(shared, '.git')).files).toEqual([]);
  });

  it('searches only readable files', async () => {
    await symlink(path.join(outside, 'secret.md'), path.join(shared, 'looks-local.md'));
    const { matches } = await searchSharedFiles(shared, 'THE PLAN');
    expect(matches.map((match) => match.path).sort()).toEqual(
      ['README.md', path.join('docs', 'plan.md')].sort()
    );
    expect(matches.find((match) => match.path === 'README.md')).toMatchObject({ line: 2 });
  });
});
