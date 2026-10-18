import { describe, expect, it } from 'vitest';
import {
  createDocLinkIndex,
  docHeadingAnchor,
  docSlug,
  relativeDocHref,
  type DocIndexEntry,
} from '../doc-links.js';

/** An index entry, slug worked out the way the server works it out. */
function doc(path: string, title?: string): DocIndexEntry {
  const base = path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/i, '');
  return { path, title: title ?? base, slug: docSlug(base) };
}

const docs = [
  doc('README.md', 'Welcome'),
  doc('plan.md', 'Launch plan'),
  doc('notes/plan.md', 'Notes plan'),
  doc('notes/Meeting Notes.md', 'Meeting notes'),
  doc('notes/deep/idea.md', 'Q3/Q4 idea'),
  doc('specs/plan.md', 'Spec plan'),
  doc('specs/api.md', 'API'),
  doc('café/Crème Brûlée.md', 'Crème brûlée'),
];
const index = createDocLinkIndex(docs);
const path = (target: string, from: string | null = null) =>
  index.resolve(target, from)?.path ?? null;

describe('docSlug', () => {
  it('lowercases and turns each run of spaces into one dash', () => {
    expect(docSlug('Meeting  Notes')).toBe('meeting-notes');
    expect(docSlug('  Plan ')).toBe('plan');
  });

  it('keeps letters outside ASCII and normalizes to NFC', () => {
    expect(docSlug('Cre\u0300me')).toBe('crème');
    expect(docSlug('Ünïcödé Doc')).toBe('ünïcödé-doc');
  });
});

describe('resolve', () => {
  it('matches a title, a slug or a file name, ignoring case and spaces', () => {
    expect(path('Welcome')).toBe('README.md');
    expect(path('  welcome  ')).toBe('README.md');
    expect(path('readme')).toBe('README.md');
    expect(path('meeting-notes')).toBe('notes/Meeting Notes.md');
    expect(path('Meeting Notes')).toBe('notes/Meeting Notes.md');
    expect(path('API')).toBe('specs/api.md');
  });

  it('matches a file name written with .md', () => {
    expect(path('README.md')).toBe('README.md');
    expect(path('api.MD')).toBe('specs/api.md');
  });

  it('matches a path from the linking doc’s folder first, then from the root', () => {
    expect(path('deep/idea', 'notes/plan.md')).toBe('notes/deep/idea.md');
    expect(path('notes/deep/idea.md', 'specs/api.md')).toBe('notes/deep/idea.md');
    expect(path('../plan', 'notes/deep/idea.md')).toBe('notes/plan.md');
    expect(path('NOTES/PLAN')).toBe('notes/plan.md');
  });

  it('reads a path starting with / from the root only', () => {
    expect(path('/plan', 'notes/Meeting Notes.md')).toBe('plan.md');
    expect(path('/deep/idea', 'notes/plan.md')).toBeNull();
  });

  it('never resolves a path that leaves the space', () => {
    expect(path('../plan', 'notes/plan.md')).toBe('plan.md');
    expect(path('../../plan', 'notes/plan.md')).toBeNull();
    expect(path('../outside')).toBeNull();
  });

  it('tries a target with / as a name when no path matches it', () => {
    expect(path('Q3/Q4 idea')).toBe('notes/deep/idea.md');
  });

  it('prefers the doc in the linking doc’s folder when names collide', () => {
    expect(path('plan', 'notes/Meeting Notes.md')).toBe('notes/plan.md');
    expect(path('plan', 'specs/api.md')).toBe('specs/plan.md');
    expect(path('plan', 'README.md')).toBe('plan.md');
  });

  it('breaks a tie by folder steps, then path, never by index order', () => {
    // From notes/deep, notes/plan.md is one step away, the others two.
    expect(path('plan', 'notes/deep/idea.md')).toBe('notes/plan.md');
    const tie = [doc('b/x.md'), doc('a/x.md')];
    expect(createDocLinkIndex(tie).resolve('x', 'c/y.md')?.path).toBe('a/x.md');
    expect(createDocLinkIndex([...tie].reverse()).resolve('x', 'c/y.md')?.path).toBe('a/x.md');
  });

  it('treats no linking doc as linking from the root', () => {
    expect(path('plan', null)).toBe('plan.md');
  });

  it('matches unicode titles and file names in either normal form', () => {
    expect(path('crème brûlée')).toBe('café/Crème Brûlée.md');
    expect(path('Cre\u0300me bru\u0302le\u0301e')).toBe('café/Crème Brûlée.md');
    expect(path('café/crème brûlée')).toBe('café/Crème Brûlée.md');
  });

  it('answers null for a missing or empty target', () => {
    expect(path('Nothing like this')).toBeNull();
    expect(path('')).toBeNull();
    expect(path('   ')).toBeNull();
    expect(createDocLinkIndex([]).resolve('plan', null)).toBeNull();
  });
});

describe('search', () => {
  const targets = (query: string, from: string | null = null) =>
    index.search(query, from).map((s) => s.target);

  it('ranks a title prefix above a word start above a substring above a path hit', () => {
    const titles = index.search('plan', null).map((s) => s.title);
    // "plan" starts no title, but it starts a word in three of them.
    expect(titles.slice(0, 3)).toEqual(['Launch plan', 'Notes plan', 'Spec plan']);
    expect(index.search('meet', null)[0]?.title).toBe('Meeting notes');
    expect(index.search('deep', null).map((s) => s.description)).toEqual(['notes/deep/idea.md']);
  });

  it('lists the nearest docs for an empty query, never the linking doc', () => {
    const near = index.search('', 'specs/api.md').map((s) => s.description);
    expect(near[0]).toBe('specs/plan.md');
    expect(near).not.toContain('specs/api.md');
  });

  it('writes a target that resolves back to the suggested doc', () => {
    for (const from of [null, 'notes/plan.md', 'specs/api.md', 'notes/deep/idea.md']) {
      for (const suggestion of index.search('', from, 100)) {
        expect(index.resolve(suggestion.target, from)?.path).toBe(suggestion.description);
      }
    }
  });

  it('writes the title when it is unique, else a name or root path that is', () => {
    expect(targets('Welcome')).toEqual(['Welcome']);
    const dupes = createDocLinkIndex([doc('a/x.md', 'Same'), doc('b/y.md', 'Same')]);
    expect(dupes.search('same', 'a/z.md').map((s) => s.target)).toEqual(['Same', 'y']);
    const clash = createDocLinkIndex([doc('a/x.md', 'Same'), doc('b/x.md', 'Same')]);
    expect(clash.search('same', 'a/z.md').map((s) => s.target)).toEqual(['Same', '/b/x']);
  });

  it('never writes a target that would break the link', () => {
    const odd = createDocLinkIndex([doc('odd.md', 'A | B #1')]);
    expect(odd.search('a', null).map((s) => s.target)).toEqual(['odd']);
  });

  it('respects the limit', () => {
    expect(index.search('', null, 2)).toHaveLength(2);
  });
});

describe('relativeDocHref', () => {
  it('walks up and down between folders', () => {
    expect(relativeDocHref('notes/plan.md', 'specs/api.md')).toBe('../specs/api.md');
    expect(relativeDocHref('notes/deep/idea.md', 'README.md')).toBe('../../README.md');
    expect(relativeDocHref('README.md', 'notes/deep/idea.md')).toBe('notes/deep/idea.md');
    expect(relativeDocHref(null, 'notes/plan.md')).toBe('notes/plan.md');
  });

  it('percent-encodes each segment', () => {
    expect(relativeDocHref('README.md', 'notes/Meeting Notes.md')).toBe('notes/Meeting%20Notes.md');
  });

  it('adds the heading’s anchor, and links to itself by anchor alone', () => {
    expect(relativeDocHref('README.md', 'plan.md', 'Next Steps!')).toBe('plan.md#next-steps');
    expect(relativeDocHref('plan.md', 'plan.md', 'Goals')).toBe('#goals');
    expect(relativeDocHref('plan.md', 'plan.md')).toBe('plan.md');
  });
});

describe('docHeadingAnchor', () => {
  it('keeps letters, digits, dashes and underscores', () => {
    expect(docHeadingAnchor('Étape 2: Ship it_now')).toBe('étape-2-ship-it_now');
  });
});
