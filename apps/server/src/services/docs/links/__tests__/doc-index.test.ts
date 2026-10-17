import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { initBoundary } from '../../../../lib/boundary.js';
import { resolveDocSpace, type DocSpace } from '../../doc-space.js';
import { execFileSync } from 'node:child_process';
import { DOC_TITLE_BYTES } from '@dorkos/shared/doc-links';
import { buildDocIndex, DOC_INDEX_LIMITS, resetDocIndexCacheForTests } from '../doc-index.js';

let base: string;
let root: string;
let space: DocSpace;

/** Write a file under the space, making its folders. */
function put(relative: string, text: string): void {
  const absolute = path.join(root, relative);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, text);
}

beforeEach(async () => {
  resetDocIndexCacheForTests();
  base = realpathSync(mkdtempSync(path.join(tmpdir(), 'doc-index-')));
  root = path.join(base, 'space');
  mkdirSync(root);
  await initBoundary(base);
  space = await resolveDocSpace(root);
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(base, { recursive: true, force: true });
});

describe('buildDocIndex', () => {
  it('lists every .md file with its path, title and slug, sorted by path', async () => {
    put('README.md', '# Welcome\n');
    put('notes/Meeting Notes.md', 'no heading here\n');
    put('notes/plan.MD', '---\ntitle: Plan\n---\n');
    put('notes/image.png', 'x');
    put('notes/draft.txt', '# Not a doc\n');
    await expect(buildDocIndex(space)).resolves.toEqual({
      root,
      docs: [
        { path: 'README.md', title: 'Welcome', slug: 'readme' },
        { path: 'notes/Meeting Notes.md', title: 'Meeting Notes', slug: 'meeting-notes' },
        { path: 'notes/plan.MD', title: 'Plan', slug: 'plan' },
      ],
      truncated: false,
    });
  });

  it('skips dot-folders, dependency and build folders, and dotfiles', async () => {
    put('.git/x.md', '');
    put('.obsidian/y.md', '');
    put('node_modules/pkg/README.md', '');
    put('dist/out.md', '');
    put('vendor/lib.md', '');
    put('.hidden.md', '');
    put('kept/doc.md', '');
    const { docs, truncated } = await buildDocIndex(space);
    expect(docs.map((doc) => doc.path)).toEqual(['kept/doc.md']);
    expect(truncated).toBe(false);
  });

  it('never follows a symlink, to a folder or a file', async () => {
    const outside = path.join(base, 'outside');
    mkdirSync(outside);
    writeFileSync(path.join(outside, 'secret.md'), '# Secret\n');
    symlinkSync(outside, path.join(root, 'linked'));
    symlinkSync(path.join(outside, 'secret.md'), path.join(root, 'secret.md'));
    put('own.md', '# Own\n');
    const { docs } = await buildDocIndex(space);
    expect(docs.map((doc) => doc.path)).toEqual(['own.md']);
  });

  it('reads only the start of a doc for its title', async () => {
    put('long.md', `${'x'.repeat(DOC_TITLE_BYTES)}\n# Too far down\n`);
    put('cut.md', `${'y\n'.repeat(DOC_TITLE_BYTES / 2 - 2)}# Cut short by the read`);
    const { docs } = await buildDocIndex(space);
    expect(docs.map((doc) => doc.title)).toEqual(['cut', 'long']);
  });

  it('stops at the doc limit and says so', async () => {
    for (const name of ['a', 'b', 'c']) put(`${name}.md`, '');
    const limits = { ...DOC_INDEX_LIMITS, maxDocs: 2 };
    await expect(buildDocIndex(space, limits)).resolves.toMatchObject({ truncated: true });
    expect((await buildDocIndex(space, limits)).docs).toHaveLength(2);
  });

  it('stops at the depth limit and says so', async () => {
    put('one/two/three/deep.md', '');
    put('one/shallow.md', '');
    const { docs, truncated } = await buildDocIndex(space, { ...DOC_INDEX_LIMITS, maxDepth: 2 });
    expect(docs.map((doc) => doc.path)).toEqual(['one/shallow.md']);
    expect(truncated).toBe(true);
  });

  it('stops at the folder limit and says so', async () => {
    put('a/x.md', '');
    put('b/y.md', '');
    const { docs, truncated } = await buildDocIndex(space, { ...DOC_INDEX_LIMITS, maxFolders: 2 });
    expect(docs.map((doc) => doc.path)).toEqual(['a/x.md']);
    expect(truncated).toBe(true);
  });

  it('lists a doc created since the last walk at once', async () => {
    put('first.md', '# First\n');
    expect((await buildDocIndex(space)).docs).toHaveLength(1);
    put('second.md', '# Second\n');
    expect((await buildDocIndex(space)).docs.map((doc) => doc.title)).toEqual(['First', 'Second']);
  });

  it('reads a title again only when the file changed', async () => {
    const file = path.join(root, 'doc.md');
    put('doc.md', '# Before\n');
    const pinned = new Date('2026-01-01T00:00:00Z');
    utimesSync(file, pinned, pinned);
    expect((await buildDocIndex(space)).docs[0]?.title).toBe('Before');

    // Same size and modified time: the cached title stands, so the file was not read.
    writeFileSync(file, '# Behind\n');
    utimesSync(file, pinned, pinned);
    expect((await buildDocIndex(space)).docs[0]?.title).toBe('Before');

    put('doc.md', '# After, longer\n');
    expect((await buildDocIndex(space)).docs[0]?.title).toBe('After, longer');
  });

  it('answers a request made during a walk with a walk that started after it', async () => {
    put('first.md', '# First\n');
    const running = buildDocIndex(space);
    // Created after the first walk started: that walk may or may not see it.
    put('second.md', '# Second\n');
    const later = buildDocIndex(space);
    const laterStill = buildDocIndex(space);
    expect(later).not.toBe(running);
    expect(laterStill).toBe(later);
    await running;
    expect((await later).docs.map((doc) => doc.title)).toEqual(['First', 'Second']);
  });

  it('runs one follow-up walk however many requests arrive during a walk', async () => {
    put('doc.md', '# Doc\n');
    const readdir = vi.spyOn(fs, 'readdir');
    const all = await Promise.all([1, 2, 3, 4].map(() => buildDocIndex(space)));
    expect(all[1]).toBe(all[3]);
    expect(readdir).toHaveBeenCalledTimes(2);
  });

  it('stops at its time budget and says so', async () => {
    put('a/x.md', '# X\n');
    put('top.md', '# Top\n');
    const { docs, truncated } = await buildDocIndex(space, { ...DOC_INDEX_LIMITS, budgetMs: 0 });
    expect(truncated).toBe(true);
    expect(docs).toEqual([]);
  });

  it('never reads a symlink or FIFO swapped in after the folder was listed', async () => {
    const outside = path.join(base, 'outside');
    mkdirSync(outside);
    writeFileSync(path.join(outside, 'secret.md'), '# Secret\n');
    put('linked.md', '# Linked\n');
    put('piped.md', '# Piped\n');
    const realReaddir = fs.readdir.bind(fs);
    vi.spyOn(fs, 'readdir').mockImplementation((async (...args: Parameters<typeof fs.readdir>) => {
      const entries = await realReaddir(...args);
      // Swap both docs after the listing, before their titles are read.
      rmSync(path.join(root, 'linked.md'));
      symlinkSync(path.join(outside, 'secret.md'), path.join(root, 'linked.md'));
      rmSync(path.join(root, 'piped.md'));
      execFileSync('mkfifo', [path.join(root, 'piped.md')]);
      return entries;
    }) as typeof fs.readdir);
    const { docs } = await buildDocIndex(space);
    expect(docs.map((doc) => doc.title)).toEqual(['linked', 'piped']);
  });
});
