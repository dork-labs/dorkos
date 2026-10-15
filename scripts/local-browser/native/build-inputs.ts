/** Frozen built payload inventory used before packaging and during every seal/readback. */
import assert from 'node:assert/strict';
import path from 'node:path';
import { lstat, readdir, realpath } from 'node:fs/promises';
import { captureProofSource } from '../source-snapshot.js';
import { nativeSourceInventory, type ArchivePayload } from './bundle.js';
import { sha } from './resources.js';
/** Inventory the exact compiled package and desktop files consumed by packaging. */
export async function builtInputs(root: string) {
  const files: Record<string, string> = {};
  async function walk(directory: string) {
    assert.equal(await realpath(directory), directory);
    for (const name of (await readdir(directory)).sort()) {
      const file = path.join(directory, name),
        info = await lstat(file);
      assert(!info.isSymbolicLink(), 'Built input symlink refused');
      if (info.isDirectory()) await walk(file);
      else {
        assert(info.isFile());
        files[path.relative(root, file).split(path.sep).join('/')] = await sha(file);
      }
    }
  }
  for (const name of await readdir(path.join(root, 'packages'))) {
    const directory = path.join(root, 'packages', name, 'dist');
    try {
      await lstat(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    await walk(directory);
  }
  await walk(path.join(root, 'apps/desktop/dist'));
  await walk(path.join(root, 'apps/desktop/core-extensions'));
  assert(files['apps/desktop/dist/main/index.js']);
  return files;
}
/** Refuse packaged payloads that differ from their frozen normal-build inputs. */
export function assertBuiltPayloads(
  inputs: Record<string, string>,
  archive: { payloads: Record<string, Pick<ArchivePayload, 'sha256'>> }
) {
  let count = 0;
  for (const [name, digest] of Object.entries(inputs)) {
    if (!name.startsWith('apps/desktop/dist/') && !name.startsWith('apps/desktop/core-extensions/'))
      continue;
    const entry = name.slice('apps/desktop/'.length);
    assert.equal(
      archive.payloads[entry]?.sha256,
      digest,
      'Candidate differs from frozen built payload ' + entry
    );
    count++;
  }
  assert(count > 0 && inputs['apps/desktop/dist/main/index.js']);
  return count;
}

/** Capture current source and shared native file identities without loading them. */
export async function captureDesktopInputs(root: string) {
  // eslint-disable-next-line no-restricted-syntax -- Standalone proof captures source without importing app startup.
  const proofEnvironment = process.env;
  return {
    source: await captureProofSource(root, proofEnvironment),
    natives: await nativeSourceInventory(root),
  };
}
