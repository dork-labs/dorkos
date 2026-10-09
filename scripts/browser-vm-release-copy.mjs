import { productionBrowserVMModules } from './browser-vm-production-modules.mjs';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, lstat, realpath, mkdir, rename, rm, readdir } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
const sha = (b) => createHash('sha256').update(b).digest('hex');
const bad = (c) => new Error(c);
const exact = (v, k) =>
  v &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  Object.keys(v).sort().join(',') === k.split(',').sort().join(',');
const same = (a, b) =>
  ['dev', 'ino', 'size', 'mode', 'uid', 'mtimeNs', 'ctimeNs'].every((k) => a[k] === b[k]);
const fixed = new Map([
  ['qemu-system-aarch64', 64 * 1024 * 1024],
  ['atomic-child.node', 64 * 1024 * 1024],
  ['managed-browser-catalogue.dylib', 1048576],
  ['kernel.Image', 64 * 1024 * 1024],
  ['root-init.cpio', 64 * 1024 * 1024],
  ['root.raw', 4 * 1024 ** 3],
  ['blank-profile.raw', 2 * 1024 ** 3],
]);
export const browserVMAssetNames = Object.freeze([...fixed.keys()]);
const name = (n) => fixed.has(n);
async function canonical(path) {
  if (resolve(path) !== path || (await realpath(path)) !== path) throw bad('VM_PACKAGE_PATH');
  return path;
}
async function read(path, cap) {
  let fd, first, out;
  try {
    const before = await lstat(path, { bigint: true });
    if (!before.isFile() || before.size < 1n || before.size > BigInt(cap))
      throw bad('VM_PACKAGE_FILE');
    fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    if (!same(before, await fd.stat({ bigint: true }))) throw bad('VM_PACKAGE_CHANGED');
    out = await fd.readFile();
    if (
      out.length > cap ||
      !same(before, await fd.stat({ bigint: true })) ||
      !same(before, await lstat(path, { bigint: true }))
    )
      throw bad('VM_PACKAGE_CHANGED');
  } catch (value) {
    first = { value };
  } finally {
    if (fd) {
      const original = fd;
      try {
        await original.close();
      } catch (value) {
        first ??= { value };
      }
    }
  }
  if (first) throw first.value;
  return out;
}

async function copyFile(source, target, row) {
  let input, output, first;
  try {
    const before = await lstat(source, { bigint: true });
    if (
      !before.isFile() ||
      before.size !== BigInt(row.bytes) ||
      (await realpath(source)) !== source
    )
      throw bad('VM_PACKAGE_INPUT');
    input = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    if (!same(before, await input.stat({ bigint: true }))) throw bad('VM_PACKAGE_CHANGED');
    output = await open(
      target,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600
    );
    const hash = createHash('sha256'),
      buffer = Buffer.alloc(65536);
    let total = 0;
    for (;;) {
      const { bytesRead } = await input.read(
        buffer,
        0,
        Math.min(buffer.length, row.bytes + 1 - total),
        null
      );
      if (!bytesRead) break;
      total += bytesRead;
      if (total > row.bytes) throw bad('VM_PACKAGE_SIZE');
      hash.update(buffer.subarray(0, bytesRead));
      let offset = 0;
      while (offset < bytesRead) {
        const r = await output.write(buffer, offset, bytesRead - offset, null);
        if (!r.bytesWritten) throw bad('VM_PACKAGE_WRITE_PROGRESS');
        offset += r.bytesWritten;
      }
    }
    if (
      total !== row.bytes ||
      hash.digest('hex') !== row.sha256 ||
      !same(before, await input.stat({ bigint: true })) ||
      !same(before, await lstat(source, { bigint: true }))
    )
      throw bad('VM_PACKAGE_CHANGED');
    await output.chmod(row.name === 'qemu-system-aarch64' ? 0o500 : 0o400);
    await output.sync();
  } catch (value) {
    first = { value };
  } finally {
    for (const original of [output, input])
      if (original)
        try {
          await original.close();
        } catch (value) {
          first ??= { value };
        }
  }
  if (first) throw first.value;
}
// Build-owned paths only. Validate every existing component before deletion or creation.
export async function originalOutputPath(output, relativePath) {
  await canonical(output);
  let current = output;
  for (const part of relativePath.split('/')) {
    if (!part || part === '.' || part === '..') throw bad('VM_PACKAGE_OUTPUT_PATH');
    current = join(current, part);
    let stat;
    try {
      stat = await lstat(current);
    } catch (value) {
      if (value?.code === 'ENOENT') return false;
      throw value;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory() || (await realpath(current)) !== current)
      throw bad('VM_PACKAGE_OUTPUT_ALIAS');
  }
  return true;
}
export async function clearBrowserVMModules(output) {
  if (!(await originalOutputPath(output, 'services/browser'))) return;
  async function clear(directory) {
    await canonical(directory);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name),
        stat = await lstat(path);
      if (stat.isSymbolicLink()) throw bad('VM_SERVER_OUTPUT_SYMLINK');
      if (stat.isDirectory()) await clear(path);
      else if (entry.name.endsWith('.mjs')) {
        if (!stat.isFile() || (await realpath(path)) !== path) throw bad('VM_SERVER_OUTPUT_ALIAS');
        await rm(path);
      }
    }
  }
  await clear(join(output, 'services/browser'));
}
async function loadRelease(root) {
  await canonical(root);
  const selection = JSON.parse(
    (await read(join(root, 'scripts/browser-vm-release.json'), 65536)).toString('utf8')
  );
  if (!exact(selection, 'v,release') || selection.v !== 1) throw bad('VM_PACKAGE_SELECTION');
  if (selection.release === null) return null;
  const selected = selection.release;
  if (
    !exact(selected, 'directory,manifestSHA256') ||
    typeof selected.directory !== 'string' ||
    !/^release-assets\/browser-vm\/[a-f0-9]{64}$/.test(selected.directory) ||
    !/^[a-f0-9]{64}$/.test(selected.manifestSHA256)
  )
    throw bad('VM_PACKAGE_SELECTION');
  const source = await canonical(join(root, selected.directory));
  const manifestBytes = await read(join(source, 'PACKAGE-FILES.json'), 1048576);
  if (sha(manifestBytes) !== selected.manifestSHA256) throw bad('VM_PACKAGE_MANIFEST_HASH');
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  if (
    !exact(manifest, 'v,stage,platform,anchorSHA256,files') ||
    manifest.v !== 1 ||
    manifest.stage !== 'PUBLISHER_INSTALLED_RELEASE' ||
    manifest.platform !== 'darwin-arm64' ||
    !/^[a-f0-9]{64}$/.test(manifest.anchorSHA256) ||
    !Array.isArray(manifest.files) ||
    manifest.files.length !== fixed.size
  )
    throw bad('VM_PACKAGE_MANIFEST');
  const bank = new Map();
  for (const row of manifest.files) {
    if (
      !exact(row, 'name,bytes,sha256') ||
      !name(row.name) ||
      bank.has(row.name) ||
      !Number.isSafeInteger(row.bytes) ||
      row.bytes < 1 ||
      row.bytes > (fixed.get(row.name) ?? 1048576) ||
      !/^[a-f0-9]{64}$/.test(row.sha256)
    )
      throw bad('VM_PACKAGE_ASSET');
    bank.set(row.name, row);
  }
  for (const n of fixed.keys()) if (!bank.has(n)) throw bad('VM_PACKAGE_REQUIRED_ASSET');
  // Anchor is statically compiled in the SAME canonical module graph.
  const anchor = await read(
    join(root, 'apps/server/src/services/browser/runtime/installed-publisher-anchor.mjs'),
    65536
  );
  if (sha(anchor) !== manifest.anchorSHA256) throw bad('VM_PACKAGE_COMPILED_ANCHOR_HASH');
  return { bank, source, selected };
}
// Recheck copied pre-signed assets against the same source-selected manifest and compiled anchor.
// Streaming is bounded for multi-GiB raw disks; this performs no signing or runtime admission.
export async function verifyBrowserVMRelease(root, directory) {
  const loaded = await loadRelease(root);
  if (!loaded) {
    try {
      await lstat(directory);
      throw bad('VM_PACKAGE_UNSELECTED_BANK');
    } catch (value) {
      if (value?.code !== 'ENOENT') throw value;
    }
    return Object.freeze({ available: false });
  }
  await canonical(directory);
  for (const row of loaded.bank.values()) {
    let fd, first;
    try {
      const path = join(directory, row.name),
        before = await lstat(path, { bigint: true });
      if (!before.isFile() || before.size !== BigInt(row.bytes) || (await realpath(path)) !== path)
        throw bad('VM_PACKAGE_INPUT');
      fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      if (!same(before, await fd.stat({ bigint: true }))) throw bad('VM_PACKAGE_CHANGED');
      let total = 0;
      const buffer = Buffer.alloc(65536),
        hash = createHash('sha256');
      for (;;) {
        const { bytesRead } = await fd.read(buffer, 0, buffer.length, null);
        if (!bytesRead) break;
        total += bytesRead;
        if (total > row.bytes) throw bad('VM_PACKAGE_SIZE');
        hash.update(buffer.subarray(0, bytesRead));
      }
      if (
        total !== row.bytes ||
        hash.digest('hex') !== row.sha256 ||
        !same(before, await fd.stat({ bigint: true })) ||
        !same(before, await lstat(path, { bigint: true }))
      )
        throw bad('VM_PACKAGE_CHANGED');
    } catch (value) {
      first = { value };
    } finally {
      if (fd) {
        const original = fd;
        fd = undefined;
        try {
          await original.close();
        } catch (value) {
          first ??= { value };
        }
      }
    }
    if (first) throw first.value;
  }
  return Object.freeze({ available: true, manifestSHA256: loaded.selected.manifestSHA256 });
}
/** Publisher-time byte copier only. No candidate modules/addons are imported,
 * tools executed, signatures minted, downloads or runtime compilers. */
export async function copyBrowserVMRelease(root, output) {
  await canonical(output);
  const destination = join(output, 'browser/vm'),
    loaded = await loadRelease(root);
  const exists = await originalOutputPath(output, 'browser/vm');
  if (!loaded) {
    if (exists) await rm(destination, { recursive: true });
    return Object.freeze({ available: false });
  }
  const { bank, source, selected } = loaded;
  await mkdir(dirname(destination), { recursive: true });
  await canonical(dirname(destination));
  try {
    await lstat(destination);
    throw bad('VM_PACKAGE_OUTPUT_EXISTS');
  } catch (value) {
    if (value?.code !== 'ENOENT') throw value;
  }
  const stage = join(dirname(destination), '.vm-copy-pending');
  let first;
  try {
    await mkdir(stage, { mode: 0o700 });
    for (const row of bank.values())
      await copyFile(join(source, row.name), join(stage, row.name), row);
    const fd = await open(stage, 'r');
    let directoryFailure;
    try {
      await fd.sync();
    } catch (value) {
      directoryFailure = { value };
    } finally {
      try {
        await fd.close();
      } catch (value) {
        directoryFailure ??= { value };
      }
    }
    if (directoryFailure) throw directoryFailure.value;
    await rename(stage, destination);
    return Object.freeze({ available: true, manifestSHA256: selected.manifestSHA256 });
  } catch (value) {
    first = { value };
  }
  throw first.value; // Failed original-copy stages remain for diagnosis; never publish them.
}

/** Same-relative static module graph for server tsc output. Never enumerate or
 * import candidate runtime modules, and never copy a second issuer graph. */
export async function copyBrowserVMModules(root, output) {
  await canonical(root);
  await canonical(output);
  await clearBrowserVMModules(output);
  for (const relative of productionBrowserVMModules) {
    if (!/^apps\/server\/src\/services\/browser\/(runtime|vm)\/[-a-zA-Z0-9/]+\.mjs$/.test(relative))
      throw bad('VM_SERVER_MODULE_SELECTION');
    const source = join(root, relative),
      bytes = await read(source, 1048576),
      destination = join(output, relative.slice('apps/server/src/'.length));
    const parent = dirname(destination);
    await originalOutputPath(output, parent.slice(output.length + 1));
    await mkdir(parent, { recursive: true });
    await canonical(parent);
    await copyFile(source, destination, {
      name: relative,
      bytes: bytes.length,
      sha256: sha(bytes),
    });
  }
  return Object.freeze({ modules: productionBrowserVMModules.length });
}
