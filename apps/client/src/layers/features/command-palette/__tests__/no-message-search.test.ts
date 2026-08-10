// @vitest-environment node
// Reads the palette's own source off disk, so it needs real `file:` URLs —
// jsdom's `import.meta.url` is an http one and `fileURLToPath` refuses it.
/**
 * ⌘K finds things, not words (P3 AC-6).
 *
 * Message-content search is a separate surface — the ⌘K/⌘F split recorded in
 * `specs/rooms` §13.2 and `specs/message-search` §8 — and the palette is one
 * plausible line away from breaking it at any time: every session on the wire
 * carries a `lastMessagePreview`, and adding it to a row's keywords would turn
 * the palette into a content search nobody chose and nobody can switch off.
 *
 * So this reads the feature's own source. A unit test can only assert about the
 * corpus it was handed; this asserts about every line that ships.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const FEATURE_DIR = join(fileURLToPath(new URL('.', import.meta.url)), '..');

/**
 * Every way the palette could come to search what was SAID rather than what
 * things are called.
 *
 * `lastMessagePreview` is here beside the API names on purpose: no
 * content-search route exists on this client yet, so the realistic regression
 * is not a call to one — it is the preview field, which is already in hand.
 */
const BANNED = [
  /lastMessagePreview/,
  /searchEntries/,
  /searchMessages/,
  /messageSearch/i,
  /entrySearch/i,
  /entries\/search/,
];

/** Every `.ts`/`.tsx` file the feature ships — tests excluded, they are not shipped. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      return name === '__tests__' ? [] : sourceFiles(path);
    }
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

describe('the palette never searches message content', () => {
  const files = sourceFiles(FEATURE_DIR);

  it('reads a feature that actually has files in it', () => {
    // Without this, a broken path would make every claim below vacuously true.
    expect(files.length).toBeGreaterThan(15);
  });

  it('mentions nothing that searches what was said', () => {
    const hits = files.flatMap((path) => {
      const source = readFileSync(path, 'utf8');
      return BANNED.filter((pattern) => pattern.test(source)).map(
        (pattern) => `${path}: ${pattern}`
      );
    });
    expect(hits).toEqual([]);
  });

  it('would catch each of them if one arrived', () => {
    // The guard above passes trivially against a matcher that matches nothing.
    // This is the matcher being made to fire, once per pattern.
    const planted = `
      const preview = session.lastMessagePreview;
      transport.searchEntries(query);
      transport.searchMessages(query);
      const x = useMessageSearch();
      const y = entrySearchResults;
      fetch('/api/rooms/1/entries/search?q=' + query);
    `;
    for (const pattern of BANNED) {
      expect(pattern.test(planted)).toBe(true);
    }
  });

  it('gives Fuse only what things are CALLED', () => {
    const search = readFileSync(join(FEATURE_DIR, 'model', 'use-palette-search.ts'), 'utf8');
    const keys = /keys:\s*\[([^\]]*)\]/.exec(search);
    expect(keys).not.toBeNull();
    expect(keys?.[1].replace(/\s/g, '')).toBe("'name','keywords'");
  });
});
