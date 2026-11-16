/**
 * An app must name every other app it touches by its exact id (DOR-3293,
 * Security): the apps it calls (`capabilities.http.apps`) and the apps an
 * exported route admits (`exports.http[].callers`). The real installer, as a
 * direct server call reaches it, refuses anything else on preview, install
 * and update, in the designer's words, and an update it refuses leaves the
 * installed version in place.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initBoundary } from '../../../lib/boundary.js';
import { InvalidPackageError } from '../installer/errors.js';
import { buildInstallerForTests } from './installer-harness.js';

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'valid-plugin'
);

/** The designer's refusal, naming the app and never the id it made up. */
const REFUSAL =
  'sample-ext can’t be installed. It names another app in a way DorkOS doesn’t accept. Ask its maker for an update.';

let dorkHome: string;
let workDir: string;

beforeEach(async () => {
  dorkHome = await mkdtemp(path.join(tmpdir(), 'dor-3293-home-'));
  await mkdir(path.join(dorkHome, 'plugins'), { recursive: true });
  workDir = await mkdtemp(path.join(tmpdir(), 'dor-3293-pkg-'));
  await initBoundary(workDir);
});

afterEach(async () => {
  await rm(dorkHome, { recursive: true, force: true });
  await rm(workDir, { recursive: true, force: true });
});

/** A copy of the plugin fixture whose app manifest gets these extra fields. */
async function pluginWith(extra: Record<string, unknown>): Promise<string> {
  const dir = path.join(workDir, 'valid-plugin');
  await rm(dir, { recursive: true, force: true });
  await cp(FIXTURE, dir, { recursive: true });
  await setManifest(dir, extra);
  return dir;
}

/** Rewrite the app manifest in a package folder with these extra fields. */
async function setManifest(dir: string, extra: Record<string, unknown>): Promise<void> {
  const file = path.join(dir, '.dork', 'extensions', 'sample-ext', 'extension.json');
  const base = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
  await writeFile(file, JSON.stringify({ ...base, clientApiVersion: 2, ...extra }));
}

const BAD_CALL = { capabilities: { http: { apps: ['Google Drive (official)'] } } };
const BAD_CALLER = {
  exports: { http: [{ path: '/items', methods: ['GET'], callers: ['Google Drive (official)'] }] },
};

describe('apps named by id, through the real installer', () => {
  it.each([
    ['an app it calls', BAD_CALL],
    ['an app an exported route admits', BAD_CALLER],
  ])(
    'refuses to preview or install a package naming %s by anything but its id',
    async (_, extra) => {
      const harness = buildInstallerForTests(dorkHome);
      const dir = await pluginWith(extra);
      for (const call of [
        () => harness.installer.preview({ name: dir }),
        () => harness.installer.install({ name: dir }),
      ]) {
        const refused = call();
        await expect(refused).rejects.toBeInstanceOf(InvalidPackageError);
        await expect(refused).rejects.toMatchObject({ errors: [REFUSAL] });
      }
      // Nothing of it was built or turned on.
      expect(harness.spies.extensionCompile).not.toHaveBeenCalled();
      expect(harness.spies.extensionEnable).not.toHaveBeenCalled();
    }
  );

  it('refuses an update that starts naming another app badly, and keeps the installed version', async () => {
    const harness = buildInstallerForTests(dorkHome);
    const dir = await pluginWith({ capabilities: { http: { apps: ['ledger'] } } });
    await expect(harness.installer.install({ name: dir })).resolves.toMatchObject({ ok: true });
    harness.spies.extensionCompile.mockClear();

    await setManifest(dir, BAD_CALL);
    const update = harness.installer.update({ name: dir });
    await expect(update).rejects.toBeInstanceOf(InvalidPackageError);
    await expect(update).rejects.toMatchObject({ errors: [REFUSAL] });

    // The installed copy still names only `ledger`.
    const installed = JSON.parse(
      await readFile(
        path.join(
          dorkHome,
          'plugins',
          'valid-plugin',
          '.dork',
          'extensions',
          'sample-ext',
          'extension.json'
        ),
        'utf8'
      )
    ) as { capabilities?: { http?: { apps?: string[] } } };
    expect(installed.capabilities?.http?.apps).toEqual(['ledger']);
    expect(harness.spies.extensionCompile).not.toHaveBeenCalled();
  });
});
