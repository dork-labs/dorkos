/**
 * The one mechanical guarantee that capability flags survive contact.
 *
 * `ConversationCapabilities` exists so behaviour never branches on which of the
 * three presentations a conversation is. That is easy to state and easy to
 * erode: the first `if (surface` comparison looks harmless, and by the fifth the
 * compound is two components sharing a file. So the rule is scanned rather than
 * asked for, in the manner of `sse-event-allowlist.test.ts` — a textual
 * cross-check over source, which is the only kind of check that can catch a
 * decision being unpicked one line at a time.
 *
 * `ConversationRoot.tsx` is the single exception: it is where a host says which
 * surface this is, and nothing below it may ask again.
 */
import { describe, expect, it } from 'vitest';

/**
 * Every source file in the slice, as text.
 *
 * **All three directories, not just `ui/`.** A `lib/` helper handed the surface
 * and asked to answer differently for a room is the same decision as a
 * component doing it, one indirection further away, and a scan that stopped at
 * `ui/` would wave it through — `row-kinds.ts` and `format-entry-time.ts` both
 * take arguments a caller could hang a surface off. `model/` holds the
 * capability table itself, which is the one thing the whole rule protects.
 *
 * Read through Vite rather than off the filesystem: the working directory
 * differs between `pnpm vitest run <path>` from the repo root and the
 * per-package run turbo does, and a scan that resolved the wrong directory
 * would report no violations and read exactly like a pass. `import.meta.glob`
 * is resolved at build time against THIS file, so it cannot miss.
 */
const SOURCES = import.meta.glob('../{ui,lib,model}/**/*.{ts,tsx}', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

/** The one file allowed to compare a surface — the provider itself. */
const ALLOWED = 'ui/ConversationRoot.tsx';

/**
 * A comparison against `surface`, in either direction.
 *
 * `[=!]==` catches `surface === 'room'` and `surface !== 'session'` alike; the
 * previous scan looked for the literal `surface ===` and would have read a
 * negated check as clean, which is the same decision written the other way
 * round. `\bsurface\b` keeps `surfaceLabel` and `surfaces` out of it.
 */
const COMPARISON = /\bsurface\b\s*[=!]==/;

/**
 * A `switch` on the surface.
 *
 * The shape a growing set of comparisons collapses into, and the one a scan for
 * `===` alone would stop seeing at exactly the moment the problem got worse.
 */
const SWITCH = /switch\s*\(\s*surface/;

describe('features/conversation — no part asks which surface it is on', () => {
  const files = Object.keys(SOURCES).map((key) => key.replace('../', ''));

  it('scans the whole slice, so a clean result means something', () => {
    // Without this, a scan that resolved the wrong directory would report an
    // empty violation list and read exactly like a pass.
    expect(files.length).toBeGreaterThan(10);
    expect(files).toContain(ALLOWED);
    expect(files.some((f) => f.startsWith('ui/message/'))).toBe(true);
    expect(files.some((f) => f.startsWith('ui/rows/'))).toBe(true);
    expect(files.some((f) => f.startsWith('lib/'))).toBe(true);
    expect(files.some((f) => f.startsWith('model/'))).toBe(true);
    // And the two P4 files most likely to have wanted a surface check: the one
    // list and the one composer card, each of which draws for both surfaces
    // from one body.
    expect(files).toContain('ui/Timeline.tsx');
    expect(files).toContain('ui/ComposerHost.tsx');
    // And the text really arrived — an empty string includes nothing.
    expect(SOURCES[`../${ALLOWED}`]).toContain('ConversationRoot');
  });

  it('finds no comparison against `surface` outside the provider', () => {
    const offenders = files.filter((file) => {
      if (file === ALLOWED) return false;
      return COMPARISON.test(SOURCES[`../${file}`] ?? '');
    });

    expect(
      offenders,
      'a part branched on which surface it is on — the difference belongs in ConversationCapabilities, declared by the host'
    ).toEqual([]);
  });

  it('finds no `switch` on `surface` anywhere at all, the provider included', () => {
    // No carve-out here: even the provider only READS the surface to hand it
    // down. A switch on it there would mean the slice had grown per-surface
    // behaviour at its own root.
    const offenders = files.filter((file) => SWITCH.test(SOURCES[`../${file}`] ?? ''));

    expect(
      offenders,
      'a switch on the surface is the same decision as a chain of comparisons, further along'
    ).toEqual([]);
  });
});
