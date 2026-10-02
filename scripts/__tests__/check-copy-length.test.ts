/**
 * Pin suite for `check-copy-length.ts`, the in-app copy length check.
 *
 * WHY THIS EXISTS. The check is only as honest as its idea of a "block". A
 * walker that splits `<p>Couldn’t reach {name}. Try again.</p>` into two
 * fragments would pass a 30-word paragraph as two 15-word ones, and one that
 * counts a label and its description together would fail copy that is
 * already fine. Both directions are pinned here on synthetic source, so the
 * suite never depends on what the real app says today.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { bandFor, countWords, measureSource, runCopyLength } from '../check-copy-length.ts';

/** Measure one TSX snippet and return each block's word count and text. */
function measure(source: string): { words: number; text: string }[] {
  return measureSource('fixture.tsx', source).map(({ words, text }) => ({ words, text }));
}

describe('countWords', () => {
  it('counts tokens that hold a letter or digit, and nothing else', () => {
    expect(countWords('Finished 2m ago')).toBe(3);
    expect(countWords('12 · 3 unread … → done')).toBe(4);
    expect(countWords('   ')).toBe(0);
  });
});

describe('bandFor', () => {
  it('places counts on the standard’s scale', () => {
    expect(bandFor(3)).toBe('preferred');
    expect(bandFor(4)).toBe('good');
    expect(bandFor(6)).toBe('good');
    expect(bandFor(7)).toBe('flagged');
    expect(bandFor(15)).toBe('flagged');
    expect(bandFor(16)).toBe('error');
  });
});

describe('measureSource', () => {
  it('joins JSX text split by an interpolation into one block', () => {
    const blocks = measure('const A = () => <p>Couldn’t reach {name}. Try again.</p>;');
    expect(blocks.map((b) => b.words)).toEqual([5]);
  });

  it('joins inline formatting into the sentence around it', () => {
    const blocks = measure(
      'const A = () => <p>Scout changed <strong>three files</strong> in your project.</p>;'
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.words).toBe(7);
  });

  it('counts a code sample inside a sentence as one word, not a split', () => {
    const blocks = measure(
      'const A = () => <p>Run <code>pnpm dev --filter x</code> to start.</p>;'
    );
    expect(blocks).toEqual([{ words: 4, text: 'Run {…} to start.' }]);
  });

  it('measures a block-level child as its own block', () => {
    const blocks = measure(
      'const A = () => <label>Background agents<div>They finish and message you.</div></label>;'
    );
    expect(blocks.map((b) => b.words).sort()).toEqual([2, 5]);
  });

  it('keeps a title and a description as two blocks', () => {
    const blocks = measure(
      'const A = () => <Dialog title="Delete Scout?" description="Its chats are kept. Its folder is deleted." />;'
    );
    expect(blocks.map((b) => b.words)).toEqual([2, 8]);
  });

  it('counts a conditional child as its longest literal branch, once', () => {
    const blocks = measure(
      "const A = () => <p>Status: {down ? 'Messages can’t be delivered right now' : 'Online'}</p>;"
    );
    expect(blocks).toEqual([{ words: 7, text: 'Status: Messages can’t be delivered right now' }]);
  });

  it('counts a template interpolation as one word', () => {
    const blocks = measure('toast.error(`Couldn’t turn on ${name}. Try again.`);');
    expect(blocks.map((b) => b.words)).toEqual([6]);
  });

  it('measures copy passed to an attribute in braces', () => {
    const sixteen =
      'one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen';
    expect(measure(`const A = () => <Dialog title={'${sixteen}'} />;`).map((b) => b.words)).toEqual(
      [16]
    );
    expect(
      measure(
        'const A = () => <Dialog description={`Scout changed ${n} files in your project today`} />;'
      ).map((b) => b.words)
    ).toEqual([8]);
    expect(
      measure(`const A = () => <Row label={on ? '${sixteen}' : 'Off'} />;`).map((b) => b.words)
    ).toEqual([16, 1]);
  });

  it('joins a + chain into one block', () => {
    const blocks = measure(
      "toast.error('Couldn’t reach the server that ' + name + ' runs on, so check it and try again.');"
    );
    expect(blocks.map((b) => b.words)).toEqual([14]);
    const jsx = measure(
      "const A = () => <p>{'Hello there friend ' + name + ' and welcome back'}</p>;"
    );
    expect(jsx.map((b) => b.words)).toEqual([7]);
  });

  it('counts back-to-back interpolations as separate words', () => {
    expect(measure('toast.success(`${a}${b} done`);').map((b) => b.words)).toEqual([3]);
  });

  it('counts a literal nested in a template span by its words', () => {
    expect(
      measure("toast.success(`Outer ${c ? 'inner words here' : 'x'} tail`);").map((b) => b.words)
    ).toEqual([5]);
  });

  it('does not count HTML entities as words', () => {
    expect(
      measure('const A = () => <p>Hello &mdash; world&nbsp;there</p>;').map((b) => b.words)
    ).toEqual([3]);
  });

  it('does not treat spacing between two values as copy', () => {
    expect(measure("const A = () => <p>{a}{' '}<strong>{b}</strong></p>;")).toEqual([]);
  });

  it('joins a dotted inline element into its sentence', () => {
    expect(
      measure('const A = () => <p>Open <Nav.Link to="/x">your settings</Nav.Link> now.</p>;')
    ).toHaveLength(1);
  });

  it('still measures the attributes of a code sample', () => {
    expect(
      measure('const A = () => <code title="Copy this command">pnpm dev</code>;').map(
        (b) => b.words
      )
    ).toEqual([3]);
  });

  it('ignores a run of nothing but data', () => {
    expect(measure('const A = () => <p>{agent.name}</p>;')).toEqual([]);
  });

  it('ignores strings outside copy positions', () => {
    expect(
      measure("const cls = 'flex items-center gap-2 text-sm text-muted-foreground px-2 py-1';")
    ).toEqual([]);
  });

  it('reports the block’s line', () => {
    const blocks = measureSource('fixture.tsx', '\n\nconst A = () => <p>Two words</p>;');
    expect(blocks[0]?.line).toBe(3);
  });
});

describe('runCopyLength', () => {
  let root: string | undefined;

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  it('skips tests, stories and the Dev Playground', () => {
    root = mkdtempSync(join(tmpdir(), 'copy-length-'));
    const src = join(root, 'apps/client/src');
    for (const dir of ['ui', '__tests__', 'dev']) mkdirSync(join(src, dir), { recursive: true });
    writeFileSync(join(src, 'ui/A.tsx'), 'export const A = () => <p>Shown here</p>;');
    writeFileSync(join(src, 'ui/A.stories.tsx'), 'export const S = () => <p>Story copy</p>;');
    writeFileSync(join(src, 'ui/A.test.tsx'), 'export const T = () => <p>Test copy</p>;');
    writeFileSync(join(src, '__tests__/B.tsx'), 'export const B = () => <p>Fixture copy</p>;');
    writeFileSync(join(src, 'dev/C.tsx'), 'export const C = () => <p>Playground copy</p>;');

    const blocks = runCopyLength(root);
    expect(blocks.map((b) => b.text)).toEqual(['Shown here']);
  });
});
