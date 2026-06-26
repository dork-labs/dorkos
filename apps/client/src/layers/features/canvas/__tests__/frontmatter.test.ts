import { describe, it, expect } from 'vitest';
import { splitFrontmatter, joinFrontmatter } from '../lib/frontmatter';

describe('splitFrontmatter', () => {
  it('peels a leading YAML frontmatter block off the body', () => {
    const doc = '---\ntitle: Hello\ntags: [a, b]\n---\n\n# Body\n\nText.\n';
    const { frontmatter, body } = splitFrontmatter(doc);
    expect(frontmatter).toBe('---\ntitle: Hello\ntags: [a, b]\n---\n');
    expect(body).toBe('\n# Body\n\nText.\n');
  });

  it('returns no frontmatter for a plain document', () => {
    const doc = '# Just a heading\n\nNo frontmatter here.\n';
    expect(splitFrontmatter(doc)).toEqual({ frontmatter: '', body: doc });
  });

  it('does not treat a bare --- thematic break as frontmatter', () => {
    const doc = 'Intro paragraph.\n\n---\n\nAfter the rule.\n';
    expect(splitFrontmatter(doc)).toEqual({ frontmatter: '', body: doc });
  });

  it('does not match a --- that is not on the very first line', () => {
    const doc = '\n---\ntitle: Late\n---\nbody\n';
    expect(splitFrontmatter(doc)).toEqual({ frontmatter: '', body: doc });
  });

  it('handles a document that is only frontmatter (no body)', () => {
    const doc = '---\ntitle: Only\n---\n';
    const { frontmatter, body } = splitFrontmatter(doc);
    expect(frontmatter).toBe(doc);
    expect(body).toBe('');
  });

  it('detects an empty frontmatter block (--- immediately followed by ---)', () => {
    const doc = '---\n---\n\n# Body\n';
    const { frontmatter, body } = splitFrontmatter(doc);
    expect(frontmatter).toBe('---\n---\n');
    expect(body).toBe('\n# Body\n');
    // Must still re-glue exactly so an edit cannot corrupt the empty block.
    expect(joinFrontmatter(frontmatter, body)).toBe(doc);
  });

  it('does not match a leading --- with no closing fence', () => {
    const doc = '---\njust a thematic break vibe\nno closing fence\n';
    expect(splitFrontmatter(doc)).toEqual({ frontmatter: '', body: doc });
  });

  it('tolerates CRLF line endings in the fences', () => {
    const doc = '---\r\ntitle: Win\r\n---\r\nbody\r\n';
    const { frontmatter, body } = splitFrontmatter(doc);
    expect(frontmatter).toBe('---\r\ntitle: Win\r\n---\r\n');
    expect(body).toBe('body\r\n');
  });
});

describe('joinFrontmatter', () => {
  it('reconstructs the original document byte-for-byte after an edit', () => {
    const doc = '---\ntitle: Hello\n---\n\nOriginal body.\n';
    const { frontmatter, body } = splitFrontmatter(doc);
    expect(joinFrontmatter(frontmatter, body)).toBe(doc);

    const editedBody = '\nEdited body, frontmatter must survive.\n';
    expect(joinFrontmatter(frontmatter, editedBody)).toBe('---\ntitle: Hello\n---\n' + editedBody);
  });

  it('returns the body unchanged when there is no frontmatter', () => {
    expect(joinFrontmatter('', '# Body\n')).toBe('# Body\n');
  });

  it('round-trips split -> join as the identity for frontmatter docs', () => {
    const doc = '---\na: 1\nb: two\n---\n## Heading\n\n- list\n- items\n';
    const { frontmatter, body } = splitFrontmatter(doc);
    expect(joinFrontmatter(frontmatter, body)).toBe(doc);
  });
});
