import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { initBoundary } from '../../../../lib/boundary.js';
import { resolveDocSpace, type DocSpace } from '../../doc-space.js';
import { buildDocIndex, DOC_INDEX_LIMITS, resetDocIndexCacheForTests } from '../doc-index.js';
import { DOC_RESOLVE_LIMITS, resolveDocTarget } from '../doc-resolve.js';

let base: string;
let root: string;
let space: DocSpace;

function put(relative: string, text: string): void {
  const absolute = path.join(root, relative);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, text);
}

beforeEach(async () => {
  resetDocIndexCacheForTests();
  base = realpathSync(mkdtempSync(path.join(tmpdir(), 'doc-resolve-')));
  root = path.join(base, 'space');
  mkdirSync(root);
  await initBoundary(base);
  space = await resolveDocSpace(root);
  // Deep enough that an index allowed two levels stops before it.
  put('a.md', '# A\n');
  put('one/two/three/deep.md', '---\ntitle: Far away\n---\n');
  put('one/plan.md', '# Plan\n');
  put('one/two/three/plan.md', '# Plan\n');
});

afterEach(() => rmSync(base, { recursive: true, force: true }));

describe('resolveDocTarget', () => {
  it('finds a doc, by title, that the truncated index never listed', async () => {
    const shallow = { ...DOC_INDEX_LIMITS, maxDepth: 2 };
    const index = await buildDocIndex(space, shallow);
    expect(index.truncated).toBe(true);
    expect(index.docs.map((doc) => doc.path)).not.toContain('one/two/three/deep.md');

    await expect(resolveDocTarget(space, 'Far away', null)).resolves.toEqual({
      doc: { path: 'one/two/three/deep.md', title: 'Far away', slug: 'deep' },
      complete: true,
    });
  });

  it('picks the nearest of several matches, as the index rules do', async () => {
    const near = await resolveDocTarget(space, 'plan', 'one/two/three/deep.md');
    expect(near.doc?.path).toBe('one/two/three/plan.md');
    const top = await resolveDocTarget(space, 'plan', 'a.md');
    expect(top.doc?.path).toBe('one/plan.md');
  });

  it('says missing only after looking through the whole space', async () => {
    await expect(resolveDocTarget(space, 'Nowhere', null)).resolves.toEqual({
      doc: null,
      complete: true,
    });
    const rushed = await resolveDocTarget(space, 'Nowhere', null, {
      ...DOC_RESOLVE_LIMITS,
      budgetMs: 0,
    });
    expect(rushed).toEqual({ doc: null, complete: false });
  });
});
