/**
 * @vitest-environment node
 *
 * `POST /packages/:name/uninstall`, and `POST /packages/:name/check-files`
 * (DOR-2320), which rebuilds the file record an older install never wrote.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PackageNotInstalledError } from '../../../services/marketplace/flows/uninstall/support.js';
import { uninstallResult, useMarketplaceRoutes } from './marketplace.fixtures.js';

const h = useMarketplaceRoutes();

const uninstall = (body: object = {}, name = 'sample-plugin') =>
  h.post(`/packages/${name}/uninstall`, body);

describe('POST /packages/:name/uninstall', () => {
  it('returns the uninstall result, and a removed global package takes its approvals with it (DOR-2306)', async () => {
    // The same bytes put back later are asked about again.
    h.uninstallFlow.uninstall.mockResolvedValue(uninstallResult('sample-plugin', 4));

    const res = await uninstall({ purge: true });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, removedFiles: 4 });
    expect(h.uninstallFlow.uninstall.mock.calls[0][0]).toEqual({
      name: 'sample-plugin',
      purge: true,
    });
    expect(h.consent.removed).toHaveBeenCalledWith('sample-plugin');
    expect(h.onPluginsChanged.mock.calls).toEqual([
      [{ projectPath: undefined, packageName: 'sample-plugin', action: 'uninstall' }],
    ]);
  });

  it('keeps a global package’s approvals when only a project copy is removed, and refreshes that project with the RESOLVED name (DOR-264)', async () => {
    // The event carries what the flow resolved, never what the URL said.
    h.uninstallFlow.uninstall.mockResolvedValue(uninstallResult());
    const projectPath = join(h.dorkHome, 'project');

    await uninstall({ projectPath }, 'sample-plugin-alias');

    expect(h.consent.removed).not.toHaveBeenCalled();
    expect(h.onPluginsChanged.mock.calls).toEqual([
      [{ projectPath, packageName: 'sample-plugin', action: 'uninstall' }],
    ]);
  });

  // `:name` is joined into dorkHome, so a traversal is refused before the tier
  // gate: no approval card is ever raised for a name no package could have.
  it.each([
    ['..%2F..%2Fvictim', 'encoded parent traversal'],
    ['..%2Fetc', 'encoded single climb'],
    ['%2Fetc%2Fpasswd', 'encoded absolute path'],
    ['a%2F..%2F..%2F..%2Fetc', 'embedded traversal'],
    ['Sample-Plugin', 'uppercase, never an install directory'],
  ])('refuses %s with 400 (%s) and never reaches the flow', async (rawName) => {
    const res = await uninstall({}, rawName);

    expect(res.status).toBe(400);
    expect(res.body.detail).toMatch(/package or marketplace name/);
    expect(h.uninstallFlow.uninstall).not.toHaveBeenCalled();
    expect(h.onPluginsChanged).not.toHaveBeenCalled();
  });

  it('returns 404 when the package is not installed', async () => {
    h.uninstallFlow.uninstall.mockRejectedValue(new PackageNotInstalledError('missing-pkg'));

    const res = await uninstall({}, 'missing-pkg');

    expect(res.status).toBe(404);
    expect(res.body.detail).toBe("That package isn't installed here.");
    expect(h.onPluginsChanged).not.toHaveBeenCalled();
  });

  it('returns 403 when projectPath is outside the boundary', async () => {
    const res = await uninstall({ projectPath: '/etc/evil' });

    expect(res.status).toBe(403);
    expect(h.uninstallFlow.uninstall).not.toHaveBeenCalled();
  });
});

describe('POST /packages/:name/check-files (DOR-2320)', () => {
  const SHA = 'b'.repeat(40);
  const SHIPPED = {
    '.dork/manifest.json':
      '{"schemaVersion":1,"name":"old-plugin","version":"1.0.0","type":"plugin","description":"An older install"}',
    'skills/a/SKILL.md': '---\nname: a\ndescription: A.\n---\n\nA.\n',
  };
  const SOURCE_KEY = {
    cloneUrl: 'https://github.com/acme/plugins',
    subpath: 'old-plugin',
    ref: 'main',
  };

  const rootOf = () => join(h.dorkHome, 'plugins', 'old-plugin');
  const checkFiles = (body: object = {}, name = 'old-plugin') =>
    h.post(`/packages/${name}/check-files`, body);

  function writeTree(dir: string, files: Record<string, string>): void {
    for (const [rel, content] of Object.entries(files)) {
      mkdirSync(join(dir, dirname(rel)), { recursive: true });
      writeFileSync(join(dir, rel), content);
    }
  }

  /** An install an older DorkOS made: shipped files and a sidecar, no record. */
  function legacyInstall(files: Record<string, string> = SHIPPED, sidecar: object = {}): string {
    const root = rootOf();
    writeTree(root, files);
    writeFileSync(
      join(root, '.dork', 'install-metadata.json'),
      JSON.stringify({
        name: 'old-plugin',
        version: '1.0.0',
        type: 'plugin',
        installedAt: '2026-09-01T00:00:00.000Z',
        commitSha: SHA,
        sourceKey: SOURCE_KEY,
        ...sidecar,
      })
    );
    return root;
  }

  /** The fetcher serves the installed commit's tree. */
  function serveCommit(files: Record<string, string> = SHIPPED): void {
    const tree = join(h.dorkHome, 'commit-tree');
    writeTree(tree, files);
    h.fetcher.fetchAtCommit.mockResolvedValue({ path: tree, commitSha: SHA, fromCache: false });
  }

  it('rebuilds the record of an install that matches its commit', async () => {
    const root = legacyInstall();
    serveCommit();

    const res = await checkFiles();

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      outcome: 'rebuilt',
      message:
        'Checked old-plugin. Its files match the version you installed, so updates will keep your edits.',
    });
    expect(existsSync(join(root, '.dork', 'installed-files.json'))).toBe(true);
  });

  it.each([
    [
      'mismatch',
      () => {
        legacyInstall({ ...SHIPPED, 'skills/a/SKILL.md': 'edited' });
        serveCommit();
      },
      "Some of old-plugin's files differ from the version you installed, so DorkOS can't tell your edits from the package's files. Its next update still keeps your copies.",
    ],
    [
      'fetch-failed',
      () => legacyInstall(),
      "Couldn't fetch the version of old-plugin you installed (no network in tests). Try again when you're online.",
    ],
    [
      'no-source',
      () => legacyInstall(SHIPPED, { commitSha: undefined, sourceKey: undefined }),
      "old-plugin was installed from a folder on this computer, so there's no version to compare it with. Reinstall it so updates keep your edits.",
    ],
  ])('answers %s in plain words and writes nothing', async (outcome, setup, message) => {
    setup();

    const res = await checkFiles();

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ outcome, message });
    expect(existsSync(join(rootOf(), '.dork', 'installed-files.json'))).toBe(false);
  });

  it('says a recorded install needs no checking', async () => {
    const root = legacyInstall();
    writeFileSync(join(root, '.dork', 'installed-files.json'), '{}');

    const res = await checkFiles();

    expect(res.body).toEqual({
      outcome: 'not-needed',
      message: "old-plugin's files are already checked.",
    });
    expect(h.fetcher.fetchAtCommit).not.toHaveBeenCalled();
  });

  it('prepares only the installation installRoot names, and never an arbitrary folder', async () => {
    const root = legacyInstall();
    serveCommit();
    const elsewhere = join(h.dorkHome, 'elsewhere', 'old-plugin');
    writeTree(elsewhere, SHIPPED);

    expect((await checkFiles({ installRoot: elsewhere })).status).toBe(404);
    expect((await checkFiles({ installRoot: root })).body.outcome).toBe('rebuilt');
  });

  it('sorts the files an offline update kept unproven, and says what it did (DOR-2322)', async () => {
    // A leftover identical to the earlier version goes; the person's file stays.
    const root = rootOf();
    writeTree(root, { ...SHIPPED, 'old.md': 'old v1', 'notes.txt': 'mine' });
    const { computeInstalledFiles, writeInstalledFiles } =
      await import('../../../services/marketplace/lib/records/installed-files.js');
    const record = await computeInstalledFiles(root, {
      identity: { name: 'old-plugin', type: 'plugin' },
      userEditable: [],
      npmRan: false,
    });
    delete record.files['old.md'];
    delete record.files['notes.txt'];
    await writeInstalledFiles(root, {
      ...record,
      unproven: {
        why: 'fetch-failed',
        from: { name: 'old-plugin', commitSha: SHA, sourceKey: SOURCE_KEY },
        files: { 'old.md': 'old.md', 'notes.txt': 'notes.txt' },
      },
    });
    serveCommit({ ...SHIPPED, 'old.md': 'old v1' });

    const res = await checkFiles();

    expect(res.body).toEqual({
      outcome: 'sorted',
      message:
        'Checked the files old-plugin kept: set aside 1 left over from the version you had before (old.md.dork-old), and kept 1 as yours.',
    });
    expect(existsSync(join(root, 'old.md'))).toBe(false);
    expect(existsSync(join(root, 'old.md.dork-old'))).toBe(true);
    expect(existsSync(join(root, 'notes.txt'))).toBe(true);
  });

  it('returns 404 when the package is not installed', async () => {
    expect((await checkFiles({}, 'nowhere')).status).toBe(404);
  });

  it.each(['..%2F..%2Fvictim', 'Old-Plugin'])('refuses the name %s with 400', async (raw) => {
    const res = await checkFiles({}, raw);
    expect(res.status).toBe(400);
    expect(h.fetcher.fetchAtCommit).not.toHaveBeenCalled();
  });
});
