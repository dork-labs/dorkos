import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { buildBrowserRuntimeAssets } from '../../scripts/build.js';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const temporary: string[] = [];
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
async function fixture(controller = true) {
  const directory = await mkdtemp(join(tmpdir(), 'dorkos-browser-assets-'));
  temporary.push(directory);
  if (controller) {
    await mkdir(join(directory, 'bin'));
    await writeFile(join(directory, 'bin/cli.js'), 'export const controllerFixture = true;\n');
  }
  return directory;
}
afterEach(async () => {
  for (const directory of temporary.splice(0))
    await rm(directory, { recursive: true, force: true });
});

describe('browser runtime packaged asset build', () => {
  it('compiles the actual verifier source and binds both actual output digests without a hash cycle', async () => {
    const output = await fixture();
    await buildBrowserRuntimeAssets(root, output);
    const controller = await readFile(join(output, 'bin/cli.js'));
    const verifier = await readFile(join(output, 'browser/fresh-verifier.mjs'));
    const manifest = JSON.parse(
      await readFile(join(output, 'browser/source-manifest.json'), 'utf8')
    );
    expect(manifest).toEqual({
      schemaVersion: 1,
      controllerSHA256: digest(controller),
      verifierSHA256: digest(verifier),
    });
    expect(verifier.length).toBeGreaterThan(1000);
    expect(verifier.toString()).toContain('runFreshVerifierEntry');
    // This fixture proves the build/hash contract; it does not run Chromium or a packed CLI.
    await writeFile(join(output, 'bin/cli.js'), 'export const controllerFixture = false;\n');
    await buildBrowserRuntimeAssets(root, output);
    const next = JSON.parse(await readFile(join(output, 'browser/source-manifest.json'), 'utf8'));
    expect(next.controllerSHA256).not.toBe(manifest.controllerSHA256);
    expect(next.verifierSHA256).toBe(manifest.verifierSHA256);
  });

  it('refuses missing controller output before publishing any verifier or manifest', async () => {
    const output = await fixture(false);
    await expect(buildBrowserRuntimeAssets(root, output)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(join(output, 'browser/source-manifest.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('refuses an unbuilt source tree rather than falling back to a donor dist', async () => {
    const output = await fixture();
    await expect(
      buildBrowserRuntimeAssets(resolve(output, 'no-source-checkout'), output)
    ).rejects.toThrow();
    await expect(access(join(output, 'browser/source-manifest.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});
