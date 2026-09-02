// @vitest-environment node
/**
 * The marketing site's muted text token clears WCAG AA (4.5:1) on every cream
 * ground it is painted on, and nothing reaches for it on a dark ground or
 * hardcodes a copy of it (DOR-1503).
 *
 * `--warm-gray-light` carries real reading text site-wide — breadcrumbs, table
 * column headers, card labels, captions, source lists, install notes. At its
 * original `#7a756a` it measured 4.04:1 on cream-primary and 3.69:1 on
 * cream-secondary, under the bar. Every one of its text usages is normal-size
 * or smaller (`text-xs`/`text-sm` down to `text-[9px]`), so not one qualifies
 * for the relaxed 3:1 large-text allowance. The token was darkened; this file
 * is what keeps it dark and keeps it on the surfaces it suits.
 *
 * **What this guard covers, and what it does not.** It owns three things: the
 * token value, the light-ground rule, and the no-duplicate rule. The
 * light-ground rule now covers both warm-gray tiers, not just the muted one:
 * `/story` was painting the bare `--warm-gray` on charcoal at 1.89:1 across
 * seven call sites, under a scan that only looked for `-light` (DOR-1512).
 * Those sites moved to `text-cream-tertiary/60` and the scan was widened.
 * It still does NOT cover the brand accents, which fail AA as text on cream
 * and need a policy call before anything moves. Read a pass here as "the
 * warm-gray tokens are on the right grounds", never as "site text is
 * accessible".
 *
 * **Contrast needs layout, and a unit test has none** — the real proof is the
 * browser measurement recorded on the PR. What a test CAN own is the token
 * itself, run through the same WCAG math a browser applies, against the grounds
 * it is painted on.
 *
 * **A check that reads a token and computes a number can pass while its own
 * math is broken.** So the helpers are pinned against known pairs first (black
 * on white is 21:1, a colour on itself is 1:1, the hex parser returns distinct
 * channels), and the discriminator is proven both ways: the OLD `#7a756a` is
 * asserted to FAIL on the two cream grounds, and the shipped value to PASS.
 *
 * @module __tests__/warm-gray-contrast
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const SRC = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const GLOBALS_CSS = resolve(SRC, 'app/globals.css');

/** WCAG AA threshold for normal-size text. */
const AA = 4.5;

/** The value `--warm-gray-light` held before DOR-1503 — the failure this pins. */
const OLD_WARM_GRAY_LIGHT = '#7a756a';

type Rgb = readonly [number, number, number];

/**
 * A `#rrggbb` string to sRGB 0-255 channels.
 *
 * @param hex - Six-digit hex colour, with or without the leading `#`.
 */
function hexToRgb(hex: string): Rgb {
  const s = hex.replace('#', '');
  return [
    parseInt(s.slice(0, 2), 16),
    parseInt(s.slice(2, 4), 16),
    parseInt(s.slice(4, 6), 16),
  ] as const;
}

/**
 * WCAG relative luminance of an sRGB colour.
 *
 * @param rgb - sRGB 0-255 channels.
 */
function luminance(rgb: Rgb): number {
  const [r, g, b] = rgb.map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * WCAG contrast ratio between two colours (order-independent, 1:1 to 21:1).
 *
 * @param a - One colour.
 * @param b - The other colour.
 */
function contrast(a: Rgb, b: Rgb): number {
  const [la, lb] = [luminance(a), luminance(b)];
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Composite a colour over a ground at a given alpha — what Tailwind's `/NN`
 * opacity suffix paints.
 *
 * @param fg - Foreground colour.
 * @param alpha - Opacity 0-1.
 * @param ground - The opaque colour behind it.
 */
function over(fg: Rgb, alpha: number, ground: Rgb): Rgb {
  return fg.map((c, i) => Math.round(c * alpha + ground[i] * (1 - alpha))) as unknown as Rgb;
}

/**
 * Read a `--token: #rrggbb;` declaration out of the stylesheet.
 *
 * @param css - The stylesheet source.
 * @param name - Token name including the leading dashes.
 */
function token(css: string, name: string): Rgb {
  const m = css.match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`));
  expect(m, `token not found: ${name}`).not.toBeNull();
  return hexToRgb(m![1]);
}

const css = readFileSync(GLOBALS_CSS, 'utf8');

/** The cream surfaces `--warm-gray-light` text is actually painted on. */
const CREAM_TEXT_GROUNDS = ['--cream-white', '--cream-primary', '--cream-secondary'] as const;

// ---------------------------------------------------------------------------
// Source scan
// ---------------------------------------------------------------------------

/**
 * Every `.tsx` under `apps/site/src`, minus tests.
 *
 * @param dir - Directory to walk.
 * @param out - Accumulator.
 */
function walkTsx(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (entry === '__tests__') continue;
      walkTsx(path, out);
    } else if (path.endsWith('.tsx')) {
      out.push(path);
    }
  }
  return out;
}

/**
 * Strip JS/JSX comments so prose that merely *mentions* a colour is not
 * mistaken for a call site. Leaves `://` alone so URLs survive.
 *
 * @param source - File source.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * The `<section ...>` opening tags in a file, attributes included.
 *
 * A dark ground on a `<section>` is what marks a component as dark-grounded.
 * The same class on a `<div>`, `<pre>` or `<button>` is an icon tile, a code
 * block or a selected filter chip sitting inside an otherwise cream page —
 * which is why this looks at sections and not at the file as a whole. A
 * file-wide search reports eight matches here and six of them are correct code.
 *
 * @param source - File source.
 */
function sectionTags(source: string): string[] {
  const tags: string[] = [];
  const re = /<section\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) {
    let depth = 0;
    let end = m.index;
    for (; end < source.length; end++) {
      const c = source[end];
      if (c === '{') depth++;
      else if (c === '}') depth--;
      else if (c === '>' && depth === 0) break;
    }
    tags.push(source.slice(m.index, end));
  }
  return tags;
}

/** Grounds dark enough that the light-ground muted token is unreadable on them. */
const DARK_GROUND = /bg-charcoal|bg-\[#0f0e0c\]|bg-\[#1a1814\]/i;

/**
 * The light-ground warm-gray text tokens, as Tailwind text utilities.
 *
 * Both tiers are light-ground colours: `--warm-gray` is body text on cream and
 * `--warm-gray-light` is the muted step under it. Neither survives a dark
 * ground — `--warm-gray` measured 1.89:1 on charcoal across `/story` (DOR-1512),
 * which is why the bare token is scanned for here and not only its muted
 * sibling. The `-light` suffix is optional so one pattern catches both.
 */
const LIGHT_GROUND_TEXT_TOKENS = /text-warm-gray(?:-light)?\b/;

/** Hardcoded copies of the muted token, old value or new. */
const MUTED_HEX_LITERAL = /#(?:7A756A|686358)\b/i;

/**
 * Design-exploration variants under `app/(marketing)/test/`. These are a
 * scratchpad of alternate hero and diagram treatments, not product surfaces,
 * and they are full of one-off literals by design.
 */
const VARIANT_PLAYGROUND = `app${'/'}(marketing)/test/`;

/**
 * Files permitted to hardcode the muted gray instead of referencing the token.
 * Keep this list short and justified; every entry is a place the token would be
 * the wrong answer, not a place someone skipped the work.
 */
const HEX_LITERAL_ALLOWLIST: Record<string, string> = {
  'layers/features/marketing/ui/InstallMoment.tsx':
    'terminal mockup on a #1A1814 ground — the token was darkened for cream and moves the wrong way here (3.87:1 -> 2.97:1); tracked under DOR-1700',
};

const TSX_FILES = walkTsx(SRC)
  .map((f) => ({ rel: relative(SRC, f).split('\\').join('/'), source: readFileSync(f, 'utf8') }))
  .filter(({ rel }) => !rel.startsWith(VARIANT_PLAYGROUND));

/**
 * The files whose `<section>` carries a dark ground — the subjects of the
 * dark-ground rule below.
 *
 * Derived once and asserted on directly, because `sectionTags` can go blind:
 * it ends a tag at the first `>` outside a `{...}` expression, so a `>` inside
 * a plain-string `className` truncates the slice before the ground class is
 * read. A detector that finds nothing makes the offender list trivially empty,
 * and an empty offender list is exactly what a pass looks like.
 */
const DARK_GROUNDED_FILES = TSX_FILES.filter(({ source }) =>
  sectionTags(source).some((tag) => DARK_GROUND.test(tag))
);

describe('marketing muted-text contrast', () => {
  // --- The math, pinned before anything below is allowed to mean something ---

  it('computes known contrast pairs correctly', () => {
    expect(contrast([0, 0, 0], [255, 255, 255])).toBeCloseTo(21, 5);
    expect(contrast([255, 255, 255], [255, 255, 255])).toBeCloseTo(1, 5);
    expect(contrast([122, 117, 106], [122, 117, 106])).toBeCloseTo(1, 5);
  });

  it('parses hex into distinct, correct channels', () => {
    expect(hexToRgb('#ffffff')).toEqual([255, 255, 255]);
    expect(hexToRgb('#000000')).toEqual([0, 0, 0]);
    // Channel order matters: a colour whose R dominates must not read as blue.
    expect(hexToRgb('#e85d04')).toEqual([232, 93, 4]);
  });

  it('composites opacity toward the ground', () => {
    expect(over([255, 255, 255], 1, [0, 0, 0])).toEqual([255, 255, 255]);
    expect(over([255, 255, 255], 0, [0, 0, 0])).toEqual([0, 0, 0]);
    expect(over([255, 255, 255], 0.5, [0, 0, 0])).toEqual([128, 128, 128]);
  });

  it('discriminates: the OLD muted gray FAILS on cream, the shipped one PASSES', () => {
    // The bug DOR-1503 fixes. If the math cannot see this, no pass below counts.
    const old = hexToRgb(OLD_WARM_GRAY_LIGHT);
    expect(contrast(old, token(css, '--cream-primary'))).toBeLessThan(AA);
    expect(contrast(old, token(css, '--cream-secondary'))).toBeLessThan(AA);

    // And the value actually shipped must clear it — read from the file, never
    // hard-coded, so lightening the token turns this red.
    const shipped = token(css, '--warm-gray-light');
    expect(shipped).not.toEqual(old);
    expect(contrast(shipped, token(css, '--cream-secondary'))).toBeGreaterThanOrEqual(AA);
  });

  // --- The assertions those checks earn, against the real shipped tokens ---

  it('muted text clears AA on every cream ground it is painted on', () => {
    const muted = token(css, '--warm-gray-light');
    for (const ground of CREAM_TEXT_GROUNDS) {
      const ratio = contrast(muted, token(css, ground));
      expect({ ground, passes: ratio >= AA }).toEqual({ ground, passes: true });
    }
  });

  it('body text stays well clear of AA on every cream ground', () => {
    const body = token(css, '--warm-gray');
    for (const ground of CREAM_TEXT_GROUNDS) {
      const ratio = contrast(body, token(css, ground));
      expect({ ground, passes: ratio >= AA }).toEqual({ ground, passes: true });
    }
  });

  it('muted text stays a visibly lighter step than body text', () => {
    // Darkening for AA must not collapse the two-tier hierarchy into one colour.
    const ground = token(css, '--cream-primary');
    const muted = contrast(token(css, '--warm-gray-light'), ground);
    const body = contrast(token(css, '--warm-gray'), ground);
    expect(muted).toBeLessThan(body);
    expect(body - muted).toBeGreaterThan(1.5);
  });

  it('the dark-surface muted idiom clears AA on the story grounds', () => {
    // `--warm-gray-light` is a LIGHT-ground token: on charcoal it measured
    // 3.87:1 even before it was darkened, and darkening makes it worse. The
    // story sections use `text-cream-tertiary/60` instead — the same idiom
    // MarketingFooter already uses on charcoal.
    const tertiary = token(css, '--cream-tertiary');
    const charcoal = token(css, '--charcoal');
    const storyDark = hexToRgb('#0f0e0c'); // MondayMorningSection's section fill
    expect(contrast(over(tertiary, 0.6, charcoal), charcoal)).toBeGreaterThanOrEqual(AA);
    expect(contrast(over(tertiary, 0.6, storyDark), storyDark)).toBeGreaterThanOrEqual(AA);
    // And the token we darkened would NOT have survived there — which is why
    // those call sites moved rather than riding the token change.
    expect(contrast(token(css, '--warm-gray-light'), charcoal)).toBeLessThan(AA);
  });

  // --- The source scan: no new call site may reintroduce either failure ---

  it('scans a realistic number of source files', () => {
    // A walk that silently returned nothing would make both scans below vacuous.
    expect(TSX_FILES.length).toBeGreaterThan(50);
    expect(TSX_FILES.some(({ rel }) => rel.endsWith('story/StoryHero.tsx'))).toBe(true);
  });

  it('still finds the dark-grounded sections it is supposed to be judging', () => {
    // Without this, the rule below has a zero-subject pass: if `sectionTags`
    // stops seeing section tags, every file drops out of the subject set and
    // the offender list goes empty for the one reason a green must never mean.
    const rels = DARK_GROUNDED_FILES.map(({ rel }) => rel);
    expect(rels).toContain('layers/features/marketing/ui/story/StoryHero.tsx');
    expect(rels.length).toBeGreaterThanOrEqual(6);
  });

  it('no dark-grounded section paints text with a light-ground warm-gray token', () => {
    const offenders = DARK_GROUNDED_FILES.filter(({ source }) =>
      LIGHT_GROUND_TEXT_TOKENS.test(stripComments(source))
    ).map(({ rel }) => rel);
    expect(offenders).toEqual([]);
  });

  it('the widened scan actually sees the bare token, not just its muted sibling', () => {
    // The scan above passing is only meaningful if `text-warm-gray` on its own
    // is a match. Before DOR-1512 the pattern required the `-light` suffix, so
    // seven `/story` call sites at 1.89:1 sat under it unseen.
    expect(LIGHT_GROUND_TEXT_TOKENS.test('className="text-warm-gray text-sm"')).toBe(true);
    expect(LIGHT_GROUND_TEXT_TOKENS.test('className="text-warm-gray-light"')).toBe(true);
    // And it must not fire on the colour used as a border or a background.
    expect(LIGHT_GROUND_TEXT_TOKENS.test('className="border-warm-gray/20"')).toBe(false);
    expect(LIGHT_GROUND_TEXT_TOKENS.test('className="bg-warm-gray"')).toBe(false);
  });

  it('no component hardcodes the muted gray instead of referencing the token', () => {
    const offenders = TSX_FILES.filter(
      ({ rel, source }) =>
        !(rel in HEX_LITERAL_ALLOWLIST) && MUTED_HEX_LITERAL.test(stripComments(source))
    ).map(({ rel }) => rel);
    expect(offenders).toEqual([]);
  });

  it('every allowlisted file still exists and still needs its exemption', () => {
    // An allowlist that outlives its entries quietly stops guarding anything.
    for (const rel of Object.keys(HEX_LITERAL_ALLOWLIST)) {
      const file = TSX_FILES.find((f) => f.rel === rel);
      expect(file, `allowlisted file is gone, drop the entry: ${rel}`).toBeDefined();
      expect(
        MUTED_HEX_LITERAL.test(stripComments(file!.source)),
        `allowlisted file no longer hardcodes the gray, drop the entry: ${rel}`
      ).toBe(true);
    }
  });
});
