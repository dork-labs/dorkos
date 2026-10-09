import { createRequire } from 'node:module';
import { afterEach, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  encodedHeader,
  readPinnedDesktopLibrary,
  replaceDesktopLibraryHeader,
} from '../restore-browser-library';
const owned: string[] = [];
afterEach(() => {
  for (const directory of owned.splice(0)) rmSync(directory, { recursive: true, force: true });
});
const rows = [
  {
    name: 'package.json',
    bytes: Buffer.from('{"name":"playwright-core","version":"1.63.0"}'),
    mode: 0o100644,
  },
  { name: 'types/types.d.ts', bytes: Buffer.from('export {}'), mode: 0o100644 },
];
it('replaces trimmed SDK metadata with the exact unpacked files and retains other packed offsets', () => {
  const retained = { size: 5, offset: '17' };
  const header = {
    files: {
      node_modules: {
        files: {
          'playwright-core': {
            unpacked: true,
            files: { 'package.json': { size: 1, unpacked: true } },
          },
        },
      },
      other: retained,
    },
  };
  replaceDesktopLibraryHeader(header, rows);
  expect(header.files.other).toBe(retained);
  expect(JSON.stringify(header)).toContain('types.d.ts');
  expect(JSON.stringify(header)).toContain('SHA256');
  expect(JSON.stringify(header)).not.toContain('"size":1,');
});
it('refuses an SDK retained inside the packed payload rather than adding a second copy', () => {
  const header = {
    files: {
      node_modules: {
        files: {
          'playwright-core': {
            files: { 'package.json': { size: 1, offset: '0' } },
          },
        },
      },
    },
  };
  expect(() => replaceDesktopLibraryHeader(header, rows)).toThrow('packed browser SDK copy');
  expect(header.files.node_modules.files['playwright-core'].files['package.json'].offset).toBe('0');
});
it('refuses a transformed or incomplete SDK distribution', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'desktop-sdk-original-'));
  owned.push(root);
  writeFileSync(path.join(root, 'package.json'), '{"name":"playwright-core"}');
  expect(() => readPinnedDesktopLibrary(root)).toThrow('pinned distribution');
});
it('refuses symlink SDK entries before reading a foreign target', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'desktop-sdk-original-'));
  owned.push(root);
  symlinkSync('/definitely-not-an-original-sdk', path.join(root, 'foreign'));
  expect(() => readPinnedDesktopLibrary(root)).toThrow('symbolic link');
});

it('round-trips the rewritten header through the actual builder ASAR reader while retaining packed payload bytes', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'desktop-asar-original-'));
  owned.push(root);
  const archive = path.join(root, 'app.asar');
  const payload = Buffer.from('original packed payload');
  const header = {
    files: {
      node_modules: {
        files: {
          'playwright-core': {
            unpacked: true,
            files: { 'package.json': { unpacked: true, size: 1 } },
          },
        },
      },
      original: { size: payload.length, offset: '0' },
    },
  };
  const require = createRequire(import.meta.url);
  const builderRequire = createRequire(require.resolve('electron-builder/package.json'));
  const appBuilderRequire = createRequire(builderRequire.resolve('app-builder-lib/package.json'));
  const asar = appBuilderRequire('@electron/asar');
  writeFileSync(archive, Buffer.concat([encodedHeader(header).bytes, payload]));
  expect(asar.extractFile(archive, 'original')).toEqual(payload);
  asar.uncache(archive);
  replaceDesktopLibraryHeader(header, rows);
  for (const row of rows) {
    const filename = path.join(`${archive}.unpacked/node_modules/playwright-core`, row.name);
    mkdirSync(path.dirname(filename), { recursive: true });
    writeFileSync(filename, row.bytes);
  }
  writeFileSync(archive, Buffer.concat([encodedHeader(header).bytes, payload]));
  expect(asar.extractFile(archive, 'original')).toEqual(payload);
  expect(asar.extractFile(archive, 'node_modules/playwright-core/package.json')).toEqual(
    rows[0].bytes
  );
  expect(asar.extractFile(archive, 'node_modules/playwright-core/types/types.d.ts')).toEqual(
    rows[1].bytes
  );
  asar.uncache(archive);
});
