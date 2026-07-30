import { describe, it, expect } from 'vitest';
import { EMOJI_GROUPS, emojiLabel, searchEmoji } from '../lib/emoji-catalog';

/** Every entry in the catalog, flat. */
const ENTRIES = EMOJI_GROUPS.flatMap((group) => group.entries);

describe('the emoji catalog', () => {
  it('names every emoji uniquely', () => {
    // `emojiLabel` is what the picker puts in `aria-label`, and what the quick
    // row says as "React with …". Two emoji sharing a name is two buttons in
    // one grid that a screen reader cannot tell apart — and it is not
    // hypothetical: ❤️ 😍 🫶 ❣️ were all "heart" and ☝️ 👇 👉 👈 were all
    // "point" until this test existed. It also keeps `getByRole('button', {
    // name })` unambiguous, which is how the browser specs reach the grid.
    const byName = new Map<string, string[]>();
    for (const entry of ENTRIES) {
      const name = emojiLabel(entry.emoji);
      byName.set(name, [...(byName.get(name) ?? []), entry.emoji]);
    }

    // Reported as the whole set of collisions rather than the first, so one run
    // names every one that has to be renamed.
    expect([...byName].filter(([, emoji]) => emoji.length > 1)).toEqual([]);
  });

  it('holds each emoji once', () => {
    const emoji = ENTRIES.map((entry) => entry.emoji);

    expect(emoji).toHaveLength(new Set(emoji).size);
  });

  it('gives every emoji at least one word to find it by', () => {
    expect(ENTRIES.filter((entry) => entry.keywords.length === 0)).toEqual([]);
  });

  it('finds an emoji by a word that starts one of its keywords', () => {
    expect(searchEmoji('rocket').map((entry) => entry.emoji)).toEqual(['🚀']);
    // Every term has to match something, so a second word narrows.
    expect(searchEmoji('chart').map((entry) => entry.emoji)).toEqual(['📈', '📉']);
    expect(searchEmoji('chart-down').map((entry) => entry.emoji)).toEqual(['📉']);
  });

  it('finds an emoji pasted in as the query', () => {
    // How somebody re-uses one they copied from somewhere else.
    expect(searchEmoji('🎉').map((entry) => entry.emoji)).toEqual(['🎉']);
  });

  it('answers nothing for a blank query, because the caller draws the full grid', () => {
    expect(searchEmoji('')).toEqual([]);
    expect(searchEmoji('   ')).toEqual([]);
  });

  it('falls back to the emoji itself for one it has never heard of', () => {
    // A person may react with anything the server accepts. "React with 🫥" is a
    // better label than a blank one.
    expect(emojiLabel('🫥')).toBe('🫥');
  });
});
