/** Confined checkbox filesystem operations; every await retains an explicit host boundary. */
import { access, open, realpath, stat, lstat, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { rawByteHash } from './checkbox-bytes.js';
import { dirname, isAbsolute, relative } from 'node:path';
import type { DocWriteIntentRow } from '../store.js';
import {
  validateCheckboxEvidence,
  CheckboxEvidenceError,
  type VerifiedCheckboxAuthority,
} from './checkbox-evidence.js';
const originalFileCloseFailures = new WeakMap<() => void, Readonly<{ cause: unknown }>>();
/** Cleanup DATA only, recorded solely when an original acquired handle close rejects. */
export function readOriginalCheckboxFileCloseFailure(
  boundary: () => void
): Readonly<{ cause: unknown }> | undefined {
  return originalFileCloseFailures.get(boundary);
}
/** Remove only the exact exclusively-created inode recorded by this intent. */
export async function cleanCheckboxTemporary(
  row: DocWriteIntentRow,
  assertFs: () => void
): Promise<void> {
  const evidence = validateCheckboxEvidence(row);
  if (!evidence.tempPath || !evidence.tempIdentity) return;
  assertFs();
  const info = await lstat(evidence.tempPath, { bigint: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  );
  assertFs();
  if (!info) return;
  if (
    !info.isFile() ||
    String(info.dev) !== evidence.tempIdentity.device ||
    String(info.ino) !== evidence.tempIdentity.inode
  )
    throw new CheckboxEvidenceError('Checkbox temporary identity changed.');
  await unlink(evidence.tempPath);
}
/** Current canonical root/ancestor identities, bracketed by the caller's owned lease boundary. */
async function checkboxRootIdentity(root: string, assertFs: () => void): Promise<string> {
  const identities: string[] = [];
  let current = root;
  for (;;) {
    assertFs();
    const info = await lstat(current, { bigint: true });
    assertFs();
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new CheckboxEvidenceError('Checkbox source root changed.');
    identities.push(`${current}:${info.dev}:${info.ino}`);
    const parent = dirname(current);
    if (parent === current) return JSON.stringify(identities);
    current = parent;
  }
}

/** Read an absolute current regular file within the recorded physical tree. */
export async function readCheckboxSource(
  authority: VerifiedCheckboxAuthority,
  assertFs: () => void
): Promise<{ bytes: Buffer; mode: number; device: string; inode: string; rootIdentity: string }> {
  assertFs();
  const { canonicalPath, resolvedCwd } = authority.binding;
  if (!isAbsolute(canonicalPath) || !isAbsolute(resolvedCwd))
    throw new Error('Checkbox paths must be absolute.');
  const path = await realpath(canonicalPath);
  assertFs();
  const cwd = await realpath(resolvedCwd);
  assertFs();
  const within = relative(cwd, path);
  if (
    path !== canonicalPath ||
    cwd !== resolvedCwd ||
    within === '..' ||
    within.startsWith('../') ||
    isAbsolute(within)
  )
    throw new Error('Checkbox source escaped its recorded tree.');
  const rootIdentity = await checkboxRootIdentity(cwd, assertFs);
  const info = await stat(path, { bigint: true });
  assertFs();
  if (info.size > 5n * 1024n * 1024n) throw new Error('Checkbox source is too large.');
  if (!info.isFile() || !(info.mode & 0o222n)) throw new Error('Checkbox source is not writable.');
  await access(path, constants.R_OK | constants.W_OK);
  const bytes = await readBoundedCheckboxFile(path, assertFs, {
    device: String(info.dev),
    inode: String(info.ino),
  });
  const currentRoot = await checkboxRootIdentity(cwd, assertFs);
  const namedPath = await realpath(canonicalPath);
  assertFs();
  const named = await lstat(canonicalPath, { bigint: true });
  assertFs();
  if (
    currentRoot !== rootIdentity ||
    namedPath !== path ||
    !named.isFile() ||
    named.isSymbolicLink() ||
    named.dev !== info.dev ||
    named.ino !== info.ino
  )
    throw new CheckboxEvidenceError('Checkbox source pathname or root changed.');
  return {
    bytes,
    mode: Number(info.mode),
    device: String(info.dev),
    inode: String(info.ino),
    rootIdentity,
  };
}
/** Bound allocation even if an external writer grows a file after the pathname stat. */
export async function readBoundedCheckboxFile(
  path: string,
  assertFs: () => void,
  expected: { device: string; inode: string }
): Promise<Buffer> {
  assertFs();
  const handle = await open(path, 'r');
  let failed = false,
    first: unknown;
  // Join this scope to its captured cleanup before returning or reporting failure.
  const drainOriginalCleanup = async () => {
    try {
      await handle.close();
    } catch (cause) {
      if (!originalFileCloseFailures.has(assertFs))
        originalFileCloseFailures.set(assertFs, Object.freeze({ cause }));
      if (!failed) {
        failed = true;
        first = cause;
      }
    }
    if (failed) throw first;
  };
  try {
    assertFs();
    const current = await handle.stat({ bigint: true });
    assertFs();
    if (String(current.dev) !== expected.device || String(current.ino) !== expected.inode)
      throw new CheckboxEvidenceError('Checkbox source identity changed.');
    const limit = 5 * 1024 * 1024 + 1;
    const chunks: Buffer[] = [];
    let used = 0;
    while (used < limit) {
      // Initial acquired size only sizes allocation; keep reading to EOF so growth is not trusted.
      const capacity = Math.min(
        64 * 1024,
        limit - used,
        used === 0 ? Math.max(1, Number(current.size) + 1) : 64 * 1024
      );
      const chunk = Buffer.alloc(capacity);
      let filled = 0;
      while (filled < chunk.length) {
        const { bytesRead } = await handle.read(chunk, filled, chunk.length - filled, used);
        assertFs();
        if (!bytesRead) {
          if (filled) chunks.push(chunk.subarray(0, filled));
          return Buffer.concat(chunks, used);
        }
        filled += bytesRead;
        used += bytesRead;
      }
      chunks.push(chunk);
    }
    throw new Error('Checkbox source is too large.');
  } catch (cause) {
    failed = true;
    first = cause;
    throw cause;
  } finally {
    await drainOriginalCleanup();
  }
}

/** Verify recorded exclusive inode and bounded exact bytes immediately before replacement. */
export async function verifyCheckboxTemporary(
  row: DocWriteIntentRow,
  assertFs: () => void
): Promise<void> {
  const evidence = validateCheckboxEvidence(row);
  if (!evidence.tempPath || !evidence.tempIdentity)
    throw new CheckboxEvidenceError('Checkbox temporary evidence absent.');
  assertFs();
  const staged = await lstat(evidence.tempPath, { bigint: true });
  assertFs();
  const identity = evidence.tempIdentity;
  if (
    !staged.isFile() ||
    String(staged.dev) !== identity.device ||
    String(staged.ino) !== identity.inode
  )
    throw new CheckboxEvidenceError('Checkbox temporary identity changed.');
  const bytes = await readBoundedCheckboxFile(evidence.tempPath, assertFs, identity);
  if (rawByteHash(bytes) !== row.afterHash)
    throw new CheckboxEvidenceError('Checkbox temporary bytes changed.');
  const named = await lstat(evidence.tempPath, { bigint: true });
  assertFs();
  if (
    !named.isFile() ||
    named.isSymbolicLink() ||
    String(named.dev) !== identity.device ||
    String(named.ino) !== identity.inode
  )
    throw new CheckboxEvidenceError('Checkbox temporary pathname changed.');
}

/** Bind verified after bytes to the actual replacement inode recorded before rename. */
export function assertCheckboxReplacement(
  row: DocWriteIntentRow,
  file: { bytes: Buffer; device: string; inode: string }
): void {
  const identity = validateCheckboxEvidence(row).tempIdentity;
  if (
    !identity ||
    file.device !== identity.device ||
    file.inode !== identity.inode ||
    rawByteHash(file.bytes) !== row.afterHash
  )
    throw new CheckboxEvidenceError('Checkbox replacement evidence changed.');
}
