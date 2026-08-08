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
 * Rooms, the dashboard and onboarding graduate in a follow-up work item, gated
 * on the criteria in `specs/composer-rich-text/02-specification.md`. When they
 * do, this file changes with them — deliberately, and in the same commit.
 */
import { readFileSync } from 'fs';
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

/** The surface that HAS formatting at ship time. */
const CHAT = 'layers/features/chat/ui/input/ChatInputContainer.tsx';

/** The surfaces that stay plain until they graduate. */
const NOT_YET = [
  'layers/widgets/room-view/ui/RoomComposer.tsx',
  'layers/widgets/dashboard/ui/DashboardComposerSection.tsx',
  'layers/features/onboarding/ui/OnboardingConversation.tsx',
];

describe('which surfaces declare rich text', () => {
  it('chat passes it, from the preference', () => {
    const source = readClientSource(CHAT);
    expect(source).toContain('useComposerRichText');
    expect(source).toContain('richText={richText}');
  });

  it.each(NOT_YET)('%s passes nothing at all', (relative) => {
    // Not `richText={false}` either: an explicit false reads as a decision made
    // about that surface, when the truth is it has not graduated yet.
    expect(readClientSource(relative)).not.toContain('richText');
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
