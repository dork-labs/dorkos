// @vitest-environment node
/**
 * Keyboard focus rings are drawn at full strength.
 *
 * The ring colour clears the 3:1 a focus indicator needs on both themes, but
 * only when it is solid: `ring-ring/50` measured about 1.9:1 on the light page
 * and 2.5:1 on the dark one (DOR-2567, DOR-2609, DOR-2615). This guard scans the
 * client's strings for a ring or outline colour with an opacity and fails:
 *
 * - on **any** part-strength colour behind a focus variant (`focus:`,
 *   `focus-visible:`, `focus-within:`, `has-[:focus-visible]:`,
 *   `group-focus-visible:` and the rest). There is no list for these: a faint
 *   focus ring is always a bug. Write `focus-visible:ring-ring`, or the
 *   `focus-ring` utility, and add `ring-offset-2 ring-offset-background` where
 *   the control fills itself with the ring's own colour.
 * - on a part-strength ring with **no** focus variant in a file not listed
 *   below. That catches the conditional shape (`isFocused && 'ring-x/50'`),
 *   where a component tracks focus itself and no variant says so. The rings
 *   listed are at-rest marks (a selection, a drop target, a tile's edge), each
 *   with its exact count and reason: a ratchet, so the list can never make room
 *   for a new one without someone saying why.
 *
 * Only the file's strings are searched (it is parsed, not pattern-matched), so
 * a comment naming the class a fix replaced counts for nothing.
 *
 * @module __tests__/faint-focus-rings
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative, resolve } from 'node:path';
import ts from 'typescript';

const SRC = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');

/**
 * Whether an alpha value is under full strength.
 *
 * A bare Tailwind modifier (`/50`) is a percentage. A bracketed modifier or an
 * alpha inside a colour function is a fraction (`[.4]`, `/0.5`) unless it says
 * `%` (`[100%]`, `/50%`). Anything that is not a plain number (a variable, a
 * `calc()`) cannot be shown to be solid, so it counts as faint.
 *
 * @param alpha - The value as written.
 * @param bareModifier - It came from a bare `/NN` modifier.
 */
function belowFull(alpha: string, bareModifier: boolean): boolean {
  const value = alpha.replace(/^\[|\]$/g, '').trim();
  if (!/^[\d.]+%?$/.test(value)) return true;
  const n = parseFloat(value);
  if (value.endsWith('%')) return n < 100;
  return bareModifier ? n < 100 : n < 1;
}

/** The position of the last `/` outside brackets and parentheses, or -1. */
function topLevelSlash(value: string): number {
  let depth = 0;
  let found = -1;
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (char === '[' || char === '(') depth++;
    else if (char === ']' || char === ')') depth--;
    else if (char === '/' && depth === 0) found = i;
  }
  return found;
}

/**
 * Whether an arbitrary colour (`[rgb(0_0_0/0.5)]`, `[color:oklch(…/50%)]`,
 * `[rgba(0,0,0,.5)]`, `[#00000080]`, `[transparent]`) carries an alpha under
 * full strength. A width like `[3px]` carries none.
 */
function arbitraryIsFaint(bracketed: string): boolean {
  const inner = bracketed.slice(1, -1).replace(/^color:/, '');
  if (inner === 'transparent') return true;
  const hex = inner.match(/^#([0-9a-f]{4}|[0-9a-f]{8})$/i)?.[1];
  if (hex) return parseInt(hex.length === 4 ? hex[3].repeat(2) : hex.slice(6), 16) < 255;
  const slashAlpha = inner.match(/\/[_\s]*([^)_\s]+)[_\s]*\)\s*$/)?.[1];
  if (slashAlpha) return belowFull(slashAlpha, false);
  const legacy = inner.match(/^(?:rgba|hsla)\(([^)]*)\)$/)?.[1]?.split(',');
  if (legacy?.length === 4) return belowFull(legacy[3], false);
  return false;
}

/**
 * Whether one utility (variants already removed) paints a ring or outline
 * colour under full strength: `ring-ring/50`, `outline-ring/[.4]`,
 * `inset-ring-ring/30`, `ring-[rgb(0_0_0/0.5)]`, `ring-opacity-50`. Offsets,
 * widths and full-strength colours (`ring-ring/100`, `ring-ring/[100%]`) pass.
 *
 * @param utility - The class with its variants and `!` removed.
 */
function isPartStrength(utility: string): boolean {
  const opacity = utility.match(/^ring-opacity-(\d+)$/);
  if (opacity) return Number(opacity[1]) < 100;
  const value = utility.match(/^(?:inset-)?(?:ring|outline)-(.+)$/)?.[1];
  if (!value || value.startsWith('offset-')) return false;
  const slash = topLevelSlash(value);
  if (slash !== -1) {
    const alpha = value.slice(slash + 1);
    return belowFull(alpha, !alpha.startsWith('['));
  }
  return value.startsWith('[') && value.endsWith(']') && arbitraryIsFaint(value);
}

/** A variant that applies only while something has focus. */
const FOCUS_VARIANT = /focus/;

const STATE_MARK = 'a state mark, not a focus ring: keyboard focus draws its own solid ring';

/** Files still allowed an at-rest part-strength ring, with how many and why. */
const ALLOWED: Record<string, { count: number; reason: string }> = {
  'layers/features/ask/ui/AskCard.tsx': {
    count: 1,
    reason: `${STATE_MARK}: the question being answered now`,
  },
  'layers/features/gen-ui/ui/nodes/board/BoardNode.tsx': {
    count: 1,
    reason: 'the pulsing halo while the other player is thinking',
  },
  'layers/features/gen-ui/ui/nodes/TimelineNode.tsx': {
    count: 1,
    reason: 'the step in progress, not an interactive control',
  },
  'layers/features/relay/ui/wizard/StepIndicator.tsx': {
    count: 1,
    reason: 'the current wizard step, not an interactive control',
  },
  'layers/features/entry-actions/ui/EntryReactionPicker.tsx': {
    count: 1,
    reason: `${STATE_MARK} (the focus-ring utility): a reaction you already gave`,
  },
  'layers/features/file-explorer/ui/FileTreeRow.tsx': {
    count: 1,
    reason: 'a drag-and-drop target under the pointer',
  },
  'layers/features/file-explorer/ui/FileTree.tsx': {
    count: 1,
    reason: 'a drag-and-drop target under the pointer',
  },
  'layers/features/file-explorer/ui/FileExplorer.tsx': {
    count: 1,
    reason: 'a drag-and-drop target under the pointer',
  },
  'layers/features/settings/ui/runtimes/RuntimeCardView.tsx': {
    count: 1,
    reason: 'the default runtime card, tinted in its accent; the card is not a control',
  },
  'layers/entities/connectors/ui/ServiceMark.tsx': {
    count: 1,
    reason: 'a hairline edge on a white logo tile, not interactive',
  },
  'layers/entities/room/ui/RoomLoudnessLine.tsx': {
    count: 1,
    reason: 'a preview tint on a line of text, not interactive',
  },
  'layers/entities/agent/ui/AvatarPickerGrid.tsx': {
    count: 2,
    reason: `${STATE_MARK}: the automatic avatar or colour is the one picked`,
  },
  'layers/entities/agent/ui/AvatarPickerPanel.tsx': {
    count: 1,
    reason: `${STATE_MARK}: the automatic colour is the one picked`,
  },
};

/** Every non-test, non-playground source file under `src/`. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name === '__tests__' || name === 'dev' || name === 'node_modules') continue;
      out.push(...sourceFiles(path));
    } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) {
      out.push(path);
    }
  }
  return out;
}

/**
 * A class split into its variants and its utility, on the colons outside brackets.
 *
 * @param token - One class, e.g. `has-[:focus-visible]:ring-ring/50`.
 */
function splitVariants(token: string): { variants: string[]; utility: string } {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of token) {
    if (char === '[') depth++;
    if (char === ']') depth--;
    if (char === ':' && depth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  // Tailwind v4 writes important as a trailing `!`; v3's leading one still works.
  return { variants: parts, utility: current.replace(/^!|!$/g, '') };
}

/** The part-strength rings in one string, sorted into focus rings and at-rest ones. */
function faintRings(text: string): { focus: string[]; atRest: string[] } {
  const focus: string[] = [];
  const atRest: string[] = [];
  for (const token of text.split(/\s+/)) {
    const { variants, utility } = splitVariants(token);
    if (!isPartStrength(utility)) continue;
    (variants.some((v) => FOCUS_VARIANT.test(v)) ? focus : atRest).push(token);
  }
  return { focus, atRest };
}

/**
 * The part-strength rings a file's strings hold.
 *
 * Only nodes that carry text are searched: string literals (JSX attribute
 * strings are these too), template pieces and JSX text. A comment is never one.
 *
 * @param source - The file's text.
 * @param fileName - Its name; the extension picks TS or TSX parsing.
 */
function scan(source: string, fileName = 'probe.tsx'): { focus: string[]; atRest: string[] } {
  const file = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    false,
    fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  const found = { focus: [] as string[], atRest: [] as string[] };
  const visit = (node: ts.Node) => {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node) ||
      ts.isJsxText(node)
    ) {
      const { focus, atRest } = faintRings(node.text);
      found.focus.push(...focus);
      found.atRest.push(...atRest);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

/** Every file's part-strength rings, keyed by its path under `src/`. */
function hits(): Record<string, { focus: string[]; atRest: string[] }> {
  const out: Record<string, { focus: string[]; atRest: string[] }> = {};
  for (const path of sourceFiles(SRC)) {
    const found = scan(readFileSync(path, 'utf8'), path);
    if (found.focus.length || found.atRest.length) out[relative(SRC, path)] = found;
  }
  return out;
}

/**
 * Every way the source and the list disagree, as a sentence saying what to do.
 *
 * @param found - Part-strength rings per file, from {@link hits}.
 * @param allowed - The list of at-rest rings, file to count.
 */
function problems(
  found: Record<string, { focus: string[]; atRest: string[] }>,
  allowed: Record<string, { count: number }>
): string[] {
  const out: string[] = [];
  for (const [file, { focus, atRest }] of Object.entries(found)) {
    for (const token of focus) {
      out.push(`${file} draws a faint focus ring (${token}): use the ring colour at full strength`);
    }
    const ceiling = allowed[file]?.count ?? 0;
    if (atRest.length > ceiling) {
      out.push(
        `${file} draws ${atRest.length} part-strength rings (allowed ${ceiling}): ${atRest.join(', ')}`
      );
    }
  }
  for (const [file, { count }] of Object.entries(allowed)) {
    const actual = found[file]?.atRest.length ?? 0;
    if (actual < count) {
      out.push(
        actual === 0
          ? `remove the entry for ${file}: it draws no part-strength ring now`
          : `lower the ceiling for ${file} to ${actual}`
      );
    }
  }
  return out;
}

describe('faint focus rings', () => {
  it('sorts a faint ring behind every focus variant a call site writes as a focus ring', () => {
    expect(
      faintRings(
        'focus-visible:ring-ring/50 focus:ring-red-600/40 focus-within:ring-ring/60 ' +
          'has-[:focus-visible]:ring-ring/50 group-focus-visible:ring-ring/30 ' +
          'dark:focus-visible:outline-ring/50 focus-visible:ring-ring/[.4] focus:ring-opacity-50'
      ).focus
    ).toHaveLength(8);
  });

  it('catches the important forms, trailing and leading', () => {
    expect(faintRings('focus-visible:ring-ring/50! focus-visible:!ring-ring/50').focus).toEqual([
      'focus-visible:ring-ring/50!',
      'focus-visible:!ring-ring/50',
    ]);
  });

  it('catches an alpha inside an arbitrary colour', () => {
    const forms = [
      'focus-visible:ring-[rgb(0_0_0/0.5)]',
      'focus-visible:ring-[color:oklch(0.7_0.2_40/50%)]',
      'focus-visible:ring-[hsl(24_90%_44%_/_.4)]',
      'focus-visible:ring-[rgba(0,0,0,0.5)]',
      'focus-visible:ring-[#ff000080]',
      'focus-visible:ring-[#f008]',
      'focus-visible:ring-[transparent]',
      'focus-visible:ring-[var(--x)]/30',
    ];
    expect(faintRings(forms.join(' ')).focus).toEqual(forms);
  });

  it('catches inset rings, behind a focus variant and at rest', () => {
    expect(faintRings('focus-visible:inset-ring-ring/50 inset-ring-brand/30')).toEqual({
      focus: ['focus-visible:inset-ring-ring/50'],
      atRest: ['inset-ring-brand/30'],
    });
  });

  it('passes a full-strength colour however it is written', () => {
    expect(
      faintRings(
        'focus-visible:ring-ring/[100%] focus-visible:ring-ring/[1] focus-visible:ring-[rgb(0_0_0/1)] ' +
          'focus-visible:ring-[color:oklch(0.7_0.2_40/100%)] focus-visible:ring-[#ff0000ff] ' +
          'focus-visible:ring-[rgba(0,0,0,1)] focus-visible:inset-ring-ring focus-visible:ring-[3px] ' +
          'focus-visible:ring-[hsl(var(--ring))]'
      )
    ).toEqual({ focus: [], atRest: [] });
  });

  it('counts a faint ring with no focus variant as at rest', () => {
    expect(faintRings('ring-status-info/50 ring-1 aria-invalid:ring-destructive/20')).toEqual({
      focus: [],
      atRest: ['ring-status-info/50', 'aria-invalid:ring-destructive/20'],
    });
  });

  it('passes solid rings, ring widths, offsets and full strength', () => {
    expect(
      faintRings(
        'focus-visible:ring-ring focus-visible:ring-[3px] focus-visible:ring-offset-2 ' +
          'focus-visible:ring-offset-background/80 ring-ring/100 focus-ring bg-ring/10'
      )
    ).toEqual({ focus: [], atRest: [] });
  });

  it('comments do not count, and a template piece does', () => {
    expect(scan('// focus-visible:ring-ring/50\nconst x = 1;').focus).toEqual([]);
    expect(scan('const c = `${a} focus-visible:ring-ring/50`;').focus).toEqual([
      'focus-visible:ring-ring/50',
    ]);
  });

  it('the list fails on a faint focus ring, an unlisted file, an inflated entry and a stale one', () => {
    expect(problems({ 'a.tsx': { focus: ['focus:ring-ring/50'], atRest: [] } }, {})).toEqual([
      'a.tsx draws a faint focus ring (focus:ring-ring/50): use the ring colour at full strength',
    ]);
    expect(problems({ 'b.tsx': { focus: [], atRest: ['ring-ring/30'] } }, {})).toEqual([
      'b.tsx draws 1 part-strength rings (allowed 0): ring-ring/30',
    ]);
    expect(
      problems({ 'a.tsx': { focus: [], atRest: ['ring-x/1'] } }, { 'a.tsx': { count: 2 } })
    ).toEqual(['lower the ceiling for a.tsx to 1']);
    expect(problems({}, { 'a.tsx': { count: 1 } })).toEqual([
      'remove the entry for a.tsx: it draws no part-strength ring now',
    ]);
  });

  it('every focus ring in the app is solid, and every at-rest faint ring is listed', () => {
    expect(problems(hits(), ALLOWED)).toEqual([]);
  });
});
