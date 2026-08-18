/**
 * Which surfaces have formatting as you type, asserted against the source.
 *
 * ## Why this is a source test and not a render test
 *
 * `features/composer`'s barrel doctrine says composition IS the capability
 * declaration — which surface has rich text is visible in the JSX, not in a
 * table that can disagree with it. A claim about what is in the JSX is best
 * checked by reading the JSX. The alternative, rendering each surface and
 * looking for a `contenteditable`, cannot live here anyway: `features` may not
 * import `widgets`, and a test placed next to each widget would have to write
 * the word this spec's own acceptance criterion requires to be absent from
 * those directories.
 *
 * ## What it is guarding against
 *
 * Two ways the "chat only, locked 2026-08-07" decision could be lost quietly.
 * A surface could start passing `richText` — caught by the first test. Or
 * `ComposerInput` could read the preference itself as a fallback, which would
 * make every surface that passes nothing rich the moment anybody flips the
 * switch — caught by the second. The second is the likelier mistake: it reads
 * like a tidy-up, and nothing else in the suite would go red.
 *
 * Rooms and onboarding graduate in a follow-up work item, gated on the criteria
 * in `specs/composer-rich-text/02-specification.md`. When they do, this file
 * changes with them — deliberately, and in the same commit.
 *
 * ## Why the surfaces are DISCOVERED and not listed
 *
 * They were listed once, and the list rotted within days: main's team-room-home
 * work deleted `DashboardComposerSection` outright (the home page became a room,
 * so its composer is `ChannelComposer`, already covered here). A hardcoded path
 * that no longer exists is the good case — it throws. The bad case is the one
 * this now prevents: a NEW surface mounting a composer and nobody adding it
 * here, so the lock silently stops covering it.
 *
 * So the set is read off the tree: every file that HANDS a composer its field
 * wiring. Since P4 there is exactly one mount of `<Composer.Input` —
 * `Conversation.Composer`, the one card every surface draws — so the surfaces
 * are the files that render `<Conversation.Composer` and pass it an `input`
 * bag. The dev playground is excluded on purpose: it forces the prop to show
 * the field off, which is the one legitimate reason to pass it.
 */
import { readFileSync, readdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, it, expect } from 'vitest';

const CLIENT_SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

/**
 * Read a file under `apps/client/src`.
 *
 * @param relative - Path relative to `apps/client/src`.
 */
function readClientSource(relative: string): string {
  return readFileSync(path.join(CLIENT_SRC, relative), 'utf-8');
}

/** Every `.tsx` under `apps/client/src`, as paths relative to it. */
function allClientTsx(dir = CLIENT_SRC): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : allClientTsx(full);
    return entry.isFile() && entry.name.endsWith('.tsx') ? [path.relative(CLIENT_SRC, full)] : [];
  });
}

/**
 * The surfaces that mount the composer, found rather than remembered.
 *
 * Tests are excluded (they render it to test it) and so is `dev/` (the
 * playground forces the prop deliberately, to show the field off).
 */
const SURFACES = allClientTsx()
  .filter((rel) => !rel.includes('__tests__') && !rel.startsWith('dev' + path.sep))
  .filter((rel) => {
    const source = readClientSource(rel);
    return source.includes('<Conversation.Composer') || source.includes('<Composer.Input');
  });

/**
 * The one place `Composer.Input` is mounted at all.
 *
 * Its own assertion below, because the surfaces are now found by what they hand
 * that mount rather than by mounting it themselves — and a second mount
 * appearing would make this whole detector blind to it.
 */
const COMPOSER_HOST = path.join('layers', 'features', 'conversation', 'ui', 'ComposerHost.tsx');

/** The one surface that HAS formatting at ship time. */
const CHAT = path.join('layers', 'widgets', 'session', 'ui', 'SessionComposer.tsx');

describe('which surfaces declare rich text', () => {
  // Guard the guard: if the detector ever matches nothing, every assertion
  // below would pass vacuously and the lock would be gone without a red.
  it('finds the composer surfaces, including chat', () => {
    expect(SURFACES.length).toBeGreaterThanOrEqual(2);
    expect(SURFACES).toContain(CHAT);
  });

  it('mounts the field in the shared card and the one surface that has no conversation', () => {
    // Two, and the second is the point: the onboarding narration draws a
    // composer with no conversation behind it — nothing to send to, no target —
    // so it composes `Composer.Input` directly. Anything ELSE growing a third
    // mount is a surface that has quietly stopped going through the shared card,
    // and the detector above would go blind to it.
    const mounts = allClientTsx()
      .filter((rel) => !rel.includes('__tests__') && !rel.startsWith('dev' + path.sep))
      .filter((rel) => readClientSource(rel).includes('<Composer.Input'));
    expect([...mounts].sort()).toEqual(
      [
        COMPOSER_HOST,
        path.join('layers', 'features', 'onboarding', 'ui', 'OnboardingConversation.tsx'),
      ].sort()
    );
  });

  it('chat passes it, from the preference', () => {
    const source = readClientSource(CHAT);
    expect(source).toContain('useComposerRichText');
    expect(source).toContain('richText: richText');
  });

  it('every OTHER surface passes nothing at all', () => {
    // Not `richText={false}` either: an explicit false reads as a decision made
    // about that surface, when the truth is it has not graduated yet.
    const offenders = SURFACES.filter(
      (rel) => rel !== CHAT && readClientSource(rel).includes('richText')
    );
    expect(offenders).toEqual([]);
  });

  it('ComposerInput does not read the preference itself', () => {
    // If it did, the three surfaces above would become rich without anyone
    // editing them, and the test above them would still pass. The prop default
    // is the whole guarantee.
    const source = readClientSource('layers/features/composer/ui/ComposerInput.tsx');
    expect(source).not.toContain('useComposerRichText');
    expect(source).not.toContain('entities/config');
    expect(source).toContain('richText = false');
  });
});
