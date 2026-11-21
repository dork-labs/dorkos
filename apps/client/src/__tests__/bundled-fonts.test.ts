/**
 * The default fonts shipped with the app (`src/bundled-fonts.css`, DOR-4872).
 *
 * A start must not wait on Google, so the default pairing is served by DorkOS
 * itself. This reads the shipped stylesheet and checks it names exactly the
 * faces the default uses, with the weights the old Google URL asked for, as
 * woff2 only, from files that really ship in the font packages, and that
 * nothing at start still reaches Google.
 *
 * @module __tests__/bundled-fonts
 */
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const css = readFileSync(path.join(here, '..', 'bundled-fonts.css'), 'utf8');
const html = readFileSync(path.join(here, '..', '..', 'index.html'), 'utf8');
const indexCss = readFileSync(path.join(here, '..', 'index.css'), 'utf8');
const require = createRequire(import.meta.url);

/**
 * A `unicode-range` value as its list of ranges. Prettier writes `a, b` in our
 * stylesheet while the package writes `a,b`, so both are compared as lists.
 */
function rangesOf(body: string): string[] | undefined {
  return /unicode-range:\s*([^;]+);/
    .exec(body)?.[1]
    ?.split(',')
    .map((range) => range.trim());
}

/** Each `@font-face` block, as family, weight, its sources and its unicode-range. */
const faces = [...css.matchAll(/@font-face\s*{([^}]*)}/g)].map(([, body]) => ({
  family: /font-family:\s*'([^']+)'/.exec(body!)?.[1],
  weight: /font-weight:\s*([\d ]+);/.exec(body!)?.[1],
  sources: [...body!.matchAll(/url\('([^']+)'\)/g)].map(([, url]) => url!),
  range: rangesOf(body!),
}));

/** The subsets Google Fonts served for each face, so no script loses the font. */
const INTER_SUBSETS = [
  'cyrillic-ext',
  'cyrillic',
  'greek-ext',
  'greek',
  'vietnamese',
  'latin-ext',
  'latin',
];
const MONO_SUBSETS = ['cyrillic-ext', 'cyrillic', 'greek', 'vietnamese', 'latin-ext', 'latin'];

/** The package's own `wght.css`, as each file it names mapped to that face's unicode-range. */
function packageRanges(pkg: string): Map<string, string[]> {
  const source = readFileSync(require.resolve(`@fontsource-variable/${pkg}/wght.css`), 'utf8');
  return new Map(
    [...source.matchAll(/@font-face\s*{([^}]*)}/g)].map(([, body]) => [
      /url\(\.\/files\/([^)]+)\)/.exec(body!)![1]!,
      rangesOf(body!)!,
    ])
  );
}

describe('the default fonts shipped with the app', () => {
  // The old URL asked for `Inter:wght@400;500;600` and plain `JetBrains+Mono`.
  it('declares Inter 400-600 and JetBrains Mono 400, each subset once, and nothing else', () => {
    const declared = faces
      .map((face) => `${face.family} ${face.weight} ${face.sources[0]?.split('/').pop()}`)
      .sort();
    const expected = [
      ...INTER_SUBSETS.map((subset) => `Inter 400 600 inter-${subset}-wght-normal.woff2`),
      ...MONO_SUBSETS.map(
        (subset) => `JetBrains Mono 400 jetbrains-mono-${subset}-wght-normal.woff2`
      ),
    ].sort();
    expect(declared).toEqual(expected);
  });

  // Purpose: the stylesheet is written by hand from the package's own, so a
  // version bump that moves a subset's characters must not pass unnoticed.
  it("gives each face exactly the package's own unicode-range", () => {
    const ranges = {
      inter: packageRanges('inter'),
      'jetbrains-mono': packageRanges('jetbrains-mono'),
    };
    for (const face of faces) {
      const [, pkg, file] = /^@fontsource-variable\/([^/]+)\/files\/(.+)$/.exec(face.sources[0]!)!;
      const expected = ranges[pkg as keyof typeof ranges].get(file!);
      expect(expected, file).toBeDefined();
      expect(face.range, file).toEqual(expected);
    }
  });

  it('names one woff2 file per face, from a file the package ships', () => {
    for (const face of faces) {
      expect(face.sources).toHaveLength(1);
      const [source] = face.sources;
      expect(source).toMatch(
        /^@fontsource-variable\/(inter|jetbrains-mono)\/files\/[a-z0-9-]+-wght-normal\.woff2$/
      );
      expect(existsSync(require.resolve(source!))).toBe(true);
    }
  });

  it('is loaded with the app stylesheet', () => {
    expect(indexCss).toMatch(/@import '\.\/bundled-fonts\.css';/);
  });

  // Purpose: a preconnect is a connection to Google at every start too.
  it('leaves nothing in the page that reaches Google at start', () => {
    expect(html).not.toMatch(/fonts\.(googleapis|gstatic)\.com/);
    expect(css).not.toMatch(/fonts\.(googleapis|gstatic)\.com/);
  });
});
