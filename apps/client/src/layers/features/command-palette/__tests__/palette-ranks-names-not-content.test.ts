// @vitest-environment node
// Reads the palette's own source off disk, so it needs real `file:` URLs —
// jsdom's `import.meta.url` is an http one and `fileURLToPath` refuses it.
/**
 * ⌘K finds things, not words (P3 AC-6, `specs/message-search` §8).
 *
 * **What this file used to claim, and what it claims now.** It shipped as
 * `no-message-search.test.ts` and asserted that NOTHING in this slice searched
 * message content, because nothing could — there was no index. There is one
 * now, and this slice holds the box that reads it. The assertion that expired
 * is "nowhere in this feature"; the one that never expires is the one that was
 * always doing the work:
 *
 * > **⌘K's ranked list is built from what things are CALLED, and never from
 * > what was said inside them.**
 *
 * That is the ⌘K/⌘F split (`specs/rooms` §13.2), and the palette is one
 * plausible line away from breaking it at any time: every session on the wire
 * carries a `lastMessagePreview`, and adding it to a row's keywords would turn
 * the navigation palette into a content search nobody chose and nobody can
 * switch off — one that ranks by fuzzy title distance over a preview string,
 * which is a worse answer than the real search box gives and would quietly
 * replace it.
 *
 * So this reads the feature's own source, minus the modules that ARE the
 * message-search box. A unit test can only assert about the corpus it was
 * handed; this asserts about every line of the navigation half that ships.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const FEATURE_DIR = join(fileURLToPath(new URL('.', import.meta.url)), '..');

/**
 * The message-search box, module by module.
 *
 * **An explicit list rather than a name pattern**, and the direction of the
 * default is the point: a new file added to this slice is covered by the guard
 * unless somebody comes here and says it is part of the search box. A
 * `*message-search*` glob would have the opposite default — anything named
 * conveniently would exempt itself — which is how a guard stops guarding
 * without anybody deciding that it should.
 *
 * Every path is asserted to exist, so a rename cannot silently widen the
 * exemption to nothing.
 */
const MESSAGE_SEARCH_MODULES = [
  'model/message-search-scope.ts',
  'model/message-search-target.ts',
  'model/search-excerpt.ts',
  'model/use-message-search.ts',
  'model/use-message-search-shortcut.ts',
  'ui/MessageSearchDialog.tsx',
  'ui/MessageSearchHitRow.tsx',
  'ui/MessageSearchScope.tsx',
  'ui/SearchExcerpt.tsx',
];

/**
 * Two modules that look like they belong on that list and deliberately do not:
 * `model/search-surface.ts` and `ui/PaletteSearchHandoffRow.tsx`.
 *
 * They are the HAND-OFF — ⌘K's last row, which sends a question to the other
 * box and runs nothing itself. That makes them navigation-half code, and
 * exempting them would widen the hole for no reason: they hold none of the
 * banned shapes and are guarded like every other navigation module. This
 * constant exists so that stays a decision somebody made rather than an
 * omission somebody has to re-derive.
 */
const HANDOFF_MODULES = ['model/search-surface.ts', 'ui/PaletteSearchHandoffRow.tsx'];

/**
 * Every way ⌘K's own list could come to rank on what was SAID rather than on
 * what things are called.
 *
 * `lastMessagePreview` is first because it is the realistic one: the field is
 * already in hand on every session row, and one line adding it to `keywords`
 * is all it would take. The rest name the message index directly — a
 * navigation list that called it would be the two surfaces merging, which is
 * the decision this split exists to hold.
 *
 * **`openMessageSearch` is deliberately not banned.** Handing a question OVER
 * to the other box is the whole point of the hand-off row; running the search
 * here is what is forbidden.
 */
const BANNED = [
  /lastMessagePreview/,
  /transport\.search\(/,
  /useMessageSearch\b/,
  /searchEntries/,
  /searchMessages/,
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

describe("⌘K's list is built from names, never from message content", () => {
  const all = sourceFiles(FEATURE_DIR);
  const exempt = new Set(MESSAGE_SEARCH_MODULES.map((p) => join(FEATURE_DIR, p)));
  const navigation = all.filter((path) => !exempt.has(path));

  it('reads a feature that actually has files in it', () => {
    // Without this, a broken path would make every claim below vacuously true.
    expect(all.length).toBeGreaterThan(15);
    expect(navigation.length).toBeGreaterThan(15);
  });

  it('exempts only modules that exist — a rename cannot widen the hole', () => {
    const missing = MESSAGE_SEARCH_MODULES.filter((p) => !all.includes(join(FEATURE_DIR, p)));
    expect(missing).toEqual([]);
  });

  it('guards the hand-off modules rather than exempting them', () => {
    // Both halves: they exist, and they are inside the guarded set. Without the
    // second assertion this passes against an exemption list that quietly grew.
    for (const module of HANDOFF_MODULES) {
      const path = join(FEATURE_DIR, module);
      expect(all, module).toContain(path);
      expect(navigation, module).toContain(path);
    }
  });

  it('gives the navigation half nothing that searches what was said', () => {
    const hits = navigation.flatMap((path) => {
      const source = readFileSync(path, 'utf8');
      return BANNED.filter((pattern) => pattern.test(source)).map(
        (pattern) => `${relative(FEATURE_DIR, path)}: ${pattern}`
      );
    });
    expect(hits).toEqual([]);
  });

  it('would catch each of them if one arrived', () => {
    // The guard above passes trivially against a matcher that matches nothing.
    // This is the matcher being made to fire, once per pattern.
    const planted = `
      const preview = session.lastMessagePreview;
      const hits = await transport.search({ q });
      const { results } = useMessageSearch(query, true);
      transport.searchEntries(query);
      transport.searchMessages(query);
      fetch('/api/rooms/1/entries/search?q=' + query);
    `;
    for (const pattern of BANNED) {
      expect(pattern.test(planted)).toBe(true);
    }
  });

  it('does not fire on handing the question OVER to the search box', () => {
    // The one shape that must stay legal, asserted rather than assumed: the
    // hand-off row exists to send a question somewhere else, and a guard that
    // banned it would ban the feature it was written to protect.
    const handoff = `openMessageSearch(handoffTerm);`;
    for (const pattern of BANNED) {
      expect(pattern.test(handoff), String(pattern)).toBe(false);
    }
  });

  it('gives Fuse only what things are CALLED', () => {
    const search = readFileSync(join(FEATURE_DIR, 'model', 'use-palette-search.ts'), 'utf8');
    const keys = /keys:\s*\[([^\]]*)\]/.exec(search);
    expect(keys).not.toBeNull();
    expect(keys?.[1].replace(/\s/g, '')).toBe("'name','keywords'");
  });
});
