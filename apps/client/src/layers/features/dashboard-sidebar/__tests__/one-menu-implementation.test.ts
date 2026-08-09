// @vitest-environment node
// Reads the sidebar's own source off disk, so it needs real `file:` URLs —
// jsdom's `import.meta.url` is an http one and `fileURLToPath` refuses it.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

/** The sidebar feature's own source. */
const FEATURE_DIR = join(fileURLToPath(new URL('.', import.meta.url)), '..');

/**
 * `shared/ui`, searched too.
 *
 * The consolidated surface LIVES here, so a fifth copy of the pattern is far
 * likelier to be written next door to it than back in the feature — and the
 * first version of this guard could not see that at all.
 */
const SHARED_UI_DIR = join(FEATURE_DIR, '../../shared/ui');

/**
 * The one file allowed to pair the two menu families — the consolidated
 * surface itself, which is the whole point of the guard.
 */
const THE_ONE_IMPLEMENTATION = 'sidebar-menu-node.tsx';

/** Every `.ts`/`.tsx` file under a directory that is not a test. */
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
 * Whether a file mounts a right-click context menu AND a dropdown menu.
 *
 * Three spellings, because the first version of this guard only knew one and a
 * probe walked straight past it:
 *
 * 1. The repo's own wrappers — `ContextMenuTrigger` / `DropdownMenuTrigger`.
 * 2. An aliased named import of the same, which changes the local identifier
 *    but not the import specifier.
 * 3. A NAMESPACE import of Radix directly (`import * as X from
 *    '@radix-ui/react-context-menu'`), which mentions neither identifier and
 *    was the hole a reviewer's probe went through.
 *
 * The import specifier is what all three have in common, so that is what this
 * matches — a file cannot mount either family without naming its package or the
 * shared wrapper module.
 */
function pairsBothMenuFamilies(source: string): boolean {
  const usesContext =
    /\bContextMenuTrigger\b/.test(source) || /@radix-ui\/react-context-menu/.test(source);
  const usesDropdown =
    /\bDropdownMenuTrigger\b/.test(source) || /@radix-ui\/react-dropdown-menu/.test(source);
  return usesContext && usesDropdown;
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
 * a fifth copy.
 *
 * Mutation checks — each of these makes this test red by name:
 * - revert `RoomRow` to render its own `ContextMenu` + `DropdownMenu`;
 * - add a file that namespace-imports both Radix menu packages;
 * - add a second paired implementation anywhere in `shared/ui/`.
 */
describe('one menu implementation (P1 AC-3)', () => {
  it('pairs the two menu families in exactly one file, and that file is the shared surface', () => {
    const offenders = [...sourceFiles(FEATURE_DIR), ...sourceFiles(SHARED_UI_DIR)]
      // `.tsx` only. A barrel re-exports both families by name and mounts
      // neither, and a `.ts` file cannot hold the JSX that would mount one —
      // so the extension is the honest line between "names it" and "renders it".
      .filter((path) => path.endsWith('.tsx'))
      .map((path) => ({ path, source: readFileSync(path, 'utf8') }))
      .filter(({ source }) => pairsBothMenuFamilies(source))
      .map(({ path }) => path.split('/').pop());

    expect(offenders).toEqual([THE_ONE_IMPLEMENTATION]);
  });

  it('catches a namespace import of the Radix packages, not only the repo wrappers', () => {
    // The probe that walked past the first version of this guard, pinned so it
    // cannot walk past this one. Asserting on the detector directly rather than
    // writing a decoy file to disk: the point is the rule, not the fixture.
    const namespaceImports = [
      "import * as ContextMenuPrimitive from '@radix-ui/react-context-menu';",
      "import * as DropdownMenuPrimitive from '@radix-ui/react-dropdown-menu';",
      '<ContextMenuPrimitive.Trigger /><DropdownMenuPrimitive.Trigger />',
    ].join('\n');
    expect(pairsBothMenuFamilies(namespaceImports)).toBe(true);
  });

  it('leaves a file that mounts only one family alone', () => {
    // The guard must not fire on a legitimate single-family surface — a
    // long-press sheet, a palette — or it becomes noise nobody reads.
    expect(pairsBothMenuFamilies("import { DropdownMenuTrigger } from '@/layers/shared/ui';")).toBe(
      false
    );
    expect(pairsBothMenuFamilies("import * as C from '@radix-ui/react-context-menu';")).toBe(false);
  });

  it('leaves no second row or header implementation behind', () => {
    // The four components the consolidation absorbed. Their absence is what
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
