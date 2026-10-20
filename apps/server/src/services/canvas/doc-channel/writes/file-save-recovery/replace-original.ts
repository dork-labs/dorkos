/** Mechanical extraction of the existing ordinary replacement; recovery never calls this function. */
import fs from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { and, eq, canvasDocFileSaveIntents } from '@dorkos/db';
import { documentTransaction } from '../../store-transaction.js';
import { resolveWithinCwd, sha256 } from '../../../../../lib/file-route-guards.js';
import {
  requireCurrentDocumentSaveSource,
  requireOriginalDocumentFileEffect,
  type DocumentFileSaveDependencies,
  type Capture,
} from '../document-file-save-source.js';
import {
  requireOriginalDocumentFileOwner,
  type InstallationFileWrites,
} from '../installation-file-writes.js';
import {
  CanonicalFileIdentityChangedError,
  type CanonicalFileWriteCoordinator,
  type CanonicalFileIdentity,
  type CanonicalWriteLease,
} from '../canonical-writer.js';
import type { CheckboxWriteFence } from '../checkbox-fence.js';
import type { FileSaveIntentRow } from '../file-save-intents.js';
function matches(info: { dev: bigint; ino: bigint }, device: string, inode: string) {
  return String(info.dev) === device && String(info.ino) === inode;
}
/** Same constructor-owned installation/database/store/coordinator must own the original write. */
export async function replaceOriginalDocumentFile(
  owner: InstallationFileWrites,
  deps: DocumentFileSaveDependencies,
  coordinator: CanonicalFileWriteCoordinator,
  fence: CheckboxWriteFence,
  row: FileSaveIntentRow,
  captured: Capture,
  identity: CanonicalFileIdentity,
  lease: CanonicalWriteLease,
  content: string,
  attempt: { renameStarted: boolean; cleanupComplete: boolean }
): Promise<void> {
  requireOriginalDocumentFileOwner(owner, deps.db, deps.channels, coordinator);
  requireCurrentDocumentSaveSource(deps, captured);
  const temporary = `${row.canonicalPath}.${randomBytes(6).toString('hex')}.tmp`;
  const handle = await fs.open(temporary, 'wx');
  attempt.cleanupComplete = false;
  const owned = await handle.stat({ bigint: true }).catch(async (error: unknown) => {
    await handle.close();
    throw error;
  });
  let renamed = false;
  const ownedTemporary = async () => {
    const current = await fs.lstat(temporary, { bigint: true });
    return current.isFile() && current.dev === owned.dev && current.ino === owned.ino;
  };
  try {
    requireCurrentDocumentSaveSource(deps, captured);
    await handle.writeFile(content, 'utf8');
    await handle.sync();
    const reserved = await lease.reserveReplacement(temporary);
    if (
      reserved.canonicalPath !== temporary ||
      !matches(owned, reserved.device, reserved.inode) ||
      !(await ownedTemporary())
    )
      throw new CanonicalFileIdentityChangedError();
    documentTransaction(deps.db, (tx) => {
      requireCurrentDocumentSaveSource(deps, captured, tx);
      const changed = tx
        .update(canvasDocFileSaveIntents)
        .set({
          status: 'staged',
          replacementDevice: String(owned.dev),
          replacementInode: String(owned.ino),
          updatedAt: new Date().toISOString(),
        })
        .where(
          and(
            eq(canvasDocFileSaveIntents.intentId, row.intentId),
            eq(canvasDocFileSaveIntents.status, 'prepared')
          )
        )
        .run().changes;
      if (changed !== 1) throw new Error('Original save staging changed');
    });
    row.status = 'staged';
    row.replacementDevice = String(owned.dev);
    row.replacementInode = String(owned.ino);
    requireCurrentDocumentSaveSource(deps, captured);
    const currentPath = await resolveWithinCwd(
      captured.source.resolvedCwd!,
      captured.source.sourcePath!
    );
    const before = await fs.stat(currentPath.resolved, { bigint: true });
    if (
      currentPath.resolved !== row.canonicalPath ||
      !matches(before, identity.device, identity.inode) ||
      sha256(await fs.readFile(row.canonicalPath, 'utf8')) !== row.beforeHash
    )
      throw new CanonicalFileIdentityChangedError();
    fence.assertAdmission(identity, row.intentId);
    if (!(await ownedTemporary())) throw new CanonicalFileIdentityChangedError();
    requireCurrentDocumentSaveSource(deps, captured);
    attempt.renameStarted = true;
    await fs.rename(temporary, row.canonicalPath);
    renamed = true;
    await requireOriginalDocumentFileEffect(deps, row, captured);
  } finally {
    let closed = false;
    try {
      await handle.close();
      closed = true;
    } finally {
      if (!renamed && (await ownedTemporary().catch(() => false))) await fs.unlink(temporary);
      attempt.cleanupComplete = closed;
    }
  }
}
