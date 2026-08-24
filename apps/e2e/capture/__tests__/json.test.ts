import path from 'path';
import { fileURLToPath } from 'url';
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

/**
 * Re-format `text` the way the CI gate would.
 *
 * The config is resolved from the REAL published manifest path, never from the
 * caller's target. That asymmetry is the whole point: these tests compare what a
 * writer produced against what `prettier --check .` demands, so the expectation
 * side must be anchored to the repo's own `.prettierrc` independently of
 * wherever the writer happened to write.
 *
 * Resolving from the target instead makes every assertion here self-referential
 * — writer and expectation resolve the SAME config, agree with each other, and
 * pass even when both are wrong. That is the "parity test that pins one of the
 * two inputs it compares" shape in `.claude/rules/testing.md`, and it was real:
 * with the config resolved from a `/tmp` target, `resolveConfig` returned `null`,
 * both sides silently fell back to Prettier's default `printWidth: 80` instead of
 * this repo's `100`, and the suite stayed green while proving nothing about the
 * gate. Verified by seeding exactly that and watching it pass.
 */
async function prettierWould(text: string, filePath: string): Promise<string> {
  const gateConfig = await prettier.resolveConfig(path.join(OUTPUT_DIR, 'manifest.json'));
  return prettier.format(text, { ...gateConfig, filepath: filePath, parser: 'json' });
}

/** A value whose short arrays are exactly what `JSON.stringify` gets wrong. */
const FIXTURE = {
  schemaVersion: 2,
  shots: [
    { id: 'cockpit', kind: 'still', frame: 'desktop', consumers: ['marketing', 'docs'] },
    { id: 'topology', kind: 'loop', frame: 'desktop', consumers: ['marketing'] },
  ],
  assets: [{ file: 'cockpit-light.png', surface: 'cockpit', bytes: 3 }],
  // Collapses to a 94-column line: inside this repo's `printWidth: 100`, past
  // Prettier's built-in default of 80. Every other array here collapses under
  // BOTH widths, so this entry is the only thing that can tell the two configs
  // apart — it is what gives the `writeJsonFile` case below its teeth. Proven:
  // move REPO_SCRATCH_DIR outside the repo and that test goes red; delete this
  // entry and it goes green again while the writer is still wrong.
  widthSensitive: ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel'],
};

/**
 * Scratch space for the writer tests, INSIDE the repo (`apps/e2e/.temp`,
 * gitignored) rather than in `os.tmpdir()`.
 *
 * This is load-bearing, not incidental. `formatJson` resolves Prettier's config
 * by walking up from the file it is writing, so a target under `/tmp` finds no
 * `.prettierrc` at all — `resolveConfig` returns `null` and Prettier falls back
 * to its built-in defaults (`printWidth: 80`, not this repo's `100`). The
 * assertions here compare a writer's output against `prettierWould` of that same
 * output, so under `/tmp` both sides would resolve the same WRONG config and the
 * suite would prove internal consistency while saying nothing about the
 * `prettier --check` gate it exists to pin. Keeping the target inside the repo
 * makes the tests exercise the exact resolution production uses.
 */
const REPO_SCRATCH_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../.temp');

let tmpDir: string;

beforeEach(async () => {
  await fs.mkdir(REPO_SCRATCH_DIR, { recursive: true });
  tmpDir = await fs.mkdtemp(path.join(REPO_SCRATCH_DIR, 'capture-json-test-'));
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
