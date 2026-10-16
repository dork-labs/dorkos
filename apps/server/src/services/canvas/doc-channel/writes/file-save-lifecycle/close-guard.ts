/** Preserve the original live birth while an ordinary save still needs settlement. */
import type { Db, DbTransaction } from '@dorkos/db';
import { RoomError } from '../../../../rooms/room-errors.js';
import { DocChannelCorruptionError } from '../../store-json.js';
import { readDocumentFileSaveCloseBlocker } from '../file-save-intents.js';
/** Existing agent refusal vocabulary remains unchanged; HTTP carries the specific409 code. */
export class DocumentFileSaveCloseBlockedError extends RoomError {
  readonly recoveryCode = 'DOC_SAVE_RECOVERY_REQUIRED';
  constructor() {
    super(
      'CANVAS_UNAVAILABLE',
      'This document has an unresolved save. Keep it open until the original save is resolved.'
    );
    this.name = 'DocumentFileSaveCloseBlockedError';
  }
}
/** Called inside the same transaction as channel closure and physical document deletion. */
export function assertDocumentFileSaveCanClose(
  executor: Db | DbTransaction,
  documentId: string
): void {
  if (readDocumentFileSaveCloseBlocker(executor, documentId))
    throw new DocumentFileSaveCloseBlockedError();
}
/** Selection hint only; the transactional close guard always runs again before deletion. */
export function documentFileSaveCanClose(
  executor: Db | DbTransaction,
  documentId: string
): boolean {
  try {
    assertDocumentFileSaveCanClose(executor, documentId);
    return true;
  } catch (error) {
    if (
      error instanceof DocumentFileSaveCloseBlockedError ||
      error instanceof DocChannelCorruptionError
    )
      return false;
    throw error;
  }
}
