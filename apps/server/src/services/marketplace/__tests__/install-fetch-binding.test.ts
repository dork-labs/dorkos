/**
 * An approval is bound to the package as its preview fetched it (DOR-2325).
 * The preview and the install are two fetches, so a source can serve one
 * package to the first and another to the second: a plugin to the preview
 * (which an agent's install does not card) and an agent package to the
 * install (which it would have). The installer holds every install that
 * carries a previewed hash to it, for every package type, and refuses one
 * whose type moved, before anything is written.
 *
 * The real installer over local fixtures; only the harness's external
 * surfaces are stubbed.
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cp, lstat, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initBoundary } from '../../../lib/boundary.js';
import { buildInstallerForTests } from './installer-harness.js';
import { DisclosureChangedError } from '../marketplace-installer.js';
import { packageContentHash } from '../lib/content-hash.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

let root = '';
let dorkHome = '';
let source = '';
let harness: ReturnType<typeof buildInstallerForTests>;

/** Whether anything exists at `p`. */
async function exists(p: string): Promise<boolean> {
  return lstat(p).then(
    () => true,
    () => false
  );
}

/** Serve `fixture` from the source folder, as a moving source would. */
async function serve(fixture: string): Promise<void> {
  await rm(source, { recursive: true, force: true });
  await cp(path.join(FIXTURES, fixture), source, { recursive: true });
}

/** What the preview fetched: the hash and type an approval binds. */
async function previewed() {
  const { manifest, packagePath } = await harness.installer.preview({ name: source });
  return {
    approvedContentHash: await packageContentHash(packagePath),
    approvedPackageType: manifest.type,
  };
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'install-fetch-binding-'));
  dorkHome = path.join(root, 'dork');
  source = path.join(root, 'moving-source');
  await initBoundary(root);
  harness = buildInstallerForTests(dorkHome);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('an install held to what its preview fetched', () => {
  it('refuses a source that previewed as a plugin and installs as an agent, and lands nothing (the exploit)', async () => {
    await serve('valid-plugin');
    const bound = await previewed();
    await serve('valid-agent');

    const err = await harness.installer.install({ name: source, ...bound }).catch((e) => e);

    expect(err).toBeInstanceOf(DisclosureChangedError);
    expect(harness.spies.createAgentWorkspace).not.toHaveBeenCalled();
    expect(await exists(path.join(dorkHome, 'agents'))).toBe(false);
    expect(await exists(path.join(dorkHome, 'plugins'))).toBe(false);
  });

  it('refuses a type that moved even without a hash to compare', async () => {
    await serve('valid-plugin');
    const { approvedPackageType } = await previewed();
    await serve('valid-agent');

    const err = await harness.installer
      .install({ name: source, approvedPackageType })
      .catch((e) => e);

    expect(err).toBeInstanceOf(DisclosureChangedError);
    expect((err as Error).message).toContain('a plugin package');
    expect(await exists(path.join(dorkHome, 'agents'))).toBe(false);
  });

  it('refuses a plugin whose files changed between the two fetches', async () => {
    await serve('valid-plugin');
    const bound = await previewed();
    await writeFile(path.join(source, 'README.md'), 'served to the install only');

    const err = await harness.installer.install({ name: source, ...bound }).catch((e) => e);

    expect(err).toBeInstanceOf(DisclosureChangedError);
    expect(await exists(path.join(dorkHome, 'plugins'))).toBe(false);
  });

  it('installs a plugin that stayed the same', async () => {
    await serve('valid-plugin');
    const bound = await previewed();

    const result = await harness.installer.install({ name: source, ...bound });

    expect(result.type).toBe('plugin');
    expect(await exists(result.installPath)).toBe(true);
  });
});
