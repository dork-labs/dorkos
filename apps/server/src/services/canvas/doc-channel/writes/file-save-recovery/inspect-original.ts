import { sameOriginalFileSaveSource } from './applied-source.js';
/** Fixed evidence reads only. This module cannot replace bytes, append events or choose routes. */
import { sha256 } from '../../../../../lib/file-route-guards.js';
import { DocChannelNotFoundError } from '../../authorization.js';
import { sameDocOwnerAuthority } from '../../doc-source-policy.js';
import {
  readFileSaveIntent,
  readCurrentFileSaveWindow,
  FileSaveWriteFencedError,
  type FileSaveIntentRow,
} from '../file-save-intents.js';
import { CheckboxWriteFencedError, type CheckboxWriteFence } from '../checkbox-fence.js';
import type { CanonicalFileIdentity } from '../canonical-writer.js';
import {
  requireCurrentDocumentSaveSource,
  requireOriginalDocumentFileEffect,
  readOriginalDocumentFile,
  type Capture,
  type DocumentFileSaveDependencies,
} from '../document-file-save-source.js';
import type { FileSaveRecoveryEntry } from '@dorkos/shared/file-save/recovery';
import type { FileDocumentSaveReceipt } from '@dorkos/shared/schemas';
type Match = 'same_saved_replacement' | 'different' | 'not_checked';
export type RecoveryInspection =
  | {
      kind: 'discovery';
      rows: FileSaveIntentRow[];
      hasMore: boolean;
      admission: 'blocked' | 'not_observed_blocked';
    }
  | {
      kind: 'recovery';
      row: FileSaveIntentRow;
      verifiedReplacement: boolean;
      currentFileMatch: Match;
    };
/** Always called under the owning canonical gate after genuine binding-only capture. */
export async function inspectOriginalFileSaveEvidence(
  deps: DocumentFileSaveDependencies,
  fence: CheckboxWriteFence,
  captured: Capture,
  identity: CanonicalFileIdentity,
  eventId?: string
): Promise<RecoveryInspection> {
  requireCurrentDocumentSaveSource(deps, captured);
  if (!eventId) {
    let admission: 'blocked' | 'not_observed_blocked' = 'not_observed_blocked';
    try {
      fence.assertAdmission(identity);
    } catch (error) {
      if (error instanceof FileSaveWriteFencedError || error instanceof CheckboxWriteFencedError)
        admission = 'blocked';
      else throw error;
    }
    const window = readCurrentFileSaveWindow(deps.db, captured, identity.canonicalPath);
    requireCurrentDocumentSaveSource(deps, captured);
    return { kind: 'discovery', ...window, admission };
  }
  const row = readFileSaveIntent(deps.db, captured.source.id, eventId);
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  if (
    !row ||
    !same(row.incarnation, captured.incarnation) ||
    !sameOriginalFileSaveSource(deps.db, row.source, captured.source) ||
    !sameDocOwnerAuthority(row.owner, captured.owner) ||
    row.canonicalPath !== identity.canonicalPath
  )
    throw new DocChannelNotFoundError();
  let verifiedReplacement = false,
    currentFileMatch: Match = 'not_checked';
  if (row.status === 'staged' || (row.status === 'in_doubt' && row.replacementInode !== null)) {
    fence.assertAdmission(identity, row.intentId);
    try {
      await requireOriginalDocumentFileEffect(deps, row, captured);
      verifiedReplacement = true;
      currentFileMatch = 'same_saved_replacement';
    } catch (error) {
      if (!(
        error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'DOC_SAVE_IN_DOUBT'
      ))
        throw error;
    }
  } else if (row.status === 'committed') {
    const content = await readOriginalDocumentFile(identity);
    currentFileMatch =
      identity.device === row.replacementDevice &&
      identity.inode === row.replacementInode &&
      sha256(content) === row.afterHash
        ? 'same_saved_replacement'
        : 'different';
  }
  requireCurrentDocumentSaveSource(deps, captured);
  return { kind: 'recovery', row, verifiedReplacement, currentFileMatch };
}
/** Wire projection only, after private original completion supplies a real receipt when permitted. */
export function projectOriginalFileSaveEvidence(
  row: FileSaveIntentRow,
  receipt?: FileDocumentSaveReceipt,
  currentFileMatch: Match = 'not_checked'
): FileSaveRecoveryEntry {
  const common = { eventId: row.eventId, createdAt: row.createdAt, updatedAt: row.updatedAt };
  if (receipt) return { ...common, state: 'receipt', receipt, historical: true, currentFileMatch };
  if (row.status === 'no_op' || row.status === 'failed')
    return { ...common, state: row.status, historical: true };
  if (row.status === 'committed') throw new Error('Committed original receipt proof missing');
  return {
    ...common,
    state: 'review',
    reason:
      row.replacementInode === null ? 'prepared_without_replacement' : 'replacement_not_proven',
  };
}
