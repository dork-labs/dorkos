// @vitest-environment node
// Reads the feature's own source off disk, so it needs real `file:` URLs —
// jsdom's `import.meta.url` is an http one and `fileURLToPath` refuses it.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

/** The feature's own source, tests excluded. */
const FEATURE_DIR = join(fileURLToPath(new URL('.', import.meta.url)), '..');

/** Every `.ts`/`.tsx` file under the feature that is not a test. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      return entry === '__tests__' ? [] : sourceFiles(path);
    }
    return /\.tsx?$/.test(entry) ? [path] : [];
  });
}

/**
 * **P1 AC-3.** `SidebarRow` and `SectionHeader` are the only row and header
 * implementations in the sidebar, and the ONE menu surface behind them is the
 * only place a right-click `ContextMenu` and a "⋮" `DropdownMenu` are paired
 * up.
 *
 * The sidebar shipped four hand-written copies of that pairing — the section
 * header, the group header, the room row and the agent row — each with its own
 * slot table and its own walk over its own node type. Four copies is four
 * chances for the two menus to end up offering different things, which is the
 * exact defect the node list exists to make impossible.
 *
 * A grep rather than a type: nothing in TypeScript can express "do not write
 * this pattern again", and the failure mode is a *new* file that quietly builds
 * a fifth copy. This test reads the feature's own source and fails on the pair.
 *
 * Mutation check: reverting `RoomRow` to render its own `ContextMenu` +
 * `DropdownMenu` fails this test by name.
 */
describe('one menu implementation (P1 AC-3)', () => {
  it('pairs ContextMenu with DropdownMenu nowhere in the feature', () => {
    const offenders = sourceFiles(FEATURE_DIR)
      .map((path) => ({ path, source: readFileSync(path, 'utf8') }))
      // The Radix container components, not their items: a file may legitimately
      // build items for one family (nothing here does any more), but a file that
      // mounts BOTH containers is a second implementation of the surface.
      .filter(
        ({ source }) =>
          /\bContextMenuTrigger\b/.test(source) && /\bDropdownMenuTrigger\b/.test(source)
      )
      .map(({ path }) => path.slice(FEATURE_DIR.length + 1));

    expect(offenders).toEqual([]);
  });

  it('leaves no second row or header implementation behind', () => {
    // The five components the consolidation absorbed. Their absence is what
    // makes the primitives "the only" implementations rather than "another" one.
    const files = sourceFiles(FEATURE_DIR).map((path) => path.slice(FEATURE_DIR.length + 1));
    for (const gone of [
      'ui/SidebarSectionHeader.tsx',
      'ui/GroupHeader.tsx',
      'ui/JumpBackInRow.tsx',
      'ui/AgentContextMenu.tsx',
    ]) {
      expect(files).not.toContain(gone);
    }
  });
});
