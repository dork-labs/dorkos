/**
 * @vitest-environment node
 *
 * DOR-4358, Security's Must 1 on #3751: deciding which tracked `.npmrc` stays
 * readable must never run a repository's own program. git reads only the
 * index; "unchanged" is a blob hash taken in Node. Made-up files only.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  INDEX_READ_ARGS,
  matchesIndex,
  parseIndexEntries,
  resetTrackedLookups,
  settleTrackedLookups,
  trackedUnchangedNpmrc,
} from '../policy/tracked-npmrc.js';

let repo: string;
let marker: string;

/** Run git in the repo with a throwaway identity, and return what it printed. */
function git(...args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=a@example.com', '-c', 'user.name=A', ...args], {
    cwd: repo,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

/** A git blob id for `text`, as git computes it. */
function blobId(text: string, algorithm: 'sha1' | 'sha256' = 'sha1'): string {
  return createHash(algorithm)
    .update(`blob ${Buffer.byteLength(text)}\0`)
    .update(text)
    .digest('hex');
}

beforeEach(() => {
  resetTrackedLookups();
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-tracked-npmrc-')));
  repo = path.join(root, 'repo');
  marker = path.join(root, 'filter-ran');
  fs.mkdirSync(repo);
  git('init', '-q');
  fs.writeFileSync(path.join(repo, '.npmrc'), 'auto-install-peers=true\n');
  git('add', '.npmrc');
  git('commit', '-q', '-m', 'made-up');
});
afterEach(async () => {
  await settleTrackedLookups();
  resetTrackedLookups();
  fs.rmSync(path.dirname(repo), { recursive: true, force: true });
});

describe('a repository filter never runs (Must 1)', () => {
  /** Name a clean filter that leaves a marker, the way an agent could. */
  function plantFilter(): void {
    fs.writeFileSync(path.join(repo, '.gitattributes'), '.npmrc filter=x\n');
    git('config', 'filter.x.clean', `touch ${JSON.stringify(marker)}; cat`);
    // A touched file is what makes git hash it again through the filter.
    fs.utimesSync(path.join(repo, '.npmrc'), new Date(), new Date(Date.now() + 5_000));
  }

  it('the index read itself runs no filter, where a --modified check does', () => {
    plantFilter();
    git(...INDEX_READ_ARGS);
    expect(fs.existsSync(marker), 'the index read ran the filter').toBe(false);
    // The same repository with the old check: the filter runs, so this test can fail.
    git('ls-files', '-z', '--modified', '--', ':(glob)**/.npmrc');
    expect(fs.existsSync(marker)).toBe(true);
  });

  it('the lookup leaves no marker, and spares nothing in a repo with a filter', async () => {
    plantFilter();
    trackedUnchangedNpmrc(repo);
    await settleTrackedLookups(repo);
    expect(trackedUnchangedNpmrc(repo).size).toBe(0);
    expect(fs.existsSync(marker), 'the lookup ran the filter').toBe(false);
  });
});

describe('what counts as unchanged', () => {
  const file = () => `${repo}/.npmrc`;

  it('spares the tracked file once the index is read, and only while its bytes match', async () => {
    expect(trackedUnchangedNpmrc(repo).size, 'before the first index read').toBe(0);
    await settleTrackedLookups(repo);
    expect([...trackedUnchangedNpmrc(repo)]).toEqual([file()]);
    // Checked at render time: an edit counts at once, without a new index read.
    fs.appendFileSync(file(), 'token=added-after-commit\n');
    expect(trackedUnchangedNpmrc(repo).size).toBe(0);
  });

  it('does not spare a link, even to a file with the tracked bytes', () => {
    const copy = path.join(path.dirname(repo), 'copy');
    fs.writeFileSync(copy, 'auto-install-peers=true\n');
    fs.rmSync(file());
    fs.symlinkSync(copy, file());
    expect(matchesIndex({ file: file(), id: blobId('auto-install-peers=true\n') })).toBe(false);
  });

  it('hashes SHA-1 and SHA-256 blob ids the way git does', () => {
    const text = 'auto-install-peers=true\n';
    expect(matchesIndex({ file: file(), id: blobId(text) })).toBe(true);
    expect(matchesIndex({ file: file(), id: blobId(text, 'sha256') })).toBe(true);
    expect(matchesIndex({ file: file(), id: blobId('something else\n') })).toBe(false);
  });

  it('reads only stage-0 regular files from the index', () => {
    const id = 'a'.repeat(40);
    const out = [
      `100644 ${id} 0\tapp/.npmrc`,
      `100755 ${id} 0\tbin/.npmrc`,
      `120000 ${id} 0\tlink/.npmrc`,
      `160000 ${id} 0\tsub/.npmrc`,
      `100644 ${id} 2\tconflict/.npmrc`,
      `100644 not-hex 0\tbad/.npmrc`,
    ].join('\0');
    expect(parseIndexEntries('/repo', out).map((entry) => entry.file)).toEqual([
      '/repo/app/.npmrc',
      '/repo/bin/.npmrc',
    ]);
  });
});
