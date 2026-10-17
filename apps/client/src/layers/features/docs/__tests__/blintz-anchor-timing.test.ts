/**
 * Pins the one timing fact `DocCommentsSurface` relies on (DOR-2983).
 *
 * The surface tags each moved anchor with the markdown the editor shows when
 * Blintz reports it, read from the `value` prop. That is the editor's own
 * markdown only because Blintz reports anchors a long while after typing
 * pauses (600 ms in `@blintz/comments` 0.1.0, reset on every change), and the
 * canvas re-renders with the new draft within a frame of each change. If
 * Blintz ever reported at once, a report could carry the previous draft's tag.
 *
 * So this fails on any `@blintz/comments` upgrade, and when the delay drops
 * under a frame-safe margin: re-check the hold in `DocCommentsSurface.tsx`
 * (tag reports from the editor's own `onChange` instead) before moving the pin.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// The package exports only an `import` entry, so it is read from the client's
// own install rather than resolved.
const packageDir = path.join(__dirname, '../../../../../node_modules/@blintz/comments');

/** The smallest anchor-report delay the hold is safe with: several frames. */
const SAFE_DELAY_MS = 100;

describe('@blintz/comments anchor reports', () => {
  it('is the version whose timing the hold was checked against', () => {
    const pkg = JSON.parse(readFileSync(path.join(packageDir, 'package.json'), 'utf8')) as {
      version: string;
    };
    expect(pkg.version).toBe('0.1.0');
  });

  it('reports moved anchors only after a delay long past one render', () => {
    const source = readFileSync(path.join(packageDir, 'dist/index.js'), 'utf8');
    const delays = [...source.matchAll(/setTimeout\(\w+, (\w+)\)/g)].map(([, name]) => {
      const value = new RegExp(`const ${name} = (\\d+);`).exec(source)?.[1];
      return Number(value);
    });
    expect(delays.length).toBeGreaterThan(0);
    for (const delay of delays) expect(delay).toBeGreaterThanOrEqual(SAFE_DELAY_MS);
  });
});
