import os from 'os';
import path from 'path';
import fs from 'fs/promises';
import prettier from 'prettier';
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { formatJson, writeJsonFile } from '../json.js';
import { OUTPUT_DIR } from '../config.js';
import { writeManifest } from '../optimize.js';
import { runArchive } from '../archive.js';

/**
 * Regression tests for the Prettier-stable JSON writers (DOR-1510).
 *
 * The failure these pin shut is invisible to an ordinary unit assertion: a
 * manifest written with `JSON.stringify(value, null, 2)` is perfectly valid
 * JSON with perfectly correct contents — it just fails `prettier --check`,
 * because `JSON.stringify` expands every array and Prettier collapses the short
 * ones. On 2026-08-24 that ejected every PR from the merge queue. So these
 * tests assert the *formatting fixed point*: the bytes a writer emits must
 * already be what Prettier would produce from them.
 *
 * `expect(out).not.toBe(naiveStringify)` in each case is not decoration — it
 * proves the fixture actually contains an array Prettier collapses, so the
 * fixed-point assertion above it cannot pass vacuously on a fixture that has
 * nothing to collapse.
 *
 * @module capture/__tests__/json
 */

/** Re-format `text` the way `prettier --check` would at `filePath`. */
async function prettierWould(text: string, filePath: string): Promise<string> {
  return prettier.format(text, {
    ...(await prettier.resolveConfig(filePath)),
    filepath: filePath,
    parser: 'json',
  });
}

/** A value whose short arrays are exactly what `JSON.stringify` gets wrong. */
const FIXTURE = {
  schemaVersion: 2,
  shots: [
    { id: 'cockpit', kind: 'still', frame: 'desktop', consumers: ['marketing', 'docs'] },
    { id: 'topology', kind: 'loop', frame: 'desktop', consumers: ['marketing'] },
  ],
  assets: [{ file: 'cockpit-light.png', surface: 'cockpit', bytes: 3 }],
};

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dorkos-capture-json-test-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('formatJson', () => {
  it('emits bytes Prettier already agrees with, under the real product-dir config', async () => {
    // Resolve against the real published manifest path so this pins agreement
    // with the repo's own .prettierrc (printWidth 100), not tmpdir defaults.
    const target = path.join(OUTPUT_DIR, 'manifest.json');
    const out = await formatJson(FIXTURE, target);

    expect(out).toBe(await prettierWould(out, target));
    expect(out).not.toBe(`${JSON.stringify(FIXTURE, null, 2)}\n`);
  });

  it('collapses the short arrays JSON.stringify expands', async () => {
    const out = await formatJson(FIXTURE, path.join(OUTPUT_DIR, 'manifest.json'));

    expect(out).toContain('"consumers": ["marketing", "docs"]');
  });
});

describe('writeJsonFile', () => {
  it('writes a file Prettier would leave untouched', async () => {
    const target = path.join(tmpDir, 'manifest.json');
    await writeJsonFile(target, FIXTURE);

    const written = await fs.readFile(target, 'utf8');
    expect(written).toBe(await prettierWould(written, target));
    expect(written).not.toBe(`${JSON.stringify(FIXTURE, null, 2)}\n`);
  });
});

describe('writeManifest', () => {
  it('writes a published manifest Prettier would leave untouched', async () => {
    await writeManifest(
      [
        {
          file: 'cockpit-light.png',
          surface: 'cockpit',
          theme: 'light',
          kind: 'still',
          width: 2560,
          height: 1600,
          bytes: 3,
        },
      ],
      'run-1',
      tmpDir
    );

    const target = path.join(tmpDir, 'manifest.json');
    const written = await fs.readFile(target, 'utf8');
    expect(written).toBe(await prettierWould(written, target));
    // The real shot registry snapshot carries `consumers` arrays, so the naive
    // writer genuinely diverges here — this is the exact file that broke main.
    expect(written).not.toBe(`${JSON.stringify(JSON.parse(written), null, 2)}\n`);
  });
});

describe('runArchive', () => {
  it('writes an archive manifest Prettier would leave untouched', async () => {
    await fs.writeFile(path.join(tmpDir, 'cockpit-light.png'), 'x');
    await writeJsonFile(path.join(tmpDir, 'manifest.json'), {
      schemaVersion: 2,
      generatedAt: '2026-08-24T00:00:00.000Z',
      runId: 'run-1',
      shots: FIXTURE.shots,
      assets: [{ file: 'cockpit-light.png', surface: 'cockpit', bytes: 3 }],
    });

    await runArchive({ label: 'vTEST' }, tmpDir);

    const target = path.join(tmpDir, 'archive', 'vTEST', 'manifest.json');
    const written = await fs.readFile(target, 'utf8');
    expect(written).toBe(await prettierWould(written, target));
    expect(written).not.toBe(`${JSON.stringify(JSON.parse(written), null, 2)}\n`);
  });
});
