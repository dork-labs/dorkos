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
import {
  buildDocIndex,
  DOC_INDEX_LIMITS,
  docTitleFromHead,
  resetDocIndexCacheForTests,
} from '../doc-index.js';

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

describe('docTitleFromHead', () => {
  it('takes the frontmatter title first', () => {
    expect(docTitleFromHead('---\ntitle: "Launch plan"\n---\n# Heading\n', 'a.md')).toBe(
      'Launch plan'
    );
    expect(docTitleFromHead("---\nowner: me\ntitle: 'Q3'\n---\n", 'a.md')).toBe('Q3');
  });

  it('falls back to the first # heading, skipping code blocks and deeper headings', () => {
    expect(docTitleFromHead('Intro\n## Part\n# Real title #\n', 'a.md')).toBe('Real title');
    expect(docTitleFromHead('```\n# not this\n```\n# This\n', 'a.md')).toBe('This');
    expect(docTitleFromHead('---\ntitle:\n---\n# After empty title\n', 'a.md')).toBe(
      'After empty title'
    );
  });

  it('falls back to the file name without .md', () => {
    expect(docTitleFromHead('just text\n#hashtag\n', 'Meeting Notes.md')).toBe('Meeting Notes');
    expect(docTitleFromHead('', 'README.MD')).toBe('README');
  });

  it('ignores a byte order mark and Windows line ends', () => {
    expect(docTitleFromHead('\uFEFF# Hello\r\nbody', 'a.md')).toBe('Hello');
    expect(docTitleFromHead('---\r\ntitle: Win\r\n---\r\n', 'a.md')).toBe('Win');
  });
});

describe('buildDocIndex', () => {
  it('lists every .md file with its path, title and slug, sorted by path', async () => {
    put('README.md', '# Welcome\n');
    put('notes/Meeting Notes.md', 'no heading here\n');
    put('notes/plan.MD', '---\ntitle: Plan\n---\n');
    put('notes/image.png', 'x');
    put('notes/draft.txt', '# Not a doc\n');
    await expect(buildDocIndex(space)).resolves.toEqual({
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
    put('long.md', `${'x'.repeat(DOC_INDEX_LIMITS.titleBytes)}\n# Too far down\n`);
    put('cut.md', `${'y\n'.repeat(DOC_INDEX_LIMITS.titleBytes / 2 - 2)}# Cut short by the read`);
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
    put('doc.md', '# Before\n');
    await buildDocIndex(space);
    const open = vi.spyOn(fs, 'open');
    expect((await buildDocIndex(space)).docs[0]?.title).toBe('Before');
    expect(open).not.toHaveBeenCalled();

    put('doc.md', '# After, longer\n');
    const later = new Date(Date.now() + 5_000);
    utimesSync(path.join(root, 'doc.md'), later, later);
    expect((await buildDocIndex(space)).docs[0]?.title).toBe('After, longer');
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('shares one walk between two requests at once', async () => {
    put('doc.md', '# Doc\n');
    const readdir = vi.spyOn(fs, 'readdir');
    const [a, b] = await Promise.all([buildDocIndex(space), buildDocIndex(space)]);
    expect(a).toBe(b);
    expect(readdir).toHaveBeenCalledTimes(1);
  });
});
