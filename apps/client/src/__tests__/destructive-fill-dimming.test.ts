// @vitest-environment node
/**
 * Every labelled solid destructive fill dims itself in dark mode: a white label
 * cannot clear AA on the full-strength dark red (see `destructive-contrast.test.ts`).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  AA,
  SRC,
  UI_ROOT,
  UI_SRC,
  contrast,
  hslToRgb,
  over,
  section,
} from './destructive-contrast.fixtures';

/** Every `.ts`/`.tsx` source file under `dir`, tests excluded. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name !== '__tests__' && name !== 'node_modules') out.push(...sourceFiles(path));
    } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) {
      out.push(path);
    }
  }
  return out;
}

/** A string literal found in source: its text and where it starts and ends. */
interface Literal {
  text: string;
  start: number;
  end: number;
}

/**
 * Every string literal in `src`: single, double and template quotes, template
 * literals across lines included. Comments are skipped so prose that names a
 * class is not read as markup. A `${…}` inside a template is kept as text,
 * which is enough here: the guard only asks which class tokens a literal holds.
 */
function stringLiterals(src: string): Literal[] {
  const out: Literal[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === '/' && src[i + 1] === '/') {
      i = src.indexOf('\n', i);
      if (i < 0) break;
    } else if (c === '/' && src[i + 1] === '*') {
      i = src.indexOf('*/', i + 2);
      if (i < 0) break;
      i += 2;
    } else if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\\') j++;
        if (c !== '`' && src[j] === '\n') break;
        j++;
      }
      out.push({ text: src.slice(i + 1, j), start: i, end: j + 1 });
      i = j + 1;
    } else {
      i++;
    }
  }
  return out;
}

/** Calls whose arguments merge into ONE element's class list. */
const MERGE_CALL = /\b(cn|clsx|cx|twMerge|cva)\s*\($/;

/**
 * The span of source that becomes one element's classes around `lit`.
 *
 * A literal inside `cn(…)`, `clsx(…)` or `cva(…)` merges with its sibling
 * arguments, so the unit is the whole call (the outermost merge call, so a
 * nested `cn` inside a `cva` still counts as one). A literal outside any merge
 * call stands alone. The walk counts brackets backwards from the literal and
 * ignores brackets inside other literals.
 */
function classUnit(src: string, lit: Literal, literals: Literal[]): string {
  const inLiteral = (pos: number) => literals.some((l) => pos >= l.start && pos < l.end);
  let unit: [number, number] | null = null;
  let depth = 0;
  for (let p = lit.start - 1; p >= 0; p--) {
    if (inLiteral(p)) continue;
    const ch = src[p];
    if (ch === ')' || ch === ']' || ch === '}') depth++;
    else if (ch === '(' || ch === '[' || ch === '{') {
      if (depth > 0) {
        depth--;
        continue;
      }
      if (ch === '(' && MERGE_CALL.test(src.slice(Math.max(0, p - 12), p + 1))) {
        // Find this call's closing paren, then keep walking for an outer one.
        let d = 0;
        let q = p;
        for (; q < src.length; q++) {
          if (inLiteral(q)) continue;
          if (src[q] === '(') d++;
          else if (src[q] === ')' && --d === 0) break;
        }
        unit = [p, q + 1];
      }
      // Keep climbing past any other opener: the OUTERMOST merge call wins.
    }
  }
  return unit ? src.slice(unit[0], unit[1]) : lit.text;
}

/** A class token the label on a red fill is painted with. */
const LABEL = /(^|[\s'"`])(hover:)?text-(white|(?:dui-)?destructive-foreground)(?=[\s'"`]|$)/;
/** A solid (un-alpha'd) destructive fill. */
const SOLID = /(^|[\s'"`])bg-(?:dui-)?destructive(?=[\s'"`]|$)/;
/** A hover-only near-solid fill. */
const HOVER_SOLID = /(^|[\s'"`])hover:bg-(?:dui-)?destructive\/(9\d|100)(?=[\s'"`]|$)/;
const DIMMED = /(^|[\s'"`])dark:bg-destructive\/60(?=[\s'"`]|$)/;
const PACKAGE_DIMMED = /(^|[\s'"`])dui-dark:bg-dui-destructive\/60(?=[\s'"`]|$)/;
const HOVER_DIMMED = /(^|[\s'"`])dark:hover:bg-destructive\/60(?=[\s'"`]|$)/;
const PACKAGE_HOVER_DIMMED = /(^|[\s'"`])dui-dark:hover:bg-dui-destructive\/60(?=[\s'"`]|$)/;

/**
 * The labelled red fills in `src` that skip the dark-mode dimming.
 *
 * The unit judged is everything that becomes ONE element's classes: a lone
 * literal (single- or multi-line), or a whole `cn`/`clsx`/`cva` call, so a fill
 * in one argument and its label in the next is caught. It also returns how
 * many labelled fills it inspected, so a scan that finds nothing can be told
 * apart from a clean one.
 */
function undimmedFills(src: string): { offenders: string[]; inspected: number } {
  const literals = stringLiterals(src);
  const seen = new Set<string>();
  const offenders: string[] = [];
  let inspected = 0;
  for (const lit of literals) {
    if (!SOLID.test(lit.text) && !HOVER_SOLID.test(lit.text)) continue;
    const unit = classUnit(src, lit, literals);
    if (seen.has(unit)) continue;
    seen.add(unit);
    if (!LABEL.test(unit)) continue;
    inspected++;
    const solid = SOLID.test(unit);
    const packageFill = lit.text.includes('bg-dui-destructive');
    const dimmed = packageFill ? PACKAGE_DIMMED : DIMMED;
    const hoverDimmed = packageFill ? PACKAGE_HOVER_DIMMED : HOVER_DIMMED;
    if ((solid && !dimmed.test(unit)) || (!solid && !hoverDimmed.test(unit))) {
      offenders.push(unit.replace(/\s+/g, ' ').slice(0, 100));
    }
  }
  return { offenders, inspected };
}

describe('solid destructive fills dim themselves in dark mode', () => {
  // A labelled solid red fill must carry `dark:bg-destructive/60`, or its label
  // drops to ~3.4:1 on a dark screen. A hover-only fill needs the hover twin.

  it('catches a fill and its label split across cn() arguments', () => {
    const src = `const c = cn('bg-destructive rounded-md', 'text-destructive-foreground px-3');`;
    expect(undimmedFills(src).offenders).toHaveLength(1);
    expect(undimmedFills(src.replace('rounded-md', 'rounded-md dark:bg-destructive/60'))).toEqual({
      offenders: [],
      inspected: 1,
    });
  });

  it('catches a fill and its label split across clsx() lines and nested calls', () => {
    const src = [
      'const c = clsx(',
      "  'inline-flex',",
      "  confirming && cn('bg-destructive', 'hover:bg-destructive/90'),",
      "  'text-white',",
      ');',
    ].join('\n');
    expect(undimmedFills(src).offenders).toHaveLength(1);
  });

  it('catches a multi-line template literal', () => {
    const src = 'const c = `\n  bg-destructive\n  text-white\n`;';
    expect(undimmedFills(src).offenders).toHaveLength(1);
  });

  it('catches a hover-only fill without the hover twin', () => {
    const src = `x = 'bg-muted hover:bg-destructive/90 hover:text-destructive-foreground';`;
    expect(undimmedFills(src).offenders).toHaveLength(1);
    expect(
      undimmedFills(src.replace("foreground'", "foreground dark:hover:bg-destructive/60'"))
        .offenders
    ).toEqual([]);
  });

  it('leaves unlabelled fills, tints and comments alone', () => {
    const src = [
      "const swatch = { bg: 'bg-destructive' };",
      "const chip = 'bg-destructive/10 text-destructive';",
      '// bg-destructive text-white in prose is not markup',
    ].join('\n');
    expect(undimmedFills(src)).toEqual({ offenders: [], inspected: 0 });
  });

  it('catches namespaced package fills without their matching dark variant', () => {
    const src = `x = 'bg-dui-destructive text-dui-destructive-foreground';`;
    expect(undimmedFills(src).offenders).toHaveLength(1);
    expect(
      undimmedFills(src.replace("foreground'", "foreground dui-dark:bg-dui-destructive/60'"))
    ).toEqual({
      offenders: [],
      inspected: 1,
    });
    expect(
      undimmedFills(src.replace("foreground'", "foreground dark:bg-dui-destructive/60'")).offenders
    ).toHaveLength(1);
  });

  it('the package button paints the fill token, whose dark values are dimmed and clear AA', () => {
    const button = readFileSync(join(UI_SRC, 'button.tsx'), 'utf8');
    expect(button).toContain('bg-dui-destructive-fill');
    expect(button).toContain('hover:bg-dui-destructive-fill-hover');
    expect(undimmedFills(button).offenders).toEqual([]);

    const tokens = readFileSync(join(UI_ROOT, 'tokens.css'), 'utf8');
    const dark = section(tokens, '\n.dark {', '\n}');
    for (const name of ['--dui-destructive-fill', '--dui-destructive-fill-hover']) {
      const mix = dark.match(
        new RegExp(
          `${name}: color-mix\\(in srgb, hsl\\(([\\d.]+) (\\d+)% (\\d+)%\\) (\\d+)%, hsl\\(0 0% (\\d+)%\\)\\)`
        )
      );
      expect(mix, `${name} is not the expected mix`).not.toBeNull();
      const [h, s, l, pct, ground] = mix!.slice(1).map(Number) as [
        number,
        number,
        number,
        number,
        number,
      ];
      const fill = over(hslToRgb(h, s, l), pct / 100, hslToRgb(0, 0, ground));
      expect(contrast(hslToRgb(0, 0, 98), fill), name).toBeGreaterThanOrEqual(AA);
    }
  });

  it('every labelled solid fill in the app and package carries the dark dimming', () => {
    const offenders: string[] = [];
    let inspected = 0;
    for (const file of [...sourceFiles(SRC), ...sourceFiles(UI_SRC)]) {
      const result = undimmedFills(readFileSync(file, 'utf8'));
      inspected += result.inspected;
      offenders.push(...result.offenders.map((o) => `${relative(SRC, file)}: ${o}`));
    }
    // The real fills paint the token now, which this scan doesn't judge. The dev
    // showcase still spells one out: a scan that inspected none would guard nothing.
    expect(inspected).toBeGreaterThanOrEqual(1);
    expect(offenders).toEqual([]);
  });
});
