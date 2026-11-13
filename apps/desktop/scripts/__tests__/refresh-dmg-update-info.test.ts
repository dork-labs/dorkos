import { describe, it, expect, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

import {
  loadBlockMapBuilder,
  refreshDmgUpdateInfo,
  rewriteManifestEntry,
  type BlockMapBuilder,
} from '../refresh-dmg-update-info';

const DESKTOP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** The shape electron-builder writes, with made-up hashes. */
const MANIFEST = `version: 9.9.9
files:
  - url: DorkOS-9.9.9-arm64-mac.zip
    sha512: ZIPHASH==
    size: 100
  - url: DorkOS-9.9.9-arm64.dmg
    sha512: OLDDMGHASH==
    size: 200
path: DorkOS-9.9.9-arm64-mac.zip
sha512: ZIPHASH==
releaseDate: '2026-01-01T00:00:00.000Z'
`;

const created: string[] = [];

/** A throwaway release folder holding the given files. */
function releaseDir(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'dorkos-release-'));
  created.push(dir);
  for (const [name, body] of Object.entries(files)) writeFileSync(path.join(dir, name), body);
  return dir;
}

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('rewriteManifestEntry', () => {
  it('changes only the DMG entry', () => {
    const out = parse(
      rewriteManifestEntry(MANIFEST, 'DorkOS-9.9.9-arm64.dmg', { sha512: 'NEW==', size: 201 })
    );
    expect(out.files).toEqual([
      { url: 'DorkOS-9.9.9-arm64-mac.zip', sha512: 'ZIPHASH==', size: 100 },
      { url: 'DorkOS-9.9.9-arm64.dmg', sha512: 'NEW==', size: 201 },
    ]);
    expect(out.path).toBe('DorkOS-9.9.9-arm64-mac.zip');
    expect(out.sha512).toBe('ZIPHASH==');
    expect(out.releaseDate).toBe('2026-01-01T00:00:00.000Z');
  });

  it('refuses a manifest that does not list the file', () => {
    expect(() =>
      rewriteManifestEntry(MANIFEST, 'DorkOS-1.0.0-arm64.dmg', { sha512: 'X', size: 1 })
    ).toThrow(/0 times/);
  });

  it('refuses a manifest with no files list', () => {
    expect(() => rewriteManifestEntry('version: 1\n', 'a.dmg', { sha512: 'X', size: 1 })).toThrow(
      /no files list/
    );
  });
});

describe('refreshDmgUpdateInfo', () => {
  it('rebuilds the blockmap and writes the new hash into latest-mac.yml', async () => {
    const dir = releaseDir({
      'DorkOS-9.9.9-arm64.dmg': 'stapled bytes',
      'latest-mac.yml': MANIFEST,
    });
    const calls: string[][] = [];
    const build: BlockMapBuilder = async (file, blockMapFile) => {
      calls.push([file, blockMapFile]);
      return { sha512: 'STAPLED==', size: 13 };
    };

    await refreshDmgUpdateInfo(dir, build);

    const dmg = path.join(dir, 'DorkOS-9.9.9-arm64.dmg');
    expect(calls).toEqual([[dmg, `${dmg}.blockmap`]]);
    const files = parse(readFileSync(path.join(dir, 'latest-mac.yml'), 'utf8')).files;
    expect(files[1]).toEqual({ url: 'DorkOS-9.9.9-arm64.dmg', sha512: 'STAPLED==', size: 13 });
  });

  it('refuses a folder with no DMG, before building anything', async () => {
    const dir = releaseDir({ 'latest-mac.yml': MANIFEST });
    const build: BlockMapBuilder = async () => {
      throw new Error('should not run');
    };
    await expect(refreshDmgUpdateInfo(dir, build)).rejects.toThrow(/exactly one \.dmg/);
  });

  it('refuses a folder with no manifest, before building anything', async () => {
    const dir = releaseDir({ 'DorkOS-9.9.9-arm64.dmg': 'x' });
    let built = false;
    const build: BlockMapBuilder = async () => {
      built = true;
      return { sha512: 'X', size: 1 };
    };
    await expect(refreshDmgUpdateInfo(dir, build)).rejects.toThrow(/latest-mac\.yml/);
    expect(built).toBe(false);
  });
});

describe('loadBlockMapBuilder', () => {
  // A tripwire, not a fixture: the builder is internal to app-builder-lib, so an
  // electron-builder bump that moves it must fail here before a release does.
  it('reaches electron-builder’s own builder, which hashes the file it is given', async () => {
    const dir = releaseDir({ 'made-up.dmg': 'made-up release bytes' });
    const file = path.join(dir, 'made-up.dmg');
    const info = await loadBlockMapBuilder(DESKTOP_DIR)(file, `${file}.blockmap`);
    expect(info.size).toBe('made-up release bytes'.length);
    expect(info.sha512).toBe(createHash('sha512').update('made-up release bytes').digest('base64'));
    expect(existsSync(`${file}.blockmap`)).toBe(true);
  });
});
