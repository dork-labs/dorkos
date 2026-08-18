/**
 * The one mechanical guarantee that capability flags survive contact.
 *
 * `ConversationCapabilities` exists so behaviour never branches on which of the
 * three presentations a conversation is. That is easy to state and easy to
 * erode: the first `if (surface === 'room')` looks harmless, and by the fifth
 * the compound is two components sharing a file. So the rule is scanned rather
 * than asked for, in the manner of `sse-event-allowlist.test.ts` — a textual
 * cross-check over source, which is the only kind of check that can catch a
 * decision being unpicked one line at a time.
 *
 * `ConversationRoot.tsx` is the single exception: it is where a host says which
 * surface this is, and nothing below it may ask again.
 */
import { describe, expect, it } from 'vitest';

/**
 * Every source file under the slice's `ui/`, as text.
 *
 * Read through Vite rather than off the filesystem: the working directory
 * differs between `pnpm vitest run <path>` from the repo root and the
 * per-package run turbo does, and a scan that resolved the wrong directory
 * would report no violations and read exactly like a pass. `import.meta.glob`
 * is resolved at build time against THIS file, so it cannot miss.
 */
const SOURCES = import.meta.glob('../ui/**/*.{ts,tsx}', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

/** The one file allowed to compare a surface — the provider itself. */
const ALLOWED = 'ConversationRoot.tsx';

describe('features/conversation — no part asks which surface it is on', () => {
  const files = Object.keys(SOURCES).map((key) => key.replace('../ui/', ''));

  it('scans the whole of ui/, so a clean result means something', () => {
    // Without this, a scan that resolved the wrong directory would report an
    // empty violation list and read exactly like a pass.
    expect(files.length).toBeGreaterThan(10);
    expect(files).toContain(ALLOWED);
    expect(files.some((f) => f.startsWith('message/'))).toBe(true);
    expect(files.some((f) => f.startsWith('rows/'))).toBe(true);
    // And the text really arrived — an empty string includes nothing.
    expect(SOURCES[`../ui/${ALLOWED}`]).toContain('ConversationRoot');
  });

  it('finds no `surface ===` outside the provider', () => {
    const offenders = files.filter((file) => {
      if (file === ALLOWED) return false;
      return (SOURCES[`../ui/${file}`] ?? '').includes('surface ===');
    });

    expect(
      offenders,
      'a part branched on which surface it is on — the difference belongs in ConversationCapabilities, declared by the host'
    ).toEqual([]);
  });
});
