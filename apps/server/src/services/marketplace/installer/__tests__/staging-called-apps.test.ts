/**
 * An app that calls other apps must name each one by its exact id (DOR-3293,
 * Security): a manifest whose `capabilities.http.apps` lists anything else is
 * refused, in the designer's words, on install and on update alike. Both go through
 * {@link PackageStager}: install by resolving first, update with a source it
 * already resolved.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { InvalidPackageError } from '../errors.js';
import { PackageStager } from '../staging.js';
import type { InstallerDeps } from '../marketplace-installer.js';
import type { ResolvedPackageSource } from '../../package-resolver.js';

const VALID_PLUGIN = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'fixtures',
  'valid-plugin'
);

const temps: string[] = [];
afterEach(async () => {
  for (const dir of temps.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

/** The plugin fixture, with its app calling these other apps. */
async function pluginCalling(apps: string[]): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dor-3293-called-apps-'));
  temps.push(root);
  const dir = path.join(root, 'valid-plugin');
  await fs.cp(VALID_PLUGIN, dir, { recursive: true });
  const manifest = path.join(dir, '.dork', 'extensions', 'sample-ext', 'extension.json');
  const current = JSON.parse(await fs.readFile(manifest, 'utf8')) as Record<string, unknown>;
  await fs.writeFile(
    manifest,
    JSON.stringify({ ...current, clientApiVersion: 2, capabilities: { http: { apps } } })
  );
  return dir;
}

/** A local source for that folder, as the resolver answers it. */
function localSource(localPath: string): ResolvedPackageSource {
  return { kind: 'local', packageName: 'valid-plugin', localPath } as ResolvedPackageSource;
}

/** The stager, with a resolver that answers this folder. */
function stagerFor(localPath: string): PackageStager {
  const resolver = { resolve: vi.fn(async () => localSource(localPath)) };
  return new PackageStager({ resolver } as unknown as InstallerDeps);
}

const HOSTILE = 'Google Drive (official)';
/** The designer's refusal: the app's name, never the id it made up. */
const REFUSAL =
  'sample-ext can’t be installed. It names another app in a way DorkOS doesn’t accept. Ask its maker for an update.';

describe('apps an app calls, named by id', () => {
  it('installs an app whose calls name exact ids', async () => {
    // Purpose: the happy path stays green, so the refusals below are real.
    const dir = await pluginCalling(['ledger', 'mkt-core']);
    await expect(
      stagerFor(dir).resolveAndValidate({ name: 'valid-plugin', source: dir })
    ).resolves.toMatchObject({ packagePath: dir });
  });

  it('refuses to install an app that names another app by anything but its id', async () => {
    const dir = await pluginCalling([HOSTILE]);
    const install = stagerFor(dir).resolveAndValidate({ name: 'valid-plugin', source: dir });
    await expect(install).rejects.toBeInstanceOf(InvalidPackageError);
    // Exactly the one sentence: no id the app made up reaches the person.
    await expect(install).rejects.toMatchObject({ errors: [REFUSAL] });
  });

  it('refuses an update that starts naming another app by anything but its id', async () => {
    // An update stages a source it already resolved (installer/update.ts).
    const dir = await pluginCalling(['ledger', HOSTILE]);
    const update = stagerFor(dir).stageAndValidate(localSource(dir), {
      name: 'valid-plugin',
      source: dir,
    });
    await expect(update).rejects.toBeInstanceOf(InvalidPackageError);
    await expect(update).rejects.toMatchObject({ errors: [REFUSAL] });
  });
});
