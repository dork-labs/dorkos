import { describe, expect, it } from 'vitest';
import {
  DOC_TITLE_BYTES,
  docFileStem,
  docTitleFromBytes,
  docTitleFromHead,
  docTitleFromText,
} from '../doc-title.js';

describe('docTitleFromHead', () => {
  it('takes the frontmatter title first', () => {
    expect(docTitleFromHead('---\ntitle: "Launch plan"\n---\n# Heading\n', 'a.md')).toBe(
      'Launch plan'
    );
    expect(docTitleFromHead("---\nowner: me\ntitle: 'Q3'\n---\n", 'a.md')).toBe('Q3');
    expect(docTitleFromHead('---\ntitle: Roadmap # draft\n---\n', 'a.md')).toBe('Roadmap');
    expect(docTitleFromHead('---\ntitle: >\n  Folded\n---\n# Heading\n', 'a.md')).toBe('Heading');
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

describe('docFileStem', () => {
  it('drops .md in any case, and nothing else', () => {
    expect(docFileStem('Meeting Notes.md')).toBe('Meeting Notes');
    expect(docFileStem('README.MD')).toBe('README');
    expect(docFileStem('notes.txt')).toBe('notes.txt');
  });
});

describe('docTitleFromBytes and docTitleFromText', () => {
  it('read only the first DOC_TITLE_BYTES bytes, dropping a line the limit cut', () => {
    const far = `${'x'.repeat(DOC_TITLE_BYTES)}\n# Too far down\n`;
    expect(docTitleFromText(far, 'long.md')).toBe('long');
    const cut = `${'y\n'.repeat(DOC_TITLE_BYTES / 2 - 2)}# Cut short by the read`;
    expect(docTitleFromText(cut, 'cut.md')).toBe('cut');
    expect(docTitleFromText('# Short\n', 'a.md')).toBe('Short');
  });

  it('give the same title from text as from its bytes', () => {
    const text = '---\ntitle: Café plan\n---\n';
    expect(docTitleFromText(text, 'a.md')).toBe(
      docTitleFromBytes(new TextEncoder().encode(text), 'a.md')
    );
  });
});

describe('the heading parse is linear (CodeQL 345, DOR-3661)', () => {
  /** The regex the parse replaced, kept here only to prove the two agree. */
  const OLD = /^ {0,3}#[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
  const oldTitle = (line: string) => {
    const match = OLD.exec(line);
    return match && match[1]!.trim() !== '' ? match[1]!.trim() : null;
  };

  it('agrees with the old regex on every short line made of the characters that matter', () => {
    const alphabet = ['#', ' ', '\t', 'a', '\r', '\u2028'];
    const lines: string[] = [''];
    for (let length = 1; length <= 6; length += 1)
      for (const prefix of lines.filter((l) => l.length === length - 1))
        for (const c of alphabet) lines.push(prefix + c);
    for (const line of lines) {
      const title = docTitleFromText(`${line}\n`, 'stem.md');
      // The doc splits on \r?\n, so a CR right before the newline is not in the line.
      const seen = line.endsWith('\r') ? line.slice(0, -1) : line;
      expect(title, JSON.stringify(line)).toBe(oldTitle(seen) ?? 'stem');
    }
  });

  it('reads a long blank-filled heading inside the read cap in well under a second', () => {
    // Built in code: a heading line of mixed blanks that fails at its end.
    const blanks = ' \t'.repeat(1995);
    const text = `#${blanks}x\ry\n`;
    expect(new TextEncoder().encode(text).length).toBeLessThan(DOC_TITLE_BYTES);
    const started = performance.now();
    expect(docTitleFromText(text, 'stem.md')).toBe('stem');
    expect(performance.now() - started).toBeLessThan(500);
  });
});
