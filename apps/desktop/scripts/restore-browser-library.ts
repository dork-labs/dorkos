import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
  type Stats,
} from 'node:fs';
import path from 'node:path';
import { DISTRIBUTION } from '../../../packages/browser/src/runtime/inspection/records';

type Entry = {
  files?: Record<string, Entry>;
  unpacked?: boolean;
  size?: number;
  offset?: string;
  integrity?: {
    algorithm: string;
    hash: string;
    blockSize: number;
    blocks: string[];
  };
};
const digest = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const blockSize = 4 * 1024 * 1024;
/** Compute ASAR SHA-256 file integrity and four-mebibyte block hashes. */
export function integrity(bytes: Buffer) {
  const blocks: string[] = [];
  for (let offset = 0; offset + blockSize <= bytes.length; offset += blockSize)
    blocks.push(digest(bytes.subarray(offset, offset + blockSize)));
  blocks.push(digest(bytes.subarray(Math.floor(bytes.length / blockSize) * blockSize)));
  return { algorithm: 'SHA256', hash: digest(bytes), blockSize, blocks };
}
/** Read the original bounded, symlink-free SDK; every directory is checked again after its children. */
export function readPinnedDesktopLibrary(root: string) {
  const rows: { name: string; bytes: Buffer; mode: number }[] = [];
  let total = 0;
  const same = (a: Stats, b: Stats) =>
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs &&
    a.ctimeMs === b.ctimeMs &&
    a.mode === b.mode;
  function walk(relative: string) {
    const file = path.join(root, relative),
      before = lstatSync(file);
    if (before.isSymbolicLink()) throw new Error('Desktop browser SDK contains a symbolic link.');
    if (before.isDirectory()) {
      const names = readdirSync(file).sort();
      for (const name of names) walk(relative ? `${relative}/${name}` : name);
      if (
        JSON.stringify(names) !== JSON.stringify(readdirSync(file).sort()) ||
        !same(before, lstatSync(file))
      )
        throw new Error('Desktop browser SDK directory changed.');
    } else {
      if (
        !before.isFile() ||
        before.size > 8 * 1024 * 1024 ||
        rows.length >= 256 ||
        (total += before.size) > 33 * 1024 * 1024
      )
        throw new Error('Desktop browser SDK exceeds its file bound.');
      const bytes = readFileSync(file);
      if (bytes.length !== before.size || !same(before, lstatSync(file)))
        throw new Error('Desktop browser SDK file changed.');
      rows.push({ name: relative, bytes, mode: before.mode });
    }
  }
  walk('');
  rows.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const distribution = digest(rows.map((row) => `${row.name}\0${digest(row.bytes)}\n`).join(''));
  if (rows.length !== 114 || distribution !== DISTRIBUTION)
    throw new Error('Desktop browser SDK differs from its pinned distribution.');
  return rows;
}
/** Replace only an unpacked SDK header: packed payload offsets and bytes remain untouched. */
export function replaceDesktopLibraryHeader(
  header: Entry,
  rows: ReturnType<typeof readPinnedDesktopLibrary>
) {
  const modules = header.files?.node_modules?.files;
  const previous = modules?.['playwright-core'];
  if (!modules || !previous?.files) throw new Error('Desktop archive has no original browser SDK.');
  function originalUnpacked(entry: Entry, inherited: boolean) {
    const unpacked = inherited || entry.unpacked === true;
    if (entry.files)
      for (const child of Object.values(entry.files)) originalUnpacked(child, unpacked);
    else if (!unpacked || entry.offset !== undefined)
      throw new Error('Desktop archive contains a packed browser SDK copy.');
  }
  originalUnpacked(previous, false);
  const next: Entry = { files: {}, unpacked: true };
  for (const row of rows) {
    const components = row.name.split('/');
    let cursor = next;
    for (const name of components.slice(0, -1)) {
      const files = cursor.files!;
      cursor = files[name] ??= { files: {}, unpacked: true };
    }
    cursor.files![components.at(-1)!] = {
      size: row.bytes.length,
      unpacked: true,
      integrity: integrity(row.bytes),
    };
  }
  modules['playwright-core'] = next;
}
/** Encode the aligned ASAR header pickle and hash its JSON payload. */
export function encodedHeader(header: Entry) {
  const json = Buffer.from(JSON.stringify(header));
  const payload = Math.ceil((4 + json.length) / 4) * 4;
  const result = Buffer.alloc(8 + 4 + payload);
  result.writeUInt32LE(4, 0);
  result.writeUInt32LE(4 + payload, 4);
  result.writeUInt32LE(payload, 8);
  result.writeUInt32LE(json.length, 12);
  json.copy(result, 16);
  return { bytes: result, hash: digest(json) };
}
/** electron-builder afterPack runs before signing. Preserve one canonical physical SDK and its archive pointers. */
export default async function restoreBrowserLibrary(context: {
  appOutDir: string;
  electronPlatformName: string;
  packager: { appInfo: { productFilename: string }; info: { appDir: string } };
}) {
  // Unsupported desktop hosts remain unavailable; no Windows browser acceptance is asserted here.
  if (context.electronPlatformName !== 'darwin') return;
  const appDir = realpathSync(context.packager.info.appDir);
  const require = createRequire(path.join(appDir, 'package.json'));
  const source = realpathSync(path.dirname(require.resolve('playwright-core/package.json')));
  const rows = readPinnedDesktopLibrary(source);
  const contents = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
    'Contents'
  );
  const archive = path.join(contents, 'Resources/app.asar');
  const root = `${archive}.unpacked`;
  // The controller/source-intake package metadata must be a real file, not an ASAR virtual path.
  if (
    !lstatSync(path.join(root, 'package.json')).isFile() ||
    !lstatSync(path.join(root, 'dist/server/server-entry.mjs')).isFile()
  )
    throw new Error('Desktop controller is not physically unpacked.');
  const original = openSync(archive, 'r');
  const temporary = `${archive}.browser-restored`;
  let output: number | undefined;
  let first: { value: unknown } | undefined;
  try {
    const prefix = Buffer.alloc(16);
    if (readSync(original, prefix, 0, 16, 0) !== 16 || prefix.readUInt32LE(0) !== 4)
      throw new Error('Desktop archive prefix is invalid.');
    const oldSize = prefix.readUInt32LE(4),
      jsonSize = prefix.readUInt32LE(12);
    if (oldSize < 8 || oldSize > 64 * 1024 * 1024 || jsonSize > oldSize - 8)
      throw new Error('Desktop archive header exceeds its bound.');
    const json = Buffer.alloc(jsonSize);
    if (readSync(original, json, 0, jsonSize, 16) !== jsonSize)
      throw new Error('Desktop archive header is truncated.');
    const header: Entry = JSON.parse(json.toString());
    replaceDesktopLibraryHeader(header, rows);
    // The signing owner may have sealed the original native binary immediately before this pass.
    for (const relative of [
      'dist/browser/native/darwin-process-observer',
      'dist/browser/native/darwin-process-observer.manifest.json',
      'dist/browser/native/package-manifest.json',
    ]) {
      let entry = header;
      for (const component of relative.split('/')) {
        const next = entry.files?.[component];
        if (!next) throw new Error('Desktop original native archive entry is missing.');
        entry = next;
      }
      if (!entry.unpacked || entry.offset !== undefined)
        throw new Error('Desktop original native assets must be unpacked.');
      const filename = path.join(root, relative),
        stat = lstatSync(filename);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024)
        throw new Error('Desktop original native asset exceeds its bound.');
      const bytes = readFileSync(filename);
      entry.size = bytes.length;
      entry.integrity = integrity(bytes);
    }
    const replacement = encodedHeader(header);
    const plistPath = path.join(contents, 'Info.plist');
    const plist = JSON.parse(
      execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plistPath], {
        encoding: 'utf8',
      })
    );
    const pinned = plist.ElectronAsarIntegrity?.['Resources/app.asar'];
    if (pinned?.algorithm !== 'SHA256' || pinned.hash !== digest(json))
      throw new Error('Desktop archive integrity does not match its original header.');
    const destination = path.join(root, 'node_modules/playwright-core');
    if (!lstatSync(destination).isDirectory() || lstatSync(destination).isSymbolicLink())
      throw new Error('Desktop SDK destination is not its original physical directory.');
    rmSync(destination, { recursive: true });
    mkdirSync(destination);
    for (const row of rows) {
      const target = path.join(destination, row.name);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, row.bytes, { flag: 'wx', mode: row.mode });
    }
    readPinnedDesktopLibrary(destination);
    output = openSync(temporary, 'wx', fstatSync(original).mode);
    const writeAll = (bytes: Buffer) => {
      let at = 0;
      while (at < bytes.length) {
        const count = writeSync(output!, bytes, at, bytes.length - at);
        if (!count) throw new Error('Desktop archive write made no progress.');
        at += count;
      }
    };
    writeAll(replacement.bytes);
    const buffer = Buffer.alloc(1024 * 1024);
    let offset = 8 + oldSize,
      count: number;
    while ((count = readSync(original, buffer, 0, buffer.length, offset)) !== 0) {
      writeAll(buffer.subarray(0, count));
      offset += count;
    }
    closeSync(output);
    output = undefined;
    renameSync(temporary, archive);
    pinned.hash = replacement.hash;
    const xml = execFileSync('/usr/bin/plutil', ['-convert', 'xml1', '-o', '-', '-'], {
      input: JSON.stringify(plist),
    });
    writeFileSync(plistPath, xml);
    // A resolve from the actual real controller root must select this sole restored copy.
    const packagedRequire = createRequire(path.join(root, 'package.json'));
    if (
      realpathSync(path.dirname(packagedRequire.resolve('playwright-core/package.json'))) !==
      realpathSync(destination)
    )
      throw new Error('Desktop browser SDK resolver selected another copy.');
  } catch (value) {
    first = { value };
  } finally {
    for (const close of [
      () => {
        if (output !== undefined) closeSync(output);
      },
      () => closeSync(original),
      () => rmSync(temporary, { force: true }),
    ]) {
      try {
        close();
      } catch (value) {
        first ??= { value };
      }
    }
  }
  if (first) throw first.value;
}
